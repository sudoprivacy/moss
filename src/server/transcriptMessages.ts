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
        t === 'artifacts' ||
        t === 'thinking' ||
        t === 'tool_use' ||
        t === 'tool_result' ||
        t === 'result'
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

/** Project durable conversation facts for the context API; omit live UI observations. */
export function parseSessionTranscriptMessages(jsonl: string): Record<string, unknown>[] {
  const entries = parseJsonlEntries(jsonl).filter(entry => !entry.isSidechain)
  entries.sort((a, b) => {
    const ta = Date.parse(a.timestamp)
    const tb = Date.parse(b.timestamp)
    return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0)
  })
  return entries.map(simpleMessageToMessage)
}
