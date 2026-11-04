/**
 * Agentify configuration for one agent.
 *
 * An agentified agent is a durable identity: its sessions, outputs and memory
 * belong to the agent rather than to the employee who happened to start a
 * session. Which employees may *use* the agent is still decided by the agent's
 * normal visibility (visible_to); this config only adds what the agent keeps
 * and what it offers to other agents.
 *
 * Stored in the `agentify_agents` table (not in _moss_meta.json): several
 * existing write paths rebuild the meta file, and a separate row keyed by the
 * agent's stable id survives renames and re-installs.
 */

/**
 * Who may see one kind of data an agent keeps:
 *   private — only the employee whose session produced it
 *   users   — also other employees of this agent (subject to the users lists)
 *   agents  — also other agents, but only through a handoff: the other agent
 *             asks, and this agent's answering session can see and hand over
 *             only data at this level (subject to the agents lists)
 * Administrators see everything.
 */
export type ShareLevel = 'private' | 'users' | 'agents'

export const SHARE_TYPES = ['conversation', 'summary', 'input', 'output', 'intermediate', 'sharedMemory'] as const
/**
 * conversation  the cleaned conversation text of a session
 * summary       session summaries, and the records of calls between agents
 * input         files employees gave a session
 * output        files a session produced, and each session's file list
 * intermediate  working files a session left in .drafts/
 * sharedMemory  the agent's shared memory notes
 * An employee's personal memory notes are always private.
 */
export type ShareType = (typeof SHARE_TYPES)[number]

/** Names, ids or `*`. Deny wins over allow; an empty allow list admits nobody. */
export interface AccessList {
  allow: string[]
  deny: string[]
}

export interface ShareRule {
  level: ShareLevel
  /** Employees of this agent who may see it; absent = sharing.users. */
  users?: AccessList
  /** Other agents that may receive it; absent = sharing.agents. */
  agents?: AccessList
}

export type SharingConfig = {
  /** Default employee list for every type. Default: everyone who can use the agent. */
  users: AccessList
  /** Default agent list for every type. Absent = the agents allowed to call (a2a.callers). */
  agents?: AccessList
} & Record<ShareType, ShareRule>

export const LEVEL_RANK: Record<ShareLevel, number> = { private: 0, users: 1, agents: 2 }

export const DEFAULT_SHARE_LEVELS: Record<ShareType, ShareLevel> = {
  conversation: 'private',
  summary: 'users',
  input: 'private',
  output: 'users',
  intermediate: 'private',
  sharedMemory: 'users',
}

export interface CapabilityConfig {
  /** Stable id other agents use, e.g. `return-stats`. */
  id: string
  /** `ask` = answer a question read-only; `task` = do work and report back. */
  kind: 'ask' | 'task'
  /** What the capability does, shown to calling agents. */
  description: string
  /** Optional hint about the input the caller should provide. */
  input?: string
  /**
   * Task capabilities only: a confirmer must approve before the task runs.
   * Use for anything that acts outside moss (messages, approvals, writes).
   */
  requiresConfirmation?: boolean
  /** Task capabilities only: allow outbound actions (corpapp send etc.). */
  allowOutbound?: boolean
  /** Agents allowed to use this capability; absent = a2a.callers. */
  callers?: AccessList
  /**
   * Whose credentials the answering session uses (stored logins for rbox,
   * TMS, enterprise apps …). Absent = the employee behind the call. A user id
   * = that employee, chosen by an administrator: the caller then gets what
   * this agent can reach on that employee's access, through this capability
   * only. Stored data is still limited to what is shared with the caller.
   */
  runAsUserId?: string
  /**
   * When true, the employee behind the calling session must also be allowed
   * to use this agent directly (its visible_to). Use for capabilities whose
   * answers carry data the caller's employee should only see if they could
   * have asked this agent themselves.
   */
  requireCallerVisibility?: boolean
}

