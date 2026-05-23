import { type UUID } from 'crypto'
import { dirname, join } from 'path'
import type { Message } from '../types/message.js'
import { prepareSessionResume } from '../utils/sessionResumeCore.js'
import { loadTranscriptFile } from '../utils/sessionStorage.js'
import { getSessionUsageSummaryFromTranscriptPath } from '../utils/sessionUsage.js'
import type { SessionRecord } from './types.js'
import type { TranscriptMessage } from '../types/logs.js'

function findLatestMessage(messages: Iterable<TranscriptMessage>): TranscriptMessage | null {
  let latest: TranscriptMessage | null = null
  let latestTime = -Infinity
  for (const message of messages) {
    if (message.isSidechain) {
      continue
    }
    const ts = Date.parse(message.timestamp)
    if (Number.isFinite(ts) && ts >= latestTime) {
      latest = message
      latestTime = ts
    }
  }
  return latest
}

function buildConversationChain(
  messages: Map<UUID, TranscriptMessage>,
  lastMessage: TranscriptMessage,
): TranscriptMessage[] {
  const chain: TranscriptMessage[] = []
  const seen = new Set<string>()
  let current: TranscriptMessage | undefined = lastMessage
  while (current && !seen.has(current.uuid)) {
    seen.add(current.uuid)
    chain.unshift(current)
    current = current.parentUuid ? messages.get(current.parentUuid as UUID) : undefined
  }
  return chain
}

export async function loadSessionContextFromTranscript(session: SessionRecord): Promise<{
  customTitle?: string
  tag?: string
  summary?: string
  messages: Message[]
  usage: Awaited<ReturnType<typeof getSessionUsageSummaryFromTranscriptPath>>
} | null> {
  const loaded = await loadTranscriptFile(session.transcriptPath)
  if (loaded.messages.size === 0) {
    return null
  }
  const lastMessage = findLatestMessage(loaded.messages.values())
  if (!lastMessage) {
    return null
  }
  const prepared = await prepareSessionResume(session.transcriptSessionId, {
    sourceJsonlFile: session.transcriptPath,
  })
  if (!prepared) {
    return null
  }
  const usage = await getSessionUsageSummaryFromTranscriptPath({
    transcriptSessionId: session.transcriptSessionId,
    mainTranscriptPath: session.transcriptPath,
    subagentsDir: join(
      dirname(session.transcriptPath),
      session.transcriptSessionId,
      'subagents',
    ),
  })
  return {
    customTitle: loaded.customTitles.get(lastMessage.sessionId as UUID),
    tag: loaded.tags.get(lastMessage.sessionId as UUID),
    summary: loaded.summaries.get(lastMessage.uuid as UUID),
    messages: prepared.messages,
    usage,
  }
}
