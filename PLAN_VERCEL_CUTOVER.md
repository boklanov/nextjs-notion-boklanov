# PLAN — Fix Vercel deployment for boklanov.com

Repo: `boklanov/nextjs-notion-boklanov` · Owner: Daniil

---

## 🚨 Current state — SITE IS DOWN

Production at `boklanov.com` returns **404 "Notion Page Not Found"** on most slugs.
Every PR (#2 → #5) merged. Every deploy green. Build succeeds. Runtime breaks.

### Latest production log pattern (2026-05-03 19:44 UTC)

```
GET 404 /                           ← intermittent
GET 200 /                           ← sometimes works
GET 404 /roman-boklanov-english     ← Vercel Runtime Timeout 10s
GET 404 /Online                     ← Notion 429 Too Many Requests
GET 404 /The-Ape-Star
GET 404 /Bury-Me-Behind-the-Baseboard
```

### Root cause

PR #5 said "throw on runtime ISR error → Next preserves last-known-good snapshot."
Two reasons it doesn't help in practice:

1. **`vercel.json` `functions` block was never deployed** — the merge of PR #5
   captured only the first commit (`058db45`), missing the follow-up commit
   `6677291` that added `vercel.json`. Production has zero `maxDuration`
   override — still on legacy 10s cap. **Fix: PR #6 (open).**
2. **Even after the timeout fix, Notion 429s on first-visit slugs return error**
   → no "last good snapshot" exists yet → renders as 404. The real fix is to
   serve build-time recordMaps from R2 when Notion is rate-limited at runtime.
   **Fix: Option A below.**

---

## ✅ What's already done

| PR | Merged at | What |
|---|---|---|
| #2 | `8d76639` | Upstream sync (Feb 2026), Vercel build green, R2 host in `next.config.js` |
| #3 | `3d58cdf` | R2-backed preview-image LQIP cache (`lib/db.ts` + `lib/r2.ts`) |
| #4 | `fa50a22` | R2 cache for `/api/social-image` OG cards |
| #5 | `9698954` | Throw on runtime ISR error (only — vercel.json missed the merge window) |

### Vercel env vars (all set)

- `R2_ACCOUNT_ID`, `R2_BUCKET=boklanov-content`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
- `NEXT_PUBLIC_CDN_BASE` = `https://pub-eaffa56b38f2484cb3a48ab54ac582b0.r2.dev`
- `ENABLE_EXPERIMENTAL_COREPACK=1`

---

## 🔧 What needs to ship next

### PR #6 — vercel.json + maxDuration 60 (OPEN, immediate)

The PR #5 follow-up that missed the merge. Adds:

```json
{
  "functions": {
    "pages/index.tsx":            { "maxDuration": 60 },
    "pages/[pageId].tsx":         { "maxDuration": 60 },
    "pages/api/social-image.tsx": { "maxDuration": 60 }
  }
}
```

60s is the current Hobby plan cap (300 was rejected with
`The value for maxDuration must be between 1 second and 60 seconds, in order to increase this limit upgrade your plan`).
Without this, Vercel kills the function at the legacy 10s default — no time for
Notion's `loadPageChunk` on the heavy home page.

### Option A — R2 recordMap cache (RECOMMENDED, ~½ day)

Cache full Notion recordMaps to R2 keyed by pageId. Build-time successes write to R2.
Runtime ISR reads R2 first; only hits Notion if cache is stale; on Notion 429, falls
through to the R2 snapshot.

Result: Notion 429s become invisible to visitors. First visit to any slug serves
R2-cached HTML in <500ms instead of timing out → 404.

**Implementation sketch:**
- New `lib/notion-recordmap-cache.ts` using existing `lib/r2.ts` helpers
- Wrap `notion.getPage(pageId)` in `lib/notion.ts`:
  - Try Notion → success: write to R2, return result
  - Notion fails (429/timeout): read R2 → if hit, return cached recordMap; else throw
- Cache key: `cache/recordmap/{sha256(pageId)}.json`
- TTL: none (overwritten on next successful Notion fetch)

Same pattern as the OG cache (PR #4), just for the page payload.

### Option B — Notion API key (~10 min, partial fix)

Set `NOTION_API_KEY` env var; pass to `notion-client` in `lib/notion-api.ts`.
Authenticated requests have higher rate limits. Trade-off: `react-notion-x` uses
Notion's *unofficial* API surface, so the official key may not apply — needs verification.

### Option C — Pre-warm cache after each deploy (~1 hour, additive)

Vercel Cron hits `/`, `/English`, `/Контакты`, plus the production slugs immediately
after each deploy so first real visitors don't trigger cold ISR. Best paired with Option A.

---

## 🎯 Recommended path

1. **Merge PR #6** to land `vercel.json` (kills the 10s timeout). Site partially recovers
   for slugs that were prerendered at build.
2. **Ship Option A** (R2 recordMap cache). Site fully recovers — Notion 429s become
   invisible. Independent of B/C.
3. Optional: Option B if Notion auth turns out to apply.
4. Optional: Option C for sub-second first-visit latency.

---

## 📂 Reference — files touched / configured

- `lib/notion.ts` — Notion API wrapper, ofetch retry config (where Option A goes)
- `lib/r2.ts` — shared R2 client + binary helpers (`getR2Bytes`, `putR2Bytes`, `r2Key`)
- `lib/db.ts` — preview-image cache (PR #3, on R2)
- `pages/api/social-image.tsx` — OG endpoint with R2 cache (PR #4)
- `pages/index.tsx`, `pages/[pageId].tsx` — phase-aware error handling, `revalidate: 60`
- `vercel.json` — `functions` block sets `maxDuration: 60` for SSG pages (PR #6)
- `next.config.js` — R2 host in `images.remotePatterns`
- `site.config.ts` — `isPreviewImageSupportEnabled: true`
- `.github/workflows/build.yml` — CI runs lint + prettier only (no `pnpm build`)

---

## 🚫 Out of scope / deferred

- Multi-lockfile warning (`/home/octrow/pnpm-lock.yaml`) — cosmetic
- Home page recordMap is 1.08 MB (Next warns >128 KB) — content/Notion-page work
- Local `main` ↔ `update-main` branch hygiene — cleanup after Option A lands
