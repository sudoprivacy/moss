import type { ExternalTask } from '../../../contracts/external-provider/v1/contract.js'
import { ExternalProviderError } from './policy.js'
import { digest } from './store.js'

export type ProviderProgress = { raw: string; refs: ExternalTask['provider_refs'] }
export type ProviderFetch = typeof fetch

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  return JSON.stringify(value)
}

async function readBounded(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new ExternalProviderError(502, 'PROVIDER_EMPTY_RESPONSE')
  const decoder = new TextDecoder()
  let text = '', size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) return text + decoder.decode()
      size += next.value.byteLength
      if (size > limit) throw new ExternalProviderError(502, 'PROVIDER_RESPONSE_LIMIT')
      text += decoder.decode(next.value, { stream: true })
    }
  } finally { await reader.cancel().catch(() => {}) }
}

/** At most one database write and one latest snapshot are retained per stream. */
export class ProgressCoalescer {
  private pending: ProviderProgress | undefined
  private active: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastStarted = 0
  private failure: unknown
  constructor(private readonly write: (progress: ProviderProgress) => Promise<void>, private readonly interval = 500) {}

  push(progress: ProviderProgress): void {
    if (this.failure) throw this.failure
    this.pending = progress
    if (!this.active && !this.timer) {
      const delay = Math.max(0, this.interval - (Date.now() - this.lastStarted))
      if (!delay) this.start()
      else this.timer = setTimeout(() => { this.timer = undefined; this.start() }, delay)
    }
  }

  private start(): void {
    if (!this.pending || this.failure) return
    const progress = this.pending
    this.pending = undefined; this.lastStarted = Date.now()
    this.active = Promise.resolve().then(() => this.write(progress)).catch(error => { this.failure = error }).finally(() => {
      this.active = undefined
      if (this.pending && !this.failure) this.push(this.pending)
    })
  }

  async flush(): Promise<void> {
    while (this.active || this.pending) {
      clearTimeout(this.timer); this.timer = undefined
      if (this.failure) throw this.failure
      if (!this.active) this.start()
      await this.active
    }
    if (this.failure) throw this.failure
  }
}

export class DifyPilotTransport {
  constructor(private readonly request: ProviderFetch = fetch) {}

