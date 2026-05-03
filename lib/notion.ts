import {
  type ExtendedRecordMap,
  type SearchParams,
  type SearchResults
} from 'notion-types'
import { mergeRecordMaps } from 'notion-utils'
import pMap from 'p-map'
import pMemoize from 'p-memoize'

import {
  isPreviewImageSupportEnabled,
  navigationLinks,
  navigationStyle
} from './config'
import { getTweetsMap } from './get-tweets'
import { notion } from './notion-api'
import { getPreviewImageMap } from './preview-images'
import { getR2Bytes, isR2Enabled, putR2Bytes, r2Key } from './r2'

const RECORDMAP_PREFIX = process.env.R2_RECORDMAP_PREFIX ?? 'cache/recordmap/'

const getNavigationLinkPages = pMemoize(
  async (): Promise<ExtendedRecordMap[]> => {
    const navigationLinkPageIds = (navigationLinks || [])
      .map((link) => link?.pageId)
      .filter(Boolean)

    if (navigationStyle !== 'default' && navigationLinkPageIds.length) {
      return pMap(
        navigationLinkPageIds,
        async (navigationLinkPageId) =>
          notion.getPage(navigationLinkPageId, {
            chunkLimit: 1,
            fetchMissingBlocks: false,
            fetchCollections: false,
            signFileUrls: false
          }),
        {
          concurrency: 4
        }
      )
    }

    return []
  }
)

// Resilience options for Notion API calls during build (notion-client uses ofetch).
// 30s timeout per attempt + 2 retries with 1s base delay handles flaky
// loadPageChunk responses without killing the whole SSG export.
const ROBUST_FETCH_OPTIONS = {
  timeout: 30_000,
  retry: 3,
  retryDelay: 2000,
  retryStatusCodes: [408, 409, 425, 429, 500, 502, 503, 504]
}

export async function getPage(pageId: string): Promise<ExtendedRecordMap> {
  // R2 read-through cache: snapshot every successful recordMap; on Notion
  // 429/timeout/error during runtime ISR regen, serve the snapshot so visitors
  // never see a 404 just because Notion is rate-limiting us.
  const cacheKey = r2Key(RECORDMAP_PREFIX, pageId, 'json')

  let recordMap: ExtendedRecordMap
  try {
    recordMap = await notion.getPage(pageId, {
      ofetchOptions: ROBUST_FETCH_OPTIONS
    })
  } catch (err: any) {
    if (isR2Enabled) {
      const cached = await getR2Bytes(cacheKey).catch((err_: any) => {
        console.warn('recordmap-cache get failed', pageId, err_?.message)
        return null
      })
      if (cached) {
        console.warn(
          'notion.getPage failed, serving R2 recordMap snapshot',
          pageId,
          err?.message
        )
        return JSON.parse(new TextDecoder().decode(cached)) as ExtendedRecordMap
      }
    }
    throw err
  }

  if (navigationStyle !== 'default') {
    // ensure that any pages linked to in the custom navigation header have
    // their block info fully resolved in the page record map so we know
    // the page title, slug, etc.
    const navigationLinkRecordMaps = await getNavigationLinkPages()

    if (navigationLinkRecordMaps?.length) {
      recordMap = navigationLinkRecordMaps.reduce(
        (map, navigationLinkRecordMap) =>
          mergeRecordMaps(map, navigationLinkRecordMap),
        recordMap
      )
    }
  }

  if (isPreviewImageSupportEnabled) {
    const previewImageMap = await getPreviewImageMap(recordMap)
    ;(recordMap as any).preview_images = previewImageMap
  }

  await getTweetsMap(recordMap)

  // Snapshot the fully-assembled recordMap (with merged nav, preview images,
  // tweets) so the fallback path can return it as-is without re-fetching.
  if (isR2Enabled) {
    try {
      await putR2Bytes(
        cacheKey,
        new TextEncoder().encode(JSON.stringify(recordMap)),
        'application/json'
      )
    } catch (err: any) {
      console.warn('recordmap-cache put failed', pageId, err?.message)
    }
  }

  return recordMap
}

export async function search(params: SearchParams): Promise<SearchResults> {
  return notion.search(params)
}
