// Bounding-box parsing for the `items/page_N.json` attachments that
// LlamaCloud emits alongside each page screenshot.
//
// The JSON contains the parsed page layout: a tree of items (header /
// heading / text / table / ...), each with one or more bbox rectangles
// in the page's coordinate space (page_width × page_height).
//
// We use these boxes to overlay the *specific* chunk that was cited on
// top of the page screenshot — so the user sees exactly which paragraph
// the model is referring to, not just "somewhere on page 5".

/** Shape of `items/page_N.json` (just the bits we care about). */
export type ItemsPage = {
  page_number?: number
  page_width: number
  page_height: number
  items: PageItem[]
}

export type PageItem = {
  type: string
  value?: string
  md?: string
  /** Item-level bboxes (may be a single rect or several for wrapped text). */
  bbox?: RawBox[]
  /** Some items (e.g. header) have nested sub-items. */
  items?: Array<{
    type: string
    value?: string
    md?: string
    bbox?: RawBox[]
  }>
}

/** A bbox as it appears in the JSON. Sub-bboxes also carry char ranges. */
export type RawBox = {
  x: number
  y: number
  w: number
  h: number
  start_index?: number
  end_index?: number
  confidence?: number
  label?: string
}

/** Normalized box, expressed as percentages of the page (0..1). */
export type NormBox = {
  /** left, in 0..1 of page_width. */
  x: number
  /** top, in 0..1 of page_height. */
  y: number
  /** width, in 0..1 of page_width. */
  w: number
  /** height, in 0..1 of page_height. */
  h: number
}

/**
 * Convert + clamp a raw box to a normalized percent box. Negative
 * coordinates (sometimes emitted by the parser) get clipped to 0; boxes
 * that extend past the page edge get clipped to fit.
 *
 * Returns null if the box ends up with zero or negative area.
 */
export function normalizeBox(
  raw: RawBox,
  pageWidth: number,
  pageHeight: number,
): NormBox | null {
  if (pageWidth <= 0 || pageHeight <= 0) return null
  const left = Math.max(0, raw.x)
  const top = Math.max(0, raw.y)
  const right = Math.min(pageWidth, raw.x + raw.w)
  const bottom = Math.min(pageHeight, raw.y + raw.h)
  const w = right - left
  const h = bottom - top
  if (w <= 0 || h <= 0) return null
  return {
    x: left / pageWidth,
    y: top / pageHeight,
    w: w / pageWidth,
    h: h / pageHeight,
  }
}

// ---------- finding which boxes correspond to the cited chunk ----------

/**
 * Normalize text for fuzzy matching: lowercase, collapse whitespace,
 * strip non-alphanumerics. Enough to survive minor PDF-extraction quirks
 * (ligatures, soft hyphens, line breaks) without bringing in a dep.
 */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .trim()
}

/**
 * Score how well a candidate string matches a target (the chunk preview)
 * via shared trigrams. Cheap, language-agnostic, good enough for
 * "does this paragraph contain the cited sentence?".
 *
 * Returns a value in [0, 1]: fraction of the target's trigrams found in
 * the candidate.
 */
function trigramOverlap(target: string, candidate: string): number {
  const t = norm(target)
  const c = norm(candidate)
  if (t.length < 3 || c.length < 3) {
    // Fall back to substring containment for very short text.
    return c.includes(t) || t.includes(c) ? 1 : 0
  }
  const tgrams = new Set<string>()
  for (let i = 0; i <= t.length - 3; i++) tgrams.add(t.slice(i, i + 3))
  if (tgrams.size === 0) return 0
  let hits = 0
  const seen = new Set<string>()
  for (let i = 0; i <= c.length - 3; i++) {
    const g = c.slice(i, i + 3)
    if (tgrams.has(g) && !seen.has(g)) {
      seen.add(g)
      hits++
    }
  }
  return hits / tgrams.size
}

/** Collect every item that has text, flattening one level of nesting. */
function flattenItems(page: ItemsPage): PageItem[] {
  const out: PageItem[] = []
  for (const item of page.items) {
    out.push(item)
    if (Array.isArray(item.items)) {
      for (const sub of item.items) {
        // Re-shape sub-items to look like PageItems for uniform handling.
        out.push({
          type: sub.type,
          value: sub.value,
          md: sub.md,
          bbox: sub.bbox,
        })
      }
    }
  }
  return out
}

/**
 * Find every bbox on the page that corresponds to the cited chunk.
 *
 * Strategy: for each leaf-ish item that has bboxes and text, compute a
 * trigram overlap against the preview. Items above `threshold` are
 * considered part of the citation; their bboxes are collected.
 *
 * Returns normalized (percent) boxes ready to absolute-position over a
 * relative-positioned image. Empty array if nothing matched well enough
 * — caller should just render the screenshot without an overlay in that
 * case.
 */
export function findCitedBoxes(
  page: ItemsPage,
  previewText: string,
  options: { threshold?: number; maxBoxes?: number } = {},
): NormBox[] {
  const threshold = options.threshold ?? 0.5
  const maxBoxes = options.maxBoxes ?? 32
  const preview = previewText.trim()
  if (!preview) return []
  if (page.page_width <= 0 || page.page_height <= 0) return []

  const flat = flattenItems(page)
  const matches: { score: number; boxes: RawBox[] }[] = []

  for (const item of flat) {
    const text = item.value ?? item.md ?? ''
    if (!text.trim()) continue
    if (!Array.isArray(item.bbox) || item.bbox.length === 0) continue
    // For very short items (titles), require a stricter match so we
    // don't light up every header on the page that shares a few words.
    const minScore = text.length < 40 ? Math.max(threshold, 0.8) : threshold
    const score = trigramOverlap(preview, text)
    if (score >= minScore) matches.push({ score, boxes: item.bbox })
  }

  if (matches.length === 0) return []
  // Sort by score desc and take up to maxBoxes total rects.
  matches.sort((a, b) => b.score - a.score)
  const out: NormBox[] = []
  for (const m of matches) {
    for (const b of m.boxes) {
      const nb = normalizeBox(b, page.page_width, page.page_height)
      if (nb) out.push(nb)
      if (out.length >= maxBoxes) return out
    }
  }
  return out
}
