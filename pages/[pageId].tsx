import { type GetStaticProps } from 'next'

import { NotionPage } from '@/components/NotionPage'
import { domain, isDev, pageUrlOverrides } from '@/lib/config'
import { getSiteMap } from '@/lib/get-site-map'
import { resolveNotionPage } from '@/lib/resolve-notion-page'
import { type PageProps, type Params } from '@/lib/types'

// `vercel.json` `functions` block is what actually sets maxDuration for
// SSG pages on Pages Router (per Vercel docs); this export is a hint —
// it only takes effect for API routes. 60s is the Hobby plan cap.
export const config = {
  maxDuration: 60
}

export const getStaticProps: GetStaticProps<PageProps, Params> = async (
  context
) => {
  const rawPageId = context.params?.pageId as string

  try {
    const props = await resolveNotionPage(domain, rawPageId)

    // Long revalidate window keeps Notion request volume low. ISR still
    // serves the cached page instantly; regeneration happens in the
    // background and never blocks visitors.
    return { props, revalidate: 60 }
  } catch (err) {
    console.error('page error', domain, rawPageId, err)

    // Build phase: soft-fail so one bad page doesn't kill the whole export.
    // fallback: true + getStaticPaths still lists this slug; ISR will hydrate
    // on first request when Notion responds.
    if (process.env.NEXT_PHASE === 'phase-production-build') {
      return { notFound: true, revalidate: 60 }
    }

    // Runtime ISR: throw to keep serving the last-known-good cached page.
    // Returning notFound here would commit a 404 to the cache for the
    // revalidate window, which is what visitors saw before this fix.
    throw err
  }
}

export async function getStaticPaths() {
  if (isDev) {
    return {
      paths: [],
      fallback: true
    }
  }

  const siteMap = await getSiteMap()

  // Combine sitemap paths with URL overrides (e.g., /articles, /notes)
  // URL overrides might not be in the sitemap if not directly linked from root
  const allPageIds = [
    ...new Set([
      ...Object.keys(siteMap.canonicalPageMap),
      ...Object.keys(pageUrlOverrides)
    ])
  ]

  const staticPaths = {
    paths: allPageIds.map((pageId) => ({ params: { pageId } })),
    fallback: true
  }

  console.log(staticPaths.paths)
  return staticPaths
}

export default function NotionDomainDynamicPage(props: PageProps) {
  return <NotionPage {...props} />
}
