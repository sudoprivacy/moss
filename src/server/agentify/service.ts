/**
 * AgentifyService — one object the server and runtime talk to.
 *
 * Owns the store, the agent home, the history index, memory, the digest
 * sweeper and agent-to-agent collaboration, and answers the two questions the
 * runtime asks while starting a session: which agent is this (stable id), and
 * what should its first message tell it.
 */
import path from 'path'
import type { DatabaseSync } from 'node:sqlite'
import { AgentRegistry, type AgentLookup, type AgentRef } from './agentRegistry.js'
import { LocalAgentHomeStore, NexusAgentHomeStore, type AgentHomeStore, type NexusVfsLike } from './agentHome.js'
import { A2AError, A2AService, type CallerContext } from './a2aService.js'
import { AgentifyConfigError, parseAgentifyConfig, type AgentIdentity, type AgentifyConfig } from './config.js'
import { canAccessDoc, canAccessType, type Viewer } from './access.js'
import { DigestService } from './digestService.js'
import { HistoryIndex, type EmbedderProvider } from './historyIndex.js'
import { AgentMemory } from './memory.js'
import { buildAgentifyBlock } from './promptBlock.js'
import { cronRunNote } from './runLabel.js'
import type { SessionDriver } from './sessionDriver.js'
import { AgentifyStore, type AgentRow } from './store.js'
import { ModelSummarizer, type ModelGateway, type Summarizer } from './summarizer.js'

export interface AgentifyServiceOptions {
  db: DatabaseSync
  runtimeDir: string
  /** Used for the agent home when Nexus is not available. */
  localHomeDir: string
  nexusVfs?: NexusVfsLike | null
  lookup: AgentLookup
  embedder: EmbedderProvider
  modelGateway: () => ModelGateway | null
  driver: SessionDriver
  getUserName: (userId: string) => string | undefined
  getUserAuth: (userId: string, orgId: string) => { role: string; scopes: string[] } | null
  isAdmin: (userId: string, orgId: string) => boolean
  isAgentUsableBy: (ref: AgentRef, userId: string, orgId: string) => boolean
  /** Tests inject a summarizer; production uses the model gateway. */
  summarizer?: Summarizer
}

/** The parts of an access token agentify relies on. */
export interface AgentAuth {
  userId: string
  orgId: string
  role: string
  scopes: string[]
  assistantId?: string | null
  sessionId?: string | null
}

export class AgentifyService {
  readonly store: AgentifyStore
  readonly registry: AgentRegistry
  readonly home: AgentHomeStore
  readonly index: HistoryIndex
  readonly memory: AgentMemory
  readonly digest: DigestService
  readonly a2a: A2AService

  constructor(private readonly opts: AgentifyServiceOptions) {
    this.store = new AgentifyStore(opts.db)
    this.registry = new AgentRegistry(opts.lookup)
    this.home = opts.nexusVfs ? new NexusAgentHomeStore(opts.nexusVfs) : new LocalAgentHomeStore(opts.localHomeDir)
    this.index = new HistoryIndex(this.store, opts.embedder)
    this.memory = new AgentMemory(this.home, this.index, this.store)
    const summarizer = opts.summarizer ?? new ModelSummarizer(opts.modelGateway)
    this.digest = new DigestService({
      store: this.store,
      home: this.home,
      index: this.index,
      summarizer,
      registry: this.registry,
      getUserName: opts.getUserName,
    })
    this.a2a = new A2AService({
      store: this.store,
      registry: this.registry,
      home: this.home,
      index: this.index,
      driver: opts.driver,
      runtimeDir: opts.runtimeDir,
      isAgentUsableBy: opts.isAgentUsableBy,
      getUserName: opts.getUserName,
      digestSession: id => this.digest.digestSessionById(id),
      isAdmin: opts.isAdmin,
      getUserAuth: opts.getUserAuth,
    })
  }

  start(): void {
    console.log(`[agentify] started (agent home: ${this.home.kind})`)
    this.digest.start()
    this.a2a.start()
  }

  stop(): void {
    this.digest.stop()
    this.a2a.stop()
  }

