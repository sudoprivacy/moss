import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { SqliteDriver } from '../db/driver.js'
import { ParkStore } from './store.js'
import { extractLeadSignal } from './rules.js'
import { parkOverview, parkLeadSummary, parkMonthlyReport, parkCompliance } from './aggregates.js'
import { statisticsPeriod, subtractMonths, requestedStatisticsRange } from './statisticsPeriod.js'
import { groupQuestion, normalizeQuestion, prepareQuestionGroups, questionForLeadership } from './popularQuestions.js'

const now = Date.parse('2026-10-22T12:00:00+08:00')

void test('Shanghai date ranges include boundaries, clamp natural months and reject invalid input', () => {
  assert.equal(statisticsPeriod(now).from, '2026-10-09')
  assert.equal(statisticsPeriod(now, undefined, true).from, '2026-07-22')
  assert.equal(subtractMonths('2026-05-31', 3), '2026-02-28')
  assert.equal(subtractMonths('2024-05-31', 3), '2024-02-29')
  assert.equal(subtractMonths('2026-01-31', 3), '2025-10-31')
  assert.equal(statisticsPeriod(now, { from: '2026-09-30', to: '2026-09-30' }).days.length, 1)
  assert.throws(() => statisticsPeriod(now, { from: '2026-02-30', to: '2026-03-01' }))
  assert.throws(() => statisticsPeriod(now, { from: '2026-10-23', to: '2026-10-23' }))
  assert.throws(() => statisticsPeriod(now, { from: '2026-10-22', to: '2026-10-21' }))
  assert.throws(() => requestedStatisticsRange('/metrics?from=2026-10-01'))
})

void test('question grouping preserves constraints, masks identity and never enables unverified semantic rules', () => {
  assert.equal(normalizeQuestion('  入驻条件？  '), normalizeQuestion('入驻条件?'))
  assert.notEqual(groupQuestion('需要200平米场地').key, groupQuestion('需要500平米场地').key)
  assert.notEqual(groupQuestion('考虑入驻').key, groupQuestion('不考虑入驻').key)
  assert.notEqual(groupQuestion('人才补贴怎么申请').key, groupQuestion('人才补贴有多少钱').key)
  assert.equal(groupQuestion('企业入驻需要什么条件？').key, groupQuestion('企业入驻需要满足哪些条件？').key)
  for (const question of ['没有高新技术企业资质能否入驻？', '企业入驻需要什么条件？需要500平方米', '企业入驻需要什么条件？租金是多少？']) {
    assert.notEqual(groupQuestion(question).key, groupQuestion('企业入驻需要什么条件？').key)
  }
  const rule = { id: 'settlement', question: '入驻条件？', matches: () => true, excludes: () => false, verifiedSampleIds: [] }
  assert.match(groupQuestion('申请入驻有什么要求', [rule]).key, /^text:/)
  assert.match(groupQuestion('申请入驻有什么要求', [{ ...rule, verifiedSampleIds: ['reviewed-sample'] }]).key, /^rule:/)
  assert.match(groupQuestion('申请入驻有什么要求', [{ ...rule, verifiedSampleIds: ['a'] }, { ...rule, id: 'other', verifiedSampleIds: ['b'] }]).key, /^text:/)
  const safe = questionForLeadership('我叫张三，来自示例科技有限公司，电话13800138000，邮箱test@example.com，入驻条件是什么？', {})
  assert.ok(safe.isDisplayable)
  assert.doesNotMatch(safe.text, /张三|示例科技|13800138000|test@example/)
  assert.equal(questionForLeadership('我是张三，如何申请？', {}).isDisplayable, false)
})

