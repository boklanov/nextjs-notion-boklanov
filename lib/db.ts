import { createHash } from 'node:crypto'

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'
import Keyv from '@keyvhq/core'
import KeyvRedis from '@keyvhq/redis'

import {
  isR2Enabled,
  isRedisEnabled,
  r2AccessKeyId,
  r2AccountId,
  r2Bucket,
  r2PreviewPrefix,
  r2SecretAccessKey,
  redisNamespace,
  redisUrl
} from './config'

interface Cache {
  get: (key: string) => Promise<any>
  set: (key: string, value: any) => Promise<void>
}

// Hash keys so URLs with query strings / special chars produce safe S3 keys.
function r2Key(key: string): string {
  return `${r2PreviewPrefix}${createHash('sha256').update(key).digest('hex')}.json`
}

function createR2Cache(): Cache {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${r2AccountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: r2AccessKeyId!,
      secretAccessKey: r2SecretAccessKey!
    }
  })

  return {
    async get(key) {
      try {
        const res = await client.send(
          new GetObjectCommand({ Bucket: r2Bucket!, Key: r2Key(key) })
        )
        const body = await res.Body?.transformToString()
        return body ? JSON.parse(body) : undefined
      } catch (err: any) {
        // NoSuchKey is the cache-miss path — silent.
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404)
          return undefined
        throw err
      }
    },

    async set(key, value) {
      await client.send(
        new PutObjectCommand({
          Bucket: r2Bucket!,
          Key: r2Key(key),
          Body: JSON.stringify(value),
          ContentType: 'application/json'
        })
      )
    }
  }
}

function createKeyvCache(): Cache {
  const keyv = isRedisEnabled
    ? new Keyv({
        store: new KeyvRedis(redisUrl!),
        namespace: redisNamespace || undefined
      })
    : new Keyv()

  return {
    get: (key) => keyv.get(key),
    set: async (key, value) => {
      await keyv.set(key, value)
    }
  }
}

export const db: Cache = isR2Enabled ? createR2Cache() : createKeyvCache()
