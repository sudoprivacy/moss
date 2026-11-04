import { dcClient } from './client'

/**
 * Agentify — durable agents with an agent home (memory, history, outputs) and
 * agent-to-agent collaboration. See src/server/agentify/routes.ts.
 */

/** Names, ids or `*`; deny wins over allow. */
export interface AccessList {
  allow: string[]
  deny: string[]
}

export interface AgentifyCapability {
  id: string
  kind: 'ask' | 'task'
  description: string
  input?: string
  requiresConfirmation?: boolean
  allowOutbound?: boolean
  requireCallerVisibility?: boolean
  /** Agents allowed to use this capability; absent = a2a.callers. */
  callers?: AccessList
}

/** private = the employee whose session it is; users = also this agent's employees; agents = also other agents, by handoff. */
export type ShareLevel = 'private' | 'users' | 'agents'

export const SHARE_TYPES = ['conversation', 'summary', 'input', 'output', 'intermediate', 'sharedMemory'] as const
export type ShareType = (typeof SHARE_TYPES)[number]

export interface ShareRule {
  level: ShareLevel
  users?: AccessList
  agents?: AccessList
}

export type SharingConfig = {
  users: AccessList
  /** Absent = the agents allowed to call (a2a.callers). */
  agents?: AccessList
} & Record<ShareType, ShareRule>

export interface AgentifyConfig {
  enabled: boolean
  sharing: SharingConfig
  memory: {
    injectChars: number
    /** Hours; absent = server default. */
    digestLookbackHours?: number
    /** Hours; 0 = no decay; absent = server default. */
    decayHalfLifeHours?: number
    /** Hours; 0 = keep forever; absent = server default. */
    deleteAfterHours?: number
  }
  a2a: {
    capabilities: AgentifyCapability[]
    callers: AccessList
    confirmers: string[]
    dailyCallLimit: number
  }
}

export interface HistoryPolicy {
  digestLookbackHours: number
  decayHalfLifeHours: number
  deleteAfterHours: number
}

export interface AgentifyAgent {
  id: string
  name: string
  displayName: string
  description: string
  category: string
  enabled: boolean
  agentified: boolean
  config: AgentifyConfig | null
  /** Hours in effect for this agent. */
  historyPolicy: HistoryPolicy
  documents: number
}

export interface HistoryDoc {
  id: string
  kind: 'summary' | 'conversation' | 'memory' | 'a2a' | 'artifact' | 'input'
  title: string
  path: string
  sessionId: string | null
  userId: string | null
  visibility?: 'shared' | 'private'
  createdAt: number
  activeAt?: number
  text?: string
  snippet?: string
  score?: number
  docId?: string
}

export interface A2ACallView {
  id: string
  kind: 'ask' | 'task'
  status: string
  capability: string
  caller: { id: string; name: string }
  target: { id: string; name: string }
  input: string
  result: string | null
  files: string[]
  error: string | null
  depth: number
  actor: { id: string; name: string | null } | null
  requiresConfirmation: boolean
  confirmedBy: string | null
  targetSessionId: string | null
  callerSessionId: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface NexusUpgradeReport {
  status: 'upgraded' | 'rolled_back' | 'held' | 'fresh'
  from: string | null
  to: string
  running: string
  at: string
  backup: string | null
  secrets: number | null
  verified: boolean
  error?: string
}

const BASE = '/api/v1/admin/agentify'
const enc = encodeURIComponent

export const DEFAULT_SHARE_LEVELS: Record<ShareType, ShareLevel> = {
  conversation: 'private',
  summary: 'users',
  input: 'private',
  output: 'users',
  intermediate: 'private',
  sharedMemory: 'users',
}

export const DEFAULT_CONFIG: AgentifyConfig = {
  enabled: true,
  sharing: {
    users: { allow: ['*'], deny: [] },
    ...(Object.fromEntries(SHARE_TYPES.map(t => [t, { level: DEFAULT_SHARE_LEVELS[t] }])) as Record<ShareType, ShareRule>),
  },
  memory: { injectChars: 4000 },
  a2a: { capabilities: [], callers: { allow: [], deny: [] }, confirmers: [], dailyCallLimit: 200 },
}

export const listAgentifyAgents = () =>
  dcClient.get<{ agents: AgentifyAgent[]; home: 'nexus' | 'local'; historyDefaults: HistoryPolicy }>(`${BASE}/agents`)

export const saveAgentifyConfig = (agentId: string, config: AgentifyConfig) =>
  dcClient.put<{ agent: { id: string; displayName: string; config: AgentifyConfig } }>(`${BASE}/agents/${enc(agentId)}`, { config })

export const disableAgentify = (agentId: string) => dcClient.delete<{ ok: boolean }>(`${BASE}/agents/${enc(agentId)}`)

export const getAgentMemory = (agentId: string, scope: 'shared' | 'private' = 'shared', userId?: string) =>
  dcClient.get<{ text: string }>(`${BASE}/agents/${enc(agentId)}/memory?scope=${scope}${userId ? `&userId=${enc(userId)}` : ''}`)

export const saveAgentMemory = (agentId: string, text: string, scope: 'shared' | 'private' = 'shared', userId?: string) =>
  dcClient.put<{ ok: boolean }>(`${BASE}/agents/${enc(agentId)}/memory?scope=${scope}${userId ? `&userId=${enc(userId)}` : ''}`, { text })

export const listAgentHistory = (agentId: string, opts: { q?: string; kind?: string; limit?: number; offset?: number } = {}) => {
  const qs = new URLSearchParams()
  if (opts.q) qs.set('q', opts.q)
  if (opts.kind) qs.set('kind', opts.kind)
  if (opts.limit) qs.set('limit', String(opts.limit))
  if (opts.offset) qs.set('offset', String(opts.offset))
  return dcClient.get<{ items?: HistoryDoc[]; hits?: HistoryDoc[]; total?: number }>(`${BASE}/agents/${enc(agentId)}/history?${qs}`)
}

export const getAgentHistoryDoc = (agentId: string, docId: string) =>
  dcClient.get<HistoryDoc>(`${BASE}/agents/${enc(agentId)}/history/${enc(docId)}`)

export const purgeExpiredNow = (agentId: string) =>
  dcClient.post<{ docs: number; sessions: number; calls: number }>(`${BASE}/agents/${enc(agentId)}/purge`, {})

export const digestNow = (agentId: string) =>
  dcClient.post<{ backfilled: number; digested: number }>(`${BASE}/agents/${enc(agentId)}/digest`, {})

export const listA2ACalls = (opts: { agentId?: string; status?: string } = {}) => {
  const qs = new URLSearchParams()
  if (opts.agentId) qs.set('agentId', opts.agentId)
  if (opts.status) qs.set('status', opts.status)
  return dcClient.get<{ calls: A2ACallView[] }>(`${BASE}/calls?${qs}`)
}

export const listConfirmations = () => dcClient.get<{ calls: A2ACallView[] }>('/api/v1/agentify/confirmations')

export const confirmCall = (callId: string, approve: boolean, note?: string) =>
  dcClient.post<{ call: A2ACallView }>(`/api/v1/agentify/confirmations/${enc(callId)}`, { approve, note })

export const getNexusStatus = () =>
  dcClient.get<{ home: 'nexus' | 'local'; nexus: NexusUpgradeReport | null }>(`${BASE}/nexus`)
