/**
 * Turn a session transcript (JSONL written by acpBridge) into the readable
 * conversation the agent home keeps.
 *
 * Tool results are dropped: they are where transcripts get huge (one observed
 * session grew a model context from 19k to 960k tokens by reading them), and
 * whatever mattered in them is restated by the agent's own replies. Tool calls
 * are kept as one short line each so the summary can say what the agent did.
 */

export interface ConversationTurn {
  role: 'user' | 'assistant' | 'tool'
  text: string
  timestamp: string | null
}

export interface ParsedConversation {
  turns: ConversationTurn[]
  firstUserText: string | null
  lastAssistantText: string | null
  toolNames: string[]
  startedAt: string | null
  endedAt: string | null
}

type Entry = Record<string, unknown>

function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') parts.push(block)
    else if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    }
  }
  return parts.join('\n')
}

function toolLine(entry: Entry): string {
  const name = typeof entry.name === 'string' ? entry.name : 'tool'
  let input = entry.input
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input)
    } catch {
      // keep as string
    }
  }
  let detail = ''
  if (input && typeof input === 'object') {
    const r = input as Record<string, unknown>
    const pick = r.command ?? r.cmd ?? r.path ?? r.file_path ?? r.query ?? r.url
    detail = typeof pick === 'string' ? pick : JSON.stringify(input)
  } else if (typeof input === 'string') {
    detail = input
  }
  detail = detail.replace(/\s+/g, ' ').trim()
  if (detail.length > 160) detail = `${detail.slice(0, 157)}...`
  return detail ? `${name}: ${detail}` : name
}

export function parseTranscript(jsonl: string): ParsedConversation {
  const turns: ConversationTurn[] = []
  const toolNames = new Set<string>()
  let firstUserText: string | null = null
  let lastAssistantText: string | null = null
  let startedAt: string | null = null
  let endedAt: string | null = null

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let entry: Entry
    try {
      entry = JSON.parse(line) as Entry
    } catch {
      continue
    }
    if (entry.isSidechain === true) continue
    const ts = typeof entry.timestamp === 'string' ? entry.timestamp : null
    if (ts) {
      startedAt ??= ts
      endedAt = ts
    }
    const message = (entry.message ?? {}) as Record<string, unknown>
    if (entry.type === 'user') {
      const text = (typeof entry.displayText === 'string' ? entry.displayText : blockText(message.content ?? entry.content)).trim()
      if (!text) continue
      firstUserText ??= text
      turns.push({ role: 'user', text, timestamp: ts })
    } else if (entry.type === 'assistant') {
      const text = blockText(message.content ?? entry.content).trim()
      if (!text) continue
      lastAssistantText = text
      turns.push({ role: 'assistant', text, timestamp: ts })
    } else if (entry.type === 'tool_use') {
      const name = typeof entry.name === 'string' ? entry.name : 'tool'
      toolNames.add(name)
      turns.push({ role: 'tool', text: toolLine(entry), timestamp: ts })
    }
  }
  return { turns, firstUserText, lastAssistantText, toolNames: [...toolNames], startedAt, endedAt }
}

/** Keep the head and tail of an over-long text; the middle is least useful. */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  const tail = max - head - 40
  return `${text.slice(0, head)}\n\n…（中间省略 ${text.length - head - tail} 字）…\n\n${text.slice(text.length - tail)}`
}

export function renderConversation(conv: ParsedConversation, opts: { maxChars: number; perTurnChars?: number }): string {
  const perTurn = opts.perTurnChars ?? 6000
  const lines: string[] = []
  for (const t of conv.turns) {
    if (t.role === 'tool') {
      lines.push(`> 工具调用 ${t.text}`)
      continue
    }
    const label = t.role === 'user' ? '## 用户' : '## 助手'
    lines.push(`${label}${t.timestamp ? ` (${t.timestamp})` : ''}\n\n${truncateMiddle(t.text, perTurn)}`)
  }
  return truncateMiddle(lines.join('\n\n'), opts.maxChars)
}

/** Summary used when no model is available: what was asked and what came back. */
export function extractiveSummary(conv: ParsedConversation, artifacts: string[]): string {
  const parts: string[] = []
  if (conv.firstUserText) parts.push(`### 任务\n\n${truncateMiddle(conv.firstUserText, 1200)}`)
  if (conv.lastAssistantText) parts.push(`### 结论\n\n${truncateMiddle(conv.lastAssistantText, 2500)}`)
  if (conv.toolNames.length > 0) parts.push(`### 使用的工具\n\n${conv.toolNames.join('、')}`)
  if (artifacts.length > 0) parts.push(`### 产出文件\n\n${artifacts.map(a => `- ${a}`).join('\n')}`)
  return parts.join('\n\n') || '（会话没有可总结的内容）'
}
