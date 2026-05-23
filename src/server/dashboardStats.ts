import { stat } from 'fs/promises'
import { dirname, join } from 'path'
import pMap from 'p-map'
import type { SessionRecord, SessionStatus } from './types.js'
import {
  LITE_READ_BUF_SIZE,
  extractJsonStringField,
  readHeadAndTail,
} from '../utils/sessionStoragePortable.js'
import { getSessionUsageSummaryFromTranscriptPath } from '../utils/sessionUsage.js'

const ACTIVE_SESSION_STATUSES = new Set<SessionStatus>([
  'creating',
  'active',
  'detached',
])

export type DashboardStats = {
  sessions: {
    total: number
    active: number
  }
  agents: {
    total: number
    active: number
  }
  assistants: {
    name: string | null
    displayName: string
    totalSessions: number
    activeSessions: number
  }[]
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    totalTokens: number
  }
}

type SessionTranscriptMetadata = {
  agentSetting?: string
  teamName?: string
}

function createEmptyDashboardStats(): DashboardStats {
  return {
    sessions: {
      total: 0,
      active: 0,
    },
    agents: {
      total: 0,
      active: 0,
    },
    assistants: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 0,
    },
  }
}

function resolveAgentKey(metadata: SessionTranscriptMetadata): string {
  const agentSetting = metadata.agentSetting?.trim()
  if (agentSetting) {
    return `agent:${agentSetting}`
  }

  const teamName = metadata.teamName?.trim()
  if (teamName) {
    return `team:${teamName}`
  }

  return 'agent:default'
}

async function readSessionTranscriptMetadata(
  transcriptPath: string,
): Promise<SessionTranscriptMetadata> {
  let fileSize = 0
  try {
    fileSize = (await stat(transcriptPath)).size
  } catch {
    return {}
  }

  const readBuf = Buffer.allocUnsafe(LITE_READ_BUF_SIZE)
  const { head } = await readHeadAndTail(transcriptPath, fileSize, readBuf)
  if (!head) {
    return {}
  }

  return {
    agentSetting: extractJsonStringField(head, 'agentSetting') ?? undefined,
    teamName: extractJsonStringField(head, 'teamName') ?? undefined,
  }
}

async function loadSingleSessionStats(session: SessionRecord): Promise<{
  agentKey: string
  isActive: boolean
  usage: DashboardStats['usage']
}> {
  const [usageSummary, transcriptMetadata] = await Promise.all([
    getSessionUsageSummaryFromTranscriptPath({
      transcriptSessionId: session.transcriptSessionId,
      mainTranscriptPath: session.transcriptPath,
      subagentsDir: join(
        dirname(session.transcriptPath),
        session.transcriptSessionId,
        'subagents',
      ),
    }).catch(() => null),
    readSessionTranscriptMetadata(session.transcriptPath).catch(() => ({})),
  ])

  return {
    agentKey: resolveAgentKey(transcriptMetadata),
    isActive: ACTIVE_SESSION_STATUSES.has(session.status),
    usage: {
      inputTokens: usageSummary?.inputTokens ?? 0,
      outputTokens: usageSummary?.outputTokens ?? 0,
      cacheReadInputTokens: usageSummary?.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: usageSummary?.cacheCreationInputTokens ?? 0,
      totalTokens: usageSummary?.totalTokens ?? 0,
    },
  }
}

export async function loadDashboardStats(
  sessions: SessionRecord[],
): Promise<DashboardStats> {
  const stats = createEmptyDashboardStats()
  const totalAgentKeys = new Set<string>()
  const activeAgentKeys = new Set<string>()

  stats.sessions.total = sessions.length

  // Group sessions by assistantName
  const assistantStats = new Map<string | null, { total: number; active: number }>()

  const sessionStats = await pMap(sessions, loadSingleSessionStats, {
    concurrency: 4,
  })

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i]
    const sessionStat = sessionStats[i]

    totalAgentKeys.add(sessionStat.agentKey)
    if (sessionStat.isActive) {
      stats.sessions.active += 1
      activeAgentKeys.add(sessionStat.agentKey)
    }

    stats.usage.inputTokens += sessionStat.usage.inputTokens
    stats.usage.outputTokens += sessionStat.usage.outputTokens
    stats.usage.cacheReadInputTokens += sessionStat.usage.cacheReadInputTokens
    stats.usage.cacheCreationInputTokens +=
      sessionStat.usage.cacheCreationInputTokens
    stats.usage.totalTokens += sessionStat.usage.totalTokens

    // Count by assistantName - only count sessions with explicit assistantName
    const assistantName = session.assistantName
    if (assistantName) {
      if (!assistantStats.has(assistantName)) {
        assistantStats.set(assistantName, { total: 0, active: 0 })
      }
      const assistantCount = assistantStats.get(assistantName)!
      assistantCount.total++
      if (sessionStat.isActive) {
        assistantCount.active++
      }
    }
  }

  stats.agents.total = totalAgentKeys.size
  stats.agents.active = activeAgentKeys.size

  // Convert assistantStats to array - only includes sessions with explicit assistantName
  stats.assistants = Array.from(assistantStats.entries())
    .filter(([name]) => name !== null)
    .map(([name, counts]) => ({
      name: name as string,
      displayName: name as string,
      totalSessions: counts.total,
      activeSessions: counts.active,
    }))
    .sort((a, b) => b.totalSessions - a.totalSessions)

  return stats
}
