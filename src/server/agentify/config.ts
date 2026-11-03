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

export type HistoryShare = 'summary' | 'full'

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
  memory: {
    /**
     * What a new session of this agent can see from sessions other employees
     * started: `summary` = summaries, conclusions and outputs; `full` = also
     * the cleaned conversation text. An employee always sees their own.
     */
    share: HistoryShare
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
     * agent in the same organization. Empty = nobody.
     */
    allowCallers: string[]
    /** Agents allowed to read this agent's shared history and outputs directly. */
    historyReaders: string[]
    /** User ids who may confirm tasks that require confirmation. */
    confirmers: string[]
    /** Per-day ceiling on calls this agent accepts. */
    dailyCallLimit: number
  }
}

export const DEFAULT_AGENTIFY_CONFIG: AgentifyConfig = {
  enabled: true,
  memory: { share: 'summary', injectChars: 4000 },
  a2a: { capabilities: [], allowCallers: [], historyReaders: [], confirmers: [], dailyCallLimit: 200 },
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

  const share = memoryRaw.share === undefined ? 'summary' : memoryRaw.share
  if (share !== 'summary' && share !== 'full') throw new AgentifyConfigError('memory.share must be "summary" or "full"')

  const capsRaw = a2aRaw.capabilities ?? []
  if (!Array.isArray(capsRaw)) throw new AgentifyConfigError('a2a.capabilities must be an array')
  const capabilities = capsRaw.map(parseCapability)
  const seen = new Set<string>()
  for (const c of capabilities) {
    if (seen.has(c.id)) throw new AgentifyConfigError(`duplicate capability id ${c.id}`)
    seen.add(c.id)
  }

  const memory: AgentifyConfig['memory'] = {
    share,
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

  return {
    enabled: r.enabled === undefined ? true : r.enabled === true,
    memory,
    a2a: {
      capabilities,
      allowCallers: stringList(a2aRaw.allowCallers, 'a2a.allowCallers'),
      historyReaders: stringList(a2aRaw.historyReaders, 'a2a.historyReaders'),
      confirmers: stringList(a2aRaw.confirmers, 'a2a.confirmers'),
      dailyCallLimit: positiveInt(a2aRaw.dailyCallLimit, DEFAULT_AGENTIFY_CONFIG.a2a.dailyCallLimit, 'a2a.dailyCallLimit', 100000),
    },
  }
}

/** Does `list` (ids, names, display names or `*`) admit this agent? */
export function listAdmitsAgent(
  list: string[],
  agent: { id: string; name: string; displayName: string },
): boolean {
  return list.some(entry => entry === '*' || entry === agent.id || entry === agent.name || entry === agent.displayName)
}
