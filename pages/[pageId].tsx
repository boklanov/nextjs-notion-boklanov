import { type GetStaticProps } from 'next'

import { NotionPage } from '@/components/NotionPage'
import { domain, isDev } from '@/lib/config'
import { getSiteMap } from '@/lib/get-site-map'
import { resolveNotionPage } from '@/lib/resolve-notion-page'
import { type PageProps, type Params } from '@/lib/types'

export const getStaticProps: GetStaticProps<PageProps, Params> = async (
  context
) => {
  const rawPageId = context.params?.pageId as string

  try {
    const props = await resolveNotionPage(domain, rawPageId)

    return { props, revalidate: 10 }
  } catch (err) {
    console.error('page error', domain, rawPageId, err)

    // Soft-fail: with fallback: true + ISR, a transient Notion failure
    // should not kill the whole production build. The page hydrates on
    // first request via getStaticProps re-run.
    return { notFound: true, revalidate: 60 }
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

  const staticPaths = {
    paths: Object.keys(siteMap.canonicalPageMap).map((pageId) => ({
      params: {
        pageId
      }
    })),
    // paths: [],
    fallback: true
  }

  console.log(staticPaths.paths)
  return staticPaths
}

export default function NotionDomainDynamicPage(props: PageProps) {
  return <NotionPage {...props} />
}
