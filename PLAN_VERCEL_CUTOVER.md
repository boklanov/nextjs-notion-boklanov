# PLAN — Fix Vercel deployment for boklanov.com

Repo: `boklanov/nextjs-notion-boklanov` · Owner: Daniil · Started 2026-05-03

The legacy Notion-based site (this fork of `transitive-bullshit/nextjs-notion-starter-kit`)
had been failing Vercel production builds for 215 days when work began. This document is
the running log of what was attempted, what worked, what failed, and what's still open.

---

## Starting state (2026-05-03 morning)

- Vercel project `boklanovs-projects/nextjs-notion` linked to this repo, production branch
  `main`, last successful deploy `e058ee9` from 5/15/23.
- Latest production failure: `TimeoutError POST /api/v3/loadPageChunk` while prerendering
  `/The-Ape-Star`. Build fully aborted.
- Local `main` (working tree) was at `53790dd` — many fork-specific commits ahead of
  `origin/main` but the working branch was `update-main`.
- Upstream `transitive-bullshit/nextjs-notion-starter-kit` had ~20 unmerged commits
  including a `react-notion-x` bump that turned out to fix React-19 incompatibility.
- R2 bucket `boklanov-content` already populated (300 images, 222 MB) but unused by code.

---

## Three-step plan as agreed

1. **Sync from upstream** `transitive-bullshit/nextjs-notion-starter-kit`
2. **Fix issues** that surface
3. **Wire R2 (Cloudflare)** for caching

---

## Step 1 — Upstream sync ✅ DONE (PR #2)

Branch `sync/upstream-2026-05` cut from `update-main`, merged `upstream/main` on top.

### What conflicted

- `next.config.js` — kept eslint-ignore + added R2 hostname to `images.remotePatterns`,
  dropped `bundleAnalyzer` wrapping (upstream removed `analyze` scripts anyway).
