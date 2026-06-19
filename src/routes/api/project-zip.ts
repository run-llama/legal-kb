// /api/project-zip — stream a project's files back to the user as a
// ZIP archive.
//
// Query params:
//   userId    = WorkOS user id (TODO: derive server-side from session)
//   projectId = the project to bundle
//
// We resolve a presigned S3 URL per file via LlamaCloud
// (`client.files.get`), pipe each file's bytes through `fflate.Zip`,
// and stream the resulting archive straight back to the browser as the
// response body. Nothing is buffered to disk; memory usage scales with
// the size of the in-flight chunk, not with the total archive size.
//
// The user's LlamaCloud key never leaves the server: the API call to
// mint the presigned URL is made server-side, and so is the subsequent
// fetch() against the presigned URL.

import { createFileRoute } from '@tanstack/react-router'
import { buildProjectZip } from '@/lib/files'

export const Route = createFileRoute('/api/project-zip')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const userId = url.searchParams.get('userId')
        const projectId = url.searchParams.get('projectId')

        if (!userId || !projectId) {
          return Response.json(
            { error: 'missing required query params: userId, projectId' },
            { status: 400 },
          )
        }

        try {
          // Thread the request's AbortSignal through so that if the
          // browser cancels the download mid-stream we stop pulling
          // from LlamaCloud immediately rather than burning bandwidth.
          const { stream, filename } = await buildProjectZip(
            userId,
            projectId,
            { signal: request.signal },
          )

          return new Response(stream, {
            status: 200,
            headers: {
              'Content-Type': 'application/zip',
              // RFC 6266: filename* lets us send the UTF-8 form alongside
              // the ASCII fallback so non-ASCII project names survive.
              'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(
                filename,
              )}`,
              // Streaming archive — Content-Length is unknown up front.
              // Chunked transfer encoding is implied by omitting it.
              'Cache-Control': 'no-store',
            },
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // Project-not-found is a 404; everything else surfaces as 500
          // with the message attached so the UI can show it.
          const status =
            message.includes('project not found') ||
            message.includes('no API keys')
              ? 404
              : 500
          return Response.json({ error: message }, { status })
        }
      },
    },
  },
})
