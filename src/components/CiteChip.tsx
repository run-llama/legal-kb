// CiteChip: small numbered pill rendered inline inside assistant
// messages. Click to open a modal showing the cited page screenshots
// (one per page covered by the chunk), each with bbox highlights of the
// cited region overlaid.
//
// The chip is rendered by Streamdown's `inlineCode` component override
// when it sees a token shaped like `cite:<id>` (see chat.tsx).

import { useEffect, useState } from 'react'
import type { IndexedCitation, CitationPage } from '@/lib/citations'
import { findCitedBoxes } from '@/lib/bboxes'
import type { ItemsPage, NormBox } from '@/lib/bboxes'

type Props = {
  citation: IndexedCitation | undefined
  userId: string
}

export function CiteChip({ citation, userId }: Props) {
  const [open, setOpen] = useState(false)

  // Unknown citation id (model hallucinated, or output got truncated):
  // render an inert "?" pill so the conversation still reads cleanly.
  if (!citation) {
    return (
      <span
        className="inline-flex items-center justify-center align-baseline mx-0.5 px-1.5 h-5 min-w-[1.25rem] rounded-md text-[10px] font-semibold leading-none border border-[var(--line)] text-[var(--sea-ink-soft)] bg-transparent"
        title="Unknown citation"
      >
        ?
      </span>
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center justify-center align-baseline mx-0.5 px-1.5 h-5 min-w-[1.25rem] rounded-md text-[10px] font-semibold leading-none border border-[var(--lagoon-deep)]/40 text-[var(--lagoon-deep)] bg-[var(--lagoon-deep)]/10 hover:bg-[var(--lagoon-deep)]/20 transition-colors cursor-pointer"
        title={`${citation.fileName}${
          citation.pageStart != null ? ` — p.${citation.pageStart}` : ''
        }`}
      >
        {citation.index}
      </button>
      {open && (
        <CitationModal
          citation={citation}
          userId={userId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

// ---------- modal ----------

function CitationModal({
  citation,
  userId,
  onClose,
}: {
  citation: IndexedCitation
  userId: string
  onClose: () => void
}) {
  // Close on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const pageLabel =
    citation.pageStart != null
      ? citation.pageEnd && citation.pageEnd !== citation.pageStart
        ? `Pages ${citation.pageStart}–${citation.pageEnd}`
        : `Page ${citation.pageStart}`
      : null

  // Pages with at least a screenshot. We allow items-only pages too (in
  // case a page has no screenshot but has layout JSON), but typically
  // every page has both.
  const visiblePages = citation.pages.filter((p) => p.screenshot != null)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="relative bg-[var(--background,#fff)] rounded-2xl shadow-2xl w-full max-w-6xl max-h-[92vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 p-4 border-b border-[var(--line)] shrink-0">
          <div className="min-w-0">
            <p className="island-kicker m-0 mb-1">Citation #{citation.index}</p>
            <h3 className="m-0 text-sm font-semibold text-[var(--sea-ink)] truncate">
              {citation.fileName || 'Unknown file'} {`(v${citation.version})`}
            </h3>
            {pageLabel && (
              <p className="m-0 mt-0.5 text-xs text-[var(--sea-ink-soft)]">
                {pageLabel}
                {citation.score != null && (
                  <> · score {citation.score.toFixed(3)}</>
                )}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xs rounded-full border border-[var(--line)] px-3 py-1 hover:bg-[var(--line)]/40"
          >
            Close
          </button>
        </div>

        {/* Body: two-column on wide screens, stacked on narrow. Each
            column owns its scroll container so the modal shell never
            grows past the viewport. */}
        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_360px]">
          {/* Screenshot pane: one screenshot per cited page, stacked. */}
          <div className="min-h-0 overflow-auto bg-[var(--line)]/20 border-b md:border-b-0 md:border-r border-[var(--line)] p-4">
            {visiblePages.length === 0 ? (
              <p className="demo-muted text-xs m-0">
                No page screenshot available for this chunk.
              </p>
            ) : (
              <div className="flex flex-col items-center gap-6">
                {visiblePages.map((p) => (
                  <CitationPageView
                    key={p.page}
                    page={p}
                    userId={userId}
                    previewText={citation.preview}
                    showLabel={visiblePages.length > 1}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Excerpt pane */}
          <div className="min-h-0 overflow-auto p-4">
            {citation.preview ? (
              <>
                <p className="island-kicker m-0 mb-2">Excerpt</p>
                <blockquote className="m-0 border-l-2 border-[var(--lagoon-deep)]/40 pl-3 text-sm text-[var(--sea-ink)] whitespace-pre-wrap">
                  {citation.preview}
                  {citation.preview.length >= 240 && '…'}
                </blockquote>
              </>
            ) : (
              <p className="demo-muted text-xs m-0">No excerpt available.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------- single-page view (screenshot + bbox overlay) ----------

function CitationPageView({
  page,
  userId,
  previewText,
  showLabel,
}: {
  page: CitationPage
  userId: string
  previewText: string
  showLabel: boolean
}) {
  // NOTE: we deliberately do NOT encode '/' in the `name` value. TanStack
  // Start's router decodes the query string pre-match and a literal `%2F`
  // in the name (e.g. "screenshots%2Fpage_5.jpg") confuses the matcher
  // into emitting a notFoundError on __root__. Slashes are valid inside
  // query-string values per RFC 3986, so this is safe.
  const encodeQueryValue = (s: string) =>
    encodeURIComponent(s).replace(/%2F/g, '/')
  const buildUrl = (a: { name: string; sourceId: string }) =>
    `/api/attachment?name=${encodeQueryValue(a.name)}` +
    `&sourceId=${encodeURIComponent(a.sourceId)}` +
    `&userId=${encodeURIComponent(userId)}`

  const screenshotUrl = page.screenshot ? buildUrl(page.screenshot) : null
  const itemsUrl = page.items ? buildUrl(page.items) : null

  // Vite's dev server inspects `Sec-Fetch-Dest: image` and routes those
  // requests to its static-asset middleware, which 404s our /api route.
  // fetch() sends `Sec-Fetch-Dest: empty`, dodging that middleware.
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [boxes, setBoxes] = useState<NormBox[]>([])

  useEffect(() => {
    if (!screenshotUrl) return
    let created: string | null = null
    ;(async () => {
      try {
        const res = await fetch(screenshotUrl)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const blob = await res.blob()
        created = URL.createObjectURL(blob)
        setBlobUrl(created)
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : 'fetch failed')
      }
    })()
    return () => {
      if (created) URL.revokeObjectURL(created)
    }
  }, [screenshotUrl])

  useEffect(() => {
    if (!itemsUrl || !previewText) return
    ;(async () => {
      try {
        const res = await fetch(itemsUrl)
        if (!res.ok) return // best-effort
        const pageJson = (await res.json()) as ItemsPage
        const found = findCitedBoxes(pageJson, previewText)
        setBoxes(found)
      } catch {
        // Swallow — boxes are progressive enhancement.
      }
    })()
  }, [itemsUrl, previewText])

  return (
    <div className="flex flex-col items-center gap-1 w-full">
      {showLabel && (
        <p className="island-kicker m-0 self-start">Page {page.page}</p>
      )}
      {blobUrl ? (
        <div className="relative inline-block max-w-full">
          <img
            src={blobUrl}
            alt={`Page ${page.page}`}
            className="block max-w-full h-auto"
          />
          {boxes.map((b, i) => (
            <div
              key={i}
              aria-hidden
              className="absolute pointer-events-none rounded-sm"
              style={{
                left: `${b.x * 100}%`,
                top: `${b.y * 100}%`,
                width: `${b.w * 100}%`,
                height: `${b.h * 100}%`,
                backgroundColor: 'rgba(255, 213, 0, 0.22)',
                outline: '1.5px solid rgba(255, 170, 0, 0.85)',
                boxShadow: '0 0 0 1px rgba(255, 170, 0, 0.25)',
                transition: 'opacity 200ms ease',
              }}
            />
          ))}
        </div>
      ) : fetchError ? (
        <p className="text-xs text-red-500 m-0 p-4">
          Failed to load screenshot: {fetchError}
        </p>
      ) : (
        <p className="demo-muted text-xs m-0 p-4">Loading…</p>
      )}
    </div>
  )
}
