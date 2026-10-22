import { statisticsPeriod, type StatisticsRange } from './statisticsPeriod.js'
import { popularQuestions } from './popularQuestions.js'
import type { ParkStore } from './store.js'
import { DAY, shanghaiDay, countValues, policyInterest, dataQuality, channelEffects, channelEvidence, includeMissingChannelEvidence } from './statistics.js'

async function loadStatistics(store: ParkStore, orgId: string) {
  return store.db.transaction(async () => {
    const [sessions, inquiries, leads, contacts, events, followUps] = await Promise.all([
      store.db.all('SELECT id, started_at, source_channel FROM park_sessions WHERE org_id = ?', [orgId]),
      store.db.all('SELECT * FROM park_inquiries WHERE org_id = ?', [orgId]), store.listLeads(orgId),
      store.db.all('SELECT lead_id, consent_at, phone_verified_at FROM park_contacts WHERE org_id = ?', [orgId]),
      store.db.all('SELECT * FROM park_lead_events WHERE org_id = ?', [orgId]),
      store.db.all('SELECT DISTINCT lead_id FROM park_follow_ups WHERE org_id = ?', [orgId]),
    ])
    const quality = dataQuality(inquiries, leads, contacts, events)
    quality.missing_follow_up_records = leads.filter(row => row.status === 'following_up' && !followUps.some(record => record.lead_id === row.id)).length
    return { sessions, inquiries, leads, contacts, events,
      completed: inquiries.filter(row => row.completion_status === 'completed'), quality }

  })
}

export async function parkOverview(store: ParkStore, orgId: string, now = Date.now(), range?: StatisticsRange) {
  const { sessions, inquiries, completed, leads, contacts, events, quality } = await loadStatistics(store, orgId)
  const contactIds = new Set(contacts.map(row => String(row.lead_id)))
  const period = statisticsPeriod(now, range)
  const { days, start: from, end: to } = period
  const previousFrom = from - days.length * DAY
  const questions = await popularQuestions(store, orgId, from, to, 50)
  const series = (timestamps: number[]) => {
    const counts = new Map<string, number>()
    for (const time of timestamps) if (time >= from && time < to) {
      const day = shanghaiDay(time)
      counts.set(day, (counts.get(day) ?? 0) + 1)
    }
    return days.map(day => counts.get(day) ?? 0)
  }
  const eventTimes = (kind: string) => events.filter(row => row.kind === kind).map(row => Number(row.occurred_at))
  const inquirySeries = series(completed.map(row => Number(row.created_at)))
  const topics = completed.filter(row => row.extraction_status === 'completed')
  const recentTopics = topics.filter(row => Number(row.created_at) >= from && Number(row.created_at) < to)
  const ranked = (rows: typeof inquiries, key: string) => Object.entries(countValues(rows, key)).sort((a, b) => b[1] - a[1])
  const anonymousCreationTimes = events.filter(row => row.kind === 'created' && JSON.parse(String(row.evidence_json ?? '{}')).source === 'inquiry')
    .map(row => Number(row.occurred_at))
  return {
    period, as_of: now, data_quality: quality,
    popular_questions: questions.rows.slice(0, 10), question_samples: questions.samples,
    cards: { total_inquiries: completed.length, today_inquiries: completed.filter(row => shanghaiDay(Number(row.created_at)) === shanghaiDay(now) && Number(row.created_at) <= now).length,
      anonymous_leads: leads.filter(lead => !contactIds.has(lead.id)).length, contacted_leads: contactIds.size,
      verified_contacts: contacts.filter(row => row.phone_verified_at).length,
      converted_leads: leads.filter(lead => lead.status === 'converted').length },
    card_trends: { total_inquiries: inquirySeries, today_inquiries: inquirySeries,
      anonymous_leads: series(anonymousCreationTimes), contacted_leads: series(eventTimes('contacted')), converted_leads: series(eventTimes('converted')) },
    card_comparisons: Object.fromEntries(Object.entries({ total_inquiries: completed.map(row => Number(row.created_at)),
      today_inquiries: completed.map(row => Number(row.created_at)), anonymous_leads: anonymousCreationTimes,
      contacted_leads: eventTimes('contacted'), converted_leads: eventTimes('converted') }).map(([key, times]) => {
      const previous = times.filter(time => time >= previousFrom && time < from).length
      const current = times.filter(time => time >= from && time < to).length
      return [key, { previous, current, change: previous ? Math.round((current - previous) / previous * 100) : null }]
    })),
    comparison_period: { from: shanghaiDay(previousFrom), to: shanghaiDay(from - 1) },
    trend: days.map((day, i) => ({ day, inquiries: inquirySeries[i]! })),
    popular_topics: ranked(recentTopics, 'category').map(([category, count]) => ({ category, count })),
    policy_interest: policyInterest(completed.filter(row => Number(row.created_at) >= from && Number(row.created_at) < to)),
    channel_evidence: channelEvidence(sessions, leads, contacts, events),
    channels: includeMissingChannelEvidence(channelEffects(sessions, completed, leads, events, from, to), channelEvidence(sessions, leads, contacts, events)), lead_status: countValues(leads, 'status'),
    research: {
      weekly_topics: ranked(recentTopics, 'category')
        .map(([topic, count]) => ({ topic, count })),
      four_week_signals: await Promise.all(Array.from({ length: Math.ceil(days.length / 7) }, async (_, i) => {
        const start = from + i * 7 * DAY, end = Math.min(start + 7 * DAY, to)
        const rows = topics.filter(row => Number(row.created_at) >= start && Number(row.created_at) < end)
        const questionData = await popularQuestions(store, orgId, start, end, 50, questions.groupKeys)
        return { question_sample_count: questionData.samples.available, week: i + 1, from: shanghaiDay(start), to: shanghaiDay(end - 1), sample_count: rows.length,
          topics: Object.fromEntries(questions.groupKeys.map((key, index) => [questions.rows[index]!.question,
            questionData.rows[questionData.groupKeys.indexOf(key)]?.count ?? 0])), intent: countValues(rows, 'intent'), industry: countValues(rows, 'industry') }
      })),
    },
  }
}