- `package.json` — kept `katex@^0.16.45` (newer than upstream's `^0.16.28`); took upstream
  versions everywhere else; dropped extra eslint deps that upstream consolidated under
  `@fisch0920/config`.
- `pnpm-lock.yaml` — took upstream's, regenerated via `pnpm install`.

### Boklanov-specific identity preserved

`site.config.ts` (`name`, `domain`, `rootNotionPageId`, `description`, `navigationStyle`,
`navigationLinks` with English/Контакты), public/favicon-*.png, `manifest.json`,
`GitHubShareButton` removal in `components/NotionPage.tsx`.

### What broke after the merge

- **`Module not found: 'katex/dist/katex.min.css'`** → `pages/_app.tsx:2` imports it;
  pnpm strict resolution doesn't hoist a transitive peer dep. **Fix:** `pnpm add katex`.
- **`TypeError: Cannot read properties of undefined (reading 'replaceAll')`** during
  prerender → notion-utils called with `undefined`, React 19 / outdated `react-notion-x`
  mismatch. **Fix:** the merge itself (upstream's `0eadf00 feat: update react-notion-x`
  resolved it).
- **`Object literal may only specify known properties, and 'kyOptions' does not exist`** →
  notion-client 7.10 swapped `ky` → `ofetch`. **Fix:** `kyOptions` → `ofetchOptions`
  everywhere; deleted our hand-rolled retry wrapper since ofetch has built-in
  `retry`/`retryDelay`/`retryStatusCodes`.
- **`Notion 429 Too Many Requests` during build** → site-map walker hammered Notion in
  parallel. **Fix:** added `retryStatusCodes: [408,409,425,429,500,502,503,504]` and
  changed `getAllPagesImpl` to skip pages whose `recordMap === undefined` instead of
  throwing. Skipped pages render via `fallback:true + ISR` on first request.
- **`Next 16 removed `eslint` key in next.config.js`** → dropped it.
- **`The Edge Function "api/social-image" size is 1.04 MB and your plan size limit is 1 MB`**
  → Hobby Edge cap is 1 MB; the inter-semibold font alone pushed past it.
  **Fix:** drop `export const runtime = 'edge'`; falls back to Node runtime which has
  no such cap. `next/og` `ImageResponse` works in Node since Next 13.3.

### Vercel-specific obstacles

- **`pnpm install` errored `packages field missing or empty`** → Vercel auto-selects pnpm
  by project age. May 2023 project = pnpm@9, but our `pnpm-workspace.yaml` uses pnpm@10-only
  fields (`onlyBuiltDependencies`, `minimumReleaseAge`). pnpm@9 errors out.
  **Tried first:** `installCommand` override in `vercel.json` — community reports it's
  unreliable, deploy still failed.
  **Working fix:** Vercel UI env var `ENABLE_EXPERIMENTAL_COREPACK=1`. Combined with
  `packageManager: pnpm@10.29.3` in `package.json`, Vercel reads packageManager from
  package.json and downloads pnpm@10.29.3 via corepack. Deploy log confirms:
  `Detected ENABLE_EXPERIMENTAL_COREPACK=1 and "pnpm@10.29.3" in package.json`.
- **CI `pnpm install --strict-peer-dependencies` failed** on React 19 vs old transitive
  deps (react-body-classname, react-side-effect, react-lazy-images all want React ≤18).
  **Fix:** dropped `--strict-peer-dependencies`. Warnings remain; functionally fine.
- **CI `eslint.config.js` import broken** → after dropping our extra eslint deps, our
  custom `eslint.config.js` (from local commit `e3cb7b9`) couldn't resolve `@eslint/js`.
  **Fix:** took upstream's `eslint.config.js` which uses `@fisch0920/config/eslint`.
- **CI `pnpm build` step also hit Notion 429** from shared GitHub Actions IPs. Vercel's
  IPs are less throttled. **Fix:** dropped `pnpm build` from CI workflow entirely. CI
  does lint + prettier only; Vercel runs the real build.

### Result

PR #2 merged at `8d76639` on 2026-05-03 13:56 UTC. Production at `boklanov.com` deployed
green for the first time in 215 days.

---

## Step 2 — R2 caching ✅ DONE (PRs #3 + #4)

### PR #3 — preview-image LQIP cache

`lib/db.ts` rewritten so when `R2_*` env vars are set, the cache layer routes through
Cloudflare R2 (via `@aws-sdk/client-s3`) instead of in-memory Keyv. Public interface
unchanged: `db.get(key)` / `db.set(key, value)`. Hash keys with sha256 under prefix
`cache/preview/`. Flipped `isPreviewImageSupportEnabled: true`. Merged at `3d58cdf`.

### PR #4 — OG card cache + R2 client de-duplication

`pages/api/social-image.tsx`: cache rendered PNG bytes in R2 keyed by
`sha256("v1:" + pageId)`. Hit returns bytes immediately with `x-og-cache: hit` (no
Notion call, no render). Miss renders, buffers to `Uint8Array`, fire-and-forget puts
to R2. `Cache-Control: public, max-age=0, s-maxage=86400, stale-while-revalidate=2592000`.

Also extracted `lib/r2.ts` as the single R2 client + binary helper module
(`getR2Bytes`, `putR2Bytes`, `r2Key`, `isR2Enabled`). `lib/db.ts` rebased onto
`lib/r2.ts`, dropping its duplicate `S3Client` setup. Merged at `fa50a22`.

### Step 3.1 — `next/image remotePatterns`

R2 hostname `pub-eaffa56b38f2484cb3a48ab54ac582b0.r2.dev` added to
`next.config.js images.remotePatterns`. Landed inside PR #2.

### Vercel env vars (already set)

- `R2_ACCOUNT_ID`
- `R2_BUCKET` = `boklanov-content`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `NEXT_PUBLIC_CDN_BASE` = `https://pub-eaffa56b38f2484cb3a48ab54ac582b0.r2.dev`
- `ENABLE_EXPERIMENTAL_COREPACK` = `1`

---

## Step 3 — Runtime stability ⏳ IN PROGRESS (PR #5)

After PR #4 merged, production at `boklanov.com` started 404'ing on most slugs with:

```
Vercel Runtime Timeout Error: Task timed out after 10 seconds
Notion 429 Too Many Requests
"Notion Page Not Found"
```

Two compounding root causes:

### 1. Vercel function 10s legacy timeout

Vercel's Hobby plan has two function modes:
- **Fluid compute (new default)** — Hobby: 300s default, 300s max.
- **Legacy serverless** — 10s default and the only mode for projects created before
  fluid compute rolled out.

This project was created May 2023 → legacy mode → functions die at 10s. Notion's
`loadPageChunk` for the heavy home page (1.08 MB recordMap) routinely takes longer.
Our `ofetch` `timeout: 30_000` was moot — Vercel killed the function first.

**Attempted:** `export const config = { maxDuration: 60 }` in `pages/[pageId].tsx`
and `pages/index.tsx`. **Did not work.** Per Vercel docs, this syntax only takes
effect for **API routes** on Pages Router, not for SSG pages with `getStaticProps`.

**Working fix (`vercel.json` `functions` block):**

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "functions": {
    "pages/index.tsx":     { "maxDuration": 300 },
    "pages/[pageId].tsx":  { "maxDuration": 300 },
    "pages/api/social-image.tsx": { "maxDuration": 60 }
  }
}
```

This is the documented path for Pages Router SSG pages. Bumped to 300 (Hobby
fluid-compute max) since fluid mode treats Vercel time as wall-clock-not-CPU, so
generous numbers cost nothing for most invocations.

### 2. Soft-fail to `notFound: true` committed 404s to ISR cache

The build-resilience patch from Step 1 returned `{ notFound: true, revalidate: 30 }`
when `getStaticProps` errored. Worked at build time. **Wrong at runtime ISR** — the
404 gets cached for the revalidate window; visitors see "Notion Page Not Found"
stuck for 30s+ even though Notion was just transiently rate-limited.

**Right pattern:** during runtime ISR regeneration, throw on error. Next preserves
the **last-known-good** static snapshot and continues serving it. Build phase still
needs the soft-fail or the export dies on a single bad page.

**Fix (gate by `NEXT_PHASE`):**

```ts
} catch (err) {
  console.error('page error', domain, rawPageId, err)
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return { notFound: true, revalidate: 60 }
  }
  throw err  // runtime ISR — preserve last good snapshot
}
```

Also bumped `revalidate: 10` → `revalidate: 60`. 6× fewer regenerations means
6× fewer Notion calls, fewer 429s.

### Status

PR #5 (`fix/runtime-isr-resilience`, latest commit `6677291`) is open against `main`,
not yet merged. Until merged, production stays broken with the symptoms above.

---

## Branch & PR ledger

| PR | Title | Base | Merge commit | Status |
|---|---|---|---|---|
| #1 | Update main (auto-PR) | — | — | CLOSED |
| #2 | Sync upstream feb-2026 + fix Vercel production build | main | `8d76639` | ✅ MERGED |
| #3 | feat: R2-backed preview-image cache | main | `3d58cdf` | ✅ MERGED |
| #4 | feat: R2 cache for /api/social-image OG cards | main | `fa50a22` | ✅ MERGED |
| #5 | fix: runtime ISR resilience — maxDuration + throw on regen | main | — | ⏳ OPEN |

---

## Open issues (after PR #5 merges)

### A. Notion 429s still happen, just hidden by stale-while-revalidate

PR #5 prevents 429s from being **visible** to users, but Notion will still rate-limit
during background regeneration. The site stays up because we serve stale; eventually
content goes longer between updates than it should.

**Two real fixes**, ranked by payoff:

1. **R2 recordMap cache** (recommended next step). Same pattern as the OG cache. After
   each successful `notion.getPage`, write the recordMap to R2 keyed by pageId. On
   Notion 429, `getPage` falls through to R2. Notion 429s become invisible to the
   site. ~½ day of work; new file `lib/r2-recordmap-cache.ts` + small wiring in
   `lib/notion.ts`.
2. **`NOTION_API_KEY`** env var passed to `notion-client` constructor. Lifts the
   rate-limit ceiling significantly. Trade-off: adds a Notion integration token to
   Vercel env vars; needs the Notion workspace owner to provision it.

### B. Cache warming after each deploy

First visitor to a slug after deploy still triggers an ISR build (5–15s wait). A
Vercel Cron hitting `/`, `/English`, `/Контакты`, plus the top production slugs
post-deploy would prebuild ISR pages and eliminate that wait.

Out of scope for now; revisit if Roman or visitors notice the cold-start latency.

### C. Multi-lockfile warning (cosmetic)

```
We detected multiple lockfiles and selected /home/octrow/pnpm-lock.yaml as root
```

Stray `pnpm-lock.yaml` at `$HOME`. Either delete it or set `outputFileTracingRoot`
in `next.config.js`. Doesn't affect builds.

### D. `data for page "/" is 1.08 MB`

Home page Notion recordMap is heavy. Next.js warns >128 KB. Not a deploy-breaker,
just a perf note. The actual fix is restructuring the Notion home page to be
smaller, which is content work, not code work.

### E. Branch hygiene

Local `main` and `update-main` branches drifted across the work. After PR #5 lands,
align them so future PRs aren't reasoning about both.

### F. PRE-THEATRE / Bury-Me / Aiaccio prerender 429s on every deploy

Same ~5-10 slugs hit Notion 429 during each build. They render via fallback later,
but each deploy emits the same `skipping page` warnings. Notion auth (option A2 above)
makes this go away.

---

## Decisional log (things I tried that did not work)

| Attempt | Why it didn't work | What did work |
|---|---|---|
| `installCommand` override in `vercel.json` (force pnpm@10) | Vercel ignores `installCommand` in some configurations (community.vercel.com/t/30118) | `ENABLE_EXPERIMENTAL_COREPACK=1` env var |
| Manual retry wrapper around `notion.getPage` (kyOptions, 30s timeout, 3× exponential backoff) | Worked, then became redundant when notion-client moved to ofetch which has built-in retry | Native `ofetchOptions: { retry, retryDelay, retryStatusCodes }` |
| `throw err` on prerender error during build | Killed the whole build on a single rate-limited page | Soft-fail at build phase (`notFound + revalidate`), throw at runtime; gate by `NEXT_PHASE` |
| `notFound: true` on runtime ISR error | Committed 404 to cache for the revalidate window — visitors saw "Notion Page Not Found" stuck | Throw on runtime ISR — Next preserves last-good snapshot |
| `export const config = { maxDuration: 60 }` on `pages/[pageId].tsx` | Per Vercel docs, only takes effect for API routes on Pages Router, not SSG pages | `vercel.json` `functions` block |
| Edge runtime on `/api/social-image` | 1.04 MB exceeded Hobby Edge 1 MB cap (inter-semibold font) | Node runtime (no cap; `next/og` works fine) |
| CI `pnpm install --strict-peer-dependencies` | React 19 trips peer warnings on react-body-classname / react-side-effect / react-lazy-images | Drop the flag |
| CI `pnpm build` | GitHub Actions shared IPs hit Notion 429 hard | Drop the build step from CI; Vercel does the real build |

---

## Final shape

After PR #5 merges, the cutover is structurally complete:

- Vercel production at `boklanov.com` deploys green from `main`.
- Notion 429s are absorbed at build (skip-and-ISR) and at runtime (stale-while-revalidate).
- R2 backs both LQIP preview images and OG card PNGs, surviving across deploys with zero
  egress.
- `next/image` allowed to load directly from the R2 public bucket.
- Functions run up to 300s on Hobby fluid compute.
- CI runs lint+prettier on every push (no Notion calls).

Remaining work is **optional polish** (recordMap R2 cache, Notion auth, cache warming,
branch cleanup) — none of it gates production health, all of it improves edge cases.
