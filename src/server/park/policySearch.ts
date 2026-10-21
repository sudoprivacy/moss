import { HttpError } from '../httpRespond.js'
import { readPolicySources, type VerifiedPolicySource } from './policySources.js'

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
export async function searchParkPolicySources(wikiPath: string, wikiId: string, query: string, onSources?: (matches: PolicyMatch[], bodies: VerifiedPolicySource[]) => Promise<void>): Promise<PolicyMatch[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const sources = await readPolicySources(wikiPath, wikiId)
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
            version: item.version, line_no: section.start,
            end_line: section.end, line: section.text })
        }
      }
      await onSources?.(matches, sources)
      return matches
    } catch (error) {
      if (attempt === 2) throw new HttpError(503, error instanceof Error ? error.message : 'Policy source unavailable')
    }
  }
  throw new HttpError(503, 'Policy build changed during query; retry')
}
