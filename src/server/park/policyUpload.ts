import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import JSZip from 'jszip'
import { HttpError } from '../httpError.js'
import { parseDocument } from '../sources/docParsers.js'

export const POLICY_FILE_EXTENSIONS = ['.txt', '.md', '.markdown', '.docx', '.pdf'] as const
export const POLICY_FILE_MAX_BYTES = 50 * 1024 * 1024

/** Reject unusable policy sources before the document store creates a record. */
export async function validatePolicyUpload(fileName: string, content: Buffer): Promise<void> {
  const extension = extname(fileName).toLowerCase()
  if (!POLICY_FILE_EXTENSIONS.some(value => value === extension)) {
    throw new HttpError(400, '仅支持 TXT、MD、MARKDOWN、DOCX、PDF 政策文件。')
  }
  if (!content.byteLength) throw new HttpError(400, '文件内容为空，无法上传。')
  if (content.byteLength > POLICY_FILE_MAX_BYTES) throw new HttpError(413, '文件超过 50MB，无法上传。')

  try {
    if (extension === '.docx') {
      const archive = await JSZip.loadAsync(content)
      if (!archive.file('word/document.xml')) throw new Error('Invalid DOCX')
    } else if (extension === '.pdf') {
      if (content.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('Invalid PDF')
    } else {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(content)
      if (!text.trim() || text.startsWith('%PDF-') || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/u.test(text)) {
        throw new Error('Invalid text')
      }
    }
  } catch {
    throw new HttpError(400, '文件格式校验失败；文本文件须使用 UTF-8 编码。')
  }

  const directory = await mkdtemp(join(tmpdir(), 'park-policy-upload-'))
  try {
    const filePath = join(directory, basename(fileName))
    await writeFile(filePath, content)
    const parsed = await parseDocument(filePath, fileName)
    if (!parsed?.markdown.trim()) {
      throw new HttpError(400, '无法提取有效正文，不能用于知识库构建。')
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
