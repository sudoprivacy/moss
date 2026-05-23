/**
 * Document Center v2 — Document parsers.
 *
 * Convert binary office formats (docx/pdf/xlsx/pptx) to markdown so the
 * wiki-builder agent (and embedding-based retrieval, eventually) can
 * read them as plain text.
 *
 * Strategy:
 *   1. `.docx` → mammoth (pure-JS, fast, preserves headings/lists/images)
 *      Dynamically imported so moss runs without the dep installed.
 *   2. `.pdf`  → pdf-parse (pure-JS, no system deps).
 *      Same dynamic-import pattern.
 *   3. `.xlsx`/`.pptx` and anything else mammoth/pdf-parse don't handle
 *      → call `libreoffice --headless --convert-to txt` if available on
 *      PATH. Falls back to "binary, skipped" if libreoffice is missing.
 *
 * All parsers are best-effort and never throw past this module — failures
 * return null and the caller (WikiJobExecutor.prepareInputs) staging
 * loop keeps going.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile, writeFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { fileURLToPath } from 'url'

const execFileAsync = promisify(execFile)

let libreOfficeBinPromise: Promise<string | null> | null = null

function currentModuleDir(): string | null {
  try {
    return path.dirname(fileURLToPath(import.meta.url))
  } catch {
    return null
  }
}

export type ParseResult = {
  /** UTF-8 markdown content suitable for direct write into wiki input/ */
  markdown: string
  /** Files generated alongside (e.g. extracted images) for the caller to also write. */
  attachments?: Array<{ name: string; bytes: Buffer }>
  /** Parser identifier (for debugging / meta logs). */
  via: 'passthrough' | 'mammoth' | 'pdf-parse' | 'libreoffice'
}

/**
 * Sniff the first 8 bytes of a file to detect binary formats whose
 * extension was lying — e.g. a docx renamed to `.md`. Returns the
 * format hint or null if it's plain text / unknown.
 *
 * Magic numbers:
 *   ZIP / docx / xlsx / pptx / odt — `50 4B 03 04` (`PK..`)
 *   PDF                            — `25 50 44 46` (`%PDF`)
 *   OLE / legacy .doc              — `D0 CF 11 E0`
 */
async function sniffMagic(filePath: string): Promise<'zip' | 'pdf' | 'ole' | null> {
  try {
    const handle = await import('fs/promises').then((m) => m.open(filePath, 'r'))
    try {
      const buf = Buffer.alloc(8)
      const { bytesRead } = await handle.read(buf, 0, 8, 0)
      if (bytesRead < 4) return null
      if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'zip'
      if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'pdf'
      if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return 'ole'
      return null
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/**
 * Convert a document to markdown. Returns null if no available parser
 * recognises the extension or if conversion failed.
 *
 * Note: before falling into the .md/.txt passthrough we sniff the
 * first few bytes — files whose extension lies (e.g. a docx renamed
 * `.md` for sloppy convenience, common in shared drives) get routed
 * to mammoth/pdf-parse/libreoffice based on actual content, not the
 * misleading extension.
 */
export async function parseDocument(
  filePath: string,
  fileName: string,
): Promise<ParseResult | null> {
  const ext = path.extname(fileName).toLowerCase()

  // Content sniff overrides extension when they disagree.
  const magic = await sniffMagic(filePath)
  if (magic === 'zip') {
    // Try mammoth first (.docx), fall through to libreoffice for xlsx/pptx
    const r = await parseDocxWithMammoth(filePath).catch(() => null)
    if (r) return r
    return parseWithLibreOffice(filePath, fileName).catch(() => null)
  }
  if (magic === 'pdf') {
    const r = await parsePdfWithPdfParse(filePath).catch(() => null)
    if (r) return r
    return parseWithLibreOffice(filePath, fileName).catch(() => null)
  }
  if (magic === 'ole') {
    // legacy .doc / .xls / .ppt — libreoffice handles
    return parseWithLibreOffice(filePath, fileName).catch(() => null)
  }

  if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
    const content = await readFile(filePath, 'utf8').catch(() => null)
    if (content == null) return null
    return { markdown: content, via: 'passthrough' }
  }

  if (ext === '.docx') {
    const r = await parseDocxWithMammoth(filePath).catch(() => null)
    if (r) return r
    // mammoth missing or threw — fall through to libreoffice
  }

  if (ext === '.pdf') {
    const r = await parsePdfWithPdfParse(filePath).catch(() => null)
    if (r) return r
  }

  // Generic libreoffice fallback handles .doc/.xlsx/.pptx/.odt/.rtf and
  // also serves as the second-attempt path for .docx/.pdf above.
  return parseWithLibreOffice(filePath, fileName).catch(() => null)
}

function docImageExtension(contentType: string | undefined): string {
  switch (String(contentType || '').toLowerCase()) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/gif':
      return 'gif'
    case 'image/svg+xml':
      return 'svg'
    case 'image/tiff':
      return 'tiff'
    case 'image/webp':
      return 'webp'
    default:
      return 'bin'
  }
}

function docImageBaseName(filePath: string): string {
  const baseName = path.basename(filePath, path.extname(filePath)).trim()
  const sanitized = baseName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/\s+/g, '-').trim()
  return sanitized || 'image'
}

