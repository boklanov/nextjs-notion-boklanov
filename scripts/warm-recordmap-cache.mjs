#!/usr/bin/env node
/**
 * One-shot R2 recordMap cache warmer.
 *
 * Run from your laptop (non-Vercel IP — much higher Notion rate limit) to
 * populate the R2 recordMap cache for the page IDs you pass in. After this
 * runs successfully, lib/notion.ts:getPage will fall back to the cached
 * snapshots whenever Notion 429s a runtime ISR regen, and visitors stop
 * seeing "Notion Page Not Found".
 *
 * Usage:
 *   # Single page:
 *   node scripts/warm-recordmap-cache.mjs <pageId>
 *
 *   # All paths from a Vercel build log (paste the array Next.js prints):
 *   node scripts/warm-recordmap-cache.mjs id1 id2 id3 ...
 *
 *   # Read newline-separated IDs from stdin:
 *   cat ids.txt | node scripts/warm-recordmap-cache.mjs --stdin
 *
 * Requires R2_* + NOTION_TOKEN_V2 + NOTION_ACTIVE_USER env vars (same as
 * production reads). Loads from .env automatically with --env-file=.env.
 */
import { createHash } from 'node:crypto'

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { NotionAPI } from 'notion-client'
import { parsePageId } from 'notion-utils'

const accountId = process.env.R2_ACCOUNT_ID?.trim()
const bucket = process.env.R2_BUCKET?.trim()
const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim()
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim()
const authToken = process.env.NOTION_TOKEN_V2?.trim()
const activeUser = process.env.NOTION_ACTIVE_USER?.trim()

if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
  console.error('missing R2_* env vars')
  process.exit(2)
}
if (!authToken || !activeUser) {
  console.warn(
    'WARN: NOTION_TOKEN_V2 / NOTION_ACTIVE_USER unset — running anonymous, expect 429s'
  )
}

const PREFIX = process.env.R2_RECORDMAP_PREFIX ?? 'cache/recordmap/'
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey }
})
const notion = new NotionAPI({ authToken, activeUser })

const r2Key = (id) =>
  `${PREFIX}${createHash('sha256').update(id).digest('hex')}.json`

async function fetchAndCache(pageId) {
  const id = parsePageId(pageId)
  if (!id) return null
  process.stdout.write(`  ${id} ... `)
  const recordMap = await notion.getPage(id, { concurrency: 1 })
  await r2.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: r2Key(id),
      Body: new TextEncoder().encode(JSON.stringify(recordMap)),
      ContentType: 'application/json'
    })
  )
  console.log('cached')
  return recordMap
}

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  let ids
  if (process.argv.includes('--stdin')) {
    const text = await readStdin()
    ids = text.split(/[\s,]+/).filter(Boolean)
  } else {
    ids = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  }
  if (!ids.length) {
    console.error('Usage: node scripts/warm-recordmap-cache.mjs <pageId> [...]')
    console.error('   or: ... --stdin  (newline/comma-separated)')
    process.exit(2)
  }

  console.log(`Warming ${ids.length} page(s)...`)
  let ok = 0
  let fail = 0
  for (const id of ids) {
    try {
      await fetchAndCache(id)
      ok++
    } catch (err) {
      console.log('FAIL', err?.message?.slice(0, 80))
      fail++
    }
    await new Promise((r) => setTimeout(r, 350))
  }
  console.log(`\nDone. ${ok} cached, ${fail} failed.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
