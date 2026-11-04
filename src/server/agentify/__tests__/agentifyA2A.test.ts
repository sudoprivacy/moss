/**
 * Agent-to-agent collaboration between two agents that serve different roles:
 * 跟单助手 (purchase follow-up) and 售后返厂助手 (after-sales returns), plus
 * an unrelated agent that is not allowed to call either.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { A2AError, type CallerContext } from '../a2aService.js'
import { createFixture, configurePair, ORG, PAIR_AGENTS, type Fixture } from './agentifyFixture.js'
import type { A2ACall } from '../store.js'

let fx: Fixture
afterEach(() => fx?.cleanup())

async function callerFor(name: string, userId: string, sessionId: string | null = null): Promise<CallerContext> {
  return fx.svc.callerFromAuth({ userId, orgId: ORG, role: 'user', scopes: [], assistantId: name, sessionId })
}

async function settle(id: string): Promise<A2ACall> {
  for (let i = 0; i < 200; i++) {
    const call = fx.svc.store.getCall(id)!
    if (fx.svc.a2a.isTerminal(call.status)) return call
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`call ${id} did not settle`)
}

async function rejects(p: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  try {
    await (typeof p === 'function' ? p() : p)
  } catch (err) {
    assert.ok(err instanceof A2AError, `expected A2AError, got ${String(err)}`)
    assert.equal(err.code, code)
    return
  }
  assert.fail(`expected ${code}`)
}

describe('agent-to-agent collaboration', () => {
  it('asks a colleague agent, which answers from its own finished work', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    // Earlier, an after-sales employee ran the returns analysis.
    const prior = fx.addSession({
      agent: 'shouhou',
      userId: 'u-shouhou',
      turns: [
        { role: 'user', text: '分析第44周返厂数据' },
        { role: 'assistant', text: '第44周返厂最多的品类是厨卫五金（128件），主因阀芯漏水，供应商为佛山某五金厂。' },
      ],
      files: { 'returns-week44.md': '# 第44周返厂\n厨卫五金 128 件\n' },
    })
    await fx.svc.digest.digestSessionById(prior)

    // The returns agent answers by searching its own history, like scode would via `agentctl recall`.
    fx.scripts.set('售后返厂助手', ({ prompt, session }) => {
      assert.match(prompt, /\[A2A ask /)
      assert.match(prompt, /read-only/)
      assert.match(session.source, /"readonly":true/)
      return { reply: '根据第44周返厂分析：厨卫五金最多（128件），主因阀芯漏水。', files: { 'answer.md': '厨卫五金 128 件' } }
    })

    const caller = await callerFor('跟单助手', 'u-gendan')
    const started = await fx.svc.a2a.ask(caller, { agent: '售后返厂助手', capability: 'return-stats', question: '上周返厂最多的是什么品类？' })
    assert.equal(started.status, 'running')
    const done = await settle(started.id)
    assert.equal(done.status, 'done', done.error ?? '')
    assert.match(done.resultText!, /厨卫五金/)
    assert.equal(done.depth, 1)
    assert.deepEqual(done.chain, ['agent-gendan-uuid'])
    assert.ok(done.resultFiles.some(f => f.endsWith('/answer.md')))

    // The target session was read-only, ran under the asking employee, and belongs to the target agent.
    const info = fx.svc.store.getSessionAgentInfo(done.targetSessionId!)!
    assert.equal(info.assistantId, 'agent-shouhou-uuid')
    assert.equal(info.userId, 'u-gendan')
    assert.equal(info.a2aReadonly, true)
    assert.equal(fx.svc.isReadonlySession(done.targetSessionId), true)

    // The target session's summary is titled by the request, not the call boilerplate.
    const summary = fx.svc.store.getDocByKey(ORG, 'agent-shouhou-uuid', `summary:${done.targetSessionId}`)!
    assert.match(summary.title, /协作请求：上周返厂最多的是什么品类/)

    // Both agents keep a searchable record of the exchange.
    for (const agentId of ['agent-gendan-uuid', 'agent-shouhou-uuid']) {
      const hits = await fx.svc.index.search({ orgId: ORG, agentId, query: '厨卫五金', viewer: { kind: 'user', userId: 'someone-else' }, kinds: ['a2a'] })
      assert.equal(hits.length, 1, `exchange logged for ${agentId}`)
    }
  })

  it('hands over only what it shares with the asking agent, never its private parts', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    const s = fx.addSession({
      agent: 'shouhou',
      userId: 'u-shouhou',
      turns: [{ role: 'user', text: '用 司机名单.csv 做返厂周报' }, { role: 'assistant', text: '周报完成：灯具返厂40件。' }],
      inputs: { '司机名单.csv': '姓名,电话\n张三,13800000000\n' },
      uploaded: ['司机名单.csv'],
      files: { 'weekly.md': '# 返厂周报\n灯具 40 件\n' },
    })
    await fx.svc.digest.digestSessionById(s)
    const conv = fx.svc.store.getDocByKey(ORG, 'agent-shouhou-uuid', `conversation:${s}`)!
    const files = fx.svc.store.getDocByKey(ORG, 'agent-shouhou-uuid', `artifacts:${s}`)!.meta.files as Array<{ path: string; homePath: string; role: string }>
    const inputPath = files.find(f => f.role === 'input')!.homePath

    // The answering session sees and hands over only what is shared with 跟单助手.
    const seen: { recall?: string[]; handed?: string; errors: string[] } = { errors: [] }
    fx.scripts.set('售后返厂助手', async ({ session }) => {
      const inner = await fx.svc.callerFromAuth({ userId: session.userId, orgId: ORG, role: 'user', scopes: [], assistantId: '售后返厂助手', sessionId: session.sessionId })
      assert.equal(inner.serving?.callerAgent.displayName, '跟单助手')
      const viewer = fx.svc.callerViewer(inner)
      seen.recall = (await fx.svc.index.search({ orgId: ORG, agentId: 'agent-shouhou-uuid', query: '返厂周报 张三 司机名单', viewer })).map(h => h.kind)
      seen.handed = (await fx.svc.a2a.handoff(inner, 'weekly.md')).name
      for (const p of [inputPath, `${inputPath}.extract.json`, '司机名单.csv', conv.path, '/agent-home/org-1/agent-gendan-uuid/x', 'artifacts/../../../etc']) {
        try {
          await fx.svc.a2a.handoff(inner, p)
          seen.errors.push(`${p}: handed`)
        } catch (err) {
          seen.errors.push(`${p}: ${(err as A2AError).code}`)
        }
      }
      // It also copies the same report into its workspace: the caller gets one weekly.md.
      return { reply: '周报见附件。', files: { 'weekly.md': '# 返厂周报\n灯具 40 件\n' } }
    })
    const gendan = await callerFor('跟单助手', 'u-gendan')
    const done = await settle((await fx.svc.a2a.ask(gendan, { agent: '售后返厂助手', capability: 'return-stats', question: '发我最近的返厂周报' })).id)
    assert.equal(done.status, 'done', done.error ?? '')
    assert.ok(seen.recall!.length > 0)
    assert.ok(seen.recall!.every(k => k === 'summary' || k === 'artifact' || k === 'a2a'), `only shared kinds: ${seen.recall}`)
    assert.equal(seen.handed, 'weekly.md')
    assert.deepEqual(seen.errors, [
      `${inputPath}: private`,
      `${inputPath}.extract.json: private`,
      '司机名单.csv: file_not_found',
      `${conv.path}: private`,
      '/agent-home/org-1/agent-gendan-uuid/x: outside_agent',
      'artifacts/../../../etc: outside_agent',
    ])

    // The handed-over file comes back with the call; only the calling agent can fetch it.
    assert.equal(done.resultFiles.filter(f => f.endsWith('/weekly.md')).length, 1, `one file per name: ${done.resultFiles}`)
    assert.match((await fx.svc.a2a.callFile(gendan, done.id, 'weekly.md')).buf.toString(), /灯具 40 件/)
    await rejects(fx.svc.a2a.callFile(gendan, done.id, '司机名单.csv'), 'file_not_found')
    await fx.svc.configure(ORG, 'other', { a2a: { callers: ['*'] } })
    await rejects(fx.svc.a2a.callFile(await callerFor('其他助手', 'u-x'), done.id, 'weekly.md'), 'call_not_found')
    // The answering agent reads its own call's files through its home, not this route.
    await rejects(fx.svc.a2a.callFile(await callerFor('售后返厂助手', 'u-shouhou'), done.id, 'weekly.md'), 'not_caller')

    // Outside a call there is nothing to hand over to.
    await rejects(fx.svc.a2a.handoff(await callerFor('售后返厂助手', 'u-shouhou'), 'weekly.md'), 'not_serving')
  })

  it('hands over nothing when the agent shares nothing with agents', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx, { shareWithAsker: false })
    const s = fx.addSession({
      agent: 'shouhou',
      userId: 'u-shouhou',
      turns: [{ role: 'user', text: '做返厂周报' }, { role: 'assistant', text: '周报完成：灯具返厂40件。' }],
      files: { 'weekly.md': '# 返厂周报\n灯具 40 件\n' },
    })
    await fx.svc.digest.digestSessionById(s)
    const seen: { recall?: number; handoff?: string; block?: string } = {}
    fx.scripts.set('售后返厂助手', async ({ session }) => {
      const inner = await fx.svc.callerFromAuth({ userId: session.userId, orgId: ORG, role: 'user', scopes: [], assistantId: '售后返厂助手', sessionId: session.sessionId })
      seen.recall = (await fx.svc.index.search({ orgId: ORG, agentId: 'agent-shouhou-uuid', query: '灯具 返厂周报', viewer: fx.svc.callerViewer(inner) })).length
      seen.handoff = await fx.svc.a2a.handoff(inner, 'weekly.md').then(() => 'handed', (err: A2AError) => err.code)
      seen.block = (await fx.svc.buildSessionBlock({ sessionId: session.sessionId, orgId: ORG, userId: session.userId, role: 'user', scopes: [], assistantName: '售后返厂助手' })) ?? ''
      return { reply: '没有可以提供的周报。' }
    })
    const done = await settle((await fx.svc.a2a.ask(await callerFor('跟单助手', 'u-gendan'), { agent: '售后返厂助手', capability: 'return-stats', question: '发我返厂周报' })).id)
    assert.equal(done.status, 'done', done.error ?? '')
    assert.equal(seen.recall, 0)
    assert.equal(seen.handoff, 'file_not_found', 'asked by name, an unshared file does not exist for the caller')
    assert.doesNotMatch(seen.block!, /做返厂周报/, 'recent work of employees is not listed while answering another agent')
    assert.match(seen.block!, /agentctl handoff/)
    // Its own employees still see it.
    assert.ok((await fx.svc.index.search({ orgId: ORG, agentId: 'agent-shouhou-uuid', query: '灯具 返厂周报', viewer: { kind: 'user', userId: 'u-li' } })).length > 0)
  })

  it('opens each capability to its own callers', async () => {
    fx = createFixture(PAIR_AGENTS)
    await fx.svc.configure(ORG, 'gendan', {})
    await fx.svc.configure(ORG, 'other', {})
    await fx.svc.configure(ORG, 'shouhou', {
      a2a: {
        capabilities: [
          { id: 'stats', kind: 'ask', description: '统计' },
          { id: 'report', kind: 'task', description: '报表', callers: { allow: ['其他助手'], deny: [] } },
        ],
        callers: { allow: ['*'], deny: ['其他助手'] },
      },
    })
    fx.scripts.set('售后返厂助手', () => ({ reply: 'ok' }))
    const gendan = await callerFor('跟单助手', 'u')
    const other = await callerFor('其他助手', 'u')
    assert.deepEqual((await fx.svc.a2a.listCallable(gendan))[0]!.capabilities.map(c => c.id), ['stats'])
    assert.deepEqual((await fx.svc.a2a.listCallable(other))[0]!.capabilities.map(c => c.id), ['report'])
    await rejects(fx.svc.a2a.delegate(gendan, { agent: '售后返厂助手', capability: 'report', input: 'x' }), 'not_allowed')
    await rejects(fx.svc.a2a.ask(other, { agent: '售后返厂助手', capability: 'stats', question: 'x' }), 'not_allowed')
    assert.equal((await fx.svc.a2a.delegate(other, { agent: '售后返厂助手', capability: 'report', input: 'x' })).status, 'queued')
  })

  it('refuses callers, capabilities and kinds that are not configured', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    await fx.svc.configure(ORG, 'other', {})
    const other = await callerFor('其他助手', 'u-x')
    await rejects(fx.svc.a2a.ask(other, { agent: '售后返厂助手', capability: 'return-stats', question: 'q' }), 'not_allowed')

    const gendan = await callerFor('跟单助手', 'u-gendan')
    await rejects(fx.svc.a2a.ask(gendan, { agent: '售后返厂助手', capability: 'nope', question: 'q' }), 'capability_not_found')
    await rejects(fx.svc.a2a.ask(gendan, { agent: '售后返厂助手', capability: 'return-report', question: 'q' }), 'wrong_kind')
    await rejects(fx.svc.a2a.ask(gendan, { agent: '跟单助手', capability: 'order-status', question: 'q' }), 'self_call')
    await rejects(fx.svc.a2a.ask(gendan, { agent: '不存在', capability: 'x', question: 'q' }), 'agent_not_found')
    await rejects(fx.svc.a2a.ask(gendan, { agent: '售后返厂助手', capability: 'return-stats', question: '  ' }), 'invalid_input')
    // A non-agentified agent cannot use the endpoints at all.
    await rejects(fx.svc.callerFromAuth({ userId: 'u', orgId: ORG, role: 'user', scopes: [], assistantId: '不存在' }), 'not_agentified')
  })

  it('lists only the colleagues and capabilities this agent may use', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    const list = await fx.svc.a2a.listCallable(await callerFor('跟单助手', 'u-gendan'))
    assert.deepEqual(list.map(a => a.displayName), ['售后返厂助手'])
    assert.deepEqual(list[0]!.capabilities.map(c => c.id), ['return-stats', 'return-report', 'notify-supplier'])
  })

  it('stops cycles and over-deep chains', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    let nested: A2ACall | null = null
    // While answering, the returns agent tries to ask the follow-up agent back.
    fx.scripts.set('售后返厂助手', ({ session }) => {
      void (async () => {
        const inner = await fx.svc.callerFromAuth({ userId: session.userId, orgId: ORG, role: 'user', scopes: [], assistantId: '售后返厂助手', sessionId: session.sessionId })
        try {
          nested = await fx.svc.a2a.ask(inner, { agent: '跟单助手', capability: 'order-status', question: '回问' })
        } catch (err) {
          nested = { error: (err as A2AError).code } as unknown as A2ACall
        }
      })()
      return { reply: 'ok' }
    })
    const done = await settle((await fx.svc.a2a.ask(await callerFor('跟单助手', 'u-gendan'), { agent: '售后返厂助手', capability: 'return-stats', question: 'q' })).id)
    assert.equal(done.status, 'done')
    for (let i = 0; i < 50 && !nested; i++) await new Promise(r => setTimeout(r, 10))
    assert.equal((nested as unknown as { error: string }).error, 'cycle')

    // Depth: a caller already two levels deep cannot go further.
    const deep = { ...(await callerFor('跟单助手', 'u-gendan')), depth: 2 }
    await rejects(fx.svc.a2a.ask(deep, { agent: '售后返厂助手', capability: 'return-stats', question: 'q' }), 'too_deep')
  })

  it('enforces the daily limit and caller visibility', async () => {
    fx = createFixture(PAIR_AGENTS)
    await fx.svc.configure(ORG, 'gendan', {})
    await fx.svc.configure(ORG, 'shouhou', {
      a2a: {
        capabilities: [{ id: 'cost', kind: 'ask', description: '成本数据', requireCallerVisibility: true }, { id: 'stats', kind: 'ask', description: '统计' }],
        callers: ['*'],
        dailyCallLimit: 1,
      },
    })
    fx.scripts.set('售后返厂助手', () => ({ reply: 'ok' }))
    const gendan = await callerFor('跟单助手', 'u-gendan')
    await rejects(fx.svc.a2a.ask(gendan, { agent: '售后返厂助手', capability: 'cost', question: 'q' }), 'caller_not_permitted')
    fx.usable.add('agent-shouhou-uuid:u-gendan')
    await settle((await fx.svc.a2a.ask(gendan, { agent: '售后返厂助手', capability: 'cost', question: 'q' })).id)
    await rejects(fx.svc.a2a.ask(gendan, { agent: '售后返厂助手', capability: 'stats', question: 'q' }), 'daily_limit')
  })

  it('runs delegated tasks; outbound ones wait for a confirmer', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    const seen: string[] = []
    fx.scripts.set('售后返厂助手', ({ session }) => {
      seen.push(session.source)
      return { reply: '已完成', files: { 'report.csv': 'sku,qty\nA-1029,40\n' } }
    })
    const gendan = await callerFor('跟单助手', 'u-gendan')

    // Plain task: queued, then executed read-only by the task loop.
    const plain = await fx.svc.a2a.delegate(gendan, { agent: '售后返厂助手', capability: 'return-report', input: '生成第44周返厂报表' })
    assert.equal(plain.status, 'queued')
    await fx.svc.a2a.tickOnce()
    const plainDone = await settle(plain.id)
    assert.equal(plainDone.status, 'done', plainDone.error ?? '')
    assert.match(seen[0]!, /"readonly":true/)
    assert.ok(plainDone.resultFiles.some(f => f.endsWith('/report.csv')))

    // Outbound task: waits; a non-confirmer cannot approve; the confirmer can.
    const outbound = await fx.svc.a2a.delegate(gendan, { agent: '售后返厂助手', capability: 'notify-supplier', input: '通知佛山五金厂处理返厂', idempotencyKey: 'k1' })
    assert.equal(outbound.status, 'pending_confirmation')
    assert.equal((await fx.svc.a2a.delegate(gendan, { agent: '售后返厂助手', capability: 'notify-supplier', input: '重复', idempotencyKey: 'k1' })).id, outbound.id)
    await fx.svc.a2a.tickOnce()
    assert.equal(fx.svc.store.getCall(outbound.id)!.status, 'pending_confirmation')
    await rejects(fx.svc.a2a.confirm({ orgId: ORG, userId: 'u-gendan', callId: outbound.id, approve: true }), 'not_confirmer')
    const approved = await fx.svc.a2a.confirm({ orgId: ORG, userId: 'u-boss', callId: outbound.id, approve: true })
    assert.equal(approved.status, 'queued')
    await rejects(fx.svc.a2a.confirm({ orgId: ORG, userId: 'u-boss', callId: outbound.id, approve: true }), 'not_pending')
    await fx.svc.a2a.tickOnce()
    const outDone = await settle(outbound.id)
    assert.equal(outDone.status, 'done')
    assert.match(seen[1]!, /"readonly":false/, 'a confirmed outbound task may act')
    assert.equal(outDone.confirmedBy, 'u-boss')

    // Rejected and cancelled tasks never run.
    const rej = await fx.svc.a2a.delegate(gendan, { agent: '售后返厂助手', capability: 'notify-supplier', input: 'x' })
    fx.admins.add('u-admin')
    assert.equal((await fx.svc.a2a.confirm({ orgId: ORG, userId: 'u-admin', callId: rej.id, approve: false, note: '不需要' })).status, 'rejected')
    const can = await fx.svc.a2a.delegate(gendan, { agent: '售后返厂助手', capability: 'return-report', input: 'y' })
    assert.equal(fx.svc.a2a.cancel(gendan, can.id).status, 'cancelled')
    await fx.svc.a2a.tickOnce()
    assert.equal(seen.length, 2)
  })

  it('records a failure when the target agent errors', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    fx.scripts.set('售后返厂助手', () => {
      throw new Error('model gateway down')
    })
    const done = await settle((await fx.svc.a2a.ask(await callerFor('跟单助手', 'u'), { agent: '售后返厂助手', capability: 'return-stats', question: 'q' })).id)
    assert.equal(done.status, 'failed')
    assert.match(done.error!, /model gateway down/)
  })

  it('remembers across employees: a new session sees what another employee’s session concluded', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    const s = fx.addSession({
      agent: 'gendan',
      userId: 'u-zhang',
      turns: [{ role: 'user', text: '跟进 PO-778 交期' }, { role: 'assistant', text: 'PO-778 供应商确认11月8日发货，物流单号 SF1234。' }],
    })
    await fx.svc.digest.digestSessionById(s)
    // Another employee in the same role starts a new session of the same agent.
    const block = await fx.svc.buildSessionBlock({ sessionId: 'new', orgId: ORG, userId: 'u-li', role: 'user', scopes: [], assistantName: '跟单助手' })
    assert.match(block!, /跟进 PO-778 交期/, 'recent work is listed')
    const hits = await fx.svc.index.search({ orgId: ORG, agentId: 'agent-gendan-uuid', query: 'PO-778 发货', viewer: { kind: 'user', userId: 'u-li' } })
    assert.ok(hits.some(h => h.snippet.includes('SF1234')))
  })
})
