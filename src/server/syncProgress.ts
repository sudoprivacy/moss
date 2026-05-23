export type SyncProgress = {
  status: 'idle' | 'running' | 'done' | 'error'
  total: number
  processed: number
  installed: number
  updated: number
  skipped: number
  failed: number
  error?: string
  startedAt: number
}

const idleProgress: SyncProgress = {
  status: 'idle',
  total: 0,
  processed: 0,
  installed: 0,
  updated: 0,
  skipped: 0,
  failed: 0,
  startedAt: 0,
}

let _skillProgress: SyncProgress = { ...idleProgress }
let _agentProgress: SyncProgress = { ...idleProgress }

export function getSkillSyncProgress(): SyncProgress {
  return { ..._skillProgress }
}

export function getAgentSyncProgress(): SyncProgress {
  return { ..._agentProgress }
}

export function updateSkillSyncProgress(patch: Partial<SyncProgress>): void {
  _skillProgress = { ..._skillProgress, ...patch }
}

export function updateAgentSyncProgress(patch: Partial<SyncProgress>): void {
  _agentProgress = { ..._agentProgress, ...patch }
}

export function resetSkillSyncProgress(): void {
  _skillProgress = { ...idleProgress }
}

export function resetAgentSyncProgress(): void {
  _agentProgress = { ...idleProgress }
}
