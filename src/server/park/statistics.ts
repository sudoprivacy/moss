import type { SqlRow } from '../db/driver.js'
import type { ConsultationSource } from './consultationSources.js'

export const DAY = 86_400_000
export function shanghaiDay(value: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value))
}
export function shanghaiMonth(value = Date.now()): string { return shanghaiDay(value).slice(0, 7) }
export function countValues(rows: SqlRow[], key: string): Record<string, number> {
  const result: Record<string, number> = {}
  for (const row of rows) {
    const value = row[key]
    if (value === null || value === undefined || value === '' || value === 'unknown') continue
    result[String(value)] = (result[String(value)] ?? 0) + 1
  }
  return result
}
export function policyInterest(rows: SqlRow[]) {
  const result = new Map<string, { document_id: string; policy: string; count: number }>()
  for (const row of rows) {
    const refs = JSON.parse(String(row.source_refs_json ?? '[]')) as ConsultationSource[]
    const seen = new Set<string>()
    for (const ref of refs) {
      if (!ref.document_id || ref.citation_status !== 'verified' || seen.has(ref.document_id)) continue
      seen.add(ref.document_id)
      const item = result.get(ref.document_id) ?? { document_id: ref.document_id, policy: ref.name, count: 0 }
      item.count++
      result.set(ref.document_id, item)
    }
  }
  return [...result.values()].sort((a, b) => b.count - a.count)
}
export function dataQuality(inquiries: SqlRow[], leads: SqlRow[], contacts: SqlRow[], events: SqlRow[]) {
  const hasEvent = (leadId: string, kind: string) => events.some(event => event.lead_id === leadId && event.kind === kind)
  return {
    legacy_inquiries: inquiries.filter(row => row.completion_status !== 'completed').length,
    extraction_pending: inquiries.filter(row => row.extraction_status === 'queued').length,
    extraction_failed: inquiries.filter(row => row.extraction_status === 'failed').length,
    extraction_unverified: inquiries.filter(row => row.extraction_status === 'legacy').length,
    unverified_policy_refs: inquiries.reduce((sum, row) => sum + (JSON.parse(String(row.source_refs_json ?? '[]')) as ConsultationSource[])
      .filter(ref => ref.citation_status !== 'verified').length, 0),
    missing_follow_up_records: 0,
    missing_creation_events: leads.filter(row => !hasEvent(String(row.id), 'created')).length,
    missing_claim_events: leads.filter(row => row.owner_id && !hasEvent(String(row.id), 'claimed')).length,
    missing_conversion_events: leads.filter(row => row.status === 'converted' && !hasEvent(String(row.id), 'converted')).length,
    missing_contact_events: contacts.filter(row => !hasEvent(String(row.lead_id), 'contacted')).length,
  }
}

/** Parallel columns do not assume consultation and contact populations are nested. */
export function channelEffects(sessions: SqlRow[], inquiries: SqlRow[], leads: SqlRow[], events: SqlRow[], from: number, to: number) {
  const inPeriod = (time: unknown) => Number(time) >= from && Number(time) < to
  const sessionChannels = new Map(sessions.map(row => [String(row.id), String(row.source_channel)]))
  const leadSessions = new Map(leads.map(row => [String(row.id), String(row.source_session_id)]))
  return [...new Set(sessions.map(row => String(row.source_channel)))].map(channel => ({
    channel,
    sessions: sessions.filter(row => row.source_channel === channel && inPeriod(row.started_at)).length,
    consulted: new Set(inquiries.filter(row => inPeriod(row.created_at) && sessionChannels.get(String(row.session_id)) === channel).map(row => row.session_id)).size,
    contacted: events.filter(row => row.kind === 'contacted' && inPeriod(row.occurred_at)
      && sessionChannels.get(leadSessions.get(String(row.lead_id)) ?? '') === channel).length,
    converted: events.filter(row => row.kind === 'converted' && inPeriod(row.occurred_at)
      && sessionChannels.get(leadSessions.get(String(row.lead_id)) ?? '') === channel).length,
  })).filter(row => row.sessions || row.consulted || row.contacted || row.converted)
}

/** Missing first-event dates cannot safely be assigned to any reporting period. */
export function channelEvidence(sessions: SqlRow[], leads: SqlRow[], contacts: SqlRow[], events: SqlRow[]) {
  const channels = new Map(sessions.map(row => [String(row.id), String(row.source_channel)]))
  const result: Record<string, { contacted: number; converted: number }> = {}
  for (const lead of leads) {
    const channel = channels.get(String(lead.source_session_id)) ?? 'other'
    const item = result[channel] ??= { contacted: 0, converted: 0 }
    const has = (kind: string) => events.some(row => row.lead_id === lead.id && row.kind === kind)
    if (contacts.some(row => row.lead_id === lead.id) && !has('contacted')) item.contacted++
    if (lead.status === 'converted' && !has('converted')) item.converted++
  }
  return result
}

export function includeMissingChannelEvidence(rows: ReturnType<typeof channelEffects>, evidence: ReturnType<typeof channelEvidence>) {
  for (const [channel, missing] of Object.entries(evidence)) {
    if ((missing.contacted || missing.converted) && !rows.some(row => row.channel === channel)) {
      rows.push({ channel, sessions: 0, consulted: 0, contacted: 0, converted: 0 })
    }
  }
  return rows
}
