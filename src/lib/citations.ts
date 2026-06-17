// Citations: shared types + helpers for visual citations from the
// `retrieve` tool.
//
// Flow:
//   1. retrieve tool returns { formatted, citations } in its tool output.
//      The model sees both: the formatted text is the primary "result",
//      and the citations array gives it stable ids it can reference.
//   2. Model emits inline citation tokens of the form `cite:<id>` wrapped
//      in backticks (so they render as inline code in markdown; we then
//      swap the rendered <code> for our CiteChip component).
//   3. Client walks the assistant message's tool-result parts, harvests
//      every Citation, builds a map keyed by id, and assigns each one a
//      stable display number.

import { isToolUIPart } from 'ai'
import type { UIMessage, UIMessagePart, UIDataTypes, UITools } from 'ai'

/** A single attachment pointer the /api/attachment proxy can fetch. */
export type AttachmentRef = {
  /** Attachment-relative path, e.g. "screenshots/page_7.jpg". */
  name: string
  /** source_id required for the attachments endpoint. */
  sourceId: string
}

/** One page of a multi-page citation: screenshot + matching items JSON. */
export type CitationPage = {
  /** 1-indexed page number, parsed from the attachment_name. */
  page: number
  /** Page screenshot attachment, if available. */
  screenshot: AttachmentRef | null
  /** Layout/items JSON attachment for this page, if available. */
  items: AttachmentRef | null
}

/** A single retrievable source we can show the user. */
export type Citation = {
  /** Short stable id the model uses to reference this citation inline. */
  id: string
  /** Human-readable file name (from the chunk's metadata). */
  fileName: string
  /** LlamaCloud file_id — used to fetch attachments via /api/attachment. */
  fileId: string
  /** Page range covered by this chunk, if known. */
  pageStart: number | null
  pageEnd: number | null
  /**
   * One entry per page covered by the chunk, sorted by page number.
   * A chunk that spans pages 4–6 has three entries here, each with its
   * own screenshot + items JSON.
   */
  pages: CitationPage[]
  /** Trimmed preview of the chunk text — shown under the screenshot. */
  preview: string
  /** Relevance score (rerank if present, else hybrid). */
  score: number | null
}

/**
 * Pull the 1-indexed page number out of an attachment name like
 * "screenshots/page_7.jpg" or "items/page_12.json". Returns null if the
 * name doesn't follow the expected pattern.
 */
export function parsePageNumber(attachmentName: string): number | null {
  const m = attachmentName.match(/page_(\d+)/i)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) ? n : null
}

/**
 * Mint a short opaque citation id. Short enough that the model can echo
 * it back inline without spending many tokens, opaque enough that it
 * won't collide across retrieve calls within one conversation.
 */
export function makeCitationId(): string {
  // 6 base36 chars = ~2B possibilities. Plenty for a conversation.
  return 'c' + Math.random().toString(36).slice(2, 8)
}

/** Marker the model emits inline, wrapped in backticks: `cite:abc123` */
export const CITE_PREFIX = 'cite:'

/** True iff a string looks like a `cite:<id>` marker. */
export function isCiteMarker(s: string): boolean {
  return s.startsWith(CITE_PREFIX) && s.length > CITE_PREFIX.length
}

/** Extract the id from a `cite:<id>` marker. */
export function parseCiteMarker(s: string): string | null {
  if (!isCiteMarker(s)) return null
  return s.slice(CITE_PREFIX.length)
}

// ---------- harvesting citations from a message ----------

/**
 * Walk every tool-result part on `message` and collect any `citations`
 * field on the output. Returns a Map keyed by citation id with a stable
 * display index attached (1-based, in first-appearance order across the
 * whole assistant message).
 *
 * Defensive: tolerates older messages that pre-date this feature and
 * messages where the tool output is still a plain string.
 */
export type IndexedCitation = Citation & { index: number }

export function collectCitations(
  parts: ReadonlyArray<UIMessagePart<UIDataTypes, UITools>>,
): Map<string, IndexedCitation> {
  const out = new Map<string, IndexedCitation>()
  let nextIndex = 1
  for (const part of parts) {
    if (!isToolUIPart(part)) continue
    // Only the `retrieve` tool emits citations.
    const toolName =
      part.type === 'dynamic-tool'
        ? ((part as { toolName?: string }).toolName ?? '')
        : part.type.replace(/^tool-/, '')
    if (toolName !== 'retrieve') continue
    if (!('output' in part) || part.output == null) continue
    const output = part.output
    if (typeof output !== 'object') continue
    const citations = (output as { citations?: unknown }).citations
    if (!Array.isArray(citations)) continue
    for (const c of citations) {
      if (!c || typeof c !== 'object') continue
      const cand = c as Record<string, unknown>
      if (typeof cand.id !== 'string') continue
      if (out.has(cand.id)) continue
      out.set(cand.id, {
        id: cand.id,
        fileName: typeof cand.fileName === 'string' ? cand.fileName : '',
        fileId: typeof cand.fileId === 'string' ? cand.fileId : '',
        pageStart: typeof cand.pageStart === 'number' ? cand.pageStart : null,
        pageEnd: typeof cand.pageEnd === 'number' ? cand.pageEnd : null,
        pages: parsePagesField(cand),
        preview: typeof cand.preview === 'string' ? cand.preview : '',
        score: typeof cand.score === 'number' ? cand.score : null,
        index: nextIndex++,
      })
    }
  }
  return out
}

/** Convenience: pull citations off a full UIMessage. */
export function collectCitationsFromMessage(
  message: UIMessage,
): Map<string, IndexedCitation> {
  return collectCitations(message.parts)
}

// ---------- internal: parse the `pages` field defensively ----------

/**
 * Coerce a raw Citation-shaped object into a CitationPage[]. Handles
 * three shapes:
 *   - new shape with `pages: CitationPage[]`
 *   - old single-page shape with `attachment` + `itemsAttachment`
 *     (pre-multi-page persisted messages)
 *   - missing/garbage — returns []
 * Always returns the array sorted by page number ascending.
 */
function parsePagesField(cand: Record<string, unknown>): CitationPage[] {
  const out: CitationPage[] = []

  // New shape.
  if (Array.isArray(cand.pages)) {
    for (const p of cand.pages) {
      if (!p || typeof p !== 'object') continue
      const pp = p as Record<string, unknown>
      const page = typeof pp.page === 'number' ? pp.page : null
      if (page == null) continue
      out.push({
        page,
        screenshot: parseAttachmentRef(pp.screenshot),
        items: parseAttachmentRef(pp.items),
      })
    }
  } else {
    // Old shape: synthesize a single CitationPage from `attachment` +
    // `itemsAttachment`. We don't always know the page number here, so
    // fall back to pageStart, then to 0 (will sort first, label "—").
    const screenshot = parseAttachmentRef(cand.attachment)
    const items = parseAttachmentRef(cand.itemsAttachment)
    if (screenshot || items) {
      const name = screenshot?.name ?? items?.name ?? ''
      const inferred = parsePageNumber(name)
      const page =
        inferred ??
        (typeof cand.pageStart === 'number' ? cand.pageStart : 0)
      out.push({ page, screenshot, items })
    }
  }

  out.sort((a, b) => a.page - b.page)
  return out
}

function parseAttachmentRef(raw: unknown): AttachmentRef | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.name !== 'string' || typeof r.sourceId !== 'string') return null
  return { name: r.name, sourceId: r.sourceId }
}
