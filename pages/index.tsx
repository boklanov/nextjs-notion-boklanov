import type { PageProps } from '@/lib/types'
import { NotionPage } from '@/components/NotionPage'
import { domain } from '@/lib/config'
import { resolveNotionPage } from '@/lib/resolve-notion-page'

// `vercel.json` `functions` block actually sets this for SSG pages.
export const config = {
  maxDuration: 300
}

export const getStaticProps = async () => {
  try {
    const props = await resolveNotionPage(domain)

    return { props, revalidate: 60 }
  } catch (err) {
    console.error('page error', domain, err)

    // Build phase: soft-fail. fallback: true means home hydrates on first
    // request when Notion responds.
    if (process.env.NEXT_PHASE === 'phase-production-build') {
      return { notFound: true, revalidate: 60 }
    }

    // Runtime ISR: throw to keep serving the last-known-good snapshot.
    throw err
  }
}

export default function NotionDomainPage(props: PageProps) {
  return <NotionPage {...props} />
}
