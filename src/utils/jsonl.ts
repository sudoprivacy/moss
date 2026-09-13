// Extracted from json.ts so server-side modules (budgetStats) can read JSONL
// transcripts without loading json.ts's CLI-only import graph (slowOperations
// pulls in bun:bundle, which cannot load under Node/tsx). Keep this module
// free of node:sqlite and bun: imports — both runners must be able to load it.
import { open, readFile, stat } from 'fs/promises'
import { stripBOM } from './jsonRead.js'

/**
 * Bun.JSONLParseChunk if available, false otherwise.
 * Supports both strings and Buffers, minimizing memory usage and copies.
 * Also handles BOM stripping internally.
 */
type BunJSONLParseChunk = (
  data: string | Buffer,
  offset?: number,
) => { values: unknown[]; error: null | Error; read: number; done: boolean }

const bunJSONLParse: BunJSONLParseChunk | false = (() => {
  if (typeof Bun === 'undefined') return false
  const b = Bun as Record<string, unknown>
  const jsonl = b.JSONL as Record<string, unknown> | undefined
  if (!jsonl?.parseChunk) return false
  return jsonl.parseChunk as BunJSONLParseChunk
})()

function parseJSONLBun<T>(data: string | Buffer): T[] {
  const parse = bunJSONLParse as BunJSONLParseChunk
  const len = data.length
  const result = parse(data)
  if (!result.error || result.done || result.read >= len) {
    return result.values as T[]
  }
  // Had an error mid-stream — collect what we got and keep going
  let values = result.values as T[]
  let offset = result.read
  while (offset < len) {
    const newlineIndex =
      typeof data === 'string'
        ? data.indexOf('\n', offset)
        : data.indexOf(0x0a, offset)
    if (newlineIndex === -1) break
    offset = newlineIndex + 1
    const next = parse(data, offset)
    if (next.values.length > 0) {
      values = values.concat(next.values as T[])
    }
    if (!next.error || next.done || next.read >= len) break
    offset = next.read
  }
  return values
}

function parseJSONLBuffer<T>(buf: Buffer): T[] {
  const bufLen = buf.length
  let start = 0

  // Strip UTF-8 BOM (EF BB BF)
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    start = 3
  }

  const results: T[] = []
  while (start < bufLen) {
    let end = buf.indexOf(0x0a, start)
    if (end === -1) end = bufLen

    const line = buf.toString('utf8', start, end).trim()
    start = end + 1
    if (!line) continue
    try {
      results.push(JSON.parse(line) as T)
    } catch {
      // Skip malformed lines
    }
  }
  return results
}

function parseJSONLString<T>(data: string): T[] {
  const stripped = stripBOM(data)
  const len = stripped.length
  let start = 0

  const results: T[] = []
  while (start < len) {
    let end = stripped.indexOf('\n', start)
    if (end === -1) end = len

    const line = stripped.substring(start, end).trim()
    start = end + 1
    if (!line) continue
    try {
      results.push(JSON.parse(line) as T)
    } catch {
      // Skip malformed lines
    }
  }
  return results
}

/**
 * Parses JSONL data from a string or Buffer, skipping malformed lines.
 * Uses Bun.JSONL.parseChunk when available for better performance,
 * falls back to indexOf-based scanning otherwise.
 */
export function parseJSONL<T>(data: string | Buffer): T[] {
  if (bunJSONLParse) {
    return parseJSONLBun<T>(data)
  }
  if (typeof data === 'string') {
    return parseJSONLString<T>(data)
  }
  return parseJSONLBuffer<T>(data)
}

const MAX_JSONL_READ_BYTES = 100 * 1024 * 1024

/**
 * Reads and parses a JSONL file, reading at most the last 100 MB.
 * For files larger than 100 MB, reads the tail and skips the first partial line.
 *
 * 100 MB is more than sufficient since the longest context window we support
 * is ~2M tokens, which is well under 100 MB of JSONL.
 */
export async function readJSONLFile<T>(filePath: string): Promise<T[]> {
  const { size } = await stat(filePath)
  if (size <= MAX_JSONL_READ_BYTES) {
    return parseJSONL<T>(await readFile(filePath))
  }
  await using fd = await open(filePath, 'r')
  const buf = Buffer.allocUnsafe(MAX_JSONL_READ_BYTES)
  let totalRead = 0
  const fileOffset = size - MAX_JSONL_READ_BYTES
  while (totalRead < MAX_JSONL_READ_BYTES) {
    const { bytesRead } = await fd.read(
      buf,
      totalRead,
      MAX_JSONL_READ_BYTES - totalRead,
      fileOffset + totalRead,
    )
    if (bytesRead === 0) break
    totalRead += bytesRead
  }
  // Skip the first partial line
  const newlineIndex = buf.indexOf(0x0a)
  if (newlineIndex !== -1 && newlineIndex < totalRead - 1) {
    return parseJSONL<T>(buf.subarray(newlineIndex + 1, totalRead))
  }
  return parseJSONL<T>(buf.subarray(0, totalRead))
}
