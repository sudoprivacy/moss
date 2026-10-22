import { mergeSourceRanges, type ConsultationSource } from './consultationSources.js'

/** Only explicit document/line citations within retained ranges count as verified. */
export function verifyAnswerCitations(answer: string, refs: ConsultationSource[]): ConsultationSource[] {
  const unique = new Map<string, ConsultationSource>()
  for (const ref of refs) {
    const key = JSON.stringify([ref.document_id, ref.wiki_id, ref.version, ref.name])
    const previous = unique.get(key)
    unique.set(key, { ...ref, ranges: mergeSourceRanges([...(previous?.ranges ?? []), ...(ref.ranges ?? [])]) })
  }
  const retained = [...unique.values()]
  return retained.map(ref => {
    const escaped = ref.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`${escaped}[》」\\]）)]?\\s*(?:[，,:：]\\s*)?第\\s*(\\d+)\\s*(?:[—–~～-]\\s*(\\d+)\\s*)?行`, 'g')
    const sameName = new Set(retained.filter(item => item.name === ref.name).map(item => JSON.stringify([item.document_id, item.wiki_id, item.version])))
    const ranges = ref.ranges ?? []
    const isVerified = Boolean(ref.document_id && sameName.size === 1 && [...answer.matchAll(pattern)].some(match => {
      const start = Number(match[1]), end = Number(match[2] ?? match[1])
      return start <= end && ranges.some(range => start >= range.start && end <= range.end)
    }))
    return { ...ref, citation_status: isVerified ? 'verified' : 'unverified' }
  })
}