  // ------------------------------------------------------------ runtime hooks

  /** Called right after a session row is written: stamp the stable agent id. */
  async onSessionCreated(sessionId: string, assistantName: string | null | undefined, source: string | null | undefined): Promise<void> {
    const ref = await this.registry.resolve(assistantName)
    let a2a: { callId?: string; depth?: number; readonly?: boolean } = {}
    if (source && source.startsWith('{')) {
      try {
        const parsed = JSON.parse(source) as Record<string, unknown>
        if (parsed.source === 'a2a') {
          a2a = {
            callId: typeof parsed.callId === 'string' ? parsed.callId : undefined,
            depth: typeof parsed.depth === 'number' ? parsed.depth : undefined,
            readonly: parsed.readonly === true,
          }
        }
      } catch {
        // not ours
      }
    }
    if (!ref && !a2a.callId) return
    this.store.setSessionAgent(sessionId, {
      assistantId: ref?.id ?? null,
      a2aCallId: a2a.callId ?? null,
      a2aDepth: a2a.depth,
      a2aReadonly: a2a.readonly,
    })
  }

  /**
   * First line of a scheduled run's message, for agentified agents only:
   * which job, and when this run started. The same label names the run in
   * its history, so what the agent saw while working matches what recall finds.
   */
  async cronRunNote(input: { orgId: string; assistant: string | null | undefined; jobName: string; startedAt: number; timeZone?: string | null }): Promise<string | null> {
    const ref = await this.registry.resolve(input.assistant)
    if (!ref) return null
    if (!this.store.getAgent(input.orgId, ref.id)?.config.enabled) return null
    return cronRunNote(input.jobName, input.startedAt, input.timeZone)
  }

  /** First-message block for an agentified agent; null for every other session. */
  async buildSessionBlock(input: { sessionId: string; orgId: string; userId: string; role: string; scopes: string[]; assistantName: string | null | undefined }): Promise<string | null> {
    const ref = await this.registry.resolve(input.assistantName)
    if (!ref) return null
    const row = this.store.getAgent(input.orgId, ref.id)
    if (!row?.config.enabled) return null
    this.store.touchAgentNames(input.orgId, ref.id, ref.name, ref.displayName)
    const info = this.store.getSessionAgentInfo(input.sessionId)
    const serving = this.servingFor(input.orgId, info?.a2aCallId ?? null)
    const viewer = this.viewerFor(input.userId, serving)
    const recent = this.store
      .listDocs({ orgId: input.orgId, agentId: ref.id, kinds: ['summary'], limit: 40 })
      .filter(d => canAccessDoc(d, viewer, row.config))
      .slice(0, 8)
      .map(d => `${new Date(d.createdAt).toISOString().slice(0, 10)} ${d.title} (id ${d.id.slice(0, 8)})`)
    const memoryText = await this.memory
      .buildInjection({
        orgId: input.orgId,
        agentId: ref.id,
        // A session answering another agent gets no employee's personal notes.
        userId: serving ? null : input.userId,
        includeShared: canAccessType('sharedMemory', null, viewer, row.config),
        budget: row.config.memory.injectChars,
        recentWork: recent,
      })
      .catch(() => '')
    let collaborators: Awaited<ReturnType<A2AService['listCallable']>> = []
    try {
      collaborators = await this.a2a.listCallable(this.callerContext(row, ref, input, info?.a2aDepth ?? 0, [], null, serving))
    } catch {
      collaborators = []
    }
    let servingCall: { callerName: string; readonly: boolean } | null = null
    if (info?.a2aCallId) {
      const call = this.store.getCall(info.a2aCallId)
      const caller = call ? this.store.getAgent(input.orgId, call.callerAgentId) : null
      servingCall = { callerName: caller?.displayName ?? call?.callerAgentId ?? '', readonly: info.a2aReadonly }
    }
    // A session that is already the deepest allowed level cannot call further.
    const depth = info?.a2aDepth ?? 0
    return buildAgentifyBlock({
      displayName: ref.displayName,
      memory: memoryText,
      collaborators: depth >= 2 ? [] : collaborators,
      servingCall,
    })
  }