void test('overview and monthly questions use precomputed completed requests, date range and consistent counts', async () => {
  const store = new ParkStore(new SqliteDriver(new DatabaseSync(':memory:')))
  try {
    await store.init(); await store.putConfig('park', { display_name: 'Test' })
    const session = await store.createSession('park', 'web', 60000)
    for (const [id, question, day] of [['one', '入驻条件？', '2026-10-01'], ['two', '入驻条件?', '2026-10-22'], ['old', '租金多少钱？', '2026-09-01']]) {
      await store.recordInquiry({ orgId: 'park', sessionId: session.id, requestId: id!, inquiryId: id!, question: question!, answer: 'Answer', signal: extractLeadSignal(question!), sourceRefs: [] })
      await store.db.run('UPDATE park_inquiries SET created_at = ? WHERE id = ?', [Date.parse(`${day}T12:00:00+08:00`), id!])
    }
    await store.recordInquiry({ orgId: 'park', sessionId: session.id, requestId: 'one', inquiryId: 'retry', question: '入驻条件？', answer: 'Answer', signal: extractLeadSignal('入驻条件'), sourceRefs: [] })
    await store.db.run('DELETE FROM park_question_groups WHERE inquiry_id = ?', ['two'])
    await prepareQuestionGroups(store); await prepareQuestionGroups(store)
    const overview = await parkOverview(store, 'park', now, { from: '2026-10-01', to: '2026-10-22' })
    const report = await parkMonthlyReport(store, 'park', '2026-10', now)
    assert.equal(overview.cards.total_inquiries, 3)
    assert.equal(overview.cards.today_inquiries, 1)
    assert.equal(overview.trend.length, 22)
    assert.equal(overview.popular_questions[0].count, 2)
    assert.deepEqual(overview.popular_questions, report.popular_questions)
    assert.equal(report.period.to, '2026-10-22')
    assert.equal((await parkMonthlyReport(store, 'park', '2026-09', now)).period.to, '2026-09-30')
    assert.equal(overview.research.four_week_signals.length, 4)
    assert.equal(overview.research.four_week_signals.at(-1)!.to, '2026-10-22')
    assert.equal((await store.db.get('SELECT COUNT(*) AS n FROM park_question_groups'))!.n, 3)
    await store.putConfig('park', { redaction_config: JSON.stringify({ extra_terms: ['入驻条件'] }) })
    const updated = await parkMonthlyReport(store, 'park', '2026-10', now)
    assert.doesNotMatch(updated.popular_questions[0].question, /入驻条件/)
    for (let i = 0; i < 12; i++) {
      const id = `rank-${i}`
      await store.recordInquiry({ orgId: 'park', sessionId: session.id, requestId: id, inquiryId: id,
        question: `第${i}项服务有什么申请条件？`, answer: 'Answer', signal: extractLeadSignal('条件'), sourceRefs: [] })
      await store.db.run('UPDATE park_inquiries SET created_at = ? WHERE id = ?', [now, id])
    }
    const ranked = await parkMonthlyReport(store, 'park', '2026-10', now)
    assert.equal(ranked.popular_questions.length, 10)
    assert.equal(ranked.popular_questions[0].count, 2)
    assert.deepEqual(ranked.popular_questions, (await parkMonthlyReport(store, 'park', '2026-10', now)).popular_questions)
  } finally { await store.db.close() }
})

void test('weekly question distribution selects period top 50 and preserves weekly counts', async () => {
  const store = new ParkStore(new SqliteDriver(new DatabaseSync(':memory:')))
  try {
    await store.init(); await store.putConfig('park', { display_name: 'Test' })
    const session = await store.createSession('park', 'web', 60000)
    async function add(id: string, question: string, day: string) {
      await store.recordInquiry({ orgId: 'park', sessionId: session.id, requestId: id, inquiryId: id,
        question, answer: 'Answer', signal: extractLeadSignal(question), sourceRefs: [] })
      await store.db.run('UPDATE park_inquiries SET created_at = ? WHERE id = ?', [Date.parse(`${day}T12:00:00+08:00`), id])
    }
    for (let i = 0; i < 55; i++) {
      await add(`single-${i}`, `第${i}个不同服务如何申请？`, i % 2 ? '2026-10-01' : '2026-10-09')
    }
    for (let i = 0; i < 4; i++) await add(`hot-${i}`, '全期最高频问题？', i < 3 ? '2026-10-01' : '2026-10-09')
    for (let i = 0; i < 3; i++) await add(`second-${i}`, '仅第二周问题？', '2026-10-09')
    for (let i = 0; i < 6; i++) await add(`outside-${i}`, '周期外问题？', '2026-09-01')
    const range = { from: '2026-10-01', to: '2026-10-14' }
    const overview = await parkOverview(store, 'park', now, range)
    const weeks = overview.research.four_week_signals
    assert.equal(overview.popular_questions.length, 10)
    assert.equal(weeks.length, 2)
    for (const week of weeks) {
      assert.equal(Object.keys(week.topics).length, 50)
      assert.equal(Object.keys(week.topics)[0], '全期最高频问题？')
      assert.equal(Object.keys(week.topics)[1], '仅第二周问题？')
      assert.equal(week.topics['周期外问题？'], undefined)
    }
    assert.deepEqual(Object.keys(weeks[0]!.topics), Object.keys(weeks[1]!.topics))
    assert.equal(weeks[0]!.topics['全期最高频问题？'], 3)
    assert.equal(weeks[1]!.topics['全期最高频问题？'], 1)
    assert.equal(weeks[0]!.topics['仅第二周问题？'], 0)
    assert.equal(weeks[1]!.topics['仅第二周问题？'], 3)
    assert.deepEqual(weeks, (await parkOverview(store, 'park', now, range)).research.four_week_signals)
    const small = await parkOverview(store, 'park', now, { from: '2026-09-01', to: '2026-09-07' })
    assert.deepEqual(small.research.four_week_signals[0]!.topics, { '周期外问题？': 6 })
  } finally { await store.db.close() }
})

