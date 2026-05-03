#!/usr/bin/env node
/**
 * One-shot R2 recordMap cache warmer.
 *
 * Run from your laptop (non-Vercel IP — much higher Notion rate limit) to
 * populate the R2 recordMap cache. After this runs successfully,
 * lib/notion.ts:getPage will fall back to the cached snapshots whenever
 * Notion 429s a runtime ISR regen, and visitors stop seeing
 * "Notion Page Not Found".
 *
 * Usage:
 *   # Walk every page reachable from the root (recommended after deploy):
 *   node --env-file=.env scripts/warm-recordmap-cache.mjs --all
 *
 *   # Specific page IDs:
 *   node --env-file=.env scripts/warm-recordmap-cache.mjs <pageId> [<pageId> ...]
 *
 *   # Read newline/comma-separated IDs from stdin:
 *   cat ids.txt | node --env-file=.env scripts/warm-recordmap-cache.mjs --stdin
 *
 * Requires R2_* + NOTION_TOKEN_V2 + NOTION_ACTIVE_USER env vars (same as
 * production reads).
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { NotionAPI } from 'notion-client'
import { getAllPagesInSpace, parsePageId } from 'notion-utils'

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
    'WARN: NOTION_TOKEN_V2 / NOTION_ACTIVE_USER unset — running anonymous'
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

async function fetchPage(pageId) {
  return notion.getPage(pageId, { concurrency: 1 })
}

async function cache(pageId, recordMap) {
  await r2.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: r2Key(pageId),
      Body: new TextEncoder().encode(JSON.stringify(recordMap)),
      ContentType: 'application/json'
    })
  )
}

async function fetchAndCache(pageId) {
  const id = parsePageId(pageId)
  if (!id) return null
  process.stdout.write(`  ${id} ... `)
  const recordMap = await fetchPage(id)
  await cache(id, recordMap)
  console.log('cached')
  return recordMap
}

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

function readSiteRootId() {
  // site.config.ts is TypeScript; we can't import it from .mjs without tsx.
  // Parse rootNotionPageId out as a regex match — robust enough for a config file.
  const here = dirname(fileURLToPath(import.meta.url))
  const path = join(here, '..', 'site.config.ts')
  const src = readFileSync(path, 'utf8')
  const m = src.match(/rootNotionPageId:\s*['"]([0-9a-f]+)['"]/i)
  if (!m) throw new Error('could not read rootNotionPageId from site.config.ts')
  return m[1]
}

async function warmAll() {
  const root = readSiteRootId()
  console.log(`Walking from root ${root} (this can take a few minutes)...`)
  // Same call shape as lib/get-site-map.ts; concurrency=1 keeps Notion happy.
  const pageMap = await getAllPagesInSpace(root, undefined, fetchPage, {
    concurrency: 1,
    traverseCollections: true,
    maxDepth: 1
  })

  const ids = Object.keys(pageMap).filter((id) => pageMap[id])
  console.log(`Discovered ${ids.length} pages, caching to R2...`)

  let ok = 0
  let fail = 0
  for (const id of ids) {
    process.stdout.write(`  ${id} ... `)
    try {
      await cache(id, pageMap[id])
      console.log('cached')
      ok++
    } catch (err) {
      console.log('FAIL', err?.message?.slice(0, 80))
      fail++
    }
  }
  console.log(`\nDone. ${ok} cached, ${fail} failed.`)
}

async function warmExplicit(ids) {
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

async function main() {
  if (process.argv.includes('--all')) {
    await warmAll()
    return
  }

  let ids
  if (process.argv.includes('--stdin')) {
    const text = await readStdin()
    ids = text.split(/[\s,]+/).filter(Boolean)
  } else {
    ids = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  }
  if (!ids.length) {
    console.error('Usage:')
    console.error(
      '  node scripts/warm-recordmap-cache.mjs --all            # walk from root'
    )
    console.error(
      '  node scripts/warm-recordmap-cache.mjs <pageId> [...]   # explicit'
    )
    console.error(
      '  ... --stdin    # newline/comma-separated IDs on stdin'
    )
    process.exit(2)
  }
  await warmExplicit(ids)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
