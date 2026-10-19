import type { SqlRow } from '../db/driver.js'
import type { ParkStore } from './store.js'

const DAY = 24 * 60 * 60 * 1000

function dayKey(value: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value))
}

function counts(rows: SqlRow[], key: string): Record<string, number> {
  const result: Record<string, number> = {}
  for (const row of rows) {
    const value = String(row[key] ?? 'unknown')
    result[value] = (result[value] ?? 0) + 1
  }
  return result
}

export async function parkOverview(store: ParkStore, orgId: string, now = Date.now()) {
  const [sessions, inquiries, leads, contacts] = await Promise.all([
    store.db.all('SELECT id, started_at, source_channel FROM park_sessions WHERE org_id = ?', [orgId]),
    store.db.all('SELECT session_id, created_at, category, intent, industry, source_refs_json FROM park_inquiries WHERE org_id = ?', [orgId]),
    store.listLeads(orgId),
    store.db.all('SELECT lead_id, consent_at FROM park_contacts WHERE org_id = ?', [orgId]),
  ])
  const contactIds = new Set(contacts.map(row => String(row.lead_id)))
  const today = dayKey(now)
  const dayKeys = Array.from({ length: 14 }, (_, index) => dayKey(now - (13 - index) * DAY))
  const inquiryByDay = counts(inquiries.map(row => ({ ...row, day: dayKey(Number(row.created_at)) })), 'day')
  const sourceCounts = counts(sessions, 'source_channel')
  const consultedSessions = new Set(inquiries.map(row => String(row.session_id)))
  const contactedSessions = new Set(leads.filter(lead => contactIds.has(lead.id)).map(lead => lead.source_session_id))
  const statusCounts = counts(leads, 'status')
  const policyCounts: Record<string, number> = {}
  for (const row of inquiries) {
    const refs = JSON.parse(String(row.source_refs_json)) as Array<{ name?: string; policy_id?: string }>
    for (const ref of refs) if (ref.policy_id && ref.name) policyCounts[ref.name] = (policyCounts[ref.name] ?? 0) + 1
  }
  const series = (timestamps: number[]) => dayKeys.map(day => timestamps.filter(time => dayKey(time) === day).length)
  const cardTrends = {
    total_inquiries: series(inquiries.map(row => Number(row.created_at))),
    today_inquiries: series(inquiries.map(row => Number(row.created_at))),
    anonymous_leads: series(leads.filter(lead => !contactIds.has(lead.id)).map(lead => Number(lead.created_at))),
    contacted_leads: series(contacts.map(row => Number(row.consent_at))),
    converted_leads: series(leads.filter(lead => lead.status === 'converted').map(lead => Number(lead.updated_at))),
  }
  return {
    cards: {
      total_inquiries: inquiries.length,
      today_inquiries: inquiryByDay[today] ?? 0,
      anonymous_leads: leads.filter(lead => !contactIds.has(lead.id)).length,
      contacted_leads: contactIds.size,
      converted_leads: statusCounts.converted ?? 0,
    },
    card_trends: cardTrends,
    trend: dayKeys.map(day => ({ day, inquiries: inquiryByDay[day] ?? 0 })),
    popular_topics: Object.entries(counts(inquiries, 'category')).sort((a, b) => b[1] - a[1]).map(([category, count]) => ({ category, count })),
    policy_interest: Object.entries(policyCounts).sort((a, b) => b[1] - a[1]).map(([policy, count]) => ({ policy, count })),
    channels: Object.entries(sourceCounts).map(([channel, count]) => ({
      channel, sessions: count,
      consulted: sessions.filter(row => row.source_channel === channel && consultedSessions.has(String(row.id))).length,
      contacted: sessions.filter(row => row.source_channel === channel && contactedSessions.has(String(row.id))).length,
    })),
    lead_status: statusCounts,
    research: {
      weekly_topics: Object.entries(counts(inquiries.filter(row => Number(row.created_at) >= now - 7 * DAY), 'category')).sort((a, b) => b[1] - a[1]).map(([topic, count]) => ({ topic, count })),
      four_week_signals: Array.from({ length: 4 }, (_, index) => {
        const from = now - (4 - index) * 7 * DAY
        const to = from + 7 * DAY
        const rows = inquiries.filter(row => Number(row.created_at) >= from && Number(row.created_at) < to)
        return { week: index + 1, intent: counts(rows, 'intent'), industry: counts(rows, 'industry') }
      }),
    },
  }
}

export async function parkLeadSummary(store: ParkStore, orgId: string) {
  const leads = await store.listLeads(orgId)
  const distribution = counts(leads, 'status')
  return {
    distribution,
    pending_claim: distribution.proposed ?? 0,
    following_up: distribution.following_up ?? 0,
    funnel: {
      proposed: leads.length,
      claimed: leads.filter(lead => ['claimed', 'following_up', 'converted', 'invalid', 'closed'].includes(lead.status)).length,
      following_up: leads.filter(lead => ['following_up', 'converted', 'invalid', 'closed'].includes(lead.status)).length,
      converted: distribution.converted ?? 0,
    },
  }
}

export async function parkMonthlyReport(store: ParkStore, orgId: string, month: string) {
  const start = Date.parse(`${month}-01T00:00:00+08:00`)
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !Number.isFinite(start)) throw new Error('Invalid month')
  const [year, monthNumber] = month.split('-').map(Number)
  const nextYear = monthNumber === 12 ? year! + 1 : year!
  const nextMonth = monthNumber === 12 ? 1 : monthNumber! + 1
  const end = Date.parse(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00+08:00`)
  const [inquiries, sessions, leads] = await Promise.all([
    store.db.all('SELECT category, created_at FROM park_inquiries WHERE org_id = ? AND created_at >= ? AND created_at < ?', [orgId, start, end]),
    store.db.all('SELECT source_channel FROM park_sessions WHERE org_id = ? AND started_at >= ? AND started_at < ?', [orgId, start, end]),
    store.db.all('SELECT status FROM park_leads WHERE org_id = ? AND created_at >= ? AND created_at < ?', [orgId, start, end]),
  ])
  return { month, inquiries: inquiries.length, leads: leads.length,
    converted: leads.filter(row => row.status === 'converted').length,
    popular_topics: counts(inquiries, 'category'), channels: counts(sessions, 'source_channel') }
}

export async function parkCompliance(store: ParkStore, orgId: string, now = Date.now()) {
  const [sessions, rejections, audit, contacts] = await Promise.all([
    store.db.all('SELECT risk_state FROM park_sessions WHERE org_id = ?', [orgId]),
    store.db.all('SELECT reason, response_status FROM park_rejection_hits WHERE org_id = ?', [orgId]),
    store.db.all('SELECT response_status FROM operation_audit_events WHERE org_id = ? AND response_status >= 400', [orgId]),
    store.db.all('SELECT retention_until FROM park_contacts WHERE org_id = ?', [orgId]),
  ])
  return {
    session_risk: counts(sessions, 'risk_state'),
    rejection_hits: { by_reason: counts(rejections, 'reason'), by_status: counts(rejections, 'response_status') },
    audit_failures: { total: audit.length, auth_rejections: audit.filter(row => row.response_status === 401 || row.response_status === 403).length },
    contact_retention: {
      expiring_soon: contacts.filter(row => Number(row.retention_until) >= now && Number(row.retention_until) <= now + 30 * DAY).length,
      expired: contacts.filter(row => Number(row.retention_until) < now).length,
    },
  }
}
