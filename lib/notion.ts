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

export async function getPage(pageId: string): Promise<ExtendedRecordMap> {
  // Notion 429s requests from Vercel egress IPs even with cookie auth (see
  // react-notion-x #649). The R2 recordMap snapshot is the hard fallback:
  // every successful fetch writes through; on Notion failure we serve the
  // last-known-good snapshot so visitors never see a 404 from a transient
  // rate-limit event.
  const cacheKey = r2Key(RECORDMAP_PREFIX, pageId, 'json')

  let recordMap: ExtendedRecordMap
  try {
    // concurrency=1 makes notion-client fetch chunks serially. The home
    // page recordMap (~1 MB) splits into multiple loadPageChunk requests;
    // serial fetch trades a few seconds of latency for far fewer 429s.
    recordMap = await notion.getPage(pageId, { concurrency: 1 })
  } catch (err: any) {
    if (isR2Enabled) {
      const cached = await getR2Bytes(cacheKey).catch((cacheErr: any) => {
        console.warn('recordmap-cache get failed', pageId, cacheErr?.message)
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
  // tweets) so the fallback path can return it as-is. Best-effort — never
  // fail the request on a cache write.
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