export interface AgentifyConfig {
  enabled: boolean
  /** Who sees which kind of data. */
  sharing: SharingConfig
  memory: {
    /** Characters of agent memory injected into a new session. */
    injectChars: number
    /**
     * Hours. Absent = the server default (see serverHistoryDefaults).
     *
     * digestLookbackHours: sessions active within this window are digested
     *   (and re-digested when they change). Older sessions are left alone.
     * decayHalfLifeHours: search ranks a document half as high for recency
     *   after this long since its last activity; 0 = no decay.
     * deleteAfterHours: digested history (summaries, conversations, outputs,
     *   collaboration logs) is deleted this long after its last activity;
     *   0 = keep forever. Curated memory notes are never deleted by age.
     */
    digestLookbackHours?: number
    decayHalfLifeHours?: number
    deleteAfterHours?: number
  }
  a2a: {
    capabilities: CapabilityConfig[]
    /**
     * Agents (ids or names) allowed to call this agent. `*` = any agentified
     * agent in the same organization. Empty allow = nobody. A capability can
     * narrow or replace this with its own `callers`.
     */
    callers: AccessList
    /** User ids who may confirm tasks that require confirmation. */
    confirmers: string[]
    /** Per-day ceiling on calls this agent accepts. */
    dailyCallLimit: number
  }
}

export function defaultSharing(): SharingConfig {
  const rules = Object.fromEntries(SHARE_TYPES.map(t => [t, { level: DEFAULT_SHARE_LEVELS[t] }])) as Record<ShareType, ShareRule>
  return { users: { allow: ['*'], deny: [] }, ...rules }
}

export const DEFAULT_AGENTIFY_CONFIG: AgentifyConfig = {
  enabled: true,
  sharing: defaultSharing(),
  memory: { injectChars: 4000 },
  a2a: { capabilities: [], callers: { allow: [], deny: [] }, confirmers: [], dailyCallLimit: 200 },
}

export interface HistoryPolicy {
  digestLookbackHours: number
  decayHalfLifeHours: number
  deleteAfterHours: number
}

const MAX_HOURS = 24 * 365 * 20
let processDefaults: HistoryPolicy | undefined

function envHours(env: NodeJS.ProcessEnv, name: string, fallback: number, allowZero: boolean): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || (n === 0 && !allowZero)) {
    console.warn(`[agentify] ignoring ${name}=${raw}: expected ${allowZero ? 'a number of hours >= 0' : 'a positive number of hours'}`)
    return fallback
  }
  return Math.min(n, MAX_HOURS)
}

/**
 * Server-wide defaults, in hours, for agents that do not set their own:
 *   MOSS_AGENTIFY_DIGEST_LOOKBACK_HR   (default 720 = 30 days)
 *   MOSS_AGENTIFY_DECAY_HALF_LIFE_HR   (default 720 = 30 days; 0 = no decay)
 *   MOSS_AGENTIFY_DELETE_AFTER_HR      (default 4320 = 180 days; 0 = keep forever)
 */
export function serverHistoryDefaults(env?: NodeJS.ProcessEnv): HistoryPolicy {
  // The process environment does not change while running: read it once.
  if (!env) return (processDefaults ??= serverHistoryDefaults(process.env))
  return {
    digestLookbackHours: envHours(env, 'MOSS_AGENTIFY_DIGEST_LOOKBACK_HR', 30 * 24, false),
    decayHalfLifeHours: envHours(env, 'MOSS_AGENTIFY_DECAY_HALF_LIFE_HR', 30 * 24, true),
    deleteAfterHours: envHours(env, 'MOSS_AGENTIFY_DELETE_AFTER_HR', 180 * 24, true),
  }
}

/**
 * The policy in effect for one agent. The digest lookback never reaches past
 * the deletion window: a session old enough to be deleted must not be digested
 * again, or it would be written and deleted over and over.
 */
