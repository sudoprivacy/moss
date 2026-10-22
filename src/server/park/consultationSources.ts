import { createHash, randomUUID } from 'node:crypto'
import type { DbDriver } from '../db/driver.js'
import { HttpError } from '../httpRespond.js'
import type { PolicyMatch } from './policySearch.js'
import type { VerifiedPolicySource } from './policySources.js'

export interface SourceRange {
  start: number
  end: number
}
export interface ConsultationSource {
  name: string
  version: string
  section: string
  document_id?: string
  wiki_id?: string
  source_id?: string
  ranges?: SourceRange[]
  preview_status?: 'available' | 'unavailable'
  citation_status?: 'verified' | 'unverified'
}

/** Merge positions without changing the retrieved clauses or their scoring. */
export function mergeSourceRanges(ranges: SourceRange[]): SourceRange[] {
  const result: SourceRange[] = []
  for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = result.at(-1)
    if (previous && range.start <= previous.end + 1)
      previous.end = Math.max(previous.end, range.end)
    else result.push({ ...range })
  }
  return result
}

export function groupPolicyMatches(matches: PolicyMatch[]): ConsultationSource[] {
  const groups = new Map<string, ConsultationSource>()
  for (const match of matches) {
    const key = JSON.stringify([match.wiki_id, match.document_id, match.version])
    let source = groups.get(key)
    if (!source) {
      source = {
        name: match.file,
        version: match.version,
        section: '',
        document_id: match.document_id,
        wiki_id: match.wiki_id,
        ranges: [],
      }
      groups.set(key, source)
    }
    source.ranges!.push({ start: match.line_no, end: match.end_line })
  }
  for (const source of groups.values()) {
    source.ranges = mergeSourceRanges(source.ranges!)
    source.section = source.ranges
      .map((range) =>
        range.start === range.end ? `第 ${range.start} 行` : `第 ${range.start}—${range.end} 行`,
      )
      .join('、')
  }
  return [...groups.values()]
}

/** Persist the exact verified text before its published wiki directory can be replaced. */
export async function saveConsultationSources(
  db: DbDriver,
  orgId: string,
  sessionId: string,
  matches: PolicyMatch[],
  bodies: VerifiedPolicySource[],
): Promise<ConsultationSource[]> {
  const refs = groupPolicyMatches(matches)
  for (const ref of refs) {
    const body = bodies.find(
      (item) => item.source.id === ref.document_id && item.version === ref.version,
    )
    if (!body) throw new Error('Verified policy body is missing')
    const sha256 = createHash('sha256').update(body.markdown, 'utf8').digest('hex')
    try {
      const id = randomUUID()
      await db.transaction(async () => {
        await db.run(
          `INSERT INTO park_source_bodies (org_id, sha256, markdown) VALUES (?, ?, ?)
          ON CONFLICT (org_id, sha256) DO NOTHING`,
          [orgId, sha256, body.markdown],
        )
        await db.run(
          `INSERT INTO park_session_sources (id, org_id, session_id, wiki_id, document_id, version, file_name, body_sha256, ranges_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            orgId,
            sessionId,
            ref.wiki_id!,
            ref.document_id!,
            ref.version,
            ref.name,
            sha256,
            JSON.stringify(ref.ranges),
          ],
        )
      })
      ref.source_id = id
      ref.preview_status = 'available'
    } catch (error) {
      console.error('[Park sources] Failed to retain policy preview', error)
      ref.preview_status = 'unavailable'
    }
  }
  return refs
}

export async function readConsultationPreview(
  db: DbDriver,
  orgId: string,
  sessionId: string,
  sourceId: string,
) {
  const row = await db.get<{
    file_name: string
    version: string
    ranges_json: string
    body_sha256: string
    markdown: string | null
  }>(
    `SELECT s.file_name, s.version, s.ranges_json, s.body_sha256, b.markdown FROM park_session_sources s
      LEFT JOIN park_source_bodies b ON b.org_id = s.org_id AND b.sha256 = s.body_sha256
      WHERE s.id = ? AND s.org_id = ? AND s.session_id = ?`,
    [sourceId, orgId, sessionId],
  )
  if (!row) throw new HttpError(404, 'SOURCE_NOT_FOUND')
  if (
    row.markdown === null ||
    createHash('sha256').update(row.markdown, 'utf8').digest('hex') !== row.body_sha256
  )
    throw new HttpError(503, 'SOURCE_PREVIEW_UNAVAILABLE')
  return {
    name: row.file_name,
    version: row.version,
    markdown: row.markdown,
    ranges: JSON.parse(row.ranges_json) as SourceRange[],
  }
}