void test('summary uses creation cohort and retains cumulative follow-up after conversion; missing first events remain explicit', async () => {
  const store = new ParkStore(new SqliteDriver(new DatabaseSync(':memory:')))
  try {
    await store.init(); await store.putConfig('park', { display_name: 'Test' })
    const session = await store.createSession('park', 'web', 60000)
    const lead = await store.saveLead('park', session.id, null, extractLeadSignal('contact'))
    await store.claimLead('park', lead.id, 'human')
    await store.addFollowUp('park', lead.id, 'human', 'followed', null)
    await store.closeLead('park', lead.id, 'human', 'converted')
    await store.saveContact('park', lead.id, { name: null, companyName: null, phone: null, email: null, consentText: 'yes', retentionUntil: now + 1000 })
    await store.db.run('UPDATE park_leads SET created_at = ? WHERE id = ?', [Date.parse('2026-09-01T12:00:00+08:00'), lead.id])
    await store.db.run('UPDATE park_lead_events SET occurred_at = ?', [now])
    await store.db.run('UPDATE park_follow_ups SET created_at = ?', [now])
    const report = await parkLeadSummary(store, 'park', now, { from: '2026-09-01', to: '2026-09-30' })
    assert.equal(report.following_up, 0)
    assert.equal(report.funnel.following_up, 1)
    assert.equal(report.funnel.converted, 1)
    assert.equal((await parkLeadSummary(store, 'park', now, { from: '2026-10-01', to: '2026-10-22' })).funnel.proposed, 0)
    await store.db.run("DELETE FROM park_lead_events WHERE kind IN ('claimed','converted','contacted')")
    const missing = await parkLeadSummary(store, 'park', now)
    assert.equal(missing.data_quality.missing_claim_events, 1)
    assert.equal(missing.data_quality.missing_conversion_events, 1)
    const overview = await parkOverview(store, 'park', now)
    assert.equal(overview.cards.contacted_leads, 1)
    assert.equal(overview.channel_evidence.web.contacted, 1)
    assert.equal((await parkMonthlyReport(store, 'park', '2026-10', now)).converted, null)
  } finally { await store.db.close() }
})

void test('compliance limits event dates while retaining current risk and retention', async () => {
  const store = new ParkStore(new SqliteDriver(new DatabaseSync(':memory:')))
  try {
    await store.init(); await store.putConfig('park', { display_name: 'Test' })
    await store.db.exec('CREATE TABLE operation_audit_events (org_id TEXT, response_status INTEGER, created_at BIGINT, path TEXT)')
    const session = await store.createSession('park', 'web', 60000)
    await store.db.run("UPDATE park_sessions SET risk_state = 'challenge_required', expires_at = ?", [now + 1000])
    await store.recordRejection('park', session.id, 'ip_rate', 429, null)
    await store.db.run('UPDATE park_rejection_hits SET created_at = ?', [now])
    assert.deepEqual((await parkCompliance(store, 'park', now, { from: '2026-09-01', to: '2026-09-30' })).rejection_hits.by_reason, {})
    assert.equal((await parkCompliance(store, 'park', now, { from: '2026-09-01', to: '2026-09-30' })).session_risk.challenge_required, 1)
    assert.equal((await parkCompliance(store, 'park', now)).rejection_hits.by_reason.ip_rate, 1)
  } finally { await store.db.close() }
})
