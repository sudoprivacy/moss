/**
 * Digest: turn finished (or quiet) sessions of agentified agents into
 * agent-home documents and index them.
 *
 * A background sweep picks sessions whose transcript changed since the last
 * digest and has been quiet for a while. Cron sessions are reused across
 * runs, so a session can be digested many times; each digest replaces the
 * previous documents for that session rather than adding new ones.
 */
import { stat, readFile } from 'fs/promises'
import type { AgentHomeStore } from './agentHome.js'
import { artifactDir, historyDir } from './agentHome.js'
import { historyPolicy, hoursToMs } from './config.js'
import { collectArtifacts, describeArtifacts, type ArtifactEntry } from './artifacts.js'
import type { HistoryIndex } from './historyIndex.js'
import type { AgentifyStore, AgentRow, SessionAgentInfo } from './store.js'
import type { Summarizer } from './summarizer.js'
import { extractiveSummary, parseTranscript, renderConversation, truncateMiddle } from './transcriptDigest.js'
import type { AgentRegistry } from './agentRegistry.js'

const QUIET_MS = Number(process.env.MOSS_AGENTIFY_DIGEST_QUIET_MS) || 2 * 60 * 1000
const SWEEP_MS = Number(process.env.MOSS_AGENTIFY_DIGEST_SWEEP_MS) || 60 * 1000
/** How often expired history is deleted. */
const PURGE_EVERY_MS = Number(process.env.MOSS_AGENTIFY_PURGE_EVERY_MS) || 3600 * 1000
const TEXT_OUTPUT = /\.(md|txt|csv|tsv|json|html?|xml|ya?ml|log|sql)$/i

export interface DigestDeps {
  store: AgentifyStore
  home: AgentHomeStore
  index: HistoryIndex
  summarizer: Summarizer
  registry: AgentRegistry
  getUserName: (userId: string) => string | undefined
}

export interface DigestResult {
  status: 'ok' | 'skipped' | 'unchanged' | 'error'
  reason?: string
  summaryPath?: string
}

export interface PurgeResult {
  /** Index documents removed. */
  docs: number
  /** Sessions whose digested history was removed. */
  sessions: number
  /** Finished agent-to-agent call records removed. */
  calls: number
}

const lookbackStart = (agent: AgentRow, now: number): number => now - hoursToMs(historyPolicy(agent.config).digestLookbackHours)

/** Human-readable description of how a session was started. */
export function describeOrigin(source: string | null, userName: string | undefined): string {
  let parsed: Record<string, unknown> | null = null
  if (source && source.startsWith('{')) {
    try {
      parsed = JSON.parse(source) as Record<string, unknown>
    } catch {
      parsed = null
    }
  }
  const who = userName ? `员工 ${userName}` : '员工'
  const kind = parsed?.source ?? source
  if (kind === 'cron') return `定时任务「${String(parsed?.cronJobName ?? '')}」（${who}名下）`
  if (kind === 'event_trigger') return `事件触发「${String(parsed?.triggerName ?? '')}」`
  if (kind === 'a2a') return `智能体「${String(parsed?.callerAgentName ?? '')}」通过协作调用（${String(parsed?.capability ?? '')}），背后员工 ${userName ?? ''}`
  if (kind === 'wecom') return `企业微信对话（${who}）`
  return `${who}发起的对话`
}

/**
 * One-line headline of what a session was about. A session answering another
 * agent starts with the call instructions; its headline is the request itself.
 */
export function sessionHeadline(firstUserText: string | null): string {
  const text = firstUserText ?? '会话'
  if (text.startsWith('[A2A ')) {
    const m = text.match(/<request>\s*([\s\S]*?)\s*<\/request>/)
    if (m) return `协作请求：${m[1]!.replace(/\s+/g, ' ')}`
  }
  return text.replace(/\s+/g, ' ')
}

export class DigestService {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private stopped = true
  /** Set by stop(): long loops give up early during shutdown. */
  private shuttingDown = false
  /** Digests running now, so a second request for the same session waits for the first. */
  private inProgress = new Map<string, Promise<DigestResult>>()
  private lastPurgeAt = 0

