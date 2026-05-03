import type { PageProps } from '@/lib/types'
import { NotionPage } from '@/components/NotionPage'
import { domain } from '@/lib/config'
import { resolveNotionPage } from '@/lib/resolve-notion-page'

export const getStaticProps = async () => {
  try {
    const props = await resolveNotionPage(domain)

    return { props, revalidate: 10 }
  } catch (err) {
    console.error('page error', domain, err)

    // Build phase: soft-fail so a Notion 429 during pnpm build doesn't kill
    // the whole deploy. fallback: true + ISR will hydrate the home page on
    // first visit, where Notion-cookie auth makes regen reliable.
    if (process.env.NEXT_PHASE === 'phase-production-build') {
      return { notFound: true, revalidate: 10 }
    }

    // Runtime: throw so we keep serving the last-known-good ISR snapshot
    // instead of caching a 404 for the revalidate window.
    throw err
  }
}

export default function NotionDomainPage(props: PageProps) {
  return <NotionPage {...props} />
}
