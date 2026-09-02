import { dirname, join } from 'path'
import { readFile } from 'fs/promises'
import type { SessionRecord } from './types.js'
import { getSessionUsageSummaryFromTranscriptPath } from '../utils/sessionUsage.js'

type SimpleMessage = {
  type: string
  uuid: string
  parentUuid: string | null
  timestamp: string
  sessionId: string
  isSidechain: boolean
  message?: {
    role?: string
    content?: unknown
  }
  role?: string
  content?: unknown
  name?: string
  input?: unknown
  is_error?: boolean
  tool_use_id?: string
  displayText?: string
}

function parseJsonlEntries(buf: string): SimpleMessage[] {
  const lines = buf.split('\n').filter(l => l.trim().length > 0)
  const entries: SimpleMessage[] = []
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      const t = obj.type as string
      if (
        t === 'user' ||
        t === 'assistant' ||
        t === 'thinking' ||
        t === 'tool_use' ||
        t === 'tool_result'
      ) {
        entries.push(obj as unknown as SimpleMessage)
      }
    } catch {
      // skip malformed lines
    }
  }
  return entries
}

function simpleMessageToMessage(msg: SimpleMessage): Record<string, unknown> {
  if (msg.type === 'user') {
    const content = msg.message?.content ?? msg.content
    return {
      type: 'user',
      role: 'user',
      content,
      // displayText carries the human-typed text with the client-injected
      // preambles stripped; present only when it differs from the raw content.
      ...(typeof msg.displayText === 'string' ? { displayText: msg.displayText } : {}),
      uuid: msg.uuid,
      timestamp: msg.timestamp,
    }
  }
  if (msg.type === 'assistant') {
    const content = msg.message?.content ?? msg.content
    return {
      type: 'assistant',
      role: 'assistant',
      content,
      uuid: msg.uuid,
      timestamp: msg.timestamp,
    }
  }
  if (msg.type === 'thinking') {
    const content = msg.message?.content ?? msg.content
    return {
      type: 'thinking',
      role: 'assistant',
      content,
      uuid: msg.uuid,
      timestamp: msg.timestamp,
    }
  }
  if (msg.type === 'tool_use') {
    return {
      type: 'tool_use',
      role: 'assistant',
      name: msg.name,
      input: msg.input,
      uuid: msg.uuid,
      timestamp: msg.timestamp,
    }
  }
  if (msg.type === 'tool_result') {
    return {
      type: 'tool_result',
      role: 'user',
      content: msg.content,
      is_error: msg.is_error,
      tool_use_id: msg.tool_use_id,
      uuid: msg.uuid,
      timestamp: msg.timestamp,
    }
  }
  return msg as unknown as Record<string, unknown>
}

async function readJsonlMessages(filePath: string): Promise<SimpleMessage[]> {
  const buf = await readFile(filePath, 'utf-8')
  return parseJsonlEntries(buf)
}

export async function loadSessionContextFromTranscript(session: SessionRecord): Promise<{
  customTitle?: string
  tag?: string
  summary?: string
  messages: Record<string, unknown>[]
  usage: Awaited<ReturnType<typeof getSessionUsageSummaryFromTranscriptPath>>
} | null> {
  try {
    const entries = await readJsonlMessages(session.transcriptPath)
    // Filter out sidechain messages
    const mainEntries = entries.filter(e => !e.isSidechain)
    if (mainEntries.length === 0) {
      return null
    }

    // Sort by timestamp to ensure correct order
    mainEntries.sort((a, b) => {
      const ta = Date.parse(a.timestamp)
      const tb = Date.parse(b.timestamp)
      return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0)
    })

    const messages = mainEntries.map(simpleMessageToMessage)

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