async function parseDocxWithMammoth(filePath: string): Promise<ParseResult | null> {
  let mammoth: typeof import('mammoth') | null
  try {
    mammoth = (await import('mammoth')) as typeof import('mammoth')
  } catch {
    return null
  }
  if (!mammoth) return null

  const attachments: Array<{ name: string; bytes: Buffer }> = []
  const imageBaseName = docImageBaseName(filePath)
  let imageIndex = 0

  // convertToMarkdown returns { value, messages }
  const result = await mammoth.convertToMarkdown(
    { path: filePath },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        imageIndex += 1
        const ext = docImageExtension(image.contentType)
        const imageName = path.posix.join(
          'images',
          `${imageBaseName}-${String(imageIndex).padStart(3, '0')}.${ext}`,
        )
        attachments.push({
          name: imageName,
          bytes: await image.readAsBuffer(),
        })
        return { src: imageName }
      }),
    },
  )
  const markdown = String(result?.value ?? '').trim()
  if (!markdown) return null
  return {
    markdown,
    attachments: attachments.length > 0 ? attachments : undefined,
    via: 'mammoth',
  }
}

async function parsePdfWithPdfParse(filePath: string): Promise<ParseResult | null> {
  let pdfParse: ((data: Buffer) => Promise<{ text: string }>) | null
  try {
    const mod = (await import('pdf-parse')) as { default?: unknown } & Record<string, unknown>
    const candidate =
      (typeof mod === 'function' ? mod : null) ??
      (typeof mod.default === 'function' ? (mod.default as unknown) : null)
    pdfParse = candidate as ((data: Buffer) => Promise<{ text: string }>) | null
  } catch {
    return null
  }
  if (!pdfParse) return null

  const bytes = await readFile(filePath)
  const out = await pdfParse(bytes)
  const text = String(out?.text ?? '').trim()
  if (!text) return null
  return { markdown: text, via: 'pdf-parse' }
}

async function resolveLibreOfficeBin(): Promise<string | null> {
  if (!libreOfficeBinPromise) {
    libreOfficeBinPromise = (async () => {
      const moduleDir = currentModuleDir()
      const candidates = [
        process.env.LIBREOFFICE_BIN,
        moduleDir ? path.join(moduleDir, 'soffice') : null,
        moduleDir ? path.join(moduleDir, 'libreoffice') : null,
        path.join(process.cwd(), 'bin', 'soffice'),
        path.join(process.cwd(), 'bin', 'libreoffice'),
        path.join(path.dirname(process.execPath), 'soffice'),
        path.join(path.dirname(process.execPath), 'libreoffice'),
        '/Applications/LibreOffice.app/Contents/MacOS/soffice',
        '/Applications/OpenOffice.app/Contents/MacOS/soffice',
        'soffice',
        'libreoffice',
      ].filter((v): v is string => typeof v === 'string' && v.length > 0)

      for (const candidate of candidates) {
        try {
          await execFileAsync(candidate, ['--version'], { timeout: 5_000 })
          return candidate
        } catch {
          // try next candidate
        }
      }
      return null
    })()
  }
  return libreOfficeBinPromise
}

async function parseWithLibreOffice(
  filePath: string,
  fileName: string,
): Promise<ParseResult | null> {
  // LibreOffice can convert to markdown directly on modern releases; we
  // ask for txt for max compatibility, then prepend a single H1 derived
  // from the file name so chunks have at least one heading.
  const sofficeBin = await resolveLibreOfficeBin()
  if (!sofficeBin) return null

  // Make a temp work dir so concurrent jobs don't collide on output names.
  const workDir = path.join(tmpdir(), `moss-conv-${randomUUID()}`)
  await mkdir(workDir, { recursive: true })

  try {
    await execFileAsync(sofficeBin, [
      '--headless',
      '--convert-to',
      'txt:Text (encoded):UTF8',
      '--outdir',
      workDir,
      filePath,
    ], { timeout: 60_000 })
  } catch (err) {
    // Either soffice is missing, or it errored. Either way, can't proceed.
    return null
  }

  const baseName = path.basename(fileName, path.extname(fileName))
  const outPath = path.join(workDir, `${baseName}.txt`)

  let text: string
  try {
    text = await readFile(outPath, 'utf8')
  } catch {
    return null
  } finally {
    // Best-effort cleanup; tmp will get GC'd anyway.
    rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }

  const trimmed = text.trim()
  if (!trimmed) return null

  const title = baseName.replace(/[_-]+/g, ' ')
  return {
    markdown: `# ${title}\n\n${trimmed}\n`,
    via: 'libreoffice',
  }
}

/**
 * Convenience: parse a doc and write the markdown (+ any attachments)
 * into `outDir`. Returns the relative file path written, or null on
 * failure.
 */
export async function parseAndWrite(
  filePath: string,
  fileName: string,
  outDir: string,
): Promise<{ writtenPath: string; via: ParseResult['via'] } | null> {
  const parsed = await parseDocument(filePath, fileName)
  if (!parsed) return null

  const baseName = path.basename(fileName, path.extname(fileName))
  const mdName = `${baseName}.md`
  const mdPath = path.join(outDir, mdName)

  await writeFile(mdPath, parsed.markdown, 'utf8')

  if (parsed.attachments) {
    for (const a of parsed.attachments) {
      const attachmentPath = path.join(outDir, a.name)
      await mkdir(path.dirname(attachmentPath), { recursive: true })
      await writeFile(attachmentPath, a.bytes)
    }
  }

  return { writtenPath: mdPath, via: parsed.via }
}
