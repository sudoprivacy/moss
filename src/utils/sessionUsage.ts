import type { Dirent } from 'fs'
import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import type { ModelUsage } from '../entrypoints/agentSdkTypes.js'
import type { Entry, TranscriptMessage } from '../types/logs.js'
import { errorMessage, isENOENT } from './errors.js'
import { readJSONLFile } from './json.js'
import { calculateUSDCost } from './modelCost.js'
import { SYNTHETIC_MODEL } from './messages.js'
import {
  getProjectDir,
  isTranscriptMessage,
  MAX_TRANSCRIPT_READ_BYTES,
} from './sessionStorage.js'

export type SessionUsageSummary = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  totalTokens: number
  costUSD: number
  webSearchRequests: number
  modelUsage: Record<string, ModelUsage>
  assistantMessageCount: number
  filesRead: number
  truncatedFiles: string[]
  includesSubagents: boolean
  subagentTranscriptCount: number
}

function createEmptyUsageSummary(): SessionUsageSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 0,
    costUSD: 0,
    webSearchRequests: 0,
    modelUsage: {},
    assistantMessageCount: 0,
    filesRead: 0,
    truncatedFiles: [],
    includesSubagents: false,
    subagentTranscriptCount: 0,
  }
}

function createEmptyModelUsage(): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
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
  summary: SessionUsageSummary,
  options: {
    includeSidechains: boolean
  },
): Promise<void> {
  try {
    const fileStat = await stat(filePath)
    if (fileStat.size > MAX_TRANSCRIPT_READ_BYTES) {
      summary.truncatedFiles.push(filePath)
    }
  } catch {}

  const entries = await readJSONLFile<Entry>(filePath)
  summary.filesRead += 1

  for (const entry of entries) {
    if (!isTranscriptMessage(entry)) continue
    if (entry.type !== 'assistant') continue
    if (!options.includeSidechains && entry.isSidechain) continue
    accumulateAssistantUsage(summary, entry)
  }
}

function accumulateAssistantUsage(
  summary: SessionUsageSummary,
  message: TranscriptMessage,
): void {
  const usage = message.message?.usage
  const model = message.message?.model || 'unknown'

  if (!usage || model === SYNTHETIC_MODEL) {
    return
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
  const webSearchRequests =
    usage.server_tool_use?.web_search_requests ?? 0
  const costUSD = calculateUSDCost(model, usage)

  summary.inputTokens += inputTokens
  summary.outputTokens += outputTokens
  summary.cacheReadInputTokens += cacheReadInputTokens
  summary.cacheCreationInputTokens += cacheCreationInputTokens
  summary.totalTokens += totalTokens
  summary.costUSD += costUSD
  summary.webSearchRequests += webSearchRequests
  summary.assistantMessageCount += 1

  if (!summary.modelUsage[model]) {
    summary.modelUsage[model] = createEmptyModelUsage()
  }
  const modelUsage = summary.modelUsage[model]!
  modelUsage.inputTokens += inputTokens
  modelUsage.outputTokens += outputTokens
  modelUsage.cacheReadInputTokens += cacheReadInputTokens
  modelUsage.cacheCreationInputTokens += cacheCreationInputTokens
  modelUsage.webSearchRequests += webSearchRequests
  modelUsage.costUSD += costUSD
}

export async function getSessionUsageSummary(input: {
  transcriptSessionId: string
  cwd: string
}): Promise<SessionUsageSummary | null> {
  const projectDir = getProjectDir(input.cwd)
  const mainTranscriptPath = join(projectDir, `${input.transcriptSessionId}.jsonl`)
  const subagentsDir = join(projectDir, input.transcriptSessionId, 'subagents')

  return getSessionUsageSummaryFromTranscriptPath({
    transcriptSessionId: input.transcriptSessionId,
    mainTranscriptPath,
    subagentsDir,
  })
}

export async function getSessionUsageSummaryFromTranscriptPath(input: {
  transcriptSessionId: string
  mainTranscriptPath: string
  subagentsDir: string
}): Promise<SessionUsageSummary | null> {
  const mainTranscriptPath = input.mainTranscriptPath
  const subagentsDir = input.subagentsDir

  const summary = createEmptyUsageSummary()

  try {
    await collectUsageFromTranscriptFile(mainTranscriptPath, summary, {
      includeSidechains: false,
    })
  } catch (error) {
    if (isENOENT(error)) {
      return null
    }
    throw new Error(
      `Failed to read session transcript ${mainTranscriptPath}: ${errorMessage(error)}`,
    )
  }

  const subagentFiles = await collectJsonlFilesRecursive(subagentsDir)
  summary.subagentTranscriptCount = subagentFiles.length
  summary.includesSubagents = subagentFiles.length > 0

  for (const subagentFile of subagentFiles) {
    await collectUsageFromTranscriptFile(subagentFile, summary, {
      includeSidechains: true,
    })
  }

  return summary
}
