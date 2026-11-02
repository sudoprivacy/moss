import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { AgentifyConfigError, listAdmitsAgent, parseAgentifyConfig } from '../config.js'
import { buildQueryTerms, canSeeDoc } from '../historyIndex.js'
import { extractiveSummary, parseTranscript, renderConversation, truncateMiddle } from '../transcriptDigest.js'
import { replyAfterPrompt } from '../sessionDriver.js'
import { ModelSummarizer } from '../summarizer.js'
import { parseMemoryEntries } from '../memory.js'
import { safeRelative } from '../agentHome.js'
import { describeOrigin, sessionHeadline } from '../digestService.js'
import { issueWikiSessionToken, verifyAccessToken } from '../../auth/token.js'
import { createFixture, ORG, PAIR_AGENTS, configurePair, type Fixture } from './agentifyFixture.js'

describe('agentify config', () => {
  it('fills defaults', () => {
    const c = parseAgentifyConfig({})
    assert.equal(c.enabled, true)
    assert.equal(c.memory.share, 'summary')
    assert.deepEqual(c.a2a.allowCallers, [])
  })

  it('rejects outbound tasks without confirmation and read-only asks with flags', () => {
    assert.throws(
      () => parseAgentifyConfig({ a2a: { capabilities: [{ id: 'x', kind: 'task', description: 'd', allowOutbound: true }] } }),
      AgentifyConfigError,
    )
    assert.throws(
      () => parseAgentifyConfig({ a2a: { capabilities: [{ id: 'x', kind: 'ask', description: 'd', requiresConfirmation: true }] } }),
      AgentifyConfigError,
    )
    assert.throws(() => parseAgentifyConfig({ a2a: { capabilities: [{ id: 'Bad Id', kind: 'ask', description: 'd' }] } }), AgentifyConfigError)
    assert.throws(
      () => parseAgentifyConfig({ a2a: { capabilities: [{ id: 'a', kind: 'ask', description: 'd' }, { id: 'a', kind: 'ask', description: 'e' }] } }),
      AgentifyConfigError,
    )
    assert.throws(() => parseAgentifyConfig({ memory: { share: 'everything' } }), AgentifyConfigError)
  })

  it('admits agents by id, name, display name or *', () => {
    const agent = { id: 'u1', name: 'gendan', displayName: '跟单助手' }
    assert.equal(listAdmitsAgent(['gendan'], agent), true)
    assert.equal(listAdmitsAgent(['跟单助手'], agent), true)
    assert.equal(listAdmitsAgent(['u1'], agent), true)
    assert.equal(listAdmitsAgent(['*'], agent), true)
    assert.equal(listAdmitsAgent(['other'], agent), false)
  })
})

describe('transcript digest', () => {
  const jsonl = [
    { type: 'user', message: { role: 'user', content: '[Assistant Rules]\nxx\n[User Request]\n上周返厂最多的品类？' }, displayText: '上周返厂最多的品类？', timestamp: '2026-11-01T01:00:00Z' },
    { type: 'tool_use', name: 'bash', input: JSON.stringify({ command: 'python stats.py --week 44' }), timestamp: '2026-11-01T01:00:05Z' },
    { type: 'tool_result', content: 'x'.repeat(50_000), timestamp: '2026-11-01T01:00:06Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '厨卫五金最多，共 128 件，SKU A-1029 占 31%。' }] }, timestamp: '2026-11-01T01:00:09Z' },
    { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'sidechain' }] } },
  ].map(e => JSON.stringify(e)).join('\n')

  it('keeps human text and replies, drops tool payloads and sidechains', () => {
    const conv = parseTranscript(jsonl)
    assert.equal(conv.firstUserText, '上周返厂最多的品类？')
    assert.equal(conv.lastAssistantText, '厨卫五金最多，共 128 件，SKU A-1029 占 31%。')
    assert.deepEqual(conv.toolNames, ['bash'])
    const md = renderConversation(conv, { maxChars: 10_000 })
    assert.match(md, /工具调用 bash: python stats.py --week 44/)
    assert.doesNotMatch(md, /xxxxxxxxxx/)
    assert.doesNotMatch(md, /sidechain/)
    assert.match(extractiveSummary(conv, ['report.md（产出，1 KB）']), /report\.md/)
  })

  it('finds the reply that follows the prompt', () => {
    const t = [
      { type: 'user', message: { content: 'old question' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'old answer' }] } },
      { type: 'user', message: { content: '[A2A ask 1]\nrules\n<request>q</request>' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'new answer' }] } },
    ].map(e => JSON.stringify(e)).join('\n')
    assert.equal(replyAfterPrompt(t, '[A2A ask 1]\nrules\n<request>q</request>'), 'new answer')
    assert.equal(replyAfterPrompt(t, 'never sent'), null)
  })

  it('truncates the middle', () => {
    const out = truncateMiddle('a'.repeat(1000), 200)
    assert.ok(out.length < 260)
    assert.match(out, /省略/)
  })

  it('titles agent-call sessions by their request', () => {
    assert.equal(sessionHeadline('[A2A ask x]\nrules\n\n<request>\n上周 返厂\n</request>'), '协作请求：上周 返厂')
    assert.equal(sessionHeadline('普通问题'), '普通问题')
    assert.equal(sessionHeadline(null), '会话')
  })

  it('describes where a session came from', () => {
    assert.match(describeOrigin(JSON.stringify({ source: 'cron', cronJobName: '日报' }), '张三'), /定时任务「日报」/)
    assert.match(describeOrigin(JSON.stringify({ source: 'a2a', callerAgentName: '跟单助手', capability: 'x' }), '李四'), /跟单助手/)
    assert.match(describeOrigin(null, '王五'), /员工 王五/)
  })
})