  /** An employee uploaded a file into a session workspace: it is an input of that session. */
  recordUpload(sessionId: string, relativePath: string): void {
    try {
      this.store.recordUpload(sessionId, relativePath)
    } catch (err) {
      console.warn(`[agentify] could not record upload ${relativePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Is this session barred from outbound actions? */
  isReadonlySession(sessionId: string | null | undefined): boolean {
    if (!sessionId) return false
    return this.store.getSessionAgentInfo(sessionId)?.a2aReadonly === true
  }

  // ------------------------------------------------------------- callers

  private callerContext(
    row: AgentRow,
    ref: AgentRef,
    auth: { orgId: string; userId: string; role: string; scopes: string[] },
    depth: number,
    chain: string[],
    sessionId: string | null = null,
    serving: CallerContext['serving'] = null,
  ): CallerContext {
    return { orgId: auth.orgId, userId: auth.userId, role: auth.role, scopes: auth.scopes, sessionId, agent: row, ref, depth, chain, serving }
  }

  /** The call a session answers, and which agent made it. */
  private servingFor(orgId: string, callId: string | null): CallerContext['serving'] {
    if (!callId) return null
    const call = this.store.getCall(callId)
    if (!call) return null
    const row = this.store.getAgent(orgId, call.callerAgentId)
    const callerAgent: AgentIdentity = { id: call.callerAgentId, name: row?.agentName ?? call.callerAgentId, displayName: row?.displayName ?? call.callerAgentId }
    return { callId, callerAgent }
  }

  /**
   * Who a session reads as: the employee using the agent, or — in a session
   * answering another agent — that agent, whatever the employee behind it may see.
   */
  viewerFor(userId: string, serving: CallerContext['serving']): Viewer {
    if (serving) return { kind: 'agent', agent: serving.callerAgent }
    return { kind: 'user', userId, userName: this.opts.getUserName(userId) ?? null }
  }

  /** The viewer for an agentctl call. */
  callerViewer(caller: CallerContext): Viewer {
    return this.viewerFor(caller.userId, caller.serving)
  }

  /** Build the caller from a session token; throws A2AError when not allowed. */
  async callerFromAuth(auth: AgentAuth): Promise<CallerContext> {
    if (!auth.assistantId) throw new A2AError(403, 'not_agent_session', 'only an agent session can use this endpoint')
    const ref = await this.registry.resolve(auth.assistantId)
    const row = ref ? this.store.getAgent(auth.orgId, ref.id) : null
    if (!ref || !row?.config.enabled) throw new A2AError(403, 'not_agentified', 'this agent is not agentified')
    let depth = 0
    let chain: string[] = []
    let serving: CallerContext['serving'] = null
    const info = auth.sessionId ? this.store.getSessionAgentInfo(auth.sessionId) : null
    if (info && info.orgId === auth.orgId) {
      depth = info.a2aDepth
      if (info.a2aCallId) {
        chain = this.store.getCall(info.a2aCallId)?.chain ?? []
        serving = this.servingFor(auth.orgId, info.a2aCallId)
      }
    }
    return this.callerContext(row, ref, auth, depth, chain, info?.sessionId ?? null, serving)
  }

  // --------------------------------------------------------------- admin

  async configure(orgId: string, nameOrId: string, raw: unknown): Promise<AgentRow> {
    const ref = await this.registry.resolve(nameOrId)
    if (!ref) throw new AgentifyConfigError(`agent ${nameOrId} not found`)
    const config: AgentifyConfig = parseAgentifyConfig(raw)
    const row = this.store.upsertAgent({ orgId, agentId: ref.id, agentName: ref.name, displayName: ref.displayName, config })
    this.registry.invalidate()
    // Existing sessions of this agent become searchable on the next sweep.
    void this.digest.backfillAgentIds().catch(() => undefined)
    return row
  }

  removeAgent(orgId: string, agentId: string): boolean {
    return this.store.deleteAgent(orgId, agentId)
  }

  static localHomeDirFor(rootDir: string): string {
    return path.join(rootDir, 'agent-home')
  }
}