export function historyPolicy(config: Pick<AgentifyConfig, 'memory'> | null | undefined, defaults: HistoryPolicy = serverHistoryDefaults()): HistoryPolicy {
  const m = config?.memory
  const deleteAfterHours = m?.deleteAfterHours ?? defaults.deleteAfterHours
  let digestLookbackHours = m?.digestLookbackHours ?? defaults.digestLookbackHours
  if (deleteAfterHours > 0) digestLookbackHours = Math.min(digestLookbackHours, deleteAfterHours)
  return {
    digestLookbackHours,
    decayHalfLifeHours: m?.decayHalfLifeHours ?? defaults.decayHalfLifeHours,
    deleteAfterHours,
  }
}

const HOUR_MS = 3600 * 1000
export const hoursToMs = (hours: number): number => hours * HOUR_MS

const CAPABILITY_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

export class AgentifyConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentifyConfigError'
  }
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new AgentifyConfigError(`${field} must be an array of strings`)
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw new AgentifyConfigError(`${field} must be an array of strings`)
    const trimmed = item.trim()
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

/** `["a","b"]` (allow only) or `{ allow: [...], deny: [...] }`. */
function accessList(value: unknown, field: string): AccessList | undefined {
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value)) return { allow: stringList(value, field), deny: [] }
  if (typeof value !== 'object') throw new AgentifyConfigError(`${field} must be a list of names or { allow, deny }`)
  const r = value as Record<string, unknown>
  for (const k of Object.keys(r)) {
    if (k !== 'allow' && k !== 'deny') throw new AgentifyConfigError(`${field}.${k} is not a known field (use allow / deny)`)
  }
  return { allow: stringList(r.allow, `${field}.allow`), deny: stringList(r.deny, `${field}.deny`) }
}

function parseSharing(raw: unknown, legacy: { share: unknown; historyReaders: string[] }): SharingConfig {
  const sharing = defaultSharing()
  if (raw === undefined || raw === null) {
    // Configs saved before per-type sharing: `memory.share: full` opened
    // conversations and inputs to other employees; history readers could
    // read summaries and outputs directly, which is now a handoff.
    if (legacy.share === 'full') {
      sharing.conversation.level = 'users'
      sharing.input.level = 'users'
    }
    if (legacy.historyReaders.length > 0) {
      for (const t of ['summary', 'output'] as const) sharing[t] = { level: 'agents', agents: { allow: legacy.historyReaders, deny: [] } }
    }
    return sharing
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new AgentifyConfigError('sharing must be an object')
  const r = raw as Record<string, unknown>
  for (const k of Object.keys(r)) {
    if (k !== 'users' && k !== 'agents' && !(SHARE_TYPES as readonly string[]).includes(k)) {
      throw new AgentifyConfigError(`sharing.${k} is not a known field (types: ${SHARE_TYPES.join(', ')}; lists: users, agents)`)
    }
  }
  sharing.users = accessList(r.users, 'sharing.users') ?? sharing.users
  const agents = accessList(r.agents, 'sharing.agents')
  if (agents) sharing.agents = agents
  for (const t of SHARE_TYPES) {
    const ruleRaw = r[t]
    if (ruleRaw === undefined || ruleRaw === null) continue
    // Shorthand: `"summary": "users"`.
    const obj = (typeof ruleRaw === 'string' ? { level: ruleRaw } : ruleRaw) as Record<string, unknown>
    if (typeof obj !== 'object' || Array.isArray(obj)) throw new AgentifyConfigError(`sharing.${t} must be an object`)
    for (const k of Object.keys(obj)) {
      if (k !== 'level' && k !== 'users' && k !== 'agents') throw new AgentifyConfigError(`sharing.${t}.${k} is not a known field (use level / users / agents)`)
    }
    const level = obj.level === undefined ? DEFAULT_SHARE_LEVELS[t] : obj.level
    if (level !== 'private' && level !== 'users' && level !== 'agents') {
      throw new AgentifyConfigError(`sharing.${t}.level must be "private", "users" or "agents"`)
    }
    if (t === 'sharedMemory' && level === 'private') {
      throw new AgentifyConfigError('sharing.sharedMemory.level must be "users" or "agents" (personal notes are always private)')
    }
    const rule: ShareRule = { level }
    const users = accessList(obj.users, `sharing.${t}.users`)
    const ruleAgents = accessList(obj.agents, `sharing.${t}.agents`)
    if (users) rule.users = users
    if (ruleAgents) rule.agents = ruleAgents
    sharing[t] = rule
  }
  return sharing
}

function positiveInt(value: unknown, fallback: number, field: string, max: number): number {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new AgentifyConfigError(`${field} must be a positive number`)
  return Math.min(Math.floor(n), max)
}

/** Optional hours: absent/null/'' = server default; `allowZero` admits 0 (= off). */
function optionalHours(value: unknown, field: string, allowZero: boolean): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || (n === 0 && !allowZero)) {
    throw new AgentifyConfigError(`${field} must be ${allowZero ? 'a number of hours >= 0 (0 = off)' : 'a positive number of hours'}`)
  }
  if (n > MAX_HOURS) throw new AgentifyConfigError(`${field} must be at most ${MAX_HOURS} hours`)
  return n
}

