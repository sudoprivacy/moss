import { dirname, join } from 'path'
import { readFile } from 'fs/promises'
import type { SessionRecord } from './types.js'
import { getSessionUsageSummaryFromTranscriptPath } from '../utils/sessionUsage.js'

import { parseSessionTranscriptMessages } from './transcriptMessages.js'

export async function loadSessionContextFromTranscript(session: SessionRecord): Promise<{
  customTitle?: string
  tag?: string
  summary?: string
  messages: Record<string, unknown>[]
  usage: Awaited<ReturnType<typeof getSessionUsageSummaryFromTranscriptPath>>
} | null> {
  try {
    const messages = parseSessionTranscriptMessages(await readFile(session.transcriptPath, 'utf-8'))
    if (messages.length === 0) return null

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
      messages,
      usage,
    }
  } catch (error) {
    // Fall back to original method if direct JSONL parsing fails
    const { loadTranscriptFile } = await import('../utils/sessionStorage.js')
    const { prepareSessionResume } = await import('../utils/sessionResumeCore.js')

    const loaded = await loadTranscriptFile(session.transcriptPath)
    if (loaded.messages.size === 0) {
      return null
    }

    let latestTime = -Infinity
    let lastSessionId: string | undefined
    let lastUuid: UUID | undefined
    for (const msg of loaded.messages.values()) {
      if (msg.isSidechain) continue
      const ts = Date.parse(msg.timestamp)
      if (Number.isFinite(ts) && ts >= latestTime) {
        latestTime = ts
        lastSessionId = msg.sessionId as string
        lastUuid = msg.uuid as UUID
      }
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
      customTitle: lastSessionId ? loaded.customTitles.get(lastSessionId as UUID) : undefined,
      tag: lastSessionId ? loaded.tags.get(lastSessionId as UUID) : undefined,
      summary: lastUuid ? loaded.summaries.get(lastUuid) : undefined,
      messages: prepared.messages as Record<string, unknown>[],
      usage,
    }
  }
}
