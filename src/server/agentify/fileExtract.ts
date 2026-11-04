/**
 * Turn session files (inputs and outputs) into searchable text plus a
 * structured JSON copy.
 *
 * Search retrieves ~500-character chunks on their own, so a spreadsheet row
 * is indexed as one line that repeats its column names:
 *
 *   「2026十月份.xls」工作表「Sheet1」第12行：日期=2026-10-03｜出发地=上虞｜运费含税=1200
 *
 * A chunk taken from row 300 still says what each number means, which a
 * markdown table cut into pieces would not. Each sheet also gets a profile
 * (columns, types, ranges, totals) so "what does this file cover" questions
 * do not need every row.
 *
 * The JSON copy (`<file>.extract.json` in the agent home) keeps typed values
 * (dates as ISO strings, numbers as numbers, formula results, merged cells
 * filled in) so an agent can load the data with plain `json` even though the
 * runtime image has no spreadsheet library.
 *
 * Formats: xlsx/xlsm (read directly), csv/tsv (UTF-8 or GB18030), docx,
 * pptx, pdf (pdftotext, per page), plain text; xls/ods/doc/rtf/odt/ppt/odp
 * are converted with LibreOffice first when it is installed. Everything here
 * is best effort: failures return null and the file is still listed by name.
 */
import { execFile } from 'child_process'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export type CellValue = string | number | boolean | null

export interface SheetColumn {
  name: string
  type: 'number' | 'date' | 'text' | 'bool' | 'mixed' | 'empty'
  filled: number
  min?: number | string
  max?: number | string
  sum?: number
  distinct?: number
  top?: string[]
}

export interface SheetData {
  name: string
  hidden?: boolean
  /** Text above the header row (titles, notes). */
  caption: string[]
  /** 1-based row number of the header in the sheet; 0 when none was found. */
  headerRow: number
  columns: SheetColumn[]
  rowCount: number
  /** One object per data row, keyed by column name. Capped (see `truncated`). */
  rows: Array<Record<string, CellValue>>
  /** 1-based sheet row number of each entry in `rows`. */
  rowNumbers: number[]
  truncated: boolean
}

export interface DocBlock {
  type: 'heading' | 'paragraph' | 'table'
  level?: number
  text?: string
  rows?: string[][]
}

export type ExtractData =
  | { format: 'sheet'; sheets: SheetData[] }
  | { format: 'document'; blocks: DocBlock[] }
  | { format: 'slides'; slides: Array<{ index: number; texts: string[]; notes?: string }> }
  | { format: 'pdf'; pages: Array<{ index: number; text: string }> }
  | { format: 'text'; text: string }

export interface IndexChunk {
  text: string
  /** False for bulk rows: keyword search only, keeps the vector table small. */
  embed: boolean
}

export interface ExtractResult {
  data: ExtractData
  /** One line describing the content, for summaries and file lists. */
  outline: string
  chunks: IndexChunk[]
  /** Something was cut to stay within the limits. */
  truncated: boolean
  via: string
}

export interface ExtractLimits {
  /** Rows kept per sheet in the JSON copy. */
  maxJsonRows: number
  /** Rows indexed per sheet. */
  maxIndexRows: number
  /** Characters of index text per file. */
  maxIndexChars: number
  /** Chunks per file that get an embedding. */
  maxEmbeddedChunks: number
  /** Refuse archives that expand beyond this (zip bombs). */
  maxUncompressedBytes: number
  /** LibreOffice / pdftotext timeout. */
  convertTimeoutMs: number
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxJsonRows: Number(process.env.MOSS_AGENTIFY_EXTRACT_MAX_JSON_ROWS) || 50_000,
  maxIndexRows: Number(process.env.MOSS_AGENTIFY_EXTRACT_MAX_INDEX_ROWS) || 3_000,
  maxIndexChars: Number(process.env.MOSS_AGENTIFY_EXTRACT_MAX_INDEX_CHARS) || 400_000,
  maxEmbeddedChunks: Number(process.env.MOSS_AGENTIFY_EXTRACT_MAX_EMBEDDED_CHUNKS) || 40,
  maxUncompressedBytes: 300 * 1024 * 1024,
  convertTimeoutMs: 120_000,
}

const CHUNK_CHARS = 500
/** Sheet XML parsed per sheet (about 200k typical rows). */
const MAX_SHEET_XML_CHARS = 60 * 1024 * 1024
const EXCEL_ERROR = /^#(N\/A|VALUE!|REF!|DIV\/0!|NAME\?|NUM!|NULL!|SPILL!|CALC!)$/
const CELL_CHARS = 200

