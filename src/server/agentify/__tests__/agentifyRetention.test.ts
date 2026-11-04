/**
 * Per-agent history policy: digest lookback, search decay and deletion, all in
 * hours, with server defaults from MOSS_AGENTIFY_*_HR.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'fs'
import path from 'path'
import { AgentifyConfigError, historyPolicy, parseAgentifyConfig, serverHistoryDefaults } from '../config.js'
import { recencyWeight } from '../historyIndex.js'
import { AgentifyStore } from '../store.js'
import { a2aLogPath } from '../agentHome.js'
import { createFixture, ORG, PAIR_AGENTS, configurePair, type Fixture } from './agentifyFixture.js'

const DAY = 24 * 3600 * 1000
const SHOUHOU = 'agent-shouhou-uuid'

describe('history policy config', () => {
  it('server defaults are 30 / 30 / 180 days, in hours, overridable by env', () => {
    assert.deepEqual(serverHistoryDefaults({}), { digestLookbackHours: 720, decayHalfLifeHours: 720, deleteAfterHours: 4320 })
    assert.deepEqual(
      serverHistoryDefaults({ MOSS_AGENTIFY_DIGEST_LOOKBACK_HR: '48', MOSS_AGENTIFY_DECAY_HALF_LIFE_HR: '0', MOSS_AGENTIFY_DELETE_AFTER_HR: '0' }),
      { digestLookbackHours: 48, decayHalfLifeHours: 0, deleteAfterHours: 0 },
    )
    // Nonsense falls back to the default; a zero lookback is not allowed.
    assert.equal(serverHistoryDefaults({ MOSS_AGENTIFY_DIGEST_LOOKBACK_HR: '0' }).digestLookbackHours, 720)
    assert.equal(serverHistoryDefaults({ MOSS_AGENTIFY_DELETE_AFTER_HR: 'abc' }).deleteAfterHours, 4320)
    assert.equal(serverHistoryDefaults({ MOSS_AGENTIFY_DECAY_HALF_LIFE_HR: '-5' }).decayHalfLifeHours, 720)
  })

  it('keeps per-agent hours, leaves unset ones to the server, and validates them', () => {
    const c = parseAgentifyConfig({ memory: { digestLookbackHours: 2000, decayHalfLifeHours: 0, deleteAfterHours: 0 } })
    assert.equal(c.memory.digestLookbackHours, 2000)
    assert.equal(c.memory.decayHalfLifeHours, 0)
    assert.equal(c.memory.deleteAfterHours, 0)
    const unset = parseAgentifyConfig({ memory: { share: 'full', digestLookbackHours: '' } })
    assert.equal('digestLookbackHours' in unset.memory, false)
    assert.equal('deleteAfterHours' in unset.memory, false)
    assert.throws(() => parseAgentifyConfig({ memory: { digestLookbackHours: 0 } }), AgentifyConfigError)
    assert.throws(() => parseAgentifyConfig({ memory: { deleteAfterHours: -1 } }), AgentifyConfigError)
    assert.throws(() => parseAgentifyConfig({ memory: { decayHalfLifeHours: 'soon' } }), AgentifyConfigError)
    assert.throws(
      () => parseAgentifyConfig({ memory: { digestLookbackHours: 1000, deleteAfterHours: 500 } }),
      /cannot be longer than/,
    )
    // Lookback past a deletion of 0 (= keep forever) is fine.
    assert.doesNotThrow(() => parseAgentifyConfig({ memory: { digestLookbackHours: 100000, deleteAfterHours: 0 } }))
  })

  it('the effective policy never digests further back than it deletes', () => {
    const defaults = { digestLookbackHours: 720, decayHalfLifeHours: 720, deleteAfterHours: 4320 }
    assert.deepEqual(historyPolicy(null, defaults), defaults)
    assert.deepEqual(
      historyPolicy(parseAgentifyConfig({ memory: { deleteAfterHours: 240 } }), defaults),
      { digestLookbackHours: 240, decayHalfLifeHours: 720, deleteAfterHours: 240 },
    )
    assert.equal(historyPolicy(parseAgentifyConfig({ memory: { digestLookbackHours: 9000, deleteAfterHours: 0 } }), defaults).digestLookbackHours, 9000)
  })

  it('recency weight halves its share every half-life and is flat when decay is off', () => {
    assert.equal(recencyWeight(0, 720), 1)
    assert.ok(Math.abs(recencyWeight(720 * 3600_000, 720) - 0.85) < 1e-9)
    assert.ok(Math.abs(recencyWeight(48 * 3600_000, 24) - 0.775) < 1e-9)
    assert.equal(recencyWeight(400 * DAY, 0), 1)
  })
})

describe('history policy in action', () => {
  let fx: Fixture
  afterEach(() => fx?.cleanup())

  const returns = (text: string) => [
    { role: 'user' as const, text: '统计返厂情况' },
    { role: 'assistant' as const, text },
  ]

  it('digests only sessions inside each agent’s own lookback', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    const recent = fx.addSession({ agent: 'shouhou', userId: 'u', ageMs: 10 * DAY, turns: returns('十天前：阀芯漏水 12 件') })
    const old = fx.addSession({ agent: 'shouhou', userId: 'u', ageMs: 40 * DAY, turns: returns('四十天前：灯具破损 7 件') })
    const gendanOld = fx.addSession({ agent: 'gendan', userId: 'u', ageMs: 3 * DAY, turns: returns('三天前的跟单记录') })
    // gendan only looks back one day.
    await fx.svc.configure(ORG, 'gendan', { ...fx.svc.store.getAgent(ORG, 'agent-gendan-uuid')!.config, memory: { share: 'summary', digestLookbackHours: 24 } })

    assert.equal(await fx.svc.digest.sweepOnce(), 1, 'default 30-day lookback picks only the 10-day-old session')
    assert.ok(fx.svc.store.getDocByKey(ORG, SHOUHOU, `summary:${recent}`))
    assert.equal(fx.svc.store.getDocByKey(ORG, SHOUHOU, `summary:${old}`), null)
    assert.equal(fx.svc.store.getDocByKey(ORG, 'agent-gendan-uuid', `summary:${gendanOld}`), null)

    // Widen shouhou's lookback to 50 days in hours; the 40-day session is now in reach.
    const cfg = fx.svc.store.getAgent(ORG, SHOUHOU)!.config
    await fx.svc.configure(ORG, 'shouhou', { ...cfg, memory: { ...cfg.memory, digestLookbackHours: 50 * 24 } })
    assert.equal((await fx.svc.digest.digestAgent(ORG, SHOUHOU)).digested, 1)
    const doc = fx.svc.store.getDocByKey(ORG, SHOUHOU, `summary:${old}`)!
    assert.ok(doc, 'old session digested after widening the lookback')
    // Its last activity is the session's, not the moment it was digested.
    assert.ok(Date.now() - doc.activeAt > 39 * DAY && Date.now() - doc.activeAt < 41 * DAY)
  })

  it('ranks by recency with the agent’s half-life, or not at all when decay is 0', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    const cfg = fx.svc.store.getAgent(ORG, SHOUHOU)!.config
    await fx.svc.configure(ORG, 'shouhou', { ...cfg, memory: { ...cfg.memory, digestLookbackHours: 100 * 24, decayHalfLifeHours: 24 } })
    const fresh = fx.addSession({ agent: 'shouhou', userId: 'u', turns: returns('陶瓷洗手盆裂纹返厂 9 件') })
    const old = fx.addSession({ agent: 'shouhou', userId: 'u', ageMs: 60 * DAY, turns: returns('陶瓷洗手盆裂纹返厂 9 件') })
    assert.equal((await fx.svc.digest.digestAgent(ORG, SHOUHOU)).digested, 2)

    const search = () => fx.svc.index.search({ orgId: ORG, agentId: SHOUHOU, query: '陶瓷洗手盆裂纹', viewer: { kind: 'user', userId: 'u' }, kinds: ['summary'] })
    const decayed = await search()
    assert.equal(decayed.length, 2)
    assert.equal(decayed[0]!.sessionId, fresh, 'the recent session ranks first')
    assert.ok(decayed[1]!.score / decayed[0]!.score < 0.8, 'a 60-day-old match with a 1-day half-life sits near the 0.7 floor')

    await fx.svc.configure(ORG, 'shouhou', { ...cfg, memory: { ...cfg.memory, digestLookbackHours: 100 * 24, decayHalfLifeHours: 0 } })
    const flat = await search()
    const byId = new Map(flat.map(h => [h.sessionId, h.score]))
    assert.ok(byId.get(old)! / byId.get(fresh)! > 0.95, 'without decay the two equal matches score about the same')
  })

  it('deletes history after deleteAfterHours, keeps memory, and does not re-digest it', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    const cfg = fx.svc.store.getAgent(ORG, SHOUHOU)!.config
    // Digest everything first, keeping it forever.
    await fx.svc.configure(ORG, 'shouhou', { ...cfg, memory: { ...cfg.memory, digestLookbackHours: 100 * 24, deleteAfterHours: 0 } })
    const old = fx.addSession({ agent: 'shouhou', userId: 'u', ageMs: 40 * DAY, turns: returns('旧报表：马桶盖松动 5 件'), files: { 'old.md': '# 旧报表\n马桶盖 5 件\n' } })
    const fresh = fx.addSession({ agent: 'shouhou', userId: 'u', ageMs: 2 * DAY, turns: returns('新报表：花洒堵塞 3 件'), files: { 'new.md': '# 新报表\n花洒 3 件\n' } })
    assert.equal((await fx.svc.digest.digestAgent(ORG, SHOUHOU)).digested, 2)
    await fx.svc.memory.add({ orgId: ORG, agentId: SHOUHOU, agentDisplayName: '售后返厂助手', scope: 'shared', userId: null, author: '管理员', text: '马桶盖供应商是潮州某厂' })
    // An old finished call this agent answered, with its log.
    const call = fx.svc.store.createCall({ orgId: ORG, kind: 'ask', callerAgentId: 'agent-gendan-uuid', callerSessionId: null, targetAgentId: SHOUHOU, capability: 'return-stats', input: '马桶盖返厂多少', status: 'done', depth: 1, chain: [], actorUserId: 'u', requiresConfirmation: false, idempotencyKey: null })!
    fx.store.db.prepare('UPDATE a2a_calls SET created_at = ?, finished_at = ? WHERE id = ?').run(Date.now() - 45 * DAY, Date.now() - 45 * DAY, call.id)
    const logPath = a2aLogPath(ORG, SHOUHOU, call.id)
    await fx.svc.home.write(logPath, '# 协作记录\n马桶盖返厂 5 件\n')
    await fx.svc.index.indexDoc({ orgId: ORG, agentId: SHOUHOU, kind: 'a2a', docKey: `a2a:${call.id}`, visibility: 'shared', path: logPath, title: '协作', text: '马桶盖返厂 5 件', createdAt: Date.now() - 45 * DAY, activeAt: Date.now() - 45 * DAY })

    assert.deepEqual(await fx.svc.digest.purgeExpired(), { docs: 0, sessions: 0, calls: 0 }, '0 = keep forever')

    // Lookback longer than deletion is refused when both are set.
    await assert.rejects(
      fx.svc.configure(ORG, 'shouhou', { ...cfg, memory: { ...cfg.memory, digestLookbackHours: 100 * 24, deleteAfterHours: 30 * 24 } }),
      AgentifyConfigError,
    )
    await fx.svc.configure(ORG, 'shouhou', { ...cfg, memory: { ...cfg.memory, deleteAfterHours: 30 * 24 } })
    assert.equal(historyPolicy(fx.svc.store.getAgent(ORG, SHOUHOU)!.config).digestLookbackHours, 30 * 24)

    const home = path.join(fx.dir, 'agent-home', ORG, SHOUHOU)
    const oldSummary = fx.svc.store.getDocByKey(ORG, SHOUHOU, `summary:${old}`)!
    const oldHistoryDir = path.join(fx.dir, 'agent-home', oldSummary.path.replace(/^\/agent-home\//, '').replace(/\/summary\.md$/, ''))
    assert.ok(existsSync(oldHistoryDir))
    assert.ok(existsSync(path.join(home, 'artifacts', old, 'old.md')))

    const purged = await fx.svc.digest.purgeExpired()
    assert.deepEqual(purged, { docs: 5, sessions: 1, calls: 1 }, 'summary + conversation + file list + old.md + call log of the old session')
    assert.equal(fx.svc.store.listSessionDocs(ORG, SHOUHOU, old, 'file:').length, 0, 'per-file documents deleted')
    for (const key of [`summary:${old}`, `conversation:${old}`, `artifacts:${old}`, `a2a:${call.id}`]) {
      assert.equal(fx.svc.store.getDocByKey(ORG, SHOUHOU, key), null, `${key} deleted`)
    }
    assert.ok(!existsSync(oldHistoryDir), 'history directory removed')
    assert.ok(!existsSync(path.join(home, 'artifacts', old)), 'output copies removed')
    assert.ok(!existsSync(path.join(home, 'a2a', `${call.id}.md`)), 'call log removed')
    assert.equal(fx.svc.store.getCall(call.id), null, 'finished call record removed')
    assert.equal(fx.svc.store.getDigestState(old), null)

    // The recent session and the curated memory stay.
    assert.ok(fx.svc.store.getDocByKey(ORG, SHOUHOU, `summary:${fresh}`))
    assert.ok(existsSync(path.join(home, 'artifacts', fresh, 'new.md')))
    assert.ok(fx.svc.store.getDocByKey(ORG, SHOUHOU, 'memory:shared'))
    const hits = await fx.svc.index.search({ orgId: ORG, agentId: SHOUHOU, query: '马桶盖', viewer: { kind: 'user', userId: 'u' } })
    assert.ok(hits.some(h => h.kind === 'memory'), 'the memory note is still found')
    assert.ok(hits.every(h => h.sessionId !== old && !h.snippet.includes('马桶盖松动')), 'nothing from the deleted session')

    // The background sweep leaves the deleted session alone (outside the clamped lookback).
    ;(fx.svc.digest as unknown as { lastPurgeAt: number }).lastPurgeAt = Date.now()
    await fx.svc.digest.sweepOnce()
    assert.equal(fx.svc.store.getDocByKey(ORG, SHOUHOU, `summary:${old}`), null)
    assert.deepEqual(await fx.svc.digest.purgeExpired(), { docs: 0, sessions: 0, calls: 0 })
  })

  it('the hourly sweep runs the purge', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    const cfg = fx.svc.store.getAgent(ORG, SHOUHOU)!.config
    await fx.svc.configure(ORG, 'shouhou', { ...cfg, memory: { ...cfg.memory, deleteAfterHours: 0 } })
    const sid = fx.addSession({ agent: 'shouhou', userId: 'u', ageMs: 5 * DAY, turns: returns('五天前：龙头滴水 4 件') })
    await fx.svc.digest.sweepOnce()
    assert.ok(fx.svc.store.getDocByKey(ORG, SHOUHOU, `summary:${sid}`))
    await fx.svc.configure(ORG, 'shouhou', { ...cfg, memory: { ...cfg.memory, deleteAfterHours: 72 } })
    ;(fx.svc.digest as unknown as { lastPurgeAt: number }).lastPurgeAt = 0
    await fx.svc.digest.sweepOnce()
    assert.equal(fx.svc.store.getDocByKey(ORG, SHOUHOU, `summary:${sid}`), null)
  })

  it('upgrading a database indexed before active_at existed takes each session’s last activity', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    const cfg = fx.svc.store.getAgent(ORG, SHOUHOU)!.config
    await fx.svc.configure(ORG, 'shouhou', { ...cfg, memory: { ...cfg.memory, digestLookbackHours: 100 * 24 } })
    const sid = fx.addSession({ agent: 'shouhou', userId: 'u', ageMs: 20 * DAY, turns: returns('二十天前：角阀生锈 6 件') })
    await fx.svc.digest.digestAgent(ORG, SHOUHOU)
    await fx.svc.memory.add({ orgId: ORG, agentId: SHOUHOU, agentDisplayName: '售后返厂助手', scope: 'shared', userId: null, author: '管理员', text: '角阀换供应商' })
    const db = fx.store.db
    db.exec('DROP INDEX idx_agentify_docs_active; ALTER TABLE agentify_docs DROP COLUMN active_at')
    const upgraded = new AgentifyStore(db)
    const lastActive = (db.prepare('SELECT last_active_at v FROM sessions WHERE session_id = ?').get(sid) as { v: number }).v
    assert.equal(upgraded.getDocByKey(ORG, SHOUHOU, `summary:${sid}`)!.activeAt, lastActive)
    const memory = upgraded.getDocByKey(ORG, SHOUHOU, 'memory:shared')!
    assert.equal(memory.activeAt, memory.updatedAt)
  })
})
