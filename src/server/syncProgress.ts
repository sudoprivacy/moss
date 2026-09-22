import { getOrganizationResourceScope } from './catalog/organizationResources.js'
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

const progressByOrg = new Map<string, { skill: SyncProgress; agent: SyncProgress }>()
function current() {
  const orgId = getOrganizationResourceScope()?.orgId ?? '__offline__'
  let progress = progressByOrg.get(orgId)
  if (!progress) {
    progress = { skill: { ...idleProgress }, agent: { ...idleProgress } }
    progressByOrg.set(orgId, progress)
  }
  return progress
}

export function getSkillSyncProgress(): SyncProgress {
  return { ...current().skill }
}

export function getAgentSyncProgress(): SyncProgress {
  return { ...current().agent }
}

export function updateSkillSyncProgress(patch: Partial<SyncProgress>): void {
  current().skill = { ...current().skill, ...patch }
}

export function updateAgentSyncProgress(patch: Partial<SyncProgress>): void {
  current().agent = { ...current().agent, ...patch }
}

export function resetSkillSyncProgress(): void {
  current().skill = { ...idleProgress }
}

export function resetAgentSyncProgress(): void {
  current().agent = { ...idleProgress }
}
