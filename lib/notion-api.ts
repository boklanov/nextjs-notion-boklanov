import { NotionAPI } from 'notion-client'

// `loadPageChunk` 429s when called unauthenticated from cloud-provider IPs
// (Vercel egress is hit hard by this; see react-notion-x #649). Passing the
// `token_v2` cookie + active-user header from a logged-in browser session
// against notion.so authenticates the request and dramatically raises the
// rate-limit ceiling. Both env vars are optional — without them the client
// behaves exactly as before.
const authToken = process.env.NOTION_TOKEN_V2?.trim() || undefined
const activeUser = process.env.NOTION_ACTIVE_USER?.trim() || undefined

export const notion = new NotionAPI({
  apiBaseUrl: process.env.NOTION_API_BASE_URL,
  authToken,
  activeUser
})
