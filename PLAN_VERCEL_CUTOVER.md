# PLAN — Fix Vercel deployment for boklanov.com

Repo: `boklanov/nextjs-notion-boklanov` · Owner: Daniil

---

## ✅ Current state (after PR #15 — 2026-05-03)

Verified working:
- `https://boklanov.com/` (home) — renders via R2 fallback when Notion 429s
- `https://boklanov.com/Bury-Me-Behind-the-Baseboard` — renders

Not yet verified (likely working — they're cached):
- The other ~56 slugs. R2 has a snapshot for every page reachable from the root.

Build now finishes cleanly (~53s) even with Notion 429s on ~10 pages. Runtime
serves either fresh content or the warmed R2 snapshot. The 10s function
timeout that was killing cold-path renders is gone (60s now). Cache warming
runs daily and on push to `main` via GitHub Actions — no more manual ritual.

What actually fixed the production outage was the *combination*:

1. **Notion auth** (PR #9) — raises rate-limit ceiling
2. **R2 recordMap cache + 1-concurrency fetch** (PR #11) — runtime fallback when Notion still 429s
3. **`.trim()` on `R2_SECRET_ACCESS_KEY`** (PR #8) — production env var had a trailing newline that broke every R2 PUT silently
4. **`vercel.json` `maxDuration: 60`** (PR #12) — without it, cold renders timed out at 10s and committed `notFound` to ISR
5. **Build-phase soft-fail in pages** (PR #10) — keeps the deploy green when individual slugs 429
6. **`--all` warmer** (PR #13) — populates R2 for slugs Notion never let the build fetch
7. **GitHub Actions cron** (PR #15) — runs the warmer automatically; non-blocking on failure

Removing any one of those re-breaks the site. There is no single fix.

---

## 🔁 What we tried, in order

### Round 1 — PR #2 (`8d76639`, merged 2026-02): "Just sync upstream"

Synced Feb 2026 changes from upstream `transitive-bullshit/nextjs-notion-starter-kit`.
Build went green; runtime kept 404'ing. **Didn't fix it** — the issue was Notion-side
throttling, not stale code.

### Round 2 — PR #3 (`3d58cdf`): R2-backed preview-image cache

Replaced the in-memory Keyv with R2-persisted JSON. Reduced build duration but
**didn't fix the 404s**. Bonus side-effect: R2 PUTs were silently no-op'ing the
whole time due to a credential bug (see Round 7); we just didn't notice because
preview-image generation also has an in-memory hot path.

### Round 3 — PR #4 (`fa50a22`): R2 cache for `/api/social-image` OG cards

Same R2 infra as PR #3 but for OG PNGs. **Didn't fix the 404s** — different code
path. Same silent R2 PUT failure.

### Round 4 — PR #5 (`9698954`): "Throw on runtime ISR error"

`getStaticProps` was returning `{ notFound: true }` on every regen failure,
which committed a 404 to the ISR cache for the revalidate window. Switched
runtime path to `throw` so Next would keep serving the last-known-good
snapshot. Build path still soft-failed. **Helped on regen but didn't help
slugs that never built successfully** — those had no last-known-good to fall
back to. Still 404.

### Round 5 — PR #6 (`4948a81`): `vercel.json` `maxDuration: 60`

Initially tried `maxDuration: 300` — Vercel rejected with "must be between 1
and 60" (Hobby plan cap). Settled on 60s. Made build-time Notion fetches less
likely to time out. **Build started succeeding more reliably; runtime 404s
unchanged** because the 429s happened well under 60s and weren't a timeout
problem.

### Round 6 — PR #7 (`4b0b9c1`): R2 recordMap fallback (round 1)

The "Option A" originally laid out below. Wrap `lib/notion.ts:getPage` in
a try/catch that writes the recordMap to R2 on success and reads from R2 on
failure. Merged. **Didn't help.** Vercel logs showed
`recordmap-cache put failed ... SignatureDoesNotMatch` — every R2 write was
failing. The cache stayed empty so the fallback path had nothing to serve.

### Round 7 — PR #8 (`94ced9c`): The R2 secret had a trailing newline

Reproduced the SignatureDoesNotMatch locally with the real production
credentials. Tested permutations:

| scenario | result |
|---|---|
| SDK defaults (no checksum override) | PASS |
| WHEN_REQUIRED checksums (initial wrong fix) | PASS — no behavior change |
| **trailing `\n` on secret** | **FAIL — `SignatureDoesNotMatch` (matches prod)** |
| trailing space on secret | FAIL — same error |
| trailing `\n` on access key | FAIL — different error (`TypeError`) |
| 1.1 MB body, defaults | PASS |

Cause: the Cloudflare token UI's "Click to copy" appends a newline to the
copied value. That newline landed in Vercel's `R2_SECRET_ACCESS_KEY` env var.
sigv4 HMACs the wrong secret, the server compares against the secret-without-newline,
every PUT fails. **PRs #3 and #4's R2 caches had been silently no-op'ing for
weeks** for exactly this reason; we only saw it because PR #7 added a
`console.warn` on put failure.

Fix: `.trim()` the four `R2_*` env vars at module load. The first attempt of
PR #8 also disabled the AWS SDK's flexible-checksum default — that turned
out to be a misdiagnosis (the local probe showed defaults pass). Reverted the
checksum config; kept just the trim. **Once merged + redeployed, R2 PUTs
worked.** But runtime was still 404'ing because the cache wasn't yet populated
and Notion was still 429'ing the build.

### Round 8 — PR #9 (`b39b6b3`): Notion cookie auth

Researched upstream issues. Found
[react-notion-x #649](https://github.com/NotionX/react-notion-x/issues/649) and
[#480](https://github.com/NotionX/react-notion-x/issues/480): Notion has been
progressively throttling the unofficial `loadPageChunk` endpoint when called
from cloud-provider egress IPs. Vercel's shared pool is hit hardest. The
maintainer closed #649 with "the page itself returns 429 in UI too — nothing
we can do." The community-validated workaround is to authenticate as a
logged-in browser session via `token_v2` + `notion_user_id`. `notion-client`
already supports this (`authToken`, `activeUser` constructor options).

Wired both env vars into `lib/notion-api.ts`. Also reverted
`lib/notion.ts`, `lib/get-site-map.ts`, `pages/index.tsx`, `pages/[pageId].tsx`,
and `vercel.json` to upstream-pristine, on the assumption that auth alone
would make the build reliable.

**Auth confirmed in prod logs:** `[notion-api] auth: token_v2=present(len=537), active_user=present(len=36)`.
**But the build still 429'd** — even authenticated, Notion throttles the build's burst rate. And reverting all the resilience patches turned a degraded site into a *hard-failing* one: build threw on the first 429.

### Round 9 — PR #10 (`92e551b`): Build-phase soft-fail (restored from PR #5)

Restore the `NEXT_PHASE === 'phase-production-build'` branch in `pages/index.tsx`
and `pages/[pageId].tsx`. During build, return `{ notFound: true, revalidate: 10 }`
on error so one bad page doesn't kill the deploy. At runtime, throw to keep
serving last-known-good. **Build started succeeding** with ~10 pages skipped.
**But runtime still 404'd those skipped pages** — they had no last-known-good
to fall back to.

### Round 10 — PR #11 (`94ced9c`): R2 recordMap fallback (round 2)

Re-add the R2 fallback that PR #7 *would have* done if R2 PUTs had worked.
Now they do (PR #8). Also pass `concurrency: 1` to `notion.getPage` — the
home page recordMap is 1.08 MB and notion-client splits it into multiple
concurrent `loadPageChunk` requests; serial fetch trades latency for far
fewer 429s. Added `scripts/warm-recordmap-cache.mjs` so we can populate R2
from a residential IP for slugs Notion never let the build fetch.

**Home page now rendered via R2 fallback** (`notion.getPage failed, serving R2 recordMap snapshot`).
**`/Bury-Me-Behind-the-Baseboard` was still 404'ing** with a NEW error:

```
Vercel Runtime Timeout Error: Task timed out after 10 seconds
```

That's not a 429 — it's the function hitting Vercel's default 10s wall on the
cold path (`notion.getPage` + preview images + tweets > 10s for an uncached
slug).

### Round 11 — PR #12 (`94ced9c`): Restore `vercel.json maxDuration: 60`

PR #9's "align with upstream" pass deleted `vercel.json` on the assumption
that auth would keep runtime under 10s. It does for cache hits (~50ms),
but not for cold-path renders. Restored byte-identical to PR #6's content.
**Cold-path slugs now have 60s to populate the cache.**

### Round 12 — PR #13 (`2c84d8e`): Warmer `--all` flag

The 8 IDs from PR #11's build log's `skipping page` lines weren't enough —
`Bury-Me-Behind-the-Baseboard` actually maps to `ee2d7bea-1148-4e16-bcb0-3effc276a719`,
which appeared as a "page error" line during static export, not a "skipping page"
line. The two failure modes have different log shapes; the manual list missed
the second one.

Enhanced `scripts/warm-recordmap-cache.mjs` with `--all`: reads
`rootNotionPageId` from `site.config.ts`, calls `notion-utils' getAllPagesInSpace`
(same function `lib/get-site-map.ts` uses at build time), warms every reachable
page. Ran it from the laptop: **58 pages cached, 0 failed** including
`ee2d7bea-...`. R2 now has a snapshot for every slug.

### Round 13 — PR #15: GitHub Actions auto-warmer

Manual local warming after every Notion edit was the obvious friction point.
Added `.github/workflows/warm-recordmap-cache.yml` — runs the same `--all` script
on three triggers: manual `workflow_dispatch`, daily cron at 03:00 UTC, and
push to `main`. **Failure policy: non-blocking.** `continue-on-error: true` plus
the script's existing per-page soft-fail means the worst case is "0 cached, N
failed" with the previous R2 snapshots untouched — production keeps serving
the existing cache.

Caveat: the pre-existing `.github/workflows/build.yml` had a comment about
GitHub Actions IPs being throttled by Notion when running `pnpm build`. That
predates the auth fix; with `NOTION_TOKEN_V2` + `concurrency: 1` the warmer
should fare better. If it doesn't, the fallback is Cloudflare Workers Cron
or local-only.

---

## 📊 Why each fix individually was insufficient

| What | Without it | With everything else |
|---|---|---|
| Auth (PR #9) | Notion throttles harder | Cache hits + occasional 429s |
| R2 fallback (PR #11) | 429 → 404 directly | 429 → cached snapshot |
| `.trim()` (PR #8) | Cache silently empty | Cache writes work |
| `maxDuration: 60` (PR #12) | Cold renders timeout at 10s | Cold renders complete |
| Build soft-fail (PR #10) | One 429 kills deploy | Deploy survives |
| `--all` warmer (PR #13) | New slugs 404 forever | Every slug has snapshot |
| Auto-warmer Action (PR #15) | Cache rots; manual ritual | Self-healing on schedule |

---

## 🔧 Operations going forward

### Cache warming — automated by default

`.github/workflows/warm-recordmap-cache.yml` runs the warmer:
- on every push to `main`
- daily at 03:00 UTC
- on demand via **Actions → Warm Notion recordMap cache → Run workflow**

Required repo secrets (Settings → Secrets and variables → Actions): `R2_ACCOUNT_ID`,
`R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `NOTION_TOKEN_V2`,
`NOTION_ACTIVE_USER`. Same values as the Vercel project — paste secrets
**without** trailing whitespace.

The job is **non-blocking**: `continue-on-error: true` plus per-page soft-fail
in the script means the worst-case outcome is "0 cached, N failed" with the
previous R2 snapshots left in place. Cannot make production worse than before
the run.

### Manual warm (fallback if the workflow fails)

```bash
node --env-file=.env scripts/warm-recordmap-cache.mjs --all
```
Takes ~2 minutes for 58 pages. Run this if a Vercel build log shows many
`skipping page` / `page error` lines, or if the GitHub Actions warmer ever
gets throttled and you need to bootstrap from your residential IP.

### When `NOTION_TOKEN_V2` rotates (logout / ~1 year)
1. Open https://www.notion.so logged in as the site owner
2. DevTools → Application → Cookies → `https://www.notion.so`
3. Copy `token_v2` → Vercel env `NOTION_TOKEN_V2`
4. Copy `notion_user_id` → Vercel env `NOTION_ACTIVE_USER`
5. Redeploy

### Monitoring
Watch for these in Vercel logs:
- `[notion-api] auth: token_v2=MISSING` → env vars dropped
- `recordmap-cache put failed ... SignatureDoesNotMatch` → R2 secret has whitespace again
- `notion.getPage failed, serving R2 recordMap snapshot` → working as designed (visitor unaffected)
- `Vercel Runtime Timeout Error` → would suggest `vercel.json` got dropped or a slow upstream

---

## 📂 File map

| File | Role | Origin |
|---|---|---|
| `lib/r2.ts` | Shared R2 client + helpers, env-var trim | PRs #4, #8 |
| `lib/db.ts` | Preview-image cache routed through R2 | PR #3 |
| `lib/notion.ts` | recordMap R2 read/write fallback, `concurrency: 1` | PR #11 |
| `lib/notion-api.ts` | `NotionAPI` constructed with `authToken` + `activeUser` + presence log | PR #9 |
| `lib/get-site-map.ts` | Build-time soft-fail + retry config | PR #2 (retained) |
| `pages/index.tsx` | `NEXT_PHASE` build-phase soft-fail | PRs #5, #10 |
| `pages/[pageId].tsx` | Same | PRs #5, #10 |
| `pages/api/social-image.tsx` | OG R2 cache | PR #4 |
| `vercel.json` | `maxDuration: 60` for SSG + OG routes | PRs #6, #12 |
| `scripts/warm-recordmap-cache.mjs` | Bootstrap cache from residential IP / CI | PRs #11, #13 |
| `.github/workflows/warm-recordmap-cache.yml` | Schedule + on-demand cache warmer | PR #15 |
| `next.config.js` | R2 host in `images.remotePatterns` | PR #2 |
| `site.config.ts` | Project content (root pageId, name, etc.) | original |
| `.env.example` | Documents `NOTION_TOKEN_V2`, `NOTION_ACTIVE_USER`, `R2_*` | PRs #4, #9 |

---

## 🚫 What we did NOT do (and why not)

- **Pro plan upgrade for 300s `maxDuration`** — 60s is sufficient now that the
  cache absorbs Notion 429s. Pro would help cold renders but isn't necessary.
- **`NOTION_API_KEY` (the official integration token)** — `react-notion-x`
  uses Notion's *unofficial* API surface (`/api/v3/loadPageChunk`); the
  official token doesn't apply. The cookie-auth route is the only way.
- **Lowering `notion-utils` build-time concurrency** — would slow the build
  but build resilience is already handled by soft-fail. Not worth the
  complexity.
- **Notion proxy on a non-Vercel host** — heavier infra. Cookie auth + R2
  fallback covers the same ground.
- **Vercel Cron warmer** — would run on Vercel's IP pool, which is what we're
  trying to insulate from in the first place. The GitHub Actions warmer in
  PR #15 covers the same need from a different IP pool.
- **Cloudflare Workers Cron warmer** — kept as a fallback if PR #15's GitHub
  Actions runner ends up being throttled. Different IP pool, no throttling
  history. Would require porting the warmer off `@aws-sdk/client-s3` to
  Workers' native R2 binding.

---

## 🧷 Reference — Vercel env vars (production)

| Name | Purpose |
|---|---|
| `R2_ACCOUNT_ID`, `R2_BUCKET=boklanov-content`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | R2 credentials (use re-paste **without** trailing newline) |
| `NEXT_PUBLIC_CDN_BASE` | `https://pub-eaffa56b38f2484cb3a48ab54ac582b0.r2.dev` |
| `ENABLE_EXPERIMENTAL_COREPACK=1` | pnpm 10.29.3 via corepack |
| `NOTION_TOKEN_V2` | `token_v2` cookie value from notion.so |
| `NOTION_ACTIVE_USER` | `notion_user_id` cookie value from notion.so |