// ------------------------------------------------------------------ helpers

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    }
    return XML_ENTITIES[e] ?? ''
  })
}

/** Concatenated text of <t>/<w:t>/<a:t> elements, skipping phonetic runs. */
function runText(xml: string, tag: 't' | 'w:t' | 'a:t'): string {
  const cleaned = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>|<${tag}(?:\\s[^>]*)?/>`, 'g')
  let out = ''
  for (const m of cleaned.matchAll(re)) out += m[1] ? unescapeXml(m[1]) : ''
  return out
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`))
  return m ? unescapeXml(m[1]!) : null
}

function colIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function colLetter(i: number): string {
  let s = ''
  let n = i + 1
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Pack lines into chunks of about CHUNK_CHARS, each starting with `prefix`. */
export function packLines(prefix: string, lines: string[], budget: { chars: number }): string[] {
  const chunks: string[] = []
  let cur = ''
  for (const line of lines) {
    if (budget.chars <= 0) break
    const l = clip(line, CHUNK_CHARS * 2)
    if (cur && cur.length + l.length + 1 > CHUNK_CHARS) {
      chunks.push(`${prefix}\n${cur}`)
      cur = ''
    }
    cur = cur ? `${cur}\n${l}` : l
    budget.chars -= l.length + 1
  }
  if (cur) chunks.push(`${prefix}\n${cur}`)
  return chunks
}

// ------------------------------------------------------------- zip access

interface ZipLike {
  files: Record<string, { dir: boolean; async(type: 'string'): Promise<string>; _data?: { uncompressedSize?: number } }>
}

async function openZip(buf: Buffer, limits: ExtractLimits): Promise<ZipLike> {
  const JSZip = (await import('jszip')).default
  const zip = (await JSZip.loadAsync(buf)) as unknown as ZipLike
  let total = 0
  for (const f of Object.values(zip.files)) total += f._data?.uncompressedSize ?? 0
  if (total > limits.maxUncompressedBytes) throw new Error(`archive expands to ${total} bytes`)
  return zip
}

async function zipText(zip: ZipLike, name: string): Promise<string | null> {
  const f = zip.files[name]
  return f && !f.dir ? f.async('string') : null
}

// ---------------------------------------------------------------- xlsx

/** Excel built-in number formats that are dates or times. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58])

function isDateFormat(code: string): boolean {
  const stripped = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')
  return /[ymdhs年月日时分秒]/i.test(stripped) && !/^[#0.,%\s]*$/.test(stripped)
}

function serialToIso(serial: number, date1904: boolean): string {
  const ms = Math.round((serial - (date1904 ? -1462 : 0) - 25569) * 86_400_000)
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return String(serial)
  const iso = d.toISOString()
  if (serial < 1 && serial >= 0) return iso.slice(11, 19) // time of day only
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19)
}

interface RawSheet {
  name: string
  hidden: boolean
  /** Sparse grid: row number (1-based) → cells by 0-based column. */
  grid: Map<number, CellValue[]>
  maxCol: number
}