export async function parkLeadSummary(store: ParkStore, orgId: string, now = Date.now(), range?: StatisticsRange) {
  const data = await loadStatistics(store, orgId)
  const period = statisticsPeriod(now, range, true)
  const leads = data.leads.filter(row => Number(row.created_at) >= period.start && Number(row.created_at) < period.end)
  const ids = new Set(leads.map(row => row.id))
  const events = data.events.filter(row => ids.has(String(row.lead_id)) && Number(row.occurred_at) <= now)
  const followUps = (await store.db.all('SELECT DISTINCT lead_id FROM park_follow_ups WHERE org_id = ? AND created_at <= ?', [orgId, now]))
    .filter(row => ids.has(String(row.lead_id)))
  const distribution = countValues(leads, 'status')
  const quality = dataQuality([], leads, data.contacts.filter(row => ids.has(String(row.lead_id))), events)
  quality.missing_follow_up_records = leads.filter(row => row.status === 'following_up' && !followUps.some(record => record.lead_id === row.id)).length
  return { as_of: now, period, data_quality: quality, distribution, pending_claim: distribution.proposed ?? 0,
    following_up: distribution.following_up ?? 0,
    funnel: { proposed: leads.length, claimed: new Set(events.filter(row => row.kind === 'claimed').map(row => row.lead_id)).size,
      following_up: followUps.length, converted: new Set(events.filter(row => row.kind === 'converted').map(row => row.lead_id)).size } }
}

