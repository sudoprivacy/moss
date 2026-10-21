import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { WikiSourceSnapshot } from '../wikiSourceSnapshot.js'
import { HttpError } from '../httpRespond.js'

interface SourceMeta {
  wikiId: string
  builtAt: number
  sourceDocuments: WikiSourceSnapshot[]
}

export interface PolicyMatch {
  file: string
  document_id: string
  wiki_id: string
  version: string
  line_no: number
  end_line: number
  line: string
}

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const genericTerms = new Set(['政策', '优惠', '有', '有哪些', '哪些', '什么', '多少', '如何', '怎么', '请', '介绍', '一下', '园区', '的', '吗', '呢', '我', '想', '了解', '现在', '目前', '支持', '条件', '申请', '规定', '相关', '具体', '详细'])

function queryTerms(query: string): string[] {
  return [...new Set([...segmenter.segment(query.toLowerCase())]
    .filter(part => part.isWordLike && !genericTerms.has(part.segment))
    .map(part => part.segment))]
}

function sections(markdown: string): Array<{ start: number; end: number; text: string }> {
  const lines = markdown.split(/\r?\n/)
  const starts = [0]
  for (let i = 1; i < lines.length; i++) if (/^#{1,6}\s/.test(lines[i]!)) starts.push(i)
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length
    return { start: start + 1, end, text: lines.slice(start, end).join('\n').trim() }
  }).filter(section => section.text.length > 0)
}

/** Read one complete published source generation; never fall back to live uploads. */
export async function searchParkPolicySources(wikiPath: string, wikiId: string, query: string): Promise<PolicyMatch[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await readFile(join(wikiPath, '_moss_meta.json'), 'utf8')
      const meta = JSON.parse(raw) as SourceMeta
      if (meta.wikiId !== wikiId || !Number.isFinite(meta.builtAt) || !Array.isArray(meta.sourceDocuments)) throw new Error('Invalid source metadata')
      const sources: Array<{ source: WikiSourceSnapshot; markdown: string }> = []
      for (const source of meta.sourceDocuments) {
        if (!source.markdownPath || !source.markdownSha256) throw new Error('政策原文映射缺失，请重新构建知识库')
        if (source.markdownPath !== `_sources/${source.id}.md`) throw new Error('Invalid source path')
        const root = await realpath(wikiPath)
        const file = await realpath(resolve(wikiPath, source.markdownPath))
        const rel = relative(root, file)
        if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Invalid source path')
        const bytes = await readFile(file)
        if (createHash('sha256').update(bytes).digest('hex') !== source.markdownSha256) throw new Error('政策正文校验失败，请重新构建知识库')
        sources.push({ source, markdown: bytes.toString('utf8') })
      }
      // A concurrent publish must not produce a response mixing generations.
      if (raw !== await readFile(join(wikiPath, '_moss_meta.json'), 'utf8')) continue
      const terms = queryTerms(query)
      const ranked = sources.map(item => {
        const title = `${item.source.fileName}\n${item.markdown.split(/\r?\n/).find(line => /^#\s/.test(line)) ?? ''}`.toLowerCase()
        const body = item.markdown.toLowerCase()
        const isExact = title.includes(query.toLowerCase()) || body.includes(query.toLowerCase())
        const isRelevant = terms.length > 0 && terms.every(term => body.includes(term) || title.includes(term))
        const titleHits = terms.filter(term => title.includes(term)).length
        const score = (isExact ? 10 : 0) + terms.reduce((sum, term) => sum + (body.includes(term) ? 1 : 0), 0)
        return { ...item, titleHits, score, isRelevant: isExact || isRelevant || (terms.length === 0 && /政策|优惠/.test(query)) }
      }).filter(item => item.isRelevant).sort((a, b) => b.titleHits - a.titleHits || b.score - a.score)
      // Return complete sections, including tables and qualifications. Title
      // matches carry the entire policy so overview answers retain conditions.
      const matches: PolicyMatch[] = []
      const seen = new Set<string>()
      // Prefer policies addressing the topic in their title over incidental
      // mentions in FAQs or other policies, without cutting qualifying clauses.
      const titleHits = ranked[0]?.titleHits ?? 0
      for (const item of ranked.filter(item => titleHits === 0 || item.titleHits === titleHits).slice(0, 4)) {
        const hash = item.source.markdownSha256!
        if (seen.has(hash)) continue
        seen.add(hash)
        for (const section of sections(item.markdown)) {
          matches.push({ file: item.source.fileName, document_id: item.source.id, wiki_id: wikiId,
            version: `wiki-${new Date(meta.builtAt).toISOString()}`, line_no: section.start,
            end_line: section.end, line: section.text })
        }
      }
      return matches
    } catch (error) {
      if (attempt === 2) throw new HttpError(503, error instanceof Error ? error.message : 'Policy source unavailable')
    }
  }
  throw new HttpError(503, 'Policy build changed during query; retry')
}
