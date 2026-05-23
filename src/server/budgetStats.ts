import type { Dirent } from 'fs'
import { readdir } from 'fs/promises'
import { dirname, join } from 'path'
import pMap from 'p-map'
import type { Entry, TranscriptMessage } from '../types/logs.js'
import { errorMessage, isENOENT } from '../utils/errors.js'
import { readJSONLFile } from '../utils/json.js'
import { calculateUSDCost } from '../utils/modelCost.js'
import { SYNTHETIC_MODEL } from '../utils/messages.js'
import { isTranscriptMessage } from '../utils/sessionStorage.js'
import type { SessionRecord } from './types.js'

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS
const TREND_BUCKET_COUNTS = {
  day: 30,
  week: 12,
  month: 12,
} as const

const GRANULARITIES = ['day', 'week', 'month'] as const

type BudgetGranularity = (typeof GRANULARITIES)[number]

export type BudgetUsageTotals = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  totalTokens: number
  costUSD: number
}

export type BudgetUserStats = BudgetUsageTotals & {
  userId: string
  sessionCount: number
  lastActiveAt: number
}

export type BudgetAgentStats = BudgetUsageTotals & {
  assistantName: string
  sessionCount: number
  lastActiveAt: number
}

export type BudgetTrendBucketUser = BudgetUsageTotals & {
  userId: string
}

export type BudgetTrendBucketAgent = BudgetUsageTotals & {
  assistantName: string
}

export type BudgetTrendBucket = BudgetUsageTotals & {
  start: number
  end: number
  users: BudgetTrendBucketUser[]
  agents: BudgetTrendBucketAgent[]
}

export type BudgetStats = {
  summary: BudgetUsageTotals & {
    sessionCount: number
    userCount: number
    lastActivityAt: number | null
  }
  users: BudgetUserStats[]
  agents: BudgetAgentStats[]
  trends: Record<BudgetGranularity, BudgetTrendBucket[]>
}

type BudgetTrendWindow = {
  starts: number[]
  startSet: Set<number>
  endByStart: Map<number, number>
}

type SessionBudgetStats = {
  userId: string
  sessionCount: number
  lastActiveAt: number
  usage: BudgetUsageTotals
  trends: Record<BudgetGranularity, Map<number, BudgetUsageTotals>>
}

function createEmptyUsageTotals(): BudgetUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 0,
    costUSD: 0,
  }
}

function addUsageTotals(
  target: BudgetUsageTotals,
  delta: BudgetUsageTotals,
): void {
  target.inputTokens += delta.inputTokens
  target.outputTokens += delta.outputTokens
  target.cacheReadInputTokens += delta.cacheReadInputTokens
  target.cacheCreationInputTokens += delta.cacheCreationInputTokens
  target.totalTokens += delta.totalTokens
  target.costUSD += delta.costUSD
}

function startOfUtcDay(timestamp: number): number {
  const date = new Date(timestamp)
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  )
}

function startOfUtcWeek(timestamp: number): number {
  const dayStart = startOfUtcDay(timestamp)
  const dayOfWeek = (new Date(dayStart).getUTCDay() + 6) % 7
  return dayStart - dayOfWeek * DAY_MS
}

function startOfUtcMonth(timestamp: number): number {
  const date = new Date(timestamp)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
}

function addUtcMonths(timestamp: number, amount: number): number {
  const date = new Date(timestamp)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + amount, 1)
}

function resolveBucketStart(
  granularity: BudgetGranularity,
  timestamp: number,
): number {
  switch (granularity) {
    case 'day':
      return startOfUtcDay(timestamp)
    case 'week':
      return startOfUtcWeek(timestamp)
    case 'month':
      return startOfUtcMonth(timestamp)
  }
}

function resolveBucketEnd(
  granularity: BudgetGranularity,
  bucketStart: number,
): number {
  switch (granularity) {
    case 'day':
      return bucketStart + DAY_MS
    case 'week':
      return bucketStart + WEEK_MS
    case 'month':
      return addUtcMonths(bucketStart, 1)
  }
}

function createTrendWindow(
  granularity: BudgetGranularity,
  now: number,
): BudgetTrendWindow {
  const count = TREND_BUCKET_COUNTS[granularity]
  const currentBucketStart = resolveBucketStart(granularity, now)
  const starts =
    granularity === 'month'
      ? Array.from({ length: count }, (_, index) =>
          addUtcMonths(currentBucketStart, index - (count - 1)),
        )
      : Array.from({ length: count }, (_, index) => {
          const offset = count - 1 - index
          const size = granularity === 'week' ? WEEK_MS : DAY_MS
          return currentBucketStart - offset * size
        })

  return {
    starts,
    startSet: new Set(starts),
    endByStart: new Map(
      starts.map(start => [start, resolveBucketEnd(granularity, start)]),
    ),
  }
}