export async function parkMonthlyReport(store: ParkStore, orgId: string, month: string, now = Date.now()) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Invalid month')
  const start = Date.parse(`${month}-01T00:00:00+08:00`)
  const [year, number] = month.split('-').map(Number)
  const end = Date.parse(`${number === 12 ? year! + 1 : year}-${String(number === 12 ? 1 : number! + 1).padStart(2, '0')}-01T00:00:00+08:00`)
  const data = await loadStatistics(store, orgId)
  const questions = await popularQuestions(store, orgId, start, Math.min(end, now + 1))
  const inPeriod = (time: unknown) => Number(time) >= start && Number(time) < Math.min(end, now + 1)
  const inquiries = data.completed.filter(row => inPeriod(row.created_at))
  return { month, as_of: now, period: { from: shanghaiDay(start), to: shanghaiDay(Math.min(end - 1, now)), time_zone: 'Asia/Shanghai', is_partial: now < end },
    popular_questions: questions.rows, question_samples: questions.samples,
    unverified_inquiries: data.inquiries.filter(row => row.completion_status !== 'completed' && inPeriod(row.created_at)).length,
    data_quality: data.quality, inquiries: inquiries.length, leads: data.leads.filter(row => inPeriod(row.created_at)).length,
    contacted: data.events.filter(row => row.kind === 'contacted' && inPeriod(row.occurred_at)).length,
    converted: data.quality.missing_conversion_events ? null : data.events.filter(row => row.kind === 'converted' && inPeriod(row.occurred_at)).length,
    verified_converted: data.events.filter(row => row.kind === 'converted' && inPeriod(row.occurred_at)).length,
    popular_topics: countValues(inquiries.filter(row => row.extraction_status === 'completed'), 'category'),
    policy_interest: policyInterest(inquiries),
    channel_evidence: channelEvidence(data.sessions, data.leads, data.contacts, data.events),
    channels: includeMissingChannelEvidence(channelEffects(data.sessions, data.completed, data.leads, data.events, start, Math.min(end, now + 1)), channelEvidence(data.sessions, data.leads, data.contacts, data.events)) }
}

export async function parkCompliance(store: ParkStore, orgId: string, now = Date.now(), range?: StatisticsRange) {
  const period = statisticsPeriod(now, range)
  const from = period.start, until = period.end - 1
  const { quality } = await loadStatistics(store, orgId)
  const [sessions, rejections, audit, contacts] = await Promise.all([
    store.db.all('SELECT risk_state FROM park_sessions WHERE org_id = ? AND expires_at > ?', [orgId, now]),
    store.db.all('SELECT reason, response_status FROM park_rejection_hits WHERE org_id = ? AND created_at >= ? AND created_at <= ?', [orgId, from, until]),
    store.db.all(`SELECT response_status FROM operation_audit_events WHERE org_id = ? AND response_status >= 400
      AND created_at >= ? AND created_at <= ? AND (path LIKE ? OR path LIKE '/public/consult/%' OR path LIKE '/public/sessions/%')`,
    [orgId, from, until, `/api/v1/parks/${orgId}/%`]),
    store.db.all('SELECT retention_until FROM park_contacts WHERE org_id = ?', [orgId]),
  ])
  return { as_of: now, period, data_quality: quality,
    session_risk: countValues(sessions, 'risk_state'),
    rejection_hits: { by_reason: countValues(rejections, 'reason'), by_status: countValues(rejections, 'response_status') },
    audit_failures: { total: audit.length, auth_rejections: audit.filter(row => row.response_status === 401 || row.response_status === 403).length,
      authentication: audit.filter(row => row.response_status === 401).length, authorization: audit.filter(row => row.response_status === 403).length,
      service_errors: audit.filter(row => Number(row.response_status) >= 500).length },
    contact_retention: { expiring_soon: contacts.filter(row => Number(row.retention_until) >= now && Number(row.retention_until) <= now + 30 * DAY).length,
      expired: contacts.filter(row => Number(row.retention_until) < now).length } }
}
