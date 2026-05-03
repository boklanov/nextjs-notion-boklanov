# Restart prompt — paste this into a fresh Claude chat

---

Site is down: production at `boklanov.com` returns 404 "Notion Page Not Found"
on most slugs. Read `PLAN_VERCEL_CUTOVER.md` first — it has full context, what's
been tried, what shipped (PRs #2–#6 all merged), and what's left.

**The fix to ship:** Option A in the plan — R2 recordMap cache. After every
successful `notion.getPage`, write the recordMap to R2; on Notion 429/timeout
during runtime ISR regeneration, fall back to the R2 snapshot.

The R2 client + binary helpers (`getR2Bytes`, `putR2Bytes`, `r2Key`) already
exist in `lib/r2.ts` from PR #4. The pattern to copy is `pages/api/social-image.tsx`
which uses the same R2 cache pattern for OG card PNGs.

Edits land in `lib/notion.ts` (the `getPage` function around line 45). Cache key
prefix `cache/recordmap/`. TTL: none — overwritten on next successful fetch.

Open as a new PR off `main` (recent merged PRs: #2 `8d76639`, #3 `3d58cdf`,
#4 `fa50a22`, #5 `9698954`, #6 `4948a81`). Vercel env vars `R2_ACCOUNT_ID`,
`R2_BUCKET=boklanov-content`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`ENABLE_EXPERIMENTAL_COREPACK=1` are all set in production.

Constraints:
- Hobby plan, 60s function cap (rejected 300s with "must be between 1 and 60").
- pnpm 10.29.3 via corepack (don't touch the install path).
- Pages Router with `getStaticProps` + `fallback: true` + ISR.
- Don't add/swap deps unless necessary; `@aws-sdk/client-s3` already pinned.
