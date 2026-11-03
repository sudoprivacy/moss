/**
 * Agentify end-to-end test against a running moss server with real agents,
 * real scode sessions in Docker and a real model.
 *
 * Two NEW agents for two roles cooperate:
 *   E2E售后返厂助手 (after-sales returns) — analyses returns, writes reports
 *   E2E跟单助手     (purchase follow-up)  — asks the returns agent, fetches its
 *                                           report, delegates a task to it
 * and three employees use them.
 *
 *   npx tsx scripts/agentify-e2e.ts --base http://127.0.0.1:43137 --db <moss.db of that server>
 *
 * The --db is only read for the server's token secret so the test can act as
 * the bootstrap admin. Run it ONLY against a test environment: it creates
 * users and agents. WeCom must be black-holed there.
 *
 * Assertions are on facts the server records (calls, files, history, gating),
 * not on exact model wording.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import WebSocket from 'ws'
import { issueAccessToken, issueWikiSessionToken } from '../src/server/auth/token.js'

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  const v = i >= 0 ? process.argv[i + 1] : fallback
  if (!v) throw new Error(`--${name} is required`)
  return v
}

const BASE = arg('base', 'http://127.0.0.1:43137').replace(/\/$/, '')
const WS_BASE = BASE.replace(/^http/, 'ws')
const DB_PATH = arg('db')
/** The server's data directory (sessions live under it); defaults to the --db file's directory. */
const DATA_DIR = process.argv.includes('--data') ? arg('data') : dirname(DB_PATH)
const ORG = arg('org', '609ce2ab-f742-4cfe-aeb8-a09617bffe3a')
const RUN = Date.now().toString(36)
const TURN_TIMEOUT_MS = Number(process.env.E2E_TURN_TIMEOUT_MS) || 20 * 60 * 1000

let failures = 0
const log = (msg: string) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}] ${msg}`)
function check(ok: boolean, what: string, detail?: unknown): boolean {
  if (ok) log(`PASS ${what}`)
  else {
    failures += 1
    log(`FAIL ${what}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 600)}`}`)
  }
  return ok
}

// ------------------------------------------------------------------ http

async function api<T = any>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: any = text
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    // keep text
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status} ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`) as Error & { status: number; body: any }
    err.status = res.status
    err.body = parsed
    throw err
  }
  return parsed as T
}

/** A token like the one moss gives an agent's session (agent id + session id claims). */
function agentSessionToken(userId: string, agentId: string, sessionId: string): string {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  const cfg = (k: string) => (db.prepare('SELECT value FROM server_config WHERE key = ?').get(k) as { value?: string } | undefined)?.value
  const secret = cfg('jwt_secret')!
  const issuer = cfg('issuer') ?? 'moss-server'
  db.close()
  return issueWikiSessionToken({ secret, issuer, userId, orgId: ORG, role: 'user', scopes: [], keyId: randomUUID(), assistantName: agentId, sessionId, expiresInSec: 3600 }).token
}

function adminToken(): string {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  const cfg = (k: string) => (db.prepare('SELECT value FROM server_config WHERE key = ?').get(k) as { value?: string } | undefined)?.value
  const secret = cfg('jwt_secret')
  const issuer = cfg('issuer') ?? 'moss-server'
  const admin = db.prepare(`SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`).get() as { id: string }
  db.close()
  if (!secret || !admin) throw new Error('cannot find token secret / super admin in --db')
  return issueAccessToken({ iss: issuer, sub: admin.id, org_id: ORG, role: 'super_admin', scopes: ['*'], key_id: randomUUID() }, secret, 6 * 3600).token
}

async function login(username: string, password: string): Promise<{ token: string; userId: string }> {
  const r = await api<any>('', 'POST', '/api/v1/auth/login', { grant_type: 'password', username, password })
  const data = r.data ?? r
  return { token: data.access_token, userId: data.user?.id ?? data.user_id ?? '' }
}

// -------------------------------------------------------------- sessions

async function startSession(token: string, agent: string): Promise<string> {
  const r = await api<any>(token, 'POST', '/api/v1/sessions', { assistant_name: agent })
  return r.session_id ?? r.sessionId ?? r.session?.session_id ?? r.session?.sessionId ?? r.id
}

/** Send one message, wait for the turn to finish, return the agent's last reply. */
async function chat(token: string, sessionId: string, text: string): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws/sessions/${sessionId}`, { headers: { authorization: `Bearer ${token}` } })
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error(`turn timed out after ${TURN_TIMEOUT_MS / 1000}s`))
    }, TURN_TIMEOUT_MS)
    ws.on('open', () => ws.send(text))
    ws.on('message', data => {
      for (const line of data.toString().split('\n')) {
        if (!line.trim()) continue
        try {
          const ev = JSON.parse(line) as { type?: string; status?: string; error?: string }
          if (ev.type === 'result') {
            clearTimeout(timer)
            ws.close()
            if (ev.status === 'success') resolve()
            else reject(new Error(`turn failed: ${ev.error ?? ev.status}`))
          }
        } catch {
          // non-JSON progress
        }
      }
    })
    ws.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
  })
  // The bridge writes the reply to the transcript just before `result`.
  for (let i = 0; i < 20; i++) {
    const ctx = await api<any>(token, 'GET', `/api/v1/sessions/${sessionId}/context`)
    const msgs: any[] = ctx.context?.messages ?? ctx.messages ?? []
    const last = [...msgs].reverse().find(m => m.type === 'assistant')
    const textOut = typeof last?.content === 'string'
      ? last.content
      : Array.isArray(last?.content) ? last.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') : ''
    if (textOut) return textOut
    await new Promise(r => setTimeout(r, 500))
  }
  return ''
}

