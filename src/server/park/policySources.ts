import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { WikiSourceSnapshot } from '../wikiSourceSnapshot.js'

export interface VerifiedPolicySource {
  source: WikiSourceSnapshot
  markdown: string
  version: string
}

/** Read and verify one published generation, including its complete source bodies. */
export async function readPolicySources(
  wikiPath: string,
  wikiId: string,
): Promise<VerifiedPolicySource[]> {
  const raw = await readFile(join(wikiPath, '_moss_meta.json'), 'utf8')
  const meta = JSON.parse(raw) as {
    wikiId: string
    builtAt: number
    sourceDocuments: WikiSourceSnapshot[]
  }
  if (
    meta.wikiId !== wikiId ||
    !Number.isFinite(meta.builtAt) ||
    !Array.isArray(meta.sourceDocuments)
  )
    throw new Error('Invalid source metadata')
  const sources: VerifiedPolicySource[] = []
  const root = await realpath(wikiPath)
  for (const source of meta.sourceDocuments) {
    if (!source.markdownPath || !source.markdownSha256)
      throw new Error('政策原文映射缺失，请重新构建知识库')
    if (source.markdownPath !== `_sources/${source.id}.md`) throw new Error('Invalid source path')
    const file = await realpath(resolve(wikiPath, source.markdownPath))
    const rel = relative(root, file)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
      throw new Error('Invalid source path')
    const bytes = await readFile(file)
    if (createHash('sha256').update(bytes).digest('hex') !== source.markdownSha256)
      throw new Error('政策正文校验失败，请重新构建知识库')
    sources.push({
      source,
      markdown: bytes.toString('utf8'),
      version: `wiki-${new Date(meta.builtAt).toISOString()}`,
    })
  }
  if (raw !== (await readFile(join(wikiPath, '_moss_meta.json'), 'utf8')))
    throw new Error('Policy build changed during query; retry')
  return sources
}