function createTrendWindows(now: number): Record<BudgetGranularity, BudgetTrendWindow> {
  return {
    day: createTrendWindow('day', now),
    week: createTrendWindow('week', now),
    month: createTrendWindow('month', now),
  }
}

function parseMessageUsage(
  message: TranscriptMessage,
): BudgetUsageTotals | null {
  const usage = message.message?.usage
  const model = message.message?.model || 'unknown'
  if (!usage || model === SYNTHETIC_MODEL) {
    return null
  }

  const inputTokens = usage.input_tokens || 0
  const outputTokens = usage.output_tokens || 0
  const cacheReadInputTokens = usage.cache_read_input_tokens || 0
  const cacheCreationInputTokens = usage.cache_creation_input_tokens || 0
  const totalTokens =
    inputTokens +
    outputTokens +
    cacheReadInputTokens +
    cacheCreationInputTokens

  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalTokens,
    costUSD: calculateUSDCost(model, usage),
  }
}

async function collectJsonlFilesRecursive(dirPath: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch (error) {
    if (isENOENT(error)) {
      return []
    }
    throw error
  }

  const files: string[] = []
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectJsonlFilesRecursive(fullPath)))
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(fullPath)
    }
  }
  return files
}

async function collectUsageFromTranscriptFile(
  filePath: string,
  options: {
    includeSidechains: boolean
    onUsage: (timestamp: number, usage: BudgetUsageTotals) => void
  },
): Promise<void> {
  let entries: Entry[]
  try {
    entries = await readJSONLFile<Entry>(filePath)
  } catch (error) {
    if (isENOENT(error)) {
      return
    }
    throw new Error(
      `Failed to read transcript ${filePath}: ${errorMessage(error)}`,
    )
  }

  for (const entry of entries) {
    if (!isTranscriptMessage(entry)) {
      continue
    }
    if (entry.type !== 'assistant') {
      continue
    }
    if (!options.includeSidechains && entry.isSidechain) {
      continue
    }
    const timestamp = Date.parse(entry.timestamp)
    if (!Number.isFinite(timestamp)) {
      continue
    }
    const usage = parseMessageUsage(entry)
    if (!usage) {
      continue
    }
    options.onUsage(timestamp, usage)
  }
}

async function loadSingleSessionBudgetStats(
  session: SessionRecord,
  windows: Record<BudgetGranularity, BudgetTrendWindow>,
): Promise<SessionBudgetStats> {
  const usage = createEmptyUsageTotals()
  const trends: Record<BudgetGranularity, Map<number, BudgetUsageTotals>> = {
    day: new Map<number, BudgetUsageTotals>(),
    week: new Map<number, BudgetUsageTotals>(),
    month: new Map<number, BudgetUsageTotals>(),
  }

  const accumulateUsage = (timestamp: number, delta: BudgetUsageTotals) => {
    addUsageTotals(usage, delta)

    for (const granularity of GRANULARITIES) {
      const bucketStart = resolveBucketStart(granularity, timestamp)
      if (!windows[granularity].startSet.has(bucketStart)) {
        continue
      }
      let bucketUsage = trends[granularity].get(bucketStart)
      if (!bucketUsage) {
        bucketUsage = createEmptyUsageTotals()
        trends[granularity].set(bucketStart, bucketUsage)
      }
      addUsageTotals(bucketUsage, delta)
    }
  }

  await collectUsageFromTranscriptFile(session.transcriptPath, {
    includeSidechains: false,
    onUsage: accumulateUsage,
  })

  const subagentFiles = await collectJsonlFilesRecursive(
    join(dirname(session.transcriptPath), session.transcriptSessionId, 'subagents'),
  )
  await pMap(
    subagentFiles,
    filePath =>
      collectUsageFromTranscriptFile(filePath, {
        includeSidechains: true,
        onUsage: accumulateUsage,
      }),
    { concurrency: 4 },
  )

  return {
    userId: session.userId,
    sessionCount: 1,
    lastActiveAt: session.lastActiveAt,
    usage,
    trends,
  }
}

function createEmptyBudgetStats(): BudgetStats {
  return {
    summary: {
      ...createEmptyUsageTotals(),
      sessionCount: 0,
      userCount: 0,
      lastActivityAt: null,
    },
    users: [],
    agents: [],
    trends: {
      day: [],
      week: [],
      month: [],
    },
  }
}