function parseCapability(raw: unknown, index: number): CapabilityConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AgentifyConfigError(`a2a.capabilities[${index}] must be an object`)
  }
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id.trim() : ''
  if (!CAPABILITY_ID.test(id)) {
    throw new AgentifyConfigError(
      `a2a.capabilities[${index}].id must be lowercase letters, digits, - or _ (got ${JSON.stringify(r.id)})`,
    )
  }
  const kind = r.kind === 'task' ? 'task' : r.kind === 'ask' ? 'ask' : null
  if (!kind) throw new AgentifyConfigError(`a2a.capabilities[${index}].kind must be "ask" or "task"`)
  const description = typeof r.description === 'string' ? r.description.trim() : ''
  if (!description) throw new AgentifyConfigError(`a2a.capabilities[${index}].description is required`)
  const cap: CapabilityConfig = { id, kind, description }
  if (typeof r.input === 'string' && r.input.trim()) cap.input = r.input.trim()
  if (kind === 'task') {
    cap.requiresConfirmation = r.requiresConfirmation === true
    cap.allowOutbound = r.allowOutbound === true
    if (cap.allowOutbound && !cap.requiresConfirmation) {
      throw new AgentifyConfigError(
        `a2a.capabilities[${index}] (${id}): allowOutbound requires requiresConfirmation`,
      )
    }
  } else if (r.allowOutbound === true || r.requiresConfirmation === true) {
    throw new AgentifyConfigError(`a2a.capabilities[${index}] (${id}): ask capabilities are read-only`)
  }
  if (r.requireCallerVisibility === true) cap.requireCallerVisibility = true
  const callers = accessList(r.callers, `a2a.capabilities[${index}].callers`)
  if (callers) cap.callers = callers
  if (r.runAsUserId !== undefined && r.runAsUserId !== null && r.runAsUserId !== '') {
    if (typeof r.runAsUserId !== 'string' || !r.runAsUserId.trim()) {
      throw new AgentifyConfigError(`a2a.capabilities[${index}] (${id}): runAsUserId must be a user id`)
    }
    cap.runAsUserId = r.runAsUserId.trim()
  }
  return cap
}

