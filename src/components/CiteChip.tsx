// CiteChip: small numbered pill rendered inline inside assistant
// messages. Click to open a modal showing the cited page screenshot.
//
// The chip is rendered by Streamdown's `inlineCode` component override
// when it sees a token shaped like `cite:<id>` (see chat.tsx).

import { useEffect, useState } from 'react'
import type { IndexedCitation } from '@/lib/citations'

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
          citation.pageStart != null ? ` \u2014 p.${citation.pageStart}` : ''
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

  const attachmentUrl = citation.attachment
    ? `/api/attachment?name=${encodeURIComponent(citation.attachment.name)}` +
      `&sourceId=${encodeURIComponent(citation.attachment.sourceId)}` +
      `&userId=${encodeURIComponent(userId)}`
    : null

  const pageLabel =
    citation.pageStart != null
      ? citation.pageEnd && citation.pageEnd !== citation.pageStart
        ? `Pages ${citation.pageStart}\u2013${citation.pageEnd}`
        : `Page ${citation.pageStart}`
      : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="relative bg-[var(--background,#fff)] rounded-2xl shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 p-4 border-b border-[var(--line)]">
          <div className="min-w-0">
            <p className="island-kicker m-0 mb-1">
              Citation #{citation.index}
            </p>
            <h3 className="m-0 text-sm font-semibold text-[var(--sea-ink)] truncate">
              {citation.fileName || 'Unknown file'}
            </h3>
            {pageLabel && (
              <p className="m-0 mt-0.5 text-xs text-[var(--sea-ink-soft)]">
                {pageLabel}
                {citation.score != null && (
                  <> \u00b7 score {citation.score.toFixed(3)}</>
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

        {/* Body */}
        <div className="overflow-y-auto p-4 grid gap-4">
          {attachmentUrl ? (
            <div className="rounded-lg border border-[var(--line)] bg-[var(--line)]/20 overflow-hidden flex items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={attachmentUrl}
                alt={`Page ${citation.pageStart ?? ''} of ${citation.fileName}`}
                className="max-w-full max-h-[60vh] object-contain"
              />
            </div>
          ) : (
            <p className="demo-muted text-xs m-0">
              No page screenshot available for this chunk.
            </p>
          )}
          {citation.preview && (
            <div>
              <p className="island-kicker m-0 mb-1">Excerpt</p>
              <blockquote className="m-0 border-l-2 border-[var(--lagoon-deep)]/40 pl-3 text-sm text-[var(--sea-ink)] whitespace-pre-wrap">
                {citation.preview}
                {citation.preview.length >= 240 && '\u2026'}
              </blockquote>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
