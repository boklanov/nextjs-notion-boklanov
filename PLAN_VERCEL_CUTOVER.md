# PLAN — Fix Vercel deployment for boklanov.com

Repo: `boklanov/nextjs-notion-boklanov` · Owner: Daniil

---

## 🚨 Current state — SITE STILL DOWN

Production at `boklanov.com` returns **404 "Notion Page Not Found"** on most slugs.
PRs #2 → #6 all merged. Build succeeds. 60s function timeout in place. Still broken.

### Why timeouts alone don't fix it

PR #6 raised the Vercel function cap to 60s (Hobby plan max). That's enough time
for most successful Notion responses. **But it does not solve Notion 429s.**

Sequence on first visit to a slug after deploy:
1. Build skipped this slug because it 429'd → no static HTML cached.
2. First visitor triggers `getStaticProps` → Notion returns 429.
3. Our runtime catch throws → no last-known-good snapshot exists → renders as 404.
4. ISR retries every 60s but Notion keeps 429-ing → 404 stays.

The site has **no fallback data path**. Every render attempts a fresh Notion call.

---

## ✅ What's already done

| PR | Merged at | What |
|---|---|---|
| #2 | `8d76639` | Upstream sync (Feb 2026), Vercel build green, R2 host in `next.config.js` |
| #3 | `3d58cdf` | R2-backed preview-image LQIP cache (`lib/db.ts` + `lib/r2.ts`) |
| #4 | `fa50a22` | R2 cache for `/api/social-image` OG cards |
| #5 | `9698954` | Throw on runtime ISR error (revalidate 60, soft-fail at build only) |
| #6 | `4948a81` | `vercel.json` `functions` block with `maxDuration: 60` |

### Vercel env vars (all set)

- `R2_ACCOUNT_ID`, `R2_BUCKET=boklanov-content`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
- `NEXT_PUBLIC_CDN_BASE` = `https://pub-eaffa56b38f2484cb3a48ab54ac582b0.r2.dev`
- `ENABLE_EXPERIMENTAL_COREPACK=1`

### Vercel plan

Hobby. `maxDuration` capped at 60s. Pro raises this to 300s but that's not on the table.

---

## 🔧 The only thing that will fix the site — Option A

### R2 recordMap cache (~½ day, single PR)

Cache full Notion recordMaps to R2 keyed by pageId. On every successful
`notion.getPage`, write the recordMap to R2. On Notion 429/timeout/error during
ISR regeneration, **fall back to the R2 snapshot** (even if old).

Result: Notion 429s become invisible to visitors. After the first deploy that
populates R2, the site stays up regardless of Notion's mood — every page has a
fallback.

**Implementation sketch:**
- New `lib/notion-recordmap-cache.ts` using existing `lib/r2.ts` helpers
  (`getR2Bytes`, `putR2Bytes`, `r2Key` already shipped in PR #4).
- Modify `lib/notion.ts` `getPage`:
  ```ts
  try {
    const recordMap = await notion.getPage(pageId, { ofetchOptions: ROBUST })
    putR2Bytes(r2Key('cache/recordmap/', pageId, 'json'),
               new TextEncoder().encode(JSON.stringify(recordMap)),
               'application/json').catch(() => {}) // fire-and-forget
    return recordMap
  } catch (err) {
    const cached = await getR2Bytes(r2Key('cache/recordmap/', pageId, 'json'))
    if (cached) {
      console.warn('notion getPage failed, serving R2 cache for', pageId)
      return JSON.parse(new TextDecoder().decode(cached))
    }
    throw err
  }
  ```
- Cache key: `cache/recordmap/{sha256(pageId)}.json`
- TTL: none — overwritten on next successful Notion fetch.
- Same pattern as the OG cache (PR #4); reuses the R2 client already in `lib/r2.ts`.

**Edge cases to handle:**
- Cold deploy on a fresh R2 bucket prefix → first build still has to hit Notion
  successfully at least once per slug. The build-phase soft-fail (skip rate-limited
  pages from `getStaticPaths`) means uncached slugs may still 404 on first deploy.
- `recordMap` JSON for the home page is ~1 MB — fits comfortably in R2 PUT, but
  watch S3 cost / latency at scale.

---

## 🥈 Optional, lower-priority

- **Notion API key** (`NOTION_API_KEY` env var) — higher rate limit. Trade-off:
  `react-notion-x` uses Notion's *unofficial* API surface; the official integration
  token may not apply. Verify before relying on it.
- **Vercel Cron cache-warming** post-deploy — hits `/`, `/English`, `/Контакты`, plus
  top slugs to prebuild ISR pages. Best paired with Option A; doesn't solve anything
  on its own.

---

## 📂 Reference — files / config

- `lib/notion.ts` — Notion API wrapper, ofetch retry config (where Option A goes)
- `lib/r2.ts` — shared R2 client + binary helpers (`getR2Bytes`, `putR2Bytes`, `r2Key`)
- `lib/db.ts` — preview-image cache layer (PR #3, on R2)
- `pages/api/social-image.tsx` — OG endpoint with R2 cache (PR #4 reference impl)
- `pages/index.tsx`, `pages/[pageId].tsx` — phase-aware error handling, `revalidate: 60`,
  `export const config = { maxDuration: 60 }`
- `vercel.json` — `functions` block: `maxDuration: 60` for SSG pages
- `next.config.js` — R2 host in `images.remotePatterns`
- `site.config.ts` — `isPreviewImageSupportEnabled: true`
- `.github/workflows/build.yml` — CI runs lint + prettier only

---

## 🚫 Out of scope / deferred

- Multi-lockfile warning (`/home/octrow/pnpm-lock.yaml`) — cosmetic
- Home page recordMap is 1.08 MB (Next warns >128 KB) — content/Notion-page work
- Local `main` ↔ `update-main` branch hygiene — cleanup after Option A
- Pro plan upgrade for 300s `maxDuration` — would help but not necessary; 60s is enough
  *if* Option A absorbs Notion 429s
