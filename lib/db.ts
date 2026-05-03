/**
 * Cache layer for preview images and URI→pageId mappings.
 *
 * Strategy: when R2 is configured (via R2_* env vars), persist values to
 * R2 as JSON. Otherwise fall back to in-memory Keyv (or Redis-backed Keyv
 * if isRedisEnabled). The public interface is the same in all modes:
 *
 *   db.get(key) → value | undefined
 *   db.set(key, value) → Promise<void>
 */
import Keyv from '@keyvhq/core'
import KeyvRedis from '@keyvhq/redis'

import { isRedisEnabled, redisNamespace, redisUrl } from './config'
import { getR2Bytes, isR2Enabled, putR2Bytes, r2Key } from './r2'

interface Cache {
  get: (key: string) => Promise<any>
  set: (key: string, value: any) => Promise<void>
}

const PREVIEW_PREFIX = process.env.R2_PREVIEW_PREFIX ?? 'cache/preview/'

function createR2Cache(): Cache {
  return {
    async get(key) {
      const bytes = await getR2Bytes(r2Key(PREVIEW_PREFIX, key, 'json'))
      if (!bytes) return undefined
      // R2 binary → utf-8 JSON.
      return JSON.parse(new TextDecoder().decode(bytes))
    },

    async set(key, value) {
      const body = new TextEncoder().encode(JSON.stringify(value))
      await putR2Bytes(
        r2Key(PREVIEW_PREFIX, key, 'json'),
        body,
        'application/json'
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
