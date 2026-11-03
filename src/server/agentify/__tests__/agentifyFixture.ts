/**
 * Shared fixture for agentify tests: a real moss.db (DirectConnectStore, so
 * the sessions table is the production one), agents on disk, a local agent
 * home, a deterministic embedder and a scripted session driver standing in
 * for scode.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, utimesSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { DirectConnectStore } from '../../db.js'
import type { AssistantStoreMeta } from '../../agentStore.js'
import type { Embedder } from '../../wikiIndex/embedder.js'
import { AgentifyService } from '../service.js'
import type { CreateAgentSessionInput, SessionDriver } from '../sessionDriver.js'
import type { Summarizer } from '../summarizer.js'

export const ORG = 'org-1'

/** Character-bigram hashing: texts sharing words land near each other. */
export function fakeEmbedder(dim = 128): Embedder {
  const vec = (text: string): Float32Array => {
    const v = new Float32Array(dim)
    const t = text.replace(/^(query|passage): /, '').replace(/\s+/g, '')
    for (let i = 0; i + 2 <= t.length; i++) {
      let h = 2166136261
      for (const ch of t.slice(i, i + 2)) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619)
      v[Math.abs(h) % dim]! += 1
    }
    let norm = 0
    for (const x of v) norm += x * x
    norm = Math.sqrt(norm) || 1
    for (let i = 0; i < dim; i++) v[i]! /= norm
    return v
  }
  return {
    dim,
    modelId: 'fake',
    passage: async texts => texts.map(vec),
    query: async text => vec(text),
  }
}

export const echoSummarizer: Summarizer = {
  async summarize(input) {
    return { text: `### 结论\n\n${input.fallbackText}`, model: 'fake-model' }
  },
}

export type ScriptedAgent = (input: { prompt: string; session: CreateAgentSessionInput & { sessionId: string } }) => { reply: string; files?: Record<string, string> }

export interface Fixture {
  dir: string
  store: DirectConnectStore
  svc: AgentifyService
  agents: Record<string, { id: string; dir: string }>
  driverCalls: Array<{ sessionId: string; input: CreateAgentSessionInput; prompt?: string }>
  scripts: Map<string, ScriptedAgent>
  usable: Set<string>
  admins: Set<string>
  /** Create a finished session for an agent with a transcript. */
  addSession(input: {
    agent: string
    userId: string
    turns: Array<{ role: 'user' | 'assistant'; text: string }>
    /** Files the agent wrote (after its first reply). */
    files?: Record<string, string | Buffer>
    /** Files the employee provided before the agent started; `uploaded` ones go through the upload API. */
    inputs?: Record<string, string | Buffer>
    uploaded?: string[]
    source?: string
    ageMs?: number
  }): string
  cleanup(): void
}

function transcriptLine(role: 'user' | 'assistant', text: string, sessionId: string, at: number): string {
  const message = role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] }
  return `${JSON.stringify({ type: role, sessionId, uuid: randomUUID(), parentUuid: null, isSidechain: false, timestamp: new Date(at).toISOString(), message })}\n`
}

