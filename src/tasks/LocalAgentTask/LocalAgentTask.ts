export type LocalAgentTaskState = Record<string, unknown>

export function drainPendingMessages(): unknown[] {
  return []
}

export function createActivityDescriptionResolver(): unknown {
  return {}
}

export function createProgressTracker(): unknown {
  return {}
}

export function getProgressUpdate(): unknown {
  return null
}

export function updateProgressFromMessage(): void {}