/** Validate and normalize a config from JSON. Throws AgentifyConfigError. */
export function parseAgentifyConfig(raw: unknown): AgentifyConfig {
  if (raw === undefined || raw === null) return structuredClone(DEFAULT_AGENTIFY_CONFIG)
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new AgentifyConfigError('config must be an object')
  const r = raw as Record<string, unknown>
  const memoryRaw = (r.memory ?? {}) as Record<string, unknown>
  const a2aRaw = (r.a2a ?? {}) as Record<string, unknown>
  if (typeof memoryRaw !== 'object' || Array.isArray(memoryRaw)) throw new AgentifyConfigError('memory must be an object')
  if (typeof a2aRaw !== 'object' || Array.isArray(a2aRaw)) throw new AgentifyConfigError('a2a must be an object')

  if (memoryRaw.share !== undefined && memoryRaw.share !== 'summary' && memoryRaw.share !== 'full') {
    throw new AgentifyConfigError('memory.share must be "summary" or "full" (replaced by sharing; kept for old configs)')
  }

  const capsRaw = a2aRaw.capabilities ?? []
  if (!Array.isArray(capsRaw)) throw new AgentifyConfigError('a2a.capabilities must be an array')
  const capabilities = capsRaw.map(parseCapability)
  const seen = new Set<string>()
  for (const c of capabilities) {
    if (seen.has(c.id)) throw new AgentifyConfigError(`duplicate capability id ${c.id}`)
    seen.add(c.id)
  }

  const memory: AgentifyConfig['memory'] = {
    injectChars: positiveInt(memoryRaw.injectChars, DEFAULT_AGENTIFY_CONFIG.memory.injectChars, 'memory.injectChars', 20000),
  }
  const lookback = optionalHours(memoryRaw.digestLookbackHours, 'memory.digestLookbackHours', false)
  const halfLife = optionalHours(memoryRaw.decayHalfLifeHours, 'memory.decayHalfLifeHours', true)
  const deleteAfter = optionalHours(memoryRaw.deleteAfterHours, 'memory.deleteAfterHours', true)
  if (lookback !== undefined) memory.digestLookbackHours = lookback
  if (halfLife !== undefined) memory.decayHalfLifeHours = halfLife
  if (deleteAfter !== undefined) memory.deleteAfterHours = deleteAfter
  if (lookback !== undefined && deleteAfter !== undefined && deleteAfter > 0 && lookback > deleteAfter) {
    throw new AgentifyConfigError('memory.digestLookbackHours cannot be longer than memory.deleteAfterHours')
  }

  // `allowCallers` is the name used before allow/deny lists.
  const callers = accessList(a2aRaw.callers, 'a2a.callers') ?? { allow: stringList(a2aRaw.allowCallers, 'a2a.allowCallers'), deny: [] }
  const sharing = parseSharing(r.sharing, { share: memoryRaw.share, historyReaders: stringList(a2aRaw.historyReaders, 'a2a.historyReaders') })

  return {
    enabled: r.enabled === undefined ? true : r.enabled === true,
    sharing,
    memory,
    a2a: {
      capabilities,
      callers,
      confirmers: stringList(a2aRaw.confirmers, 'a2a.confirmers'),
      dailyCallLimit: positiveInt(a2aRaw.dailyCallLimit, DEFAULT_AGENTIFY_CONFIG.a2a.dailyCallLimit, 'a2a.dailyCallLimit', 100000),
    },
  }
}

export interface AgentIdentity {
  id: string
  name: string
  displayName: string
}

/** Does an access list admit someone known by these names? Deny wins; `*` matches everyone. */
export function listAdmits(list: AccessList, names: Array<string | null | undefined>): boolean {
  const known = names.filter((n): n is string => typeof n === 'string' && n.length > 0)
  const hit = (entry: string) => entry === '*' || known.includes(entry)
  if (list.deny.some(hit)) return false
  return list.allow.some(hit)
}

/** Does `list` (ids, names, display names or `*`) admit this agent? */
export function listAdmitsAgent(list: AccessList, agent: AgentIdentity): boolean {
  return listAdmits(list, [agent.id, agent.name, agent.displayName])
}

/** The callers list in effect for one capability. */
export function capabilityCallers(config: AgentifyConfig, cap: CapabilityConfig): AccessList {
  return cap.callers ?? config.a2a.callers
}