describe('summarizer', () => {
  it('uses the model when available and falls back on errors', async () => {
    const calls: string[] = []
    const ok = new ModelSummarizer(() => ({ url: 'https://gw.example/v1', apiKey: 'k', model: 'm' }), 1000, (async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '### 结论\n\n好' }] }), { status: 200 })
    }) as typeof fetch)
    const r1 = await ok.summarize({ agentDisplayName: 'A', conversation: 'c', artifacts: [], origin: 'o', fallbackText: 'fb' })
    assert.equal(r1.text, '### 结论\n\n好')
    assert.equal(calls[0], 'https://gw.example/v1/messages')

    const bad = new ModelSummarizer(() => ({ url: 'https://gw.example', apiKey: 'k', model: 'm' }), 1000, (async () => new Response('no', { status: 502 })) as unknown as typeof fetch)
    const r2 = await bad.summarize({ agentDisplayName: 'A', conversation: 'c', artifacts: [], origin: 'o', fallbackText: 'fb' })
    assert.deepEqual(r2, { text: 'fb', model: null })

    const none = new ModelSummarizer(() => null)
    assert.equal((await none.summarize({ agentDisplayName: 'A', conversation: 'c', artifacts: [], origin: 'o', fallbackText: 'fb' })).text, 'fb')
  })
})

describe('query terms', () => {
  it('splits Chinese into trigrams and keeps short terms for substring search', () => {
    const { fts, short } = buildQueryTerms('上周退货最多的品类 厨卫 SKU A-1029')
    assert.match(fts, /"上周退"/)
    assert.match(fts, /"A-1029"/)
    assert.match(fts, /"SKU"/)
    assert.deepEqual(short, ['厨卫'])
  })
})

describe('paths', () => {
  it('refuses to climb out of the agent home', () => {
    assert.throws(() => safeRelative('../../etc/passwd'))
    assert.equal(safeRelative('reports/./week44.md'), 'reports/week44.md')
  })
})

describe('memory entries', () => {
  it('round-trips the entry format', () => {
    const entries = parseMemoryEntries('# t\n\n- [2026-11-01 10:00 张三] 供应商A周三停产\n- [2026-11-02 09:00 李四] 返厂单号以RF开头')
    assert.equal(entries.length, 2)
    assert.equal(entries[1]!.body, '返厂单号以RF开头')
  })
})

describe('session token', () => {
  it('carries the session id', () => {
    const { token } = issueWikiSessionToken({ secret: 's', issuer: 'i', userId: 'u', orgId: 'o', role: 'user', scopes: [], keyId: 'k', assistantName: '跟单助手', sessionId: 'sess-1' })
    const auth = verifyAccessToken(token, 's', 'i')
    assert.equal(auth?.assistantId, '跟单助手')
    assert.equal(auth?.sessionId, 'sess-1')
  })
})

