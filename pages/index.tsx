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

    // Soft-fail: matches pages/[pageId].tsx. Notion 429s during build
    // shouldn't kill the whole deploy. ISR rebuilds the page on first
    // request when the rate-limit window clears.
    return { notFound: true, revalidate: 30 }
  }
}

export default function NotionDomainPage(props: PageProps) {
  return <NotionPage {...props} />
}
