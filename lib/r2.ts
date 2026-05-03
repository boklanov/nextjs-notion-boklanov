/**
 * Shared Cloudflare R2 client + binary cache helpers.
 *
 * R2 is S3-compatible; we use @aws-sdk/client-s3 against the
 * `r2.cloudflarestorage.com` endpoint. R2 has zero egress, so it's a
 * good fit for build-time / request-time caches that survive across
 * deploys.
 *
 * Two callers planned:
 * - lib/db.ts (preview-image LQIP cache, JSON values) — separate PR
 * - pages/api/social-image.tsx (rendered PNG cache, binary values) — this PR
 */
import { createHash } from 'node:crypto'

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'

const accountId = process.env.R2_ACCOUNT_ID
const bucket = process.env.R2_BUCKET
const accessKeyId = process.env.R2_ACCESS_KEY_ID
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY

export const isR2Enabled = !!(
  accountId &&
  bucket &&
  accessKeyId &&
  secretAccessKey
)

let client: S3Client | undefined

function getClient(): S3Client {
  if (!isR2Enabled) {
    throw new Error('R2 not configured: missing one of R2_* env vars')
  }
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: accessKeyId!,
        secretAccessKey: secretAccessKey!
      }
    })
  }
  return client
}

export function r2Key(prefix: string, key: string, ext: string): string {
  // sha256 keeps S3 keys safe regardless of input characters.
  return `${prefix}${createHash('sha256').update(key).digest('hex')}.${ext}`
}

export async function getR2Bytes(key: string): Promise<Uint8Array | null> {
  if (!isR2Enabled) return null
  try {
    const res = await getClient().send(
      new GetObjectCommand({ Bucket: bucket!, Key: key })
    )
    const arr = await res.Body?.transformToByteArray()
    return arr ?? null
  } catch (err: any) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404)
      return null
    throw err
  }
}

export async function putR2Bytes(
  key: string,
  body: Uint8Array | Buffer,
  contentType: string
): Promise<void> {
  if (!isR2Enabled) return
  await getClient().send(
    new PutObjectCommand({
      Bucket: bucket!,
      Key: key,
      Body: body,
      ContentType: contentType
    })
  )
}