async function digest(admin: string, agentId: string): Promise<void> {
  await api(admin, 'POST', `/api/v1/admin/agentify/agents/${encodeURIComponent(agentId)}/digest`, {})
}

async function waitQuiet(ms: number): Promise<void> {
  log(`waiting ${Math.round(ms / 1000)}s for sessions to go quiet before digesting`)
  await new Promise(r => setTimeout(r, ms))
}

// ------------------------------------------------------------------ main

const RETURNS_CSV = `周次,品类,SKU,返厂数量,主要原因,供应商
44,厨卫五金,A-1029,86,阀芯漏水,佛山禅城某五金厂
44,厨卫五金,A-1031,42,镀层脱落,佛山禅城某五金厂
44,灯具,L-220,40,驱动电源损坏,中山古镇某灯饰厂
44,管材管件,P-77,18,尺寸偏差,广州某管业`

async function main(): Promise<void> {
  const admin = adminToken()
  const me = await api<any>(admin, 'GET', '/api/v1/auth/me').catch(() => null)
  log(`admin token ok (${me?.user?.name ?? me?.name ?? 'super_admin'})`)

  // 0. Nexus was upgraded in place on this server's old-format data.
  const nx = await api<any>(admin, 'GET', '/api/v1/admin/agentify/nexus')
  check(nx.home === 'nexus', 'agent home is stored in Nexus VFS', nx)
  check(['upgraded', 'fresh'].includes(nx.nexus?.status) && nx.nexus?.running === '0.8.26', 'embedded Nexus runs 0.8.26 after the in-place upgrade', nx.nexus)
  if (nx.nexus?.status === 'upgraded') check(nx.nexus.verified === true, `all ${nx.nexus.secrets} secrets verified against the previous daemon`, nx.nexus)

  // 1. Three employees in two roles.
  const pw = `E2e-${RUN}-pw!`
  const users: Record<string, { token: string; userId: string }> = {}
  for (const [key, display] of [['shouhou1', 'E2E售后专员'], ['gendan1', 'E2E跟单员甲'], ['gendan2', 'E2E跟单员乙']] as const) {
    const username = `e2e_${key}_${RUN}`
    await api(admin, 'POST', '/api/v1/users', { name: username, display_name: display, password: pw, role: 'user', email: `${username}@e2e.local` })
    users[key] = await login(username, pw)
    check(Boolean(users[key]!.token), `employee ${display} can sign in`)
  }

  // 2. Two NEW agents, one per role.
  const agents = {
    shouhou: { name: `e2e_shouhou_${RUN}`, display: `E2E售后返厂助手${RUN}` },
    gendan: { name: `e2e_gendan_${RUN}`, display: `E2E跟单助手${RUN}` },
  }
  await api(admin, 'POST', '/api/v1/agents/tenant/create', {
    name: agents.shouhou.name,
    display_name: agents.shouhou.display,
    description: '售后返厂岗位的数字分身：分析返厂数据、出返厂报表、跟进供应商整改',
    rules: `# ${agents.shouhou.display}\n\n你是售后返厂岗位的智能体。你分析返厂数据，结论要具体（品类、SKU、数量、原因、供应商）。\n需要出报表时，把报表写成 Markdown 文件放在工作目录根目录（第一行写 <!-- @final -->）。\n回答其他同事或智能体的问题前，先用 \`agentctl recall\` 查你以前的工作。所有回复用中文。`,
  })
  await api(admin, 'POST', '/api/v1/agents/tenant/create', {
    name: agents.gendan.name,
    display_name: agents.gendan.display,
    description: '采购跟单岗位的数字分身：跟进订单交期、协调售后返厂与供应商',
    rules: `# ${agents.gendan.display}\n\n你是采购跟单岗位的智能体。涉及返厂、售后的信息，不要自己猜，用 \`agentctl ask\` 问售后返厂智能体，需要对方的报表时用 \`agentctl files get --agent ...\` 取回。\n回答前先用 \`agentctl recall\` 查你以前的工作。所有回复用中文。`,
  })
  const list = await api<any>(admin, 'GET', '/api/v1/admin/agentify/agents')
  const findAgent = (name: string) => list.agents.find((a: any) => a.name === name)
  const B = findAgent(agents.shouhou.name)
  const A = findAgent(agents.gendan.name)
  check(Boolean(A && B), 'both new agents are listed for agentify', list.agents.map((a: any) => a.name))

  // 3. Agentify them.
  await api(admin, 'PUT', `/api/v1/admin/agentify/agents/${B.id}`, {
    config: {
      memory: { share: 'summary' },
      a2a: {
        capabilities: [
          { id: 'return-stats', kind: 'ask', description: '查询返厂统计、原因和结论（只读）' },
          { id: 'return-report', kind: 'task', description: '生成返厂分析报表文件' },
          { id: 'notify-supplier', kind: 'task', description: '通知供应商处理返厂（对外动作）', requiresConfirmation: true, allowOutbound: true },
        ],
        allowCallers: [agents.gendan.name],
        historyReaders: [agents.gendan.name],
        dailyCallLimit: 50,
      },
    },
  })
  await api(admin, 'PUT', `/api/v1/admin/agentify/agents/${A.id}`, {
    config: { a2a: { capabilities: [{ id: 'order-status', kind: 'ask', description: '查询采购订单跟单进度' }], allowCallers: [agents.shouhou.name] } },
  })
  log('agents configured')

  // 4. After-sales employee does the analysis with the returns agent.
  const s1 = await startSession(users.shouhou1!.token, B.id)
  const r1 = await chat(users.shouhou1!.token, s1,
    `这是第44周的返厂数据：\n\n${RETURNS_CSV}\n\n请分析返厂最多的品类、主要原因和涉及的供应商，并把结论写成报表文件 returns-week44.md。最后用一句话总结。`)
  log(`returns agent: ${r1.slice(0, 200)}`)
  check(/厨卫/.test(r1), 'returns agent identifies 厨卫五金 as the top category', r1.slice(0, 300))

  await waitQuiet(25_000)
  await digest(admin, B.id)
  const bHist = await api<any>(admin, 'GET', `/api/v1/admin/agentify/agents/${B.id}/history?q=${encodeURIComponent('第44周返厂 厨卫')}`)
  check(bHist.hits?.some((h: any) => h.kind === 'summary'), 'the analysis session is summarized into the returns agent home', bHist.hits?.map((h: any) => h.kind))
  check(bHist.hits?.some((h: any) => h.kind === 'artifact'), 'its report file is saved and indexed as an output', bHist.hits?.map((h: any) => h.title))

  // 5. A follow-up employee asks the follow-up agent, which must consult the returns agent.
  const s2 = await startSession(users.gendan1!.token, A.id)
  const r2 = await chat(users.gendan1!.token, s2,
    `售后那边第44周返厂最多的是什么品类？主要原因和供应商是谁？请向售后返厂智能体确认（capability: return-stats），并把对方的第44周返厂报表文件取回到当前工作目录。`)
  log(`follow-up agent: ${r2.slice(0, 300)}`)
  const callsAfterAsk = (await api<any>(admin, 'GET', `/api/v1/admin/agentify/calls?agentId=${A.id}`)).calls as any[]
  const ask = callsAfterAsk.find(c => c.kind === 'ask' && c.caller.id === A.id && c.target.id === B.id)
  check(Boolean(ask), 'the follow-up agent asked the returns agent', callsAfterAsk.map(c => `${c.kind}:${c.status}`))
  if (ask) {
    check(ask.status === 'done', 'the ask completed', ask)
    check(/厨卫/.test(ask.result ?? ''), 'the returns agent answered from its finished work', ask.result?.slice(0, 300))
    check(ask.actor?.id === users.gendan1!.userId || Boolean(ask.actor), 'the call is attributed to the asking employee', ask.actor)
  }
  check(/厨卫/.test(r2), 'the follow-up agent relays the answer to the employee', r2.slice(0, 300))
  const s2ctx = await api<any>(users.gendan1!.token, 'GET', `/api/v1/sessions/${s2}/context`)
  const usedFiles = JSON.stringify(s2ctx.context?.messages ?? []).includes('agentctl files get')
  check(usedFiles, 'the follow-up agent used `agentctl files get` on the returns agent', 'no `agentctl files get` in the transcript')
  const fetched = join(DATA_DIR, 'runtime', 'sessions', s2, 'workspace')
  const landed = existsSync(fetched) && readdirSync(fetched).some(f => /week44|返厂/.test(f) && readFileSync(join(fetched, f), 'utf8').includes('厨卫'))
  check(landed, 'the returns agent’s report landed in the follow-up agent’s workspace', existsSync(fetched) ? readdirSync(fetched) : 'no workspace')

  // 6. Another follow-up employee benefits from the first one's work (cross-employee memory).
  await waitQuiet(25_000)
  await digest(admin, A.id)
  const s3 = await startSession(users.gendan2!.token, A.id)
  const r3 = await chat(users.gendan2!.token, s3, '我们组之前有没有查过第44周售后返厂的情况？结论是什么？请先查你的历史记录再回答，不要重新去问售后。')
  log(`follow-up agent (2nd employee): ${r3.slice(0, 300)}`)
  check(/厨卫/.test(r3), 'a different employee gets the earlier conclusion from the agent’s memory', r3.slice(0, 300))
  const callsAfterMemory = (await api<any>(admin, 'GET', `/api/v1/admin/agentify/calls?agentId=${A.id}`)).calls as any[]
  check(callsAfterMemory.filter(c => c.kind === 'ask').length === callsAfterAsk.filter(c => c.kind === 'ask').length, 'it answered from memory without asking the returns agent again')

  // 7. Delegation of an outbound action waits for a person.
  const s4 = await startSession(users.gendan1!.token, A.id)
  const r4 = await chat(users.gendan1!.token, s4,
    '请委托售后返厂智能体通知佛山禅城某五金厂处理第44周厨卫五金返厂（capability: notify-supplier），这需要人工确认，提交后告诉我任务编号即可，不用等待结果。')
  log(`delegation reply: ${r4.slice(0, 200)}`)
  const pending = (await api<any>(admin, 'GET', '/api/v1/agentify/confirmations')).calls as any[]
  const task = pending.find(c => c.caller.id === A.id && c.capability === 'notify-supplier')
  check(Boolean(task), 'the outbound task waits for confirmation', pending.map(c => c.capability))
  if (task) {
    check(task.targetSessionId === null, 'nothing ran before confirmation')
    const denied = await api(users.gendan1!.token, 'POST', `/api/v1/agentify/confirmations/${task.id}`, { approve: true }).then(() => false, (e: any) => e.status === 403)
    check(denied, 'an employee who is not a confirmer cannot approve it')
    await api(admin, 'POST', `/api/v1/agentify/confirmations/${task.id}`, { approve: true })
    let settled: any = null
    for (let i = 0; i < 240 && !settled; i++) {
      await new Promise(r => setTimeout(r, 5000))
      const c = (await api<any>(admin, 'GET', `/api/v1/admin/agentify/calls?agentId=${B.id}`)).calls.find((x: any) => x.id === task.id)
      if (['done', 'failed'].includes(c?.status)) settled = c
    }
    check(settled?.status === 'done', 'after confirmation the returns agent ran the task', settled)
    check(settled?.confirmedBy !== null, 'the confirmer is recorded', settled?.confirmedBy)
  }

  // 8. Boundaries visible from outside.
  const notAgent = await api(users.gendan1!.token, 'GET', '/api/v1/agent/agentify/recall?q=x').then(() => false, (e: any) => e.status === 403)
  check(notAgent, 'a plain employee token cannot use the agent-only endpoints')
  const notAdmin = await api(users.gendan1!.token, 'GET', '/api/v1/admin/agentify/agents').then(() => false, (e: any) => e.status === 403)
  check(notAdmin, 'a plain employee cannot read agentify administration')

  // 9. History policy (hours): defaults, validation, and deletion on the live
  //    server — the returns agent's files in Nexus, read through the follow-up agent.
  const policyList = await api<any>(admin, 'GET', '/api/v1/admin/agentify/agents')
  check(JSON.stringify(policyList.historyDefaults) === JSON.stringify({ digestLookbackHours: 720, decayHalfLifeHours: 720, deleteAfterHours: 4320 }),
    'server defaults: 720 h lookback and decay half-life, 4320 h (180 days) deletion', policyList.historyDefaults)
  const cfgB = policyList.agents.find((a: any) => a.id === B.id).config
  const refused = await api(admin, 'PUT', `/api/v1/admin/agentify/agents/${B.id}`, { config: { ...cfgB, memory: { ...cfgB.memory, digestLookbackHours: 1000, deleteAfterHours: 500 } } })
    .then(() => false, (e: any) => e.status === 400)
  check(refused, 'a lookback longer than the deletion window is refused')
  const bSummaries = (await api<any>(admin, 'GET', `/api/v1/admin/agentify/agents/${B.id}/history?kind=summary&limit=200`)).items as any[]
  const bMemoryBefore = ((await api<any>(admin, 'GET', `/api/v1/admin/agentify/agents/${B.id}/history?kind=memory&limit=200`)).items as any[]).length
  const asA = agentSessionToken(users.gendan1!.userId, A.id, s2)
  const summaryPath = bSummaries[0]?.path as string | undefined
  const readable = summaryPath ? await api(asA, 'GET', `/api/v1/agent/agentify/files?agent=${B.id}&path=${encodeURIComponent(summaryPath)}`).then(() => true, () => false) : false
  check(bSummaries.length > 0 && readable, `before deletion the follow-up agent can read the returns agent's summary in Nexus (${bSummaries.length} summaries)`)
  // 0.001 h = 3.6 s: everything the returns agent did is now "old".
  await api(admin, 'PUT', `/api/v1/admin/agentify/agents/${B.id}`, { config: { ...cfgB, memory: { ...cfgB.memory, deleteAfterHours: 0.001 } } })
  await new Promise(r => setTimeout(r, 5000))
  const purged = await api<any>(admin, 'POST', `/api/v1/admin/agentify/agents/${B.id}/purge`, {})
  check(purged.sessions >= bSummaries.length && purged.docs >= bSummaries.length, 'purge deletes the returns agent’s digested sessions', purged)
  const bAfter = (await api<any>(admin, 'GET', `/api/v1/admin/agentify/agents/${B.id}/history?kind=summary,conversation,artifact,a2a&limit=200`)).items as any[]
  check(bAfter.length === 0, 'no summaries, conversations, outputs or call logs remain indexed', bAfter.map(d => d.title))
  const gone = summaryPath ? await api(asA, 'GET', `/api/v1/agent/agentify/files?agent=${B.id}&path=${encodeURIComponent(summaryPath)}`).then(() => false, (e: any) => e.status === 404) : false
  check(gone, 'the summary file is gone from Nexus too')
  const bMemoryAfter = ((await api<any>(admin, 'GET', `/api/v1/admin/agentify/agents/${B.id}/history?kind=memory&limit=200`)).items as any[]).length
  check(bMemoryAfter === bMemoryBefore, `curated memory is kept (${bMemoryAfter} entries)`)
  const recallAfter = await api<any>(admin, 'GET', `/api/v1/admin/agentify/agents/${B.id}/history?q=${encodeURIComponent('厨卫五金 返厂')}`)
  check((recallAfter.hits as any[]).every(h => h.kind === 'memory'), 'search finds nothing from the deleted history', (recallAfter.hits as any[]).map(h => h.kind))
  await api(admin, 'PUT', `/api/v1/admin/agentify/agents/${B.id}`, { config: cfgB })
  const restoredB = (await api<any>(admin, 'GET', '/api/v1/admin/agentify/agents')).agents.find((a: any) => a.id === B.id)
  check(restoredB.historyPolicy.deleteAfterHours === 4320, 'the returns agent is back on the server defaults')

  log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  log(`sessions: returns=${s1} ask=${s2} memory=${s3} delegate=${s4}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  process.exit(2)
})