export function createFixture(agentMetas: Array<AssistantStoreMeta & { id: string; name: string; display_name: string }>): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentify-test-'))
  const store = new DirectConnectStore(path.join(dir, 'moss.db'))
  const agentsDir = path.join(dir, 'assistants')
  const agents: Fixture['agents'] = {}
  for (const meta of agentMetas) {
    const d = path.join(agentsDir, meta.name)
    mkdirSync(d, { recursive: true })
    writeFileSync(path.join(d, '_moss_meta.json'), JSON.stringify(meta))
    agents[meta.name] = { id: meta.id, dir: d }
  }
  const lookup = {
    async findAssistantDir(nameOrId: string) {
      for (const name of await readdir(agentsDir)) {
        const meta = JSON.parse(await readFile(path.join(agentsDir, name, '_moss_meta.json'), 'utf8')) as AssistantStoreMeta
        if (name === nameOrId || meta.id === nameOrId || meta.display_name === nameOrId || meta.name === nameOrId) {
          return { dir: path.join(agentsDir, name) }
        }
      }
      return null
    },
    async readAssistantMeta(d: string) {
      try {
        return JSON.parse(await readFile(path.join(d, '_moss_meta.json'), 'utf8')) as AssistantStoreMeta
      } catch {
        return null
      }
    },
  }

  const driverCalls: Fixture['driverCalls'] = []
  const scripts = new Map<string, ScriptedAgent>()
  const usable = new Set<string>()
  const admins = new Set<string>()
  const runtimeDir = path.join(dir, 'runtime')
  // eslint-disable-next-line prefer-const
  let svc: AgentifyService

  const driver: SessionDriver = {
    async createAgentSession(input) {
      const sessionId = randomUUID()
      const transcriptPath = path.join(runtimeDir, 'sessions', sessionId, 'transcript.jsonl')
      mkdirSync(path.dirname(transcriptPath), { recursive: true })
      mkdirSync(input.cwd, { recursive: true })
      store.createSession({
        sessionId,
        transcriptSessionId: sessionId,
        transcriptPath,
        userId: input.userId,
        orgId: input.orgId,
        role: input.role,
        scopes: input.scopes,
        cwd: input.cwd,
        runtime: { type: 'host', engine: 'scode' } as never,
        status: 'active',
        desiredState: 'active',
        assistantName: input.assistantName,
        source: input.source,
      })
      await svc.onSessionCreated(sessionId, input.assistantName, input.source)
      driverCalls.push({ sessionId, input })
      return sessionId
    },
    async run(sessionId, prompt) {
      const call = driverCalls.find(c => c.sessionId === sessionId)!
      call.prompt = prompt
      const script = scripts.get(call.input.assistantName)
      if (!script) throw new Error(`no scripted agent for ${call.input.assistantName}`)
      const out = script({ prompt, session: { ...call.input, sessionId } })
      // Like scode: the prompt arrives and the agent starts, then writes files.
      const tp = store.getSession(sessionId)!.transcriptPath
      const now = Date.now()
      appendFileSync(tp, transcriptLine('user', prompt, sessionId, now - 20))
      appendFileSync(tp, transcriptLine('assistant', out.reply, sessionId, now - 10))
      for (const [rel, content] of Object.entries(out.files ?? {})) {
        const p = path.join(call.input.cwd, rel)
        mkdirSync(path.dirname(p), { recursive: true })
        writeFileSync(p, content)
      }
      return { reply: out.reply }
    },
    async terminate() {},
    transcriptPath(sessionId) {
      return store.getSession(sessionId)?.transcriptPath ?? null
    },
  }

  const emb = fakeEmbedder()
  svc = new AgentifyService({
    db: store.db,
    runtimeDir,
    localHomeDir: path.join(dir, 'agent-home'),
    nexusVfs: null,
    lookup,
    embedder: async () => emb,
    modelGateway: () => null,
    driver,
    getUserName: id => `用户${id}`,
    getUserAuth: () => ({ role: 'user', scopes: [] }),
    isAdmin: id => admins.has(id),
    isAgentUsableBy: (ref, userId) => usable.has(`${ref.id}:${userId}`),
    summarizer: echoSummarizer,
  })

  const addSession: Fixture['addSession'] = input => {
    const meta = agentMetas.find(m => m.name === input.agent)!
    const sessionId = randomUUID()
    const cwd = path.join(runtimeDir, 'sessions', sessionId, 'workspace')
    const transcriptPath = path.join(runtimeDir, 'sessions', sessionId, 'transcript.jsonl')
    mkdirSync(cwd, { recursive: true })
    store.createSession({
      sessionId,
      transcriptSessionId: sessionId,
      transcriptPath,
      userId: input.userId,
      orgId: ORG,
      role: 'user',
      scopes: [],
      cwd,
      runtime: { type: 'host', engine: 'scode' } as never,
      status: 'active',
      desiredState: 'active',
      assistantName: meta.display_name,
      source: input.source,
    })
    // What RuntimeService's agentify hook does on creation.
    svc.store.setSessionAgent(sessionId, { assistantId: meta.id })
    // Turns first, then the files the agent wrote (inputs are added explicitly).
    const at = Date.now() - (input.ageMs ?? 0) - (input.turns.length + 1) * 1000
    if (input.ageMs) store.db.prepare('UPDATE sessions SET created_at = ?, last_active_at = ? WHERE session_id = ?').run(at, at, sessionId)
    for (const [rel, content] of Object.entries(input.inputs ?? {})) {
      const p = path.join(cwd, rel)
      mkdirSync(path.dirname(p), { recursive: true })
      writeFileSync(p, content)
      utimesSync(p, new Date(at - 500), new Date(at - 500))
    }
    for (const rel of input.uploaded ?? []) svc.recordUpload(sessionId, rel)
    if (!input.ageMs && input.inputs) store.db.prepare('UPDATE sessions SET created_at = ? WHERE session_id = ?').run(at - 1000, sessionId)
    let t = at
    for (const turn of input.turns) appendFileSync(transcriptPath, transcriptLine(turn.role, turn.text, sessionId, (t += 1000)))
    for (const [rel, content] of Object.entries(input.files ?? {})) {
      const p = path.join(cwd, rel)
      mkdirSync(path.dirname(p), { recursive: true })
      writeFileSync(p, content)
      if (input.ageMs) utimesSync(p, new Date(t + 500), new Date(t + 500))
    }
    if (input.ageMs) {
      // An old session: its transcript was last written back then too.
      utimesSync(transcriptPath, new Date(t + 1000), new Date(t + 1000))
      store.db.prepare('UPDATE sessions SET last_active_at = ? WHERE session_id = ?').run(t + 1000, sessionId)
    }
    return sessionId
  }

  return {
    dir,
    store,
    get svc() {
      return svc
    },
    agents,
    driverCalls,
    scripts,
    usable,
    admins,
    addSession,
    cleanup() {
      svc.stop()
      try {
        store.db.close()
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Configure two cooperating agents the way an admin would. */
export async function configurePair(fx: Fixture, opts: { askerCanRead?: boolean } = {}) {
  await fx.svc.configure(ORG, 'gendan', {
    a2a: {
      capabilities: [{ id: 'order-status', kind: 'ask', description: '查询订单跟单进度' }],
      allowCallers: ['shouhou'],
    },
  })
  await fx.svc.configure(ORG, 'shouhou', {
    memory: { share: 'summary' },
    a2a: {
      capabilities: [
        { id: 'return-stats', kind: 'ask', description: '查询退货/返厂统计与结论' },
        { id: 'return-report', kind: 'task', description: '生成返厂分析报表' },
        { id: 'notify-supplier', kind: 'task', description: '通知供应商处理返厂', requiresConfirmation: true, allowOutbound: true },
      ],
      allowCallers: ['gendan'],
      historyReaders: opts.askerCanRead === false ? [] : ['gendan'],
      confirmers: ['u-boss'],
      dailyCallLimit: 50,
    },
  })
}

export const PAIR_AGENTS = [
  { id: 'agent-gendan-uuid', name: 'gendan', display_name: '跟单助手', description: '采购跟单岗位的数字分身', source_type: 'tenant' as const },
  { id: 'agent-shouhou-uuid', name: 'shouhou', display_name: '售后返厂助手', description: '售后返厂岗位的数字分身', source_type: 'tenant' as const },
  { id: 'agent-other-uuid', name: 'other', display_name: '其他助手', description: '未授权的助手', source_type: 'tenant' as const },
]