export async function readXlsx(buf: Buffer, limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS): Promise<RawSheet[]> {
  const zip = await openZip(buf, limits)
  const workbook = (await zipText(zip, 'xl/workbook.xml')) ?? ''
  const date1904 = /date1904="(1|true)"/.test(workbook)
  const rels = (await zipText(zip, 'xl/_rels/workbook.xml.rels')) ?? ''
  const relTargets = new Map<string, string>()
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id')
    const target = attr(m[0], 'Target')
    if (id && target) relTargets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`)
  }

  const shared: string[] = []
  const sst = await zipText(zip, 'xl/sharedStrings.xml')
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(runText(m[1]!, 't'))

  // Which cell styles are dates.
  const dateStyles = new Set<number>()
  const styles = await zipText(zip, 'xl/styles.xml')
  if (styles) {
    const custom = new Map<number, string>()
    for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) {
      const id = Number(attr(m[0], 'numFmtId'))
      const code = attr(m[0], 'formatCode')
      if (Number.isFinite(id) && code) custom.set(id, code)
    }
    const xfs = styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? ''
    let i = 0
    for (const m of xfs.matchAll(/<xf\b[^>]*?(?:\/>|>)/g)) {
      const id = Number(attr(m[0], 'numFmtId') ?? 0)
      const code = custom.get(id)
      if (BUILTIN_DATE_FORMATS.has(id) || (code && isDateFormat(code))) dateStyles.add(i)
      i += 1
    }
  }

  const sheets: RawSheet[] = []
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name') ?? `Sheet${sheets.length + 1}`
    const rid = attr(m[0], 'r:id')
    const target = rid ? relTargets.get(rid) : undefined
    if (!target) continue
    let xml = await zipText(zip, target)
    if (xml === null) continue
    // Very large sheets: keep the first rows rather than stall the server.
    if (xml.length > MAX_SHEET_XML_CHARS) xml = xml.slice(0, xml.lastIndexOf('</row>', MAX_SHEET_XML_CHARS) + 6)
    const grid = new Map<number, CellValue[]>()
    let maxCol = 0
    let rowNo = 0
    let seenRows = 0
    for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
      // Let other requests run while a big sheet is parsed.
      if (++seenRows % 2000 === 0) await new Promise(r => setImmediate(r))
      const rAttr = attr(`<row${rm[1] ?? rm[3] ?? ''}>`, 'r')
      rowNo = rAttr ? Number(rAttr) : rowNo + 1
      if (!rm[2]) continue
      const cells: CellValue[] = []
      let col = -1
      for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = `<c${cm[1]}>`
        const ref = attr(tag, 'r')
        col = ref ? colIndex(ref) : col + 1
        const body = cm[2] ?? ''
        const t = attr(tag, 't')
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
        let value: CellValue = null
        if (t === 's') value = v !== undefined ? shared[Number(v)] ?? null : null
        else if (t === 'inlineStr') value = runText(body, 't')
        else if (t === 'str' || t === 'e') value = v !== undefined ? unescapeXml(v) : null
        else if (t === 'b') value = v === '1'
        else if (t === 'd') value = v ?? null
        else if (v !== undefined) {
          const num = Number(v)
          const style = Number(attr(tag, 's') ?? -1)
          value = Number.isFinite(num) ? (dateStyles.has(style) ? serialToIso(num, date1904) : num) : unescapeXml(v)
        }
        if (typeof value === 'string') value = value.trim()
        if (value === '' || value === null) continue
        cells[col] = value
        if (col + 1 > maxCol) maxCol = col + 1
      }
      if (cells.length > 0) grid.set(rowNo, cells)
    }
    // Merged cells: copy the top-left value across the range.
    for (const mm of xml.matchAll(/<mergeCell\b[^>]*ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/g)) {
      const c0 = colIndex(mm[1]!)
      const r0 = Number(mm[2])
      const c1 = colIndex(mm[3]!)
      const r1 = Number(mm[4])
      const v = grid.get(r0)?.[c0]
      if (v === undefined || v === null || (r1 - r0 + 1) * (c1 - c0 + 1) > 10_000) continue
      for (let r = r0; r <= r1; r++) {
        const row = grid.get(r) ?? []
        for (let c = c0; c <= c1; c++) if (row[c] === undefined || row[c] === null) row[c] = v
        grid.set(r, row)
      }
    }
    sheets.push({ name, hidden: /state="(hidden|veryHidden)"/.test(m[0]), grid, maxCol })
  }
  return sheets
}

// ---------------------------------------------------------------- csv

export function decodeText(buf: Buffer): string {
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('�')) return utf8.replace(/^﻿/, '')
  try {
    return new TextDecoder('gb18030').decode(buf)
  } catch {
    return utf8
  }
}

export function parseCsv(text: string, delimiter?: string): string[][] {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'))
  const sep = delimiter ?? ((firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? '\t' : ',')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"' && field === '') quoted = true
    else if (ch === sep) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function csvToRaw(name: string, rows: string[][]): RawSheet {
  const grid = new Map<number, CellValue[]>()
  let maxCol = 0
  rows.forEach((r, i) => {
    const cells: CellValue[] = []
    r.forEach((v, c) => {
      const t = v.trim()
      if (!t) return
      const num = /^-?\d+(\.\d+)?$/.test(t) && !(t.length > 1 && t.startsWith('0') && !t.startsWith('0.')) ? Number(t) : NaN
      cells[c] = Number.isFinite(num) ? num : t
      if (c + 1 > maxCol) maxCol = c + 1
    })
    if (cells.length > 0) grid.set(i + 1, cells)
  })
  return { name, hidden: false, grid, maxCol }
}

// ------------------------------------------------------- sheet modelling

/**
 * Find the header row: the first of the top rows whose filled cells are
 * mostly text and cover at least half the used columns. A title row above
 * it ("总仓发车时效记录表-2026年十月") becomes the caption.
 */
function findHeader(raw: RawSheet): number {
  const rowNos = [...raw.grid.keys()].sort((a, b) => a - b).slice(0, 12)
  const width = Math.max(1, ...rowNos.map(r => (raw.grid.get(r) ?? []).filter(v => v !== undefined && v !== null).length))
  for (const r of rowNos) {
    const cells = (raw.grid.get(r) ?? []).filter(v => v !== undefined && v !== null)
    const texts = cells.filter(v => typeof v === 'string' && !/^\d{4}-\d{2}-\d{2}/.test(v))
    // A title merged across the columns repeats one value; column names differ.
    const distinct = new Set(cells.map(String)).size
    if (cells.length >= Math.max(2, Math.ceil(width * 0.5)) && texts.length >= cells.length * 0.7 && distinct >= cells.length * 0.6) return r
  }
  return 0
}

export function modelSheet(raw: RawSheet, limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS): SheetData {
  const headerRow = findHeader(raw)
  const header = headerRow ? raw.grid.get(headerRow) ?? [] : []
  const names: string[] = []
  const seen = new Map<string, number>()
  for (let c = 0; c < raw.maxCol; c++) {
    let n = header[c] !== undefined && header[c] !== null ? String(header[c]).replace(/\s+/g, ' ').trim() : ''
    if (!n) n = `列${colLetter(c)}`
    const k = seen.get(n) ?? 0
    seen.set(n, k + 1)
    names.push(k ? `${n}_${k + 1}` : n)
  }
  const caption: string[] = []
  const rowNos = [...raw.grid.keys()].sort((a, b) => a - b)
  for (const r of rowNos) {
    if (headerRow && r >= headerRow) break
    caption.push([...new Set((raw.grid.get(r) ?? []).filter(v => v !== undefined && v !== null).map(String))].join(' '))
  }
  const dataRows = rowNos.filter(r => r > headerRow)
  const rows: Array<Record<string, CellValue>> = []
  const rowNumbers: number[] = []
  const stats = names.map(() => ({ num: 0, date: 0, text: 0, bool: 0, sum: 0, min: Infinity, max: -Infinity, dmin: '', dmax: '', counts: new Map<string, number>() }))
  for (const r of dataRows) {
    const cells = raw.grid.get(r) ?? []
    const rec: Record<string, CellValue> = {}
    let any = false
    cells.forEach((v, c) => {
      if (v === undefined || v === null || c >= names.length) return
      rec[names[c]!] = v
      any = true
      // Excel errors (#N/A, #REF!…) say nothing about the column's type.
      if (typeof v === 'string' && EXCEL_ERROR.test(v)) return
      const s = stats[c]!
      if (typeof v === 'number') {
        s.num++
        s.sum += v
        if (v < s.min) s.min = v
        if (v > s.max) s.max = v
      } else if (typeof v === 'boolean') s.bool++
      else if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
        s.date++
        if (!s.dmin || v < s.dmin) s.dmin = v
        if (!s.dmax || v > s.dmax) s.dmax = v
      } else s.text++
      if (typeof v !== 'number' && s.counts.size < 2000) s.counts.set(String(v), (s.counts.get(String(v)) ?? 0) + 1)
    })
    if (!any) continue
    if (rows.length < limits.maxJsonRows) {
      rows.push(rec)
      rowNumbers.push(r)
    }
  }
  const rowCount = dataRows.filter(r => (raw.grid.get(r) ?? []).some(v => v !== undefined && v !== null)).length
  const columns: SheetColumn[] = names.map((name, c) => {
    const s = stats[c]!
    const filled = s.num + s.date + s.text + s.bool
    const counts: Array<[SheetColumn['type'], number]> = [['number', s.num], ['date', s.date], ['text', s.text], ['bool', s.bool]]
    const [topType, topCount] = counts.reduce((a, b) => (b[1] > a[1] ? b : a))
    // A column is one type when at least 90% of its cells are; otherwise mixed.
    const type: SheetColumn['type'] = filled === 0 ? 'empty' : topCount >= filled * 0.9 ? topType : 'mixed'
    const col: SheetColumn = { name, type, filled }
    if (s.num) Object.assign(col, { min: s.min, max: s.max, sum: Math.round(s.sum * 1e6) / 1e6 })
    if (s.date) Object.assign(col, s.num ? {} : { min: s.dmin, max: s.dmax })
    if (s.text || s.bool) {
      col.distinct = s.counts.size
      // Repeated values (categories) are worth listing; for unique values
      // (ids, order numbers) one example shows the format, and the rows hold the rest.
      const unique = s.counts.size >= s.text + s.bool
      col.top = [...s.counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, unique ? 1 : 5).map(([k]) => clip(k, 40))
    }
    return col
  }).filter(c => c.filled > 0 || headerRow > 0)
  return { name: raw.name, hidden: raw.hidden || undefined, caption, headerRow, columns, rowCount, rows, rowNumbers, truncated: rows.length < rowCount }
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

export function describeColumn(c: SheetColumn): string {
  if (c.type === 'number' && c.min !== undefined) return `${c.name}（数值，${fmtNum(c.min as number)}~${fmtNum(c.max as number)}，合计 ${fmtNum(c.sum ?? 0)}）`
  if (c.type === 'date' && c.min !== undefined) return `${c.name}（日期，${c.min}~${c.max}）`
  if (c.top && c.top.length === 1 && (c.distinct ?? 0) > 1 && c.distinct === c.filled) return `${c.name}（${c.distinct} 个不同值，如 ${c.top[0]}）`
  if (c.top && c.top.length > 0) return `${c.name}（${c.distinct} 种，如 ${c.top.slice(0, 3).join('/')}）`
  return c.name
}

function sheetChunks(file: string, sheets: SheetData[], limits: ExtractLimits): { chunks: IndexChunk[]; truncated: boolean } {
  const chunks: IndexChunk[] = []
  const budget = { chars: limits.maxIndexChars }
  let truncated = false
  for (const s of sheets) {
    const head = `「${file}」工作表「${s.name}」`
    // Profile: what the sheet is, its columns with types, ranges and totals.
    const first = `${head}：${s.rowCount} 行数据 × ${s.columns.length} 列${s.headerRow ? `（表头在第 ${s.headerRow} 行）` : ''}${s.truncated ? '，JSON 副本只保留前面的行' : ''}`
    const profileLines = [
      ...(s.caption.length ? [`标题：${clip(s.caption.join('；'), 300)}`] : []),
      ...s.columns.map(c => `列 ${describeColumn(c)}`),
    ]
    chunks.push(...packLines(first, profileLines.length ? profileLines : ['（无列）'], budget).map(text => ({ text, embed: true })))
    const lines: string[] = []
    s.rows.slice(0, limits.maxIndexRows).forEach((rec, i) => {
      const parts = Object.entries(rec).map(([k, v]) => `${k}=${clip(String(v), CELL_CHARS)}`)
      lines.push(`第${s.rowNumbers[i]}行：${parts.join('｜')}`)
    })
    if (s.rowCount > Math.min(s.rows.length, limits.maxIndexRows)) truncated = true
    chunks.push(...packLines(head, lines, budget).map(text => ({ text, embed: false })))
  }
  if (budget.chars <= 0) truncated = true
  return { chunks, truncated }
}

// ---------------------------------------------------------------- docx

export async function readDocx(buf: Buffer, limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS): Promise<DocBlock[]> {
  const zip = await openZip(buf, limits)
  const doc = (await zipText(zip, 'word/document.xml')) ?? ''
  const styles = (await zipText(zip, 'word/styles.xml')) ?? ''
  const headingStyles = new Map<string, number>()
  for (const m of styles.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const name = m[2]!.match(/<w:name w:val="([^"]+)"/)?.[1] ?? ''
    const lvl = name.match(/^(?:heading|标题)\s*(\d)$/i)?.[1] ?? m[2]!.match(/<w:outlineLvl w:val="(\d)"/)?.[1]
    if (lvl !== undefined) headingStyles.set(m[1]!, /^\d$/.test(lvl) && !/heading|标题/i.test(name) ? Number(lvl) + 1 : Number(lvl))
  }
  const body = doc.match(/<w:body>([\s\S]*)<\/w:body>/)?.[1] ?? doc
  const blocks: DocBlock[] = []
  const paraText = (p: string) => p
    .replace(/<w:tab\/>/g, '<w:t>\t</w:t>')
    .replace(/<w:br\/>/g, '<w:t>\n</w:t>')
  // Walk top-level tables and paragraphs in order. Tables may nest; track depth.
  let i = 0
  while (i < body.length) {
    const nextTbl = body.indexOf('<w:tbl>', i)
    const nextP = body.slice(i).search(/<w:p[\s>]/)
    const pAt = nextP === -1 ? -1 : i + nextP
    if (nextTbl !== -1 && (pAt === -1 || nextTbl < pAt)) {
      // Find the matching </w:tbl> (tables can nest).
      let depth = 0
      const re = /<w:tbl>|<\/w:tbl>/g
      re.lastIndex = nextTbl
      let m: RegExpExecArray | null
      let end = body.length
      while ((m = re.exec(body))) {
        depth += m[0] === '<w:tbl>' ? 1 : -1
        if (depth === 0) {
          end = m.index + m[0].length
          break
        }
      }
      const tbl = body.slice(nextTbl, end)
      const rows: string[][] = []
      for (const rm of tbl.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g)) {
        const cells = [...rm[0].matchAll(/<w:tc[\s>][\s\S]*?<\/w:tc>/g)].map(c => runText(paraText(c[0]), 'w:t').replace(/\s+/g, ' ').trim())
        if (cells.some(Boolean)) rows.push(cells)
      }
      if (rows.length) blocks.push({ type: 'table', rows })
      i = end
    } else if (pAt !== -1) {
      const end = body.indexOf('</w:p>', pAt)
      const p = body.slice(pAt, end === -1 ? body.length : end + 6)
      const text = runText(paraText(p), 'w:t').trim()
      const style = p.match(/<w:pStyle w:val="([^"]+)"/)?.[1]
      const level = style ? headingStyles.get(style) : undefined
      if (text) blocks.push(level ? { type: 'heading', level, text } : { type: 'paragraph', text })
      i = end === -1 ? body.length : end + 6
    } else break
  }
  return blocks
}

function tableLines(rows: string[][]): string[] {
  const header = rows[0] ?? []
  const looksLikeHeader = rows.length > 1 && header.every(h => h.length > 0 && h.length <= 40)
  if (!looksLikeHeader) return rows.map(r => r.join(' | '))
  return rows.slice(1).map((r, i) => `第${i + 1}行：${r.map((v, c) => (v ? `${header[c] || `列${c + 1}`}=${clip(v, CELL_CHARS)}` : '')).filter(Boolean).join('｜')}`)
}

function documentChunks(file: string, blocks: DocBlock[], limits: ExtractLimits): IndexChunk[] {
  const chunks: IndexChunk[] = []
  const budget = { chars: limits.maxIndexChars }
  let heading = ''
  let lines: string[] = []
  const flush = () => {
    if (lines.length) chunks.push(...packLines(`「${file}」${heading ? `「${heading}」` : ''}`, lines, budget).map(text => ({ text, embed: true })))
    lines = []
  }
  for (const b of blocks) {
    if (b.type === 'heading') {
      flush()
      heading = clip(b.text ?? '', 60)
      lines.push(b.text ?? '')
    } else if (b.type === 'paragraph') lines.push(b.text ?? '')
    else if (b.rows) {
      flush()
      chunks.push(...packLines(`「${file}」${heading ? `「${heading}」` : ''}表格`, tableLines(b.rows), budget).map(text => ({ text, embed: true })))
    }
  }
  flush()
  return chunks
}

// ---------------------------------------------------------------- pptx

export async function readPptx(buf: Buffer, limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS): Promise<Array<{ index: number; texts: string[]; notes?: string }>> {
  const zip = await openZip(buf, limits)
  const slideNames = Object.keys(zip.files)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/g)!.pop()) - Number(b.match(/\d+/g)!.pop()))
  const slides: Array<{ index: number; texts: string[]; notes?: string }> = []
  for (const name of slideNames) {
    const xml = (await zipText(zip, name)) ?? ''
    const texts = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map(m => runText(m[1]!, 'a:t').trim()).filter(Boolean)
    const n = Number(name.match(/slide(\d+)\.xml$/)![1])
    const notesXml = await zipText(zip, `ppt/notesSlides/notesSlide${n}.xml`)
    const notes = notesXml ? [...notesXml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map(m => runText(m[1]!, 'a:t').trim()).filter(t => t && !/^\d+$/.test(t)).join('\n') : ''
    slides.push({ index: n, texts, ...(notes ? { notes } : {}) })
  }
  return slides
}

// ------------------------------------------------------------- converters

let sofficePromise: Promise<string | null> | null = null

async function sofficeBin(): Promise<string | null> {
  sofficePromise ??= (async () => {
    for (const c of [process.env.LIBREOFFICE_BIN, '/usr/bin/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice', 'soffice', 'libreoffice']) {
      if (!c) continue
      try {
        await execFileAsync(c, ['--version'], { timeout: 10_000 })
        return c
      } catch {
        // next
      }
    }
    return null
  })()
  return sofficePromise
}

/** Convert with LibreOffice (e.g. xls → xlsx). Returns null when unavailable or failed. */
export async function convertWithLibreOffice(buf: Buffer, ext: string, target: 'xlsx' | 'docx' | 'pptx', limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS): Promise<Buffer | null> {
  const bin = await sofficeBin()
  if (!bin) return null
  const dir = path.join(tmpdir(), `moss-extract-${randomUUID()}`)
  await mkdir(dir, { recursive: true })
  try {
    const src = path.join(dir, `input${ext}`)
    await writeFile(src, buf)
    // A private profile directory lets conversions run side by side.
    await execFileAsync(bin, [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', target, '--outdir', dir, src], { timeout: limits.convertTimeoutMs })
    return await readFile(path.join(dir, `input.${target}`))
  } catch {
    return null
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function pdfPages(buf: Buffer, limits: ExtractLimits): Promise<string[] | null> {
  const dir = path.join(tmpdir(), `moss-extract-${randomUUID()}`)
  await mkdir(dir, { recursive: true })
  try {
    const src = path.join(dir, 'input.pdf')
    await writeFile(src, buf)
    await execFileAsync('pdftotext', ['-layout', '-enc', 'UTF-8', src, path.join(dir, 'out.txt')], { timeout: limits.convertTimeoutMs })
    const text = await readFile(path.join(dir, 'out.txt'), 'utf8')
    return text.split('\f').map(p => p.replace(/[ \t]+\n/g, '\n').trim())
  } catch {
    return null
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

// ------------------------------------------------------------------ entry

const TEXT_EXT = /^\.(md|markdown|txt|json|jsonl|ya?ml|html?|xml|log|sql|py|js|ts|sh|ini|toml|conf)$/i

export function isExtractable(name: string): boolean {
  return /\.(xlsx|xlsm|xls|ods|et|csv|tsv|docx|doc|rtf|odt|wps|pptx|ppt|odp|dps|pdf)$/i.test(name) || TEXT_EXT.test(path.extname(name))
}

/**
 * Extract a file's content. `name` is the display name (used in chunk
 * prefixes and to pick the parser); content sniffing overrides a wrong
 * extension for zip and pdf files.
 */
export async function extractFile(buf: Buffer, name: string, limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS): Promise<ExtractResult | null> {
  let ext = path.extname(name).toLowerCase()
  const isZip = buf.length > 4 && buf.readUInt32BE(0) === 0x504b0304
  const isPdf = buf.subarray(0, 5).toString('latin1') === '%PDF-'
  if (isPdf) ext = '.pdf'
  try {
    if (['.xls', '.ods', '.et'].includes(ext) || (ext === '.xlsx' && !isZip)) {
      const converted = await convertWithLibreOffice(buf, ext === '.xlsx' ? '.xls' : ext, 'xlsx', limits)
      return converted ? withVia(await extractKnown(converted, name, '.xlsx', limits, 'xlsx'), 'libreoffice') : null
    }
    if (['.doc', '.rtf', '.odt', '.wps'].includes(ext)) {
      const converted = await convertWithLibreOffice(buf, ext, 'docx', limits)
      return converted ? withVia(await extractKnown(converted, name, '.docx', limits, 'docx'), 'libreoffice') : null
    }
    if (['.ppt', '.odp', '.dps'].includes(ext)) {
      const converted = await convertWithLibreOffice(buf, ext, 'pptx', limits)
      return converted ? withVia(await extractKnown(converted, name, '.pptx', limits, 'pptx'), 'libreoffice') : null
    }
    return await extractKnown(buf, name, ext, limits)
  } catch (err) {
    console.warn(`[agentify] could not extract ${name}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

function withVia(r: ExtractResult | null, via: string): ExtractResult | null {
  return r ? { ...r, via: `${via}+${r.via}` } : null
}

async function extractKnown(buf: Buffer, name: string, ext: string, limits: ExtractLimits, forced?: 'xlsx' | 'docx' | 'pptx'): Promise<ExtractResult | null> {
  const kind = forced ?? (ext === '.xlsx' || ext === '.xlsm' ? 'xlsx' : ext === '.docx' ? 'docx' : ext === '.pptx' ? 'pptx' : null)
  const file = path.basename(name)
  if (kind === 'xlsx' || ext === '.csv' || ext === '.tsv') {
    const raws = kind === 'xlsx' ? await readXlsx(buf, limits) : [csvToRaw(file.replace(/\.[^.]+$/, ''), parseCsv(decodeText(buf), ext === '.tsv' ? '\t' : undefined))]
    const sheets = raws.map(r => modelSheet(r, limits)).filter(s => s.rowCount > 0 || s.caption.length > 0 || s.columns.length > 0)
    if (sheets.length === 0) return null
    const { chunks, truncated } = sheetChunks(file, sheets, limits)
    markEmbedded(chunks, limits)
    const outline = sheets.map(s => `「${s.name}」${s.rowCount} 行×${s.columns.length} 列（${s.columns.slice(0, 6).map(c => c.name).join('、')}${s.columns.length > 6 ? '…' : ''}）`).join('；')
    return { data: { format: 'sheet', sheets }, outline: `${sheets.length} 个工作表：${outline}`, chunks, truncated: truncated || sheets.some(s => s.truncated), via: kind === 'xlsx' ? 'xlsx' : 'csv' }
  }
  if (kind === 'docx') {
    const blocks = await readDocx(buf, limits)
    if (blocks.length === 0) return null
    const chunks = documentChunks(file, blocks, limits)
    markEmbedded(chunks, limits)
    const headings = blocks.filter(b => b.type === 'heading').map(b => b.text!).slice(0, 6)
    const tables = blocks.filter(b => b.type === 'table').length
    return { data: { format: 'document', blocks }, outline: `文档：${blocks.length} 段${tables ? `，${tables} 个表格` : ''}${headings.length ? `，章节 ${headings.join('、')}` : ''}`, chunks, truncated: false, via: 'docx' }
  }
  if (kind === 'pptx') {
    const slides = await readPptx(buf, limits)
    if (slides.length === 0) return null
    const budget = { chars: limits.maxIndexChars }
    const chunks = slides.flatMap(s => packLines(`「${file}」第${s.index}页`, [...s.texts, ...(s.notes ? [`备注：${s.notes}`] : [])], budget).map(text => ({ text, embed: true })))
    markEmbedded(chunks, limits)
    return { data: { format: 'slides', slides }, outline: `演示文稿：${slides.length} 页，${slides.slice(0, 4).map(s => s.texts[0]).filter(Boolean).join('、')}`, chunks, truncated: budget.chars <= 0, via: 'pptx' }
  }
  if (ext === '.pdf') {
    const pages = await pdfPages(buf, limits)
    if (!pages || pages.every(p => !p)) return null
    const budget = { chars: limits.maxIndexChars }
    const chunks = pages.flatMap((p, i) => (p ? packLines(`「${file}」第${i + 1}页`, p.split(/\n{2,}/), budget).map(text => ({ text, embed: true })) : []))
    markEmbedded(chunks, limits)
    return { data: { format: 'pdf', pages: pages.map((text, i) => ({ index: i + 1, text })) }, outline: `PDF：${pages.filter(Boolean).length} 页`, chunks, truncated: budget.chars <= 0, via: 'pdftotext' }
  }
  if (TEXT_EXT.test(ext)) {
    const text = decodeText(buf)
    if (!text.trim()) return null
    const budget = { chars: limits.maxIndexChars }
    const chunks = packLines(`「${file}」`, text.split(/\n{2,}/), budget).map(t => ({ text: t, embed: true }))
    markEmbedded(chunks, limits)
    return { data: { format: 'text', text: text.length > limits.maxIndexChars ? text.slice(0, limits.maxIndexChars) : text }, outline: `文本：${text.length} 字`, chunks, truncated: budget.chars <= 0, via: 'text' }
  }
  return null
}

/** Only the first chunks get vectors; the rest stay keyword-searchable. */
function markEmbedded(chunks: IndexChunk[], limits: ExtractLimits): void {
  let n = 0
  for (const c of chunks) {
    if (c.embed && n < limits.maxEmbeddedChunks) n++
    else c.embed = false
  }
}
