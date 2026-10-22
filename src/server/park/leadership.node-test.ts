import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { SqliteDriver } from '../db/driver.js'
import type { RuntimeService } from '../runtimeService.js'
import type { AuthContext } from '../auth/token.js'
import { ParkStore } from './store.js'
import { ConsultationTurns } from './consultationTurns.js'
import { validateExtraction } from './inquiryExtraction.js'
import { extractLeadSignal } from './rules.js'
import { verifyAnswerCitations } from './verifiedCitations.js'
import { parkMonthlyReport, parkOverview, parkLeadSummary } from './aggregates.js'
import { ParkRuntimeAgentChannel } from './agentChannel.js'
import { canReadParkRuntime } from './sessionAccess.js'
import { PARK_PUBLIC_SESSION_SOURCE } from './mossSessions.js'
import { inspectHistoricalTurns, recoverHistoricalTurns } from './historyRecovery.js'

async function fixture() {
  const store = new ParkStore(new SqliteDriver(new DatabaseSync(':memory:')))
  await store.init()
  await store.putConfig('park', { display_name: 'Test park' })
  const session = await store.createSession('park', 'web', 60_000)
  return { store, session, turns: new ConsultationTurns(store) }
}

void test('turn reservations serialize sessions, reject altered retries, persist completion once and recover restart states', async () => {
  const { store, session, turns } = await fixture()
  try {
    const request = randomUUID()
    const [{ turn, isNew }, retry] = await Promise.all([
      turns.begin('park', session.id, request, '人才政策'), turns.begin('park', session.id, request, '人才政策'),
    ])
    assert.equal(isNew, true)
    assert.equal(retry.isNew, false)
    await assert.rejects(turns.begin('park', session.id, request, 'different'), /REQUEST_CONTENT_CONFLICT/)
    await assert.rejects(turns.begin('park', session.id, randomUUID(), 'second'), /TURN_IN_PROGRESS/)
    const ref = { document_id: 'doc', wiki_id: 'wiki', name: '人才政策.md', version: 'v1', section: '', ranges: [{ start: 2, end: 3 }] }
    await turns.retainSources(turn, [ref])
    await turns.retainSources(turn, [{ ...ref, ranges: [{ start: 7, end: 9 }] }])
    assert.deepEqual((await turns.sources(turn))[0].ranges, [{ start: 2, end: 3 }, { start: 7, end: 9 }])
    await turns.complete(turn, '人才政策', '来源：人才政策.md 第 7—8 行', verifyAnswerCitations('人才政策.md 第 7—8 行', await turns.sources(turn)))
    await assert.rejects(turns.complete(turn, '人才政策', 'again', []), /TURN_NOT_RUNNING/)
    assert.equal((await store.db.get('SELECT COUNT(*) AS n FROM park_inquiries'))!.n, 1)
    assert.equal((await store.session('park', session.id))!.message_count, 1)
    assert.equal((await store.db.get('SELECT COUNT(*) AS n FROM park_lead_jobs'))!.n, 1)
    const next = await turns.begin('park', session.id, randomUUID(), '租金')
    await store.db.run('UPDATE park_sessions SET moss_session_id = ? WHERE id = ?', ['interrupted-runtime', session.id])
    const idle = await store.createSession('park', 'web', 60_000)
    const other = await store.createSession('other', 'web', 60_000)
    await turns.begin('other', other.id, randomUUID(), '租金')
    assert.deepEqual(await turns.interruptPending('park'), ['interrupted-runtime'])
    assert.equal((await turns.begin('park', session.id, next.turn.request_id, '租金')).turn.status, 'interrupted')
    assert.ok((await store.session('park', session.id))!.expires_at <= Date.now())
    assert.ok((await store.session('park', idle.id))!.expires_at > Date.now())
    assert.ok((await store.session('other', other.id))!.expires_at > Date.now())
    assert.equal((await turns.active('other', other.id))!.status, 'running')
    assert.equal((await parkOverview(store, 'park')).cards.total_inquiries, 1)
  } finally { await store.db.close() }
})

void test('citation metrics exclude mere hits, wrong lines, duplicate identities and duplicate versions', () => {
  const ref = { document_id: 'a', wiki_id: 'wiki', name: '人才政策.md', version: 'v1', section: '', ranges: [{ start: 1, end: 3 }] }
  assert.equal(verifyAnswerCitations('人才政策.md 第 2 行', [ref])[0].citation_status, 'verified')
  assert.equal(verifyAnswerCitations('人才政策.md 第 8 行', [ref])[0].citation_status, 'unverified')
  assert.equal(verifyAnswerCitations('人才政策.md', [ref])[0].citation_status, 'unverified')
  assert.ok(verifyAnswerCitations('人才政策.md 第 2 行', [ref, { ...ref, document_id: 'b' }]).every(item => item.citation_status === 'unverified'))
  assert.ok(verifyAnswerCitations('人才政策.md 第 2 行', [ref, { ...ref, version: 'v2' }]).every(item => item.citation_status === 'unverified'))
})

