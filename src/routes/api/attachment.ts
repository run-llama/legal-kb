// /api/attachment — proxies a LlamaCloud attachment fetch so the client
// never sees the user's API key.
//
// Query params:
//   name      = attachment_name from the citation (e.g. "screenshots/page_7.jpg")
//   sourceId  = source_id required by the attachments endpoint
//   userId    = WorkOS user id (TODO: derive server-side from session)
//
// We look up the user's encrypted LlamaCloud key, hit the LlamaCloud REST
// endpoint with the auth header, and stream the response back. Caching is
// browser-side via Cache-Control \u2014 attachments for a given (name, sourceId)
// pair are immutable.

import { createFileRoute } from '@tanstack/react-router'
import { getDecryptedApiKeys } from '@/lib/apiKeys'

const LLAMACLOUD_BASE =
  process.env.LLAMA_CLOUD_BASE_URL ?? 'https://api.cloud.llamaindex.ai'

export const Route = createFileRoute('/api/attachment')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const name = url.searchParams.get('name')
        const sourceId = url.searchParams.get('sourceId')
        const userId = url.searchParams.get('userId')

        if (!name || !sourceId || !userId) {
          return Response.json(
            { error: 'missing required query params: name, sourceId, userId' },
            { status: 400 },
          )
        }

        const keys = await getDecryptedApiKeys(userId)
        if (!keys?.llamacloudKey) {
          return Response.json(
            { error: 'no LlamaCloud key configured for this user' },
            { status: 400 },
          )
        }

        // attachment_name can contain "/" (e.g. "screenshots/page_7.jpg").
        // Build the URL ourselves so we don't double-encode.
        const upstream = new URL(
          `${LLAMACLOUD_BASE}/api/v1/beta/attachments/${name}`,
        )
        upstream.searchParams.set('source_id', sourceId)
        // If the user configured a project id, scope the request to it.
        if (keys.llamacloudProjectId) {
          upstream.searchParams.set('project_id', keys.llamacloudProjectId)
        }

        const upstreamRes = await fetch(upstream, {
          headers: { Authorization: `Bearer ${keys.llamacloudKey}` },
        })

        if (!upstreamRes.ok || !upstreamRes.body) {
          const text = await upstreamRes.text().catch(() => '')
          return Response.json(
            {
              error: `upstream returned ${upstreamRes.status}`,
              detail: text.slice(0, 500),
            },
            { status: upstreamRes.status },
          )
        }

        // Stream the body through. Preserve content-type so <img> works.
        return new Response(upstreamRes.body, {
          status: 200,
          headers: {
            'Content-Type':
              upstreamRes.headers.get('content-type') ??
              'application/octet-stream',
            // Attachments are immutable for a given (name, sourceId).
            'Cache-Control': 'private, max-age=3600',
          },
        })
      },
    },
  },
})
