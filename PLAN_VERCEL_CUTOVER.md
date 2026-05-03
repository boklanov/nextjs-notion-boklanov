# PLAN — Fix Vercel build for boklanov.com (legacy Notion site)

Date: 2026-05-03 · Owner: Daniil · Repo: `boklanov/nextjs-notion-boklanov` · Branch: `update-main`

Three steps, in order: **(1) sync from upstream** → **(2) fix remaining issues** → **(3) wire R2 for images**.

## State as of 2026-05-03

- `.env` removed from git tracking ✓
- Vercel env vars added (`R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `NEXT_PUBLIC_CDN_BASE`, `ENABLE_EXPERIMENTAL_COREPACK=1`) ✓
- **Step 1 DONE** — `sync/upstream-2026-05` branch merged ~20 commits from `upstream/main`. Conflicts in `next.config.js`, `package.json`, `pnpm-lock.yaml` resolved. Local boklanov identity preserved.
- **Step 2 DONE** — `pnpm build` passes both locally and on Vercel. Required fixes after sync:
  - `kyOptions` → `ofetchOptions` (notion-client 7.10 migrated to ofetch)
  - Use ofetch built-in retry (3× with 2s base delay, retry on 408/409/425/429/5xx)
  - Tolerate missing `recordMap` in `getAllPagesImpl` (skip page from static path list, ISR rebuilds)
  - Soft-fail on `pages/index.tsx` and `pages/[pageId].tsx` (return `notFound + revalidate` instead of throwing)
  - Drop `eslint` key from `next.config.js` (Next 16 removed support)
  - `pages/api/social-image.tsx`: drop `runtime = 'edge'` (1 MB Hobby plan cap; Node runtime is fine)
  - CI: drop `pnpm build` step (GHA shared IPs hit Notion 429 hard); CI does lint + prettier only
- **Step 3.1 DONE** — R2 hostname added to `next.config.js images.remotePatterns`.
- **PR #2 MERGED** to `main` as `8d76639` on 2026-05-03 13:56 UTC. Vercel preview `8JFAZ9Qe1YJmnKvpJsQMppaGuY4D` deployed clean in 1m39s. Production deploy from new `main` triggered automatically.

## Known runtime behaviour after deploy

Notion still rate-limits a handful of pages during each Vercel build (429s on `/api/v3/loadPageChunk`). Build absorbs them; affected slugs render via ISR on first request:
- First visit to a rate-limited slug: ~5–15s wait while `getStaticProps` runs.
- Subsequent visits: instant from cache (10/30/60s revalidate windows).
- Visitor hits `/` during the 30s ISR window for the home page: 404 until ISR re-runs.

Mitigations available if 429s become user-visible:
1. **Notion auth** — set `NOTION_API_KEY` env var, pass to `notion-client` constructor. Lifts rate-limit ceiling significantly.
2. **Cache warming** — Vercel Cron or scheduled function hitting `/`, `/English`, `/Контакты`, plus the production slugs after each deploy.
3. **R2 preview-image cache** (Step 3.2) — also reduces inflight Notion requests because LQIPs are no longer regenerated each build.

## Step 1 — Sync from upstream `transitive-bullshit/nextjs-notion-starter-kit`

`git fetch upstream` already done. Gap: ~20 commits including the relevant ones:

```
379c735 ⏭
0eadf00 feat: update react-notion-x                                 ← likely fixes replaceAll
484c14a feat: remove react-icons in favor of local icons            ← removes @react-icons/all-files DEP0128 warning
d2f1117 Merge PR #748 feature/update-feb-2026
7978cd6 feat: update core deps
0750da9 Merge PR #742 fix/static-paths-url-overrides
97b8dd2 fix: include pageUrlOverrides in getStaticPaths for prod
68af398 fix: upgrade notion-client to fix collection issues
```

Last common commit: `668c521`. Local fork commits since then:

```
83008f2 fix
e3cb7b9 fix
53790dd merge/update
bf795b7 fix: collection / database loading
```

These four are the fork's local divergence. They're titled vaguely; before merging, look at what they actually change so we know what to preserve through the merge.

### Step 1.1 — Inspect local divergence

```bash
git log 668c521..update-main --oneline
git diff 668c521..update-main -- site.config.ts                  # site identity
git diff 668c521..update-main -- styles/notion.css               # visual customisation
git diff 668c521..update-main -- components/                     # component overrides
git diff 668c521..update-main -- lib/                            # behaviour overrides
```

Expected boklanov-specific diffs to preserve:
- `site.config.ts` — `name`, `domain`, `rootNotionPageId`, `description`, `navigationLinks`
- `components/NotionPageHeader.tsx` if customised
- Any palette / typography overrides in `styles/notion.css`

The four local fork commits (`bf795b7 fix: collection/database loading` etc.) likely overlap with upstream's `68af398 fix: upgrade notion-client to fix collection issues` and `97b8dd2 fix: include pageUrlOverrides in getStaticPaths`. After upstream merge, audit whether the local `fix` commits are still needed; if upstream's solution is cleaner, drop ours.

### Step 1.2 — Merge

```bash
git checkout -b sync/upstream-2026-05
git merge upstream/main
# Conflicts expected in: site.config.ts, package.json, possibly pnpm-lock.yaml
# Resolution rule: take upstream for everything except boklanov-specific identity
#   (name, domain, rootNotionPageId, navigationLinks)
```

After conflict resolution:

```bash
pnpm install                              # bumps + new react-notion-x
rm -rf .next node_modules/.cache          # clean any stale React-18 artifacts
pnpm exec tsc --noEmit                    # confirm types still align
pnpm build                                # the test that matters
```

### Step 1.3 — Re-evaluate the local Notion-timeout patches

After merge, check:

```bash
git diff HEAD -- lib/notion.ts pages/[pageId].tsx
```

Three possibilities:
- (a) Upstream now does the same thing → drop our patches, keep upstream.
- (b) Upstream still has bare `notion.getPage(pageId)` → keep our `getPageWithRetry` wrapper + soft-fail.
- (c) Upstream did something different (e.g., relocated retry logic) → adopt upstream's pattern; drop ours.

The patches we made:
- `lib/notion.ts`: `getPageWithRetry` wrapper, 30s timeout, 3× exponential backoff
- `pages/[pageId].tsx`: catch → `{ notFound: true, revalidate: 60 }` instead of `throw err`

## Step 2 — Fix remaining issues

After step 1's `pnpm build`, the surviving error list defines step 2.

### Step 2.1 — `replaceAll on undefined` (current blocker before sync)

Already triaged. Source: `notion-utils` `uuidToId` / `getCanonicalPageId` family is being called with `undefined` somewhere inside `react-notion-x` rendering. React 19 + outdated `react-notion-x` is the suspect. Upstream's `0eadf00 feat: update react-notion-x` should resolve. If not:
- Pin React to 18.3.x temporarily: `pnpm add react@^18.3 react-dom@^18.3 -E`. Trade-off: gives up React 19 features; safe for a Notion-rendered marketing site.
- Or upgrade `react-notion-x` directly: `pnpm up react-notion-x@latest notion-client@latest notion-types@latest notion-utils@latest`.

### Step 2.2 — `Module not found: 'katex/dist/katex.min.css'`

Already fixed locally — `pnpm add katex` added `katex@0.16.45`. The starter kit imports `katex/dist/katex.min.css` in `pages/_app.tsx:2` but didn't declare `katex` as a direct dep; pnpm's strict resolution doesn't hoist it. Keep this dep in `package.json` even after upstream sync — upstream may or may not have added it.

### Step 2.3 — Multi-lockfile warning

```
We detected multiple lockfiles and selected /home/octrow/pnpm-lock.yaml as root
```

There's a stray `pnpm-lock.yaml` at `/home/octrow/`. Either delete it (if it's a leftover from running pnpm in `$HOME` once), or pin our project root in `next.config.js`:

```js
// next.config.js
const nextConfig = {
  outputFileTracingRoot: __dirname,
  // ...rest
}
```

Cosmetic; not a build-breaker. Do at end if time.

### Step 2.4 — `@react-icons/all-files` DEP0128 deprecation spam

Upstream commit `484c14a feat: remove react-icons in favor of local icons` already addresses this — it should disappear after step 1.

### Step 2.5 — Vercel build verification

After local `pnpm build` is green:

```bash
git checkout -b fix/notion-build
git push -u origin fix/notion-build
# open PR → watch Vercel preview → if green, merge to main
```

Confirm Vercel project's "Production Branch" — currently `main`, not `update-main`. After merge to `main`, production deploy at `boklanov.com` should turn green.

## Step 3 — Wire Cloudflare R2 for images

The R2 bucket `boklanov-content` (300 objects, 222 MB) is already populated. Five integration points, ranked by payoff. Pick what you need; each is independent.

Env vars (already set in Vercel + locally in `.env.local`):
- `R2_ACCOUNT_ID` — `534e18f36968949bf03935b0d40b0216`
- `R2_BUCKET` — `boklanov-content`
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — for S3-compatible writes/reads
- `NEXT_PUBLIC_CDN_BASE` — `https://pub-eaffa56b38f2484cb3a48ab54ac582b0.r2.dev` (public read URL; safe to expose)

### Step 3.1 — Allow `next/image` to load from R2 (5-minute change, do first)

Edit `next.config.js`:

```js
images: {
  remotePatterns: [
    {
      protocol: 'https',
      hostname: 'pub-eaffa56b38f2484cb3a48ab54ac582b0.r2.dev',
      pathname: '/**'
    },
    // when cdn.boklanov.com goes live behind Cloudflare, add it here too:
    // { protocol: 'https', hostname: 'cdn.boklanov.com', pathname: '/**' }
  ]
}
```

After this, anywhere we render an `<Image src={...}/>` with an R2 URL, `next/image` will optimise it.

### Step 3.2 — Persistent preview-image cache (highest payoff)

`isPreviewImageSupportEnabled: false` in `site.config.ts:34`. Turning it on triggers `getPreviewImageMap` (`lib/preview-images.ts`) which generates LQIP placeholders. The current cache layer (`lib/db.ts`) uses `@keyvhq/redis`, currently disabled.

Migrate the cache to R2 instead:

1. Add deps: `pnpm add @aws-sdk/client-s3`
2. New file `lib/r2-cache.ts`:
   ```ts
   import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'

   const r2 = new S3Client({
     region: 'auto',
     endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
     credentials: {
       accessKeyId: process.env.R2_ACCESS_KEY_ID!,
       secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!
     }
   })

   const bucket = process.env.R2_BUCKET!

   export async function getCached(key: string): Promise<string | null> { /* GetObject → text or null on 404 */ }
   export async function setCached(key: string, value: string, contentType = 'text/plain'): Promise<void> { /* PutObject */ }
   ```
3. Hash-key strategy: `cache/preview/${sha256(notionImageUrl)}.b64` so keys are deterministic, immutable, and live under a known prefix that won't collide with content photos.
4. Wire into `lib/preview-images.ts` (or `lib/db.ts`) — read R2 first, fall through to live LQIP generation, write back to R2.
5. Flip `isPreviewImageSupportEnabled: true` in `site.config.ts`.

Egress is free, build time is bounded by R2 read latency (~50ms warm), and the cache survives across deploys.

### Step 3.3 — Cache OG / social images

If/when this fork has an OG endpoint (`pages/api/social-image.tsx` in some forks), apply the same R2 cache pattern keyed by `cache/og/${sha256(slug + locale)}.png`. Defer until that endpoint actually exists in this fork.

### Step 3.4 — Static asset hosting for custom imagery

For any image outside the Notion content tree (footer portrait, fallback covers, custom hero on `/`), upload to R2 once and reference via `https://pub-eaffa56b38f2484cb3a48ab54ac582b0.r2.dev/<path>`. Combined with §3.1's `remotePatterns`, `next/image` will optimise them.

Upload script suggestion (`scripts/upload-r2.mjs` — only if you want a CLI; manual upload via Cloudflare dashboard is fine for one-offs):

```js
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import fs from 'node:fs'
import path from 'node:path'
// reads from process.env, walks an arg directory, uploads with mime type
```

### Step 3.5 — Rewrite Notion image proxy through R2 (advanced, optional)

`react-notion-x` proxies Notion image URLs through `/api/notion-images` to bypass Notion's signed-URL expiry. Replacing this with a "fetch-once-from-Notion-cache-on-R2" endpoint would:
- Eliminate the `loadPageChunk` timeout class of build failures (page renders no longer block on Notion's image CDN).
- Remove dependency on Notion's signed URLs entirely.

Cost: a non-trivial new endpoint + cache invalidation strategy when Roman swaps an image in Notion. Don't do this until §3.2 is in place and proven.

## Sequence

1. **Step 1.1 inspect** local commits (15 min) — understand what we have.
2. **Step 1.2 merge** upstream (30 min – 2 h depending on conflicts).
3. **Step 1.3 + Step 2.1 build** (30 min) — does `pnpm build` go green?
   - If yes → step 2.5 deploy.
   - If no → fix (likely React pin or `react-notion-x` direct upgrade), then step 2.5.
4. **Step 2.5 deploy** to Vercel preview → verify → merge to `main`.
5. **Step 3.1** R2 `remotePatterns` — quick win, separate small PR.
6. **Step 3.2** preview-image R2 cache — separate PR, 1 day, only if preview images are wanted.
7. Steps 3.3–3.5 — opt-in.

End-to-end estimate: half a day to green Vercel (steps 1+2), one more day if §3.2 ships.
## What this plan deliberately doesn't do

- Touch the v3 rewrite in `/home/octrow/develompent/boklanov`. Out of scope.
- Migrate this site off Notion. Notion-as-CMS stays.
- Set up Redis. R2 replaces Redis as the cache layer per §3.2.
- Build new components or routes. Pure plumbing + dep hygiene.