void test('extraction validates evidence, Chinese units, topic meaning and negative or uncertain intent', () => {
  const question = '我们做人工智能，计划下个月入驻，需要 200 平米场地和算力支持，团队 50 人'
  const body = { category: '场地空间', intent: '入驻意向', industry: '人工智能', scale: '200 平米', urgency: '下个月',
    concerns: ['场地空间', '算力支持', '入驻条件'], evidence: { category: '场地', intent: '计划下个月入驻', industry: '人工智能', scale: '200 平米', urgency: '下个月',
      场地空间: '场地', 算力支持: '算力支持', 入驻条件: '入驻' } }
  const result = validateExtraction(question, body)
  assert.equal(result.signal.scale, '200 平米')
  assert.equal(result.signal.industry, '人工智能')
  assert.ok(result.signal.score >= 40)
  assert.equal(extractLeadSignal('团队 50 人').scale, '50 人')
  assert.equal(extractLeadSignal('人才服务政策').category, '人才政策')
  assert.equal(extractLeadSignal('计划下个月入驻，需要 200 平米场地，是否有补贴？').urgency, '下个月')
  assert.equal(extractLeadSignal('可能下个月入驻，需要 200 平米场地').urgency, null)
  assert.throws(() => validateExtraction(question, { ...body, industry: '生物医药' }), /Unverified industry/)
  assert.throws(() => validateExtraction(question, { ...body, category: '人才政策' }), /Unverified/)
  const normalized = validateExtraction(question, { ...body, concerns: [...body.concerns, '产业扶持'], evidence: { ...body.evidence, category: '场地空间', 产业扶持: '有哪些支持' } })
  assert.equal(normalized.signal.category, '场地空间')
  assert.equal(normalized.signal.concerns.includes('产业扶持'), false)
  assert.throws(() => validateExtraction(question, { ...body, scale: '500 平米' }), /Unverified scale/)
  for (const prefix of ['不考虑', '不确定']) {
    const uncertain = validateExtraction(`${prefix}${question}`, body)
    assert.equal(uncertain.signal.intent, '一般咨询')
    assert.equal(uncertain.signal.urgency, null)
    assert.ok(uncertain.signal.score < 40)
  }
})

void test('every completed inquiry is extracted; retries are bounded and later inference preserves human state', async () => {
  const { store, session, turns } = await fixture()
  try {
    const low = (await turns.begin('park', session.id, randomUUID(), '人才政策')).turn
    await turns.complete(low, '人才政策', '答复', [])
    const highQuestion = '计划下个月入驻，需要 200 平米场地和算力'
    const high = (await turns.begin('park', session.id, randomUUID(), highQuestion)).turn
    await turns.complete(high, highQuestion, '答复', [])
    let calls = 0
    await store.processLeadJobs(async (_org, question) => { calls++; return { signal: extractLeadSignal(question), evidence: { question }, confidence: null } })
    assert.equal(calls, 2)
    assert.equal((await store.db.get('SELECT extraction_status FROM park_inquiries WHERE id = ?', [low.id]))!.extraction_status, 'completed')
    const lead = (await store.leadBySession('park', session.id))!
    assert.ok(lead)
    await store.claimLead('park', lead.id, 'human')
    await store.addFollowUp('park', lead.id, 'human', 'confirmed', null)
    const next = (await turns.begin('park', session.id, randomUUID(), highQuestion)).turn
    await turns.complete(next, highQuestion, '答复', [])
    for (let attempt = 1; attempt <= 3; attempt++) {
      await store.db.run('UPDATE park_lead_jobs SET next_at = 0 WHERE inquiry_id = ?', [next.id])
      await store.processLeadJobs(async () => { throw new Error('provider failed') })
    }
    assert.equal((await store.db.get('SELECT status, attempts FROM park_lead_jobs WHERE inquiry_id = ?', [next.id]))!.status, 'failed')
    assert.equal((await store.lead('park', lead.id))!.status, 'following_up')
    await store.db.run("UPDATE park_lead_jobs SET status = 'queued', next_at = 0 WHERE inquiry_id = ?", [next.id])
    await store.processLeadJobs(async (_org, question) => ({ signal: extractLeadSignal(question), evidence: { question }, confidence: null }))
    assert.equal((await store.lead('park', lead.id))!.owner_id, 'human')
    assert.equal((await store.lead('park', lead.id))!.status, 'following_up')
  } finally { await store.db.close() }
})