describe('history index and digest', () => {
  let fx: Fixture
  afterEach(() => fx?.cleanup())

  it('digests sessions into the agent home and finds them by Chinese keywords and meaning', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    const s1 = fx.addSession({
      agent: 'shouhou',
      userId: 'u-a',
      turns: [
        { role: 'user', text: '统计第44周返厂情况' },
        { role: 'assistant', text: '第44周返厂最多的品类是厨卫五金，共128件，主要原因是阀芯漏水。报表已生成 week44.md。' },
      ],
      files: { 'week44.md': '# 第44周返厂报表\n\n厨卫五金 128 件，灯具 40 件。\n', '.drafts/tmp.py': 'print(1)', '.scode/state.json': '{}' },
    })
    const r = await fx.svc.digest.digestSessionById(s1)
    assert.equal(r.status, 'ok')
    // Second digest without transcript changes is a no-op.
    assert.equal((await fx.svc.digest.digestSessionById(s1)).status, 'unchanged')

    const home = path.join(fx.dir, 'agent-home', ORG, 'agent-shouhou-uuid')
    assert.ok(existsSync(path.join(home, 'artifacts', s1, 'week44.md')))
    assert.ok(existsSync(path.join(home, 'artifacts', s1, '.drafts', 'tmp.py')))
    assert.ok(!existsSync(path.join(home, 'artifacts', s1, '.scode')))

    const agentId = 'agent-shouhou-uuid'
    const kw = await fx.svc.index.search({ orgId: ORG, agentId, query: '厨卫五金', viewerUserId: 'u-b', share: 'summary' })
    assert.ok(kw.length > 0)
    assert.ok(kw.every(h => h.kind !== 'conversation'), 'another employee must not see the raw conversation')
    const short = await fx.svc.index.search({ orgId: ORG, agentId, query: '阀芯', viewerUserId: 'u-b', share: 'summary' })
    assert.ok(short.some(h => h.snippet.includes('阀芯')))
    const report = await fx.svc.index.search({ orgId: ORG, agentId, query: '灯具 40 件', viewerUserId: 'u-b', share: 'summary', kinds: ['artifact'] })
    assert.equal(report.length, 1)

    const own = await fx.svc.index.search({ orgId: ORG, agentId, query: '统计第44周', viewerUserId: 'u-a', share: 'summary', kinds: ['conversation'] })
    assert.equal(own.length, 1, 'the employee who ran the session sees its conversation')
    const full = await fx.svc.index.search({ orgId: ORG, agentId, query: '统计第44周', viewerUserId: 'u-b', share: 'full', kinds: ['conversation'] })
    assert.equal(full.length, 1, 'share=full opens conversations to other employees')
  })

  it('digests an agent on demand even while the background sweep is busy', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    fx.addSession({ agent: 'shouhou', userId: 'u', turns: [{ role: 'user', text: '统计灯具返厂' }, { role: 'assistant', text: '灯具返厂40件' }] })
    // A sweep that is "running" makes sweepOnce a no-op; digestAgent must not depend on it.
    ;(fx.svc.digest as unknown as { running: boolean }).running = true
    assert.equal(await fx.svc.digest.sweepOnce(), 0)
    assert.equal((await fx.svc.digest.digestAgent(ORG, 'agent-shouhou-uuid')).digested, 1)
    const hits = await fx.svc.index.search({ orgId: ORG, agentId: 'agent-shouhou-uuid', query: '灯具返厂', viewerUserId: 'x', share: 'summary' })
    assert.ok(hits.some(h => h.kind === 'summary'))
  })

  it('waits for a digest that is already running instead of skipping it', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    const sid = fx.addSession({ agent: 'shouhou', userId: 'u', turns: [{ role: 'user', text: '统计管材返厂' }, { role: 'assistant', text: '管材返厂18件' }] })
    // Make the summarizer slow, like a real model call.
    const slow = { async summarize(i: { fallbackText: string }) { await new Promise(r => setTimeout(r, 300)); return { text: i.fallbackText, model: null } } }
    ;(fx.svc.digest as unknown as { deps: { summarizer: unknown } }).deps.summarizer = slow
    const sweep = fx.svc.digest.digestSessionById(sid)
    await new Promise(r => setTimeout(r, 20))
    const now = await fx.svc.digest.digestAgent(ORG, 'agent-shouhou-uuid')
    assert.equal(now.digested, 0, 'the second digest finds the work already done')
    assert.equal((await sweep).status, 'ok')
    // By the time digestAgent returned, the summary is searchable.
    assert.ok(fx.svc.store.getDocByKey(ORG, 'agent-shouhou-uuid', `summary:${sid}`))
  })

  it('stamps stable agent ids on existing sessions by display name', async () => {
    fx = createFixture(PAIR_AGENTS)
    const sid = fx.addSession({ agent: 'gendan', userId: 'u', turns: [{ role: 'user', text: 'hi' }] })
    fx.store.db.prepare('UPDATE sessions SET assistant_id = NULL WHERE session_id = ?').run(sid)
    assert.equal(await fx.svc.digest.backfillAgentIds(), 1)
    assert.equal(fx.svc.store.getSessionAgentInfo(sid)?.assistantId, 'agent-gendan-uuid')
  })

  it('keeps shared and private memory apart and injects both', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    const base = { orgId: ORG, agentId: 'agent-gendan-uuid', agentDisplayName: '跟单助手', author: '张三' }
    await fx.svc.memory.add({ ...base, scope: 'shared', userId: null, text: '供应商佛山陶瓷每周三停产' })
    await fx.svc.memory.add({ ...base, scope: 'shared', userId: null, text: '供应商佛山陶瓷每周三停产' })
    await fx.svc.memory.add({ ...base, scope: 'private', userId: 'u-a', text: '张三喜欢表格形式的回复' })
    assert.equal((await fx.svc.memory.read(ORG, base.agentId, 'shared', null)).match(/佛山陶瓷/g)?.length, 1)

    const forA = await fx.svc.memory.buildInjection({ orgId: ORG, agentId: base.agentId, userId: 'u-a', budget: 2000, recentWork: [] })
    assert.match(forA, /佛山陶瓷/)
    assert.match(forA, /表格/)
    const forB = await fx.svc.memory.buildInjection({ orgId: ORG, agentId: base.agentId, userId: 'u-b', budget: 2000, recentWork: [] })
    assert.doesNotMatch(forB, /表格/)
    const hitsB = await fx.svc.index.search({ orgId: ORG, agentId: base.agentId, query: '表格形式', viewerUserId: 'u-b', share: 'full' })
    assert.equal(hitsB.length, 0, 'private memory never leaks, even with share=full')
  })

  it('builds the first-message block only for agentified agents', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    const block = await fx.svc.buildSessionBlock({ sessionId: 'x', orgId: ORG, userId: 'u', role: 'user', scopes: [], assistantName: '跟单助手' })
    assert.ok(block)
    assert.match(block!, /\[Agent Home & Collaboration\]/)
    assert.match(block!, /售后返厂助手/)
    assert.match(block!, /return-stats/)
    assert.equal(await fx.svc.buildSessionBlock({ sessionId: 'x', orgId: ORG, userId: 'u', role: 'user', scopes: [], assistantName: '其他助手' }), null)
  })

  it('canSeeDoc rules', () => {
    assert.equal(canSeeDoc({ visibility: 'shared', userId: 'a', kind: 'summary' }, 'b', 'summary'), true)
    assert.equal(canSeeDoc({ visibility: 'private', userId: 'a', kind: 'conversation' }, 'b', 'summary'), false)
    assert.equal(canSeeDoc({ visibility: 'private', userId: 'a', kind: 'conversation' }, 'a', 'summary'), true)
    assert.equal(canSeeDoc({ visibility: 'private', userId: 'a', kind: 'conversation' }, null, 'full'), false)
    assert.equal(canSeeDoc({ visibility: 'private', userId: 'a', kind: 'memory' }, 'b', 'full'), false)
  })

  it('reads its own summary files back', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    const s = fx.addSession({ agent: 'gendan', userId: 'u', turns: [{ role: 'user', text: '跟进PO-778交期' }, { role: 'assistant', text: 'PO-778 预计11月8日到货。' }] })
    const r = await fx.svc.digest.digestSessionById(s)
    const file = path.join(fx.dir, 'agent-home', r.summaryPath!.replace('/agent-home/', ''))
    assert.match(readFileSync(file, 'utf8'), /PO-778 预计11月8日到货/)
  })
})