  constructor(private readonly deps: DigestDeps) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.shuttingDown = false
    const tick = () => {
      if (this.stopped) return
      this.sweepOnce()
        .catch(err => console.error('[agentify] digest sweep failed:', err))
        .finally(() => {
          if (!this.stopped) {
            this.timer = setTimeout(tick, SWEEP_MS)
            this.timer.unref?.()
          }
        })
    }
    this.timer = setTimeout(tick, 5000)
    this.timer.unref?.()
  }

  stop(): void {
    this.stopped = true
    this.shuttingDown = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Give sessions a stable agent id; resolves names through the registry. */
  async backfillAgentIds(limit = 5000): Promise<number> {
    const missing = this.deps.store.listSessionsMissingAgentId(limit)
    let updated = 0
    const byName = new Map<string, string | null>()
    for (const row of missing) {
      if (!byName.has(row.assistantName)) {
        const ref = await this.deps.registry.resolve(row.assistantName)
        byName.set(row.assistantName, ref?.id ?? null)
      }
      const id = byName.get(row.assistantName)
      if (id) {
        this.deps.store.setSessionAgent(row.sessionId, { assistantId: id })
        updated += 1
      }
    }
    return updated
  }

  async sweepOnce(): Promise<number> {
    if (this.running) return 0
    this.running = true
    let done = 0
    try {
      await this.backfillAgentIds(500)
      const byOrg = new Map<string, AgentRow[]>()
      for (const a of this.deps.store.listAllAgents()) {
        if (!a.config.enabled) continue
        const list = byOrg.get(a.orgId) ?? []
        list.push(a)
        byOrg.set(a.orgId, list)
      }
      const now = Date.now()
      for (const [orgId, agents] of byOrg) {
        // One query per org from the earliest lookback, then each agent's own window.
        const since = Math.min(...agents.map(a => lookbackStart(a, now)))
        const sessions = this.deps.store.listSessionsForAgents(orgId, agents.map(a => a.agentId), since)
        for (const session of sessions) {
          if (this.shuttingDown) return done
          const agent = agents.find(a => a.agentId === session.assistantId)
          if (!agent || session.lastActiveAt < lookbackStart(agent, now)) continue
          const r = await this.digestSession(session, agent, { requireQuiet: true })
          if (r.status === 'ok') done += 1
        }
      }
      if (now - this.lastPurgeAt >= PURGE_EVERY_MS && !this.shuttingDown) {
        this.lastPurgeAt = now
        const purged = await this.purgeExpired(now)
        if (purged.docs > 0 || purged.calls > 0) {
          console.log(`[agentify] deleted expired history: ${purged.sessions} sessions, ${purged.docs} documents, ${purged.calls} call records`)
        }
      }
    } finally {
      this.running = false
    }
    return done
  }

  /**
   * Digest every recent session of one agent now, without waiting for the
   * quiet period or the background sweep (admin "digest now"). Re-digesting a
   * session that is still active is harmless: the next sweep replaces it.
   */
  async digestAgent(orgId: string, agentId: string): Promise<{ backfilled: number; digested: number }> {
    const backfilled = await this.backfillAgentIds()
    const agent = this.deps.store.getAgent(orgId, agentId)
    if (!agent?.config.enabled) return { backfilled, digested: 0 }
    let digested = 0
    for (const session of this.deps.store.listSessionsForAgents(orgId, [agentId], lookbackStart(agent, Date.now()))) {
      const r = await this.digestSession(session, agent, { requireQuiet: false })
      if (r.status === 'ok') digested += 1
    }
    return { backfilled, digested }
  }

  /**
   * Delete digested history that has had no activity for longer than each
   * agent's deleteAfterHours: index entries, the session's summary,
   * conversation and output copies in the agent home, collaboration logs, and
   * finished call records. Curated memory notes are kept. The original session
   * transcript (outside the agent home) is not touched. Applies to agents with
   * agentify turned off too, since their history is still stored.
   */
  async purgeExpired(now = Date.now(), onlyAgent?: { orgId: string; agentId: string }): Promise<PurgeResult> {
    const { store, home } = this.deps
    const result: PurgeResult = { docs: 0, sessions: 0, calls: 0 }
    const agents = onlyAgent
      ? [store.getAgent(onlyAgent.orgId, onlyAgent.agentId)].filter((a): a is AgentRow => a !== null)
      : store.listAllAgents()
    for (const agent of agents) {
      const hours = historyPolicy(agent.config).deleteAfterHours
      if (hours <= 0) continue
      const cutoff = now - hoursToMs(hours)
      for (const doc of store.listExpiredDocs(agent.orgId, agent.agentId, cutoff)) {
        if (this.shuttingDown && !onlyAgent) return result
        try {
          if (doc.kind === 'summary' && doc.sessionId && doc.path.endsWith('/summary.md')) {
            // The session's history directory (summary, conversation,
            // artifacts.json) and its output copies go together.
            await home.remove(doc.path.slice(0, doc.path.lastIndexOf('/')))
            await home.remove(artifactDir(agent.orgId, agent.agentId, doc.sessionId))
            store.deleteDigestState(doc.sessionId)
            result.sessions += 1
          } else if (doc.kind === 'artifact' && doc.sessionId) {
            await home.remove(doc.path)
            await home.remove(artifactDir(agent.orgId, agent.agentId, doc.sessionId))
          } else {
            await home.remove(doc.path)
          }
        } catch (err) {
          // Keep the index entry so the next purge retries the files.
          console.warn(`[agentify] could not delete ${doc.path}: ${err instanceof Error ? err.message : String(err)}`)
          continue
        }
        if (store.deleteDocById(doc.id)) result.docs += 1
      }
      result.calls += store.deleteFinishedCallsBefore(agent.orgId, agent.agentId, cutoff)
    }
    return result
  }

  /** Digest one session now (used after an agent-to-agent call completes). */
  async digestSessionById(sessionId: string): Promise<DigestResult> {
    const info = this.deps.store.getSessionAgentInfo(sessionId)
    if (!info?.assistantId) return { status: 'skipped', reason: 'session has no agent' }
    const agent = this.deps.store.getAgent(info.orgId, info.assistantId)
    if (!agent?.config.enabled) return { status: 'skipped', reason: 'agent is not agentified' }
    return this.digestSession(info, agent, { requireQuiet: false })
  }

  async digestSession(session: SessionAgentInfo, agent: AgentRow, opts: { requireQuiet: boolean }): Promise<DigestResult> {
    const running = this.inProgress.get(session.sessionId)
    if (running) {
      // Someone (usually the background sweep) is digesting this session right
      // now; callers that asked for it want the finished result, so wait.
      const result = await running
      return opts.requireQuiet ? result : this.digestSession(session, agent, opts)
    }
    const work = this.digestSessionNow(session, agent, opts)
    this.inProgress.set(session.sessionId, work)
    try {
      return await work
    } finally {
      this.inProgress.delete(session.sessionId)
    }
  }

  private async digestSessionNow(session: SessionAgentInfo, agent: AgentRow, opts: { requireQuiet: boolean }): Promise<DigestResult> {
    let st
    try {
      st = await stat(session.transcriptPath)
    } catch {
      return { status: 'skipped', reason: 'no transcript' }
    }
    const prev = this.deps.store.getDigestState(session.sessionId)
    if (prev && prev.size === st.size && prev.mtime === Math.round(st.mtimeMs)) return { status: 'unchanged' }
    if (opts.requireQuiet && Date.now() - st.mtimeMs < QUIET_MS && !session.endedAt) {
      return { status: 'skipped', reason: 'still active' }
    }
    try {
      const conv = parseTranscript(await readFile(session.transcriptPath, 'utf8'))
      if (!conv.turns.some(t => t.role === 'assistant')) {
        this.deps.store.setDigestState(session.sessionId, { size: st.size, mtime: Math.round(st.mtimeMs), status: 'skipped' })
        return { status: 'skipped', reason: 'no agent reply yet' }
      }
      const result = await this.writeDigest(session, agent, conv, st.mtimeMs)
      this.deps.store.setDigestState(session.sessionId, { size: st.size, mtime: Math.round(st.mtimeMs), status: 'ok' })
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[agentify] digest of session ${session.sessionId} failed: ${message}`)
      this.deps.store.setDigestState(session.sessionId, { size: st.size, mtime: Math.round(st.mtimeMs), status: 'error', error: message })
      return { status: 'error', reason: message }
    }
  }

  private async writeDigest(session: SessionAgentInfo, agent: AgentRow, conv: ReturnType<typeof parseTranscript>, transcriptMtime: number): Promise<DigestResult> {
    const { home, index, summarizer } = this.deps
    const userName = this.deps.getUserName(session.userId)
    const origin = describeOrigin(session.source, userName)
    const dir = historyDir(session.orgId, agent.agentId, session.sessionId, session.createdAt)

    let artifacts: ArtifactEntry[] = []
    if (session.cwd) {
      artifacts = await collectArtifacts({
        home,
        orgId: session.orgId,
        agentId: agent.agentId,
        sessionId: session.sessionId,
        workspace: session.cwd,
        windowStartMs: session.createdAt,
        windowEndMs: Math.max(session.lastActiveAt, transcriptMtime),
      })
    }
    const artifactLines = describeArtifacts(artifacts)
    const conversation = renderConversation(conv, { maxChars: 60_000 })
    const { text: summaryBody, model } = await summarizer.summarize({
      agentDisplayName: agent.displayName,
      conversation: truncateMiddle(conversation, 24_000),
      artifacts: artifactLines,
      origin,
      fallbackText: extractiveSummary(conv, artifactLines),
    })

    const when = conv.startedAt ?? new Date(session.createdAt).toISOString()
    const header = [
      `# ${agent.displayName} 工作摘要`,
      '',
      `- 会话：${session.sessionId}`,
      `- 时间：${when}${conv.endedAt && conv.endedAt !== when ? ` ~ ${conv.endedAt}` : ''}`,
      `- 来源：${origin}`,
      ...(model ? [`- 摘要模型：${model}`] : ['- 摘要方式：抽取']),
      '',
    ].join('\n')
    const summaryText = `${header}\n${summaryBody.trim()}\n`
    const title = `${agent.displayName}｜${sessionHeadline(conv.firstUserText).slice(0, 60)}`

    await home.write(`${dir}/summary.md`, summaryText)
    await home.write(`${dir}/conversation.md`, `# 对话记录\n\n- 会话：${session.sessionId}\n- 来源：${origin}\n\n${conversation}\n`)
    await home.write(`${dir}/artifacts.json`, `${JSON.stringify({ sessionId: session.sessionId, artifacts }, null, 2)}\n`)

    const createdAt = session.createdAt
    const activeAt = Math.max(session.lastActiveAt, Math.round(transcriptMtime))
    const base = { orgId: session.orgId, agentId: agent.agentId, sessionId: session.sessionId, userId: session.userId, createdAt, activeAt }
    await index.indexDoc({ ...base, kind: 'summary', docKey: `summary:${session.sessionId}`, visibility: 'shared', path: `${dir}/summary.md`, title, text: summaryText, meta: { origin, model } })
    await index.indexDoc({ ...base, kind: 'conversation', docKey: `conversation:${session.sessionId}`, visibility: 'private', path: `${dir}/conversation.md`, title: `${title}（对话）`, text: conversation })

    if (artifacts.length > 0) {
      // Index text outputs' content so "what did the after-sales agent find"
      // can match the report itself, not just its file name.
      const parts: string[] = [`# ${agent.displayName} 产出文件`, '', ...artifactLines.map(l => `- ${l}`)]
      let budget = 30_000
      for (const a of artifacts) {
        if (!a.homePath || a.role !== 'output' || !TEXT_OUTPUT.test(a.path) || budget <= 0) continue
        const buf = await home.read(a.homePath)
        if (!buf) continue
        const text = truncateMiddle(buf.toString('utf8'), Math.min(8000, budget))
        budget -= text.length
        parts.push('', `## ${a.path}`, '', text)
      }
      await index.indexDoc({ ...base, kind: 'artifact', docKey: `artifacts:${session.sessionId}`, visibility: 'shared', path: `${dir}/artifacts.json`, title: `${title}（产出）`, text: parts.join('\n'), meta: { files: artifacts } })
    } else {
      this.deps.store.deleteDoc(session.orgId, agent.agentId, `artifacts:${session.sessionId}`)
    }
    return { status: 'ok', summaryPath: `${dir}/summary.md` }
  }
}