void test('month conversion uses first event time across creation months; direct contacts never imply consultation or follow-up', async () => {
  const { store, session } = await fixture()
  try {
    const lead = await store.saveLead('park', session.id, null, extractLeadSignal('contact'))
    await store.saveContact('park', lead.id, { name: null, companyName: null, phone: null, email: 'x@example.com', consentText: 'yes', retentionUntil: Date.now() + 1000 })
    await store.claimLead('park', lead.id, 'human')
    await store.closeLead('park', lead.id, 'human', 'converted')
    const now = Date.parse('2026-11-10T12:00:00+08:00')
    const conversion = Date.parse('2026-11-01T00:00:00+08:00')
    await store.db.run('UPDATE park_leads SET created_at = ?, updated_at = ? WHERE id = ?', [Date.parse('2026-09-01T00:00:00+08:00'), now, lead.id])
    await store.db.run("UPDATE park_lead_events SET occurred_at = ? WHERE lead_id = ? AND kind = 'converted'", [conversion, lead.id])
    const report = await parkMonthlyReport(store, 'park', '2026-11', now)
    assert.equal(report.leads, 0)
    assert.equal(report.converted, 1)
    await store.recordLeadEvent('park', lead.id, 'converted', now)
    assert.equal((await store.db.get("SELECT occurred_at FROM park_lead_events WHERE lead_id = ? AND kind = 'converted'", [lead.id]))!.occurred_at, conversion)
    const overview = await parkOverview(store, 'park')
    assert.equal(overview.channels[0].consulted, 0)
    assert.equal(overview.channels[0].contacted, 1)
    assert.equal(overview.card_trends.anonymous_leads.reduce((sum, count) => sum + count, 0), 0)
    assert.equal((await parkLeadSummary(store, 'park', Date.parse('2026-11-10T12:00:00+08:00'))).funnel.following_up, 0)
    await store.db.run("DELETE FROM park_lead_events WHERE lead_id = ? AND kind = 'converted'", [lead.id])
    assert.equal((await parkMonthlyReport(store, 'park', '2026-11', now)).converted, null)
  } finally { await store.db.close() }
})

void test('runtime channel needs an explicit successful result and rejects partial disconnect or cancellation', async () => {
  for (const outcome of ['success', 'disconnect', 'cancelled', 'error']) {
    const socket = new PassThrough()
    const runtime = { ensureSessionReady: async () => ({ attempt: {} }), connectToAttempt: async () => socket } as unknown as RuntimeService
    const channel = new ParkRuntimeAgentChannel(runtime)
    const pending = channel.sendAndStream('runtime', 'question', 'request', () => {})
    setImmediate(() => {
      socket.write(`${JSON.stringify({ type: 'text', text: 'partial answer' })}\n`)
      if (outcome === 'disconnect') socket.destroy()
      else socket.write(`${JSON.stringify({ type: 'result', session_id: 'runtime', request_id: 'request', status: outcome === 'error' ? 'error' : 'success', stop_reason: outcome === 'cancelled' ? 'cancelled' : 'end_turn', is_error: outcome === 'error' })}\n`)
    })
    if (outcome === 'success') assert.equal((await pending).answer, 'partial answer')
    else await assert.rejects(pending)
  }
})

void test('park leadership raw-session restriction survives wildcard scope and organization changes', async () => {
  const { store } = await fixture()
  try {
    await store.grantRole('park', 'leader', 'park_leader', 'admin')
    const leader = { orgId: 'park', userId: 'leader', scopes: ['*'] } as AuthContext
    assert.equal(await canReadParkRuntime(store, leader, { orgId: 'park', source: PARK_PUBLIC_SESSION_SOURCE }), false)
    assert.equal(await canReadParkRuntime(store, { ...leader, orgId: 'other' }, { orgId: 'park', source: PARK_PUBLIC_SESSION_SOURCE }), false)
    assert.equal(await canReadParkRuntime(store, leader, { orgId: 'park', source: 'ordinary' }), true)
  } finally { await store.db.close() }
})

void test('history recovery is dry by default, refuses missing completion proof and applies proven turns idempotently', async () => {
  const { store, session } = await fixture()
  try {
    const request = randomUUID()
    const events = [{ type: 'user', uuid: request, message: { content: '人才政策' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } }]
    assert.equal(inspectHistoricalTurns(events.map(event => JSON.stringify(event)).join('\n'))[0].isVerified, false)
    const transcript = [...events, { type: 'result', request_id: request, status: 'success', stop_reason: 'end_turn', timestamp: new Date().toISOString() }].map(event => JSON.stringify(event)).join('\n')
    const turns = inspectHistoricalTurns(transcript)
    assert.equal(turns[0].isVerified, true)
    assert.equal((await recoverHistoricalTurns(store, 'park', session.id, turns))[0].status, 'recoverable')
    assert.equal(await store.inquiryByRequest(session.id, request), undefined)
    assert.equal((await recoverHistoricalTurns(store, 'park', session.id, turns, true))[0].status, 'recovered')
    assert.equal((await recoverHistoricalTurns(store, 'park', session.id, turns, true))[0].status, 'already_recorded')
    assert.equal((await store.inquiryByRequest(session.id, request))!.source_refs_json, '[]')
  } finally { await store.db.close() }
})