export async function loadBudgetStats(
  sessions: SessionRecord[],
): Promise<BudgetStats> {
  const stats = createEmptyBudgetStats()
  const windows = createTrendWindows(Date.now())
  const users = new Map<string, BudgetUserStats>()
  const agents = new Map<string, BudgetAgentStats>()
  const trendUsers: Record<
    BudgetGranularity,
    Map<number, Map<string, BudgetUsageTotals>>
  > = {
    day: new Map<number, Map<string, BudgetUsageTotals>>(),
    week: new Map<number, Map<string, BudgetUsageTotals>>(),
    month: new Map<number, Map<string, BudgetUsageTotals>>(),
  }
  const trendAgents: Record<
    BudgetGranularity,
    Map<number, Map<string, BudgetUsageTotals>>
  > = {
    day: new Map<number, Map<string, BudgetUsageTotals>>(),
    week: new Map<number, Map<string, BudgetUsageTotals>>(),
    month: new Map<number, Map<string, BudgetUsageTotals>>(),
  }

  const sessionStats = await pMap(
    sessions,
    session => loadSingleSessionBudgetStats(session, windows),
    { concurrency: 4 },
  )

  for (let i = 0; i < sessionStats.length; i++) {
    const sessionStat = sessionStats[i]
    const session = sessions[i]

    let userStats = users.get(sessionStat.userId)
    if (!userStats) {
      userStats = {
        userId: sessionStat.userId,
        sessionCount: 0,
        lastActiveAt: 0,
        ...createEmptyUsageTotals(),
      }
      users.set(sessionStat.userId, userStats)
    }

    userStats.sessionCount += sessionStat.sessionCount
    userStats.lastActiveAt = Math.max(userStats.lastActiveAt, sessionStat.lastActiveAt)
    addUsageTotals(userStats, sessionStat.usage)

    const assistantName = session.assistantName ?? null
    if (assistantName !== null) {
      let agentStats = agents.get(assistantName)
      if (!agentStats) {
        agentStats = {
          assistantName,
          sessionCount: 0,
          lastActiveAt: 0,
          ...createEmptyUsageTotals(),
        }
        agents.set(assistantName, agentStats)
      }
      agentStats.sessionCount += sessionStat.sessionCount
      agentStats.lastActiveAt = Math.max(agentStats.lastActiveAt, sessionStat.lastActiveAt)
      addUsageTotals(agentStats, sessionStat.usage)

      for (const granularity of GRANULARITIES) {
        for (const [bucketStart, bucketUsage] of sessionStat.trends[granularity]) {
          let bucketAgentMap = trendAgents[granularity].get(bucketStart)
          if (!bucketAgentMap) {
            bucketAgentMap = new Map<string, BudgetUsageTotals>()
            trendAgents[granularity].set(bucketStart, bucketAgentMap)
          }
          let agentBucketUsage = bucketAgentMap.get(assistantName)
          if (!agentBucketUsage) {
            agentBucketUsage = createEmptyUsageTotals()
            bucketAgentMap.set(assistantName, agentBucketUsage)
          }
          addUsageTotals(agentBucketUsage, bucketUsage)
        }
      }
    }

    stats.summary.sessionCount += sessionStat.sessionCount
    stats.summary.lastActivityAt = Math.max(
      stats.summary.lastActivityAt ?? 0,
      sessionStat.lastActiveAt,
    )
    addUsageTotals(stats.summary, sessionStat.usage)

    for (const granularity of GRANULARITIES) {
      for (const [bucketStart, bucketUsage] of sessionStat.trends[granularity]) {
        let bucketUsers = trendUsers[granularity].get(bucketStart)
        if (!bucketUsers) {
          bucketUsers = new Map<string, BudgetUsageTotals>()
          trendUsers[granularity].set(bucketStart, bucketUsers)
        }

        let userBucketUsage = bucketUsers.get(sessionStat.userId)
        if (!userBucketUsage) {
          userBucketUsage = createEmptyUsageTotals()
          bucketUsers.set(sessionStat.userId, userBucketUsage)
        }
        addUsageTotals(userBucketUsage, bucketUsage)
      }
    }
  }

  stats.summary.userCount = users.size

  stats.agents = Array.from(agents.values()).sort(
    (left, right) =>
      right.totalTokens - left.totalTokens ||
      right.lastActiveAt - left.lastActiveAt,
  )

  stats.users = Array.from(users.values()).sort(
    (left, right) =>
      right.totalTokens - left.totalTokens ||
      right.lastActiveAt - left.lastActiveAt,
  )

  for (const granularity of GRANULARITIES) {
    stats.trends[granularity] = windows[granularity].starts.map(start => {
      const bucketUsers = trendUsers[granularity].get(start)
      const usersInBucket = bucketUsers
        ? Array.from(bucketUsers.entries())
            .map(([userId, usage]) => ({ userId, ...usage }))
            .sort((left, right) => right.totalTokens - left.totalTokens)
        : []

      const bucketAgentMap = trendAgents[granularity].get(start)
      const agentsInBucket = bucketAgentMap
        ? Array.from(bucketAgentMap.entries())
            .map(([assistantName, usage]) => ({ assistantName, ...usage }))
            .sort((left, right) => right.totalTokens - left.totalTokens)
        : []

      const bucketTotals = createEmptyUsageTotals()
      for (const userUsage of usersInBucket) {
        addUsageTotals(bucketTotals, userUsage)
      }

      return {
        start,
        end: windows[granularity].endByStart.get(start) ?? start,
        users: usersInBucket,
        agents: agentsInBucket,
        ...bucketTotals,
      }
    })
  }

  return stats
}
