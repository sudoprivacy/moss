/**
 * Markdown paragraph splitter for the wiki vector index.
 *
 * Goals:
 *  - Cut wiki-builder output (WIKI.md + chunk-NNN-*.md) into ~300-500 char
 *    passages so each gets its own embedding. Embedding a whole 5000-char
 *    chunk dilutes semantic density and tanks retrieval.
 *  - Preserve enough provenance (file, startLine, title) that the query side
 *    can return `{file, line_no, ...}` to wiki CLI without changing the
 *    response shape.
 *  - Be tolerant of the YAML frontmatter wiki-builder always prepends.
 *
 * The split is line-based: walk the file, accumulate a buffer until a blank
 * line or maxChars boundary, flush as a Passage. Headings (`# ...`) update
 * `currentTitle` but never enter the buffer — they're metadata, not content.
 *
 * Pure function, no IO, no state. Easy to unit test.
 */

export interface Passage {
  file: string
  /** 1-based, inclusive. */
  startLine: number
  /** 1-based, inclusive. */
  endLine: number
  /** Nearest H1/H2/H3 above the passage; falls back to file name. */
  title: string
  text: string
}

export interface SplitOptions {
  /** Soft cap on passage length in characters. Default 500. */
  maxChars?: number
  /**
   * Hard cap on passages returned per file. Anything beyond is silently
   * dropped (with a console.warn) to avoid pathological markdown DoS'ing
   * the index. Default 1000.
   */
  maxPassages?: number
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/
const IMAGE_ONLY_RE = /^\s*!\[[^\]]*\]\([^)]+\)\s*$/
const TABLE_RE = /^\s*\|.*\|\s*$/
const SENTENCE_BREAK_RE = /[。！？!?]\s*/g

export function splitMarkdown(
  markdown: string,
  file: string,
  opts: SplitOptions = {},
): Passage[] {
  const maxChars = opts.maxChars ?? 500
  const maxPassages = opts.maxPassages ?? 1000

  // Strip leading YAML frontmatter, remember how many lines we ate so
  // downstream line numbers point back at the on-disk file accurately.
  let body = markdown
  let lineOffset = 0
  const fmMatch = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n/)
  if (fmMatch) {
    body = markdown.slice(fmMatch[0].length)
    lineOffset = fmMatch[0].split('\n').length - 1
  }

  const lines = body.split(/\r?\n/)
  const fileTitle = file.replace(/\.md$/, '')
  let currentTitle = fileTitle

  type Pending = { startLine: number; lines: string[] }
  let pending: Pending | null = null
  const out: Passage[] = []

  const flush = () => {
    if (!pending) return
    const text = pending.lines.join('\n').trim()
    const start = pending.startLine
    const end = start + pending.lines.length - 1
    pending = null
    if (!text) return
    // No-op for purely whitespace / image-only paragraphs
    if (text.length === 0) return
    if (text.length <= maxChars) {
      out.push({ file, startLine: start, endLine: end, title: currentTitle, text })
      return
    }
    // Oversize paragraph: greedy sentence-boundary split, fall back to
    // char chunking. Line numbers degrade gracefully — each slice carries
    // the same [start, end] window since we don't track per-sentence lines.
    let cursor = 0
    while (cursor < text.length) {
      const remain = text.slice(cursor)
      if (remain.length <= maxChars) {
        out.push({ file, startLine: start, endLine: end, title: currentTitle, text: remain.trim() })
        break
      }
      // Try to break on a sentence boundary within [cursor, cursor+maxChars].
      const slice = remain.slice(0, maxChars)
      let cutAt = -1
      SENTENCE_BREAK_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = SENTENCE_BREAK_RE.exec(slice)) !== null) {
        cutAt = m.index + m[0].length
      }
      if (cutAt <= 0) cutAt = maxChars
      const piece = remain.slice(0, cutAt).trim()
      if (piece) {
        out.push({ file, startLine: start, endLine: end, title: currentTitle, text: piece })
      }
      cursor += cutAt
    }
  }

  let inTable = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    const lineNo = i + 1 + lineOffset

    const headingMatch = raw.match(HEADING_RE)
    if (headingMatch) {
      flush()
      currentTitle = (headingMatch[2] ?? fileTitle).trim() || fileTitle
      inTable = false
      continue
    }

    const isTable = TABLE_RE.test(raw)
    if (isTable) {
      // Tables: keep contiguous rows together regardless of blank lines
      // between them (rare but happens with separator rows).
      if (!pending) pending = { startLine: lineNo, lines: [] }
      pending.lines.push(raw)
      inTable = true
      continue
    } else if (inTable && raw.trim() === '') {
      // Blank line after a table closes it.
      flush()
      inTable = false
      continue
    }
    inTable = false

    if (raw.trim() === '') {
      flush()
      continue
    }

    if (IMAGE_ONLY_RE.test(raw)) {
      // Drop image-only lines; they have no semantic text to embed.
      // If pending has content, image breaks the paragraph; flush.
      if (pending) flush()
      continue
    }

    if (!pending) pending = { startLine: lineNo, lines: [] }
    pending.lines.push(raw)

    // If buffer is large enough that even appending one more line would
    // overshoot 2*maxChars, flush eagerly. The flush itself will sentence-
    // split if needed; this just keeps memory bounded.
    const joined = pending.lines.join('\n')
    if (joined.length > maxChars * 2) {
      flush()
    }
  }
  flush()

  if (out.length > maxPassages) {
    console.warn(
      `[chunkSplitter] ${file} produced ${out.length} passages; truncating to ${maxPassages}`,
    )
    return out.slice(0, maxPassages)
  }
  return out
}