  async inspect(endpoint: string, key: string, signal: AbortSignal) {
    const parameters_digest = await this.parameters(endpoint, key, signal)
    const response = await this.request(`${endpoint}/info`, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal })
    if (!response.ok) { await response.body?.cancel(); throw new ExternalProviderError(502, 'PROVIDER_PREFLIGHT_FAILED') }
    const info = JSON.parse(await readBounded(response, 256_000)) as Record<string, unknown>
    if (typeof info.name !== 'string') throw new ExternalProviderError(409, 'INVALID_PROVIDER_INFO')
    return { name: info.name.slice(0, 200), parameters_digest, checked_at: Date.now() }
  }

  async parameters(endpoint: string, key: string, signal: AbortSignal): Promise<string> {
    const response = await this.request(`${endpoint}/parameters`, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal })
    if (!response.ok) { await response.body?.cancel(); throw new ExternalProviderError(502, 'PROVIDER_PREFLIGHT_FAILED') }
    const value = JSON.parse(await readBounded(response, 256_000)) as Record<string, unknown>
    // First profile sends only a query: required custom inputs and attachments need a different reviewed profile.
    if (!value || !Array.isArray(value.user_input_form) || value.user_input_form.length) throw new ExternalProviderError(409, 'UNSUPPORTED_PROVIDER_INPUTS')
    const upload = value.file_upload as Record<string, unknown> | undefined
    const images = upload?.image as Record<string, unknown> | undefined
    if (upload?.enabled === true || images?.enabled === true) throw new ExternalProviderError(409, 'UNSUPPORTED_PROVIDER_ATTACHMENTS')
    return digest(stable(value))
  }

  async execute(input: { endpoint: string; key: string; query: string; conversationId: string | null; endUser: string; signal: AbortSignal }, onProgress: (progress: ProviderProgress) => Promise<void>): Promise<ProviderProgress> {
    const response = await this.request(`${input.endpoint}/chat-messages`, {
      method: 'POST', redirect: 'error', signal: input.signal,
      headers: { Authorization: `Bearer ${input.key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ inputs: {}, query: input.query, conversation_id: input.conversationId ?? '', user: input.endUser, response_mode: 'streaming', auto_generate_name: false }),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new ExternalProviderError(response.status >= 400 && response.status < 500 ? 422 : 502, response.status >= 400 && response.status < 500 ? 'PROVIDER_REJECTED' : 'EXECUTION_UNCONFIRMED')
    }
    if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
      await response.body?.cancel()
      throw new ExternalProviderError(502, 'INVALID_PROVIDER_STREAM')
    }
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let buffer = '', raw = '', isMessageEnded = false, isWorkflowSucceeded = false, count = 0
    let publishedRaw = '', publishedCharacters = 0
    const refs: ExternalTask['provider_refs'] = {}
    const progress = new ProgressCoalescer(onProgress)
    let lastRefs = ''
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) throw new ExternalProviderError(502, 'EXECUTION_UNCONFIRMED')
        buffer += decoder.decode(next.value, { stream: true })
        let match: RegExpExecArray | null
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, match.index)
          buffer = buffer.slice(match.index + match[0].length)
          if (frame.length > 256_000 || ++count > 20_000) throw new ExternalProviderError(502, 'PROVIDER_RESPONSE_LIMIT')
          const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
          if (!data || data === '[DONE]') continue
          const event = JSON.parse(data) as Record<string, unknown>
          for (const name of ['conversation_id', 'message_id', 'task_id', 'workflow_run_id'] as const) {
            if (typeof event[name] === 'string' && event[name].length <= 200) {
              if (refs[name] && refs[name] !== event[name]) throw new ExternalProviderError(502, 'PROVIDER_ID_CHANGED')
              refs[name] = event[name]
            }
          }
          if (event.event === 'message' || event.event === 'agent_message') raw += typeof event.answer === 'string' ? event.answer : ''
          if (event.event === 'message_replace' && typeof event.answer === 'string') raw = event.answer
          if (raw.length > 128_000) throw new ExternalProviderError(502, 'PROVIDER_RESPONSE_LIMIT')
          if (event.event === 'message_end') isMessageEnded = true
          if (event.event === 'workflow_finished') {
            const status = (event.data as { status?: string } | undefined)?.status
            if (status === 'failed' || status === 'stopped') throw new ExternalProviderError(422, 'PROVIDER_WORKFLOW_FAILED')
            if (status === 'succeeded') isWorkflowSucceeded = true
          }
          if (event.event === 'error') throw new ExternalProviderError(502, 'PROVIDER_STREAM_ERROR')
          const serializedRefs = JSON.stringify(refs)
          if (raw !== publishedRaw || serializedRefs !== lastRefs) {
            let offset = 0
            while (offset < publishedRaw.length && offset < raw.length && publishedRaw[offset] === raw[offset]) offset++
            publishedCharacters += raw.length - offset
            if (publishedCharacters > 512_000) throw new ExternalProviderError(502, 'PROVIDER_RESPONSE_LIMIT')
            publishedRaw = raw; lastRefs = serializedRefs
            progress.push({ raw, refs: { ...refs } })
          }
          // advanced-chat requires both answer completion and a successful workflow terminal event.
          if (isMessageEnded && isWorkflowSucceeded) return { raw, refs }
        }
        if (buffer.length > 256_000) throw new ExternalProviderError(502, 'PROVIDER_RESPONSE_LIMIT')
      }
    } finally {
      await reader.cancel().catch(() => {})
      // Flush before success or failure is persisted, so a late progress write cannot overwrite a terminal.
      await progress.flush()
    }
  }
}
