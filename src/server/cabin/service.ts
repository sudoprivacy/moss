import { randomUUID } from 'crypto'
import { createInterface } from 'readline'
import type net from 'net'
import type { CabinConfig, CabinMessage, CabinPassengerContext } from './types.js'
import { buildConversationKey } from './auth.js'
import { CabinStore } from './store.js'
import type { RuntimeService } from '../runtimeService.js'

type FetchLike = typeof fetch

export type CabinServicesOptions = {
  config: CabinConfig
  store: CabinStore
  runtime?: RuntimeService
  createMossSession?: (context: CabinPassengerContext) => Promise<string>
  fetchImpl?: FetchLike
}

export class CabinServices {
  private readonly fetchImpl: FetchLike

  constructor(private readonly options: CabinServicesOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async ensureConversation(context: CabinPassengerContext) {
    const key = buildConversationKey(context)
    const existing = this.options.store.getConversationByKey(key)
    if (existing) return existing
    const mossSessionId = this.options.createMossSession
      ? await this.options.createMossSession(context)
      : randomUUID()
    return this.options.store.createConversation({ ...context, mossSessionId })
  }

  async transcribe(input: {
    audio: Buffer
    filename: string
    contentType?: string
    language?: string
  }): Promise<{ text: string; elapsedMs: number }> {
    const start = Date.now()
    const body = new FormData()
    body.set('model', this.options.config.asrModel)
    body.set(
      'file',
      new Blob([input.audio], { type: input.contentType || 'audio/wav' }),
      input.filename || 'audio.wav',
    )
    if (input.language) body.set('language', input.language)
    body.set('response_format', 'json')

    const response = await this.fetchImpl(this.options.config.asrUrl, {
      method: 'POST',
      body,
      headers: this.options.config.asrApiKey
        ? { authorization: `Bearer ${this.options.config.asrApiKey}` }
        : undefined,
    })
    if (!response.ok) {
      throw new Error(`ASR request failed: ${response.status} ${await response.text()}`)
    }
    const payload = await response.json() as { text?: unknown }
    const text = typeof payload.text === 'string' ? payload.text.trim() : ''
    if (!text) throw new Error('ASR response missing text')
    return { text, elapsedMs: Date.now() - start }
  }

  async speech(text: string): Promise<{ audio: Buffer; contentType: string; elapsedMs: number }> {
    const start = Date.now()
    const response = await this.fetchImpl(this.options.config.ttsUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.config.ttsApiKey
          ? { authorization: `Bearer ${this.options.config.ttsApiKey}` }
          : {}),
      },
      body: JSON.stringify({
        model: this.options.config.ttsModel,
        voice: this.options.config.ttsVoice,
        input: text,
        response_format: 'wav',
        language: this.options.config.ttsLanguage,
      }),
    })
    if (!response.ok) {
      throw new Error(`TTS request failed: ${response.status} ${await response.text()}`)
    }
    const arrayBuffer = await response.arrayBuffer()
    return {
      audio: Buffer.from(arrayBuffer),
      contentType: response.headers.get('content-type') || 'audio/wav',
      elapsedMs: Date.now() - start,
    }
  }

  async generateReply(input: {
    context: CabinPassengerContext
    messages: CabinMessage[]
    text: string
  }): Promise<string> {
    const history = input.messages
      .filter(message => message.role === 'user' || message.role === 'assistant')
      .slice(-12)
      .map(message => ({ role: message.role, content: message.content }))
    const systemContent = [
      '你是飞机客舱 AI 乘务员。回答要简短、礼貌、明确。',
      '对于座椅、灯光、温度、服务物品等请求，先确认已收到并说明将处理。',
      '不要编造真实设备执行结果。',
      `当前上下文: ${JSON.stringify({
        flight_id: input.context.flightId,
        flight_date: input.context.flightDate,
        seat_id: input.context.seatId,
        language: input.context.language,
      })}`,
    ].join('\n')

    const response = await this.fetchImpl(`${this.options.config.llmBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.config.llmApiKey
          ? { authorization: `Bearer ${this.options.config.llmApiKey}` }
          : {}),
      },
      body: JSON.stringify({
        model: this.options.config.llmModel,
        messages: [
          {
            role: 'system',
            content: systemContent,
          },
          ...history,
        ],
        temperature: 0.2,
        stream: false,
      }),
    })
    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.status} ${await response.text()}`)
    }
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: unknown } }>
    }
    const content = payload.choices?.[0]?.message?.content
    return typeof content === 'string' && content.trim()
      ? content.trim()
      : '收到，我会为您处理。'
  }

  async generateReplyWithMossSession(input: {
    mossSessionId: string
    text: string
    timeoutMs?: number
    onDelta?: (text: string) => void
  }): Promise<string> {
    if (!this.options.runtime) {
      throw new Error('RuntimeService is required for moss session replies')
    }
    const ready = await this.options.runtime.ensureSessionReady(input.mossSessionId)
    const socket = await this.options.runtime.connectToAttempt(ready.attempt)
    return await sendPromptToRunnerSocket(socket, input.text, input.timeoutMs ?? 120_000, input.onDelta)
  }
}

function formatUserMessage(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: text,
    },
    parent_tool_use_id: null,
    session_id: '',
    uuid: randomUUID(),
  })
}

function extractAssistantText(line: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return ''
  }
  if (!parsed || typeof parsed !== 'object') return ''
  const event = parsed as {
    type?: string
    message?: { content?: unknown }
  }
  if (event.type !== 'assistant') return ''
  const content = event.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (!block || typeof block !== 'object') return ''
        const text = (block as { text?: unknown }).text
        return typeof text === 'string' ? text : ''
      })
      .join('')
  }
  return ''
}

function sendPromptToRunnerSocket(
  socket: net.Socket,
  text: string,
  timeoutMs: number,
  onDelta?: (text: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    let assistantText = ''
    const rl = createInterface({ input: socket })

    const cleanup = (): void => {
      rl.close()
      socket.destroy()
    }
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      fn()
    }
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Moss session reply timed out after ${timeoutMs}ms`)))
    }, timeoutMs)

    rl.on('line', line => {
      let envelope: unknown
      try {
        envelope = JSON.parse(line)
      } catch {
        return
      }
      if (!envelope || typeof envelope !== 'object') return
      const message = envelope as { type?: string; line?: string; message?: string }
      if (message.type === 'stderr') return
      if (message.type === 'error') {
        finish(() => reject(new Error(message.message || 'Moss session runner error')))
        return
      }
      if (message.type !== 'stdout' || typeof message.line !== 'string') return

      const textDelta = extractAssistantText(message.line)
      if (textDelta) {
        assistantText += textDelta
        onDelta?.(textDelta)
      }

      try {
        const inner = JSON.parse(message.line) as { type?: string; status?: string }
        if (inner.type === 'result') {
          if (inner.status === 'success') {
            finish(() => resolve(assistantText.trim() || '收到，我会为您处理。'))
          } else {
            finish(() => reject(new Error(`Moss session result status: ${inner.status || 'unknown'}`)))
          }
        }
      } catch {
        // ignore non-JSON stdout
      }
    })

    socket.once('error', error => {
      finish(() => reject(error))
    })
    socket.once('close', () => {
      if (!settled) {
        finish(() => reject(new Error('Moss session runner socket closed before result')))
      }
    })

    socket.write(`${JSON.stringify({ type: 'stdin', data: `${formatUserMessage(text)}\n` })}\n`)
  })
}
