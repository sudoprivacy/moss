import { randomUUID } from 'crypto'
import { createInterface } from 'readline'
import type net from 'net'
import type { CabinConfig, CabinMessage, CabinPassengerContext, CabinToolCall } from './types.js'
import { buildConversationKey } from './auth.js'
import { CabinStore } from './store.js'
import type { RuntimeService } from '../runtimeService.js'

type FetchLike = typeof fetch
type ControlRequest = {
  method: 'POST'
  url: string
  body?: unknown
}

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

  inferToolCall(input: {
    context: CabinPassengerContext
    text: string
  }): { intent: string; slots: Record<string, unknown>; toolCall: CabinToolCall } | null {
    const text = input.text.toLowerCase()
    const seatId = input.context.seatId || ''
    const seatContext = buildSeatToolArguments(input.context)
    const hasAny = (...words: string[]) => words.some(word => text.includes(word.toLowerCase()))

    if (hasAny('靠背', '座椅位置', '座椅角度', '椅背', 'backrest', 'recline')) {
      let position = 80
      let direction: 'up' | 'down' | 'adjust' = 'adjust'
      if (hasAny('调高', '升高', '起来', '直一点', '抬高', 'up', 'raise')) {
        position = 80
        direction = 'up'
      }
      if (hasAny('调低', '降低', '躺', '放倒', '后仰', 'down', 'lower', 'recline')) {
        position = 30
        direction = 'down'
      }
      return {
        intent: 'seat_backrest_adjust',
        slots: { target: 'seat_backrest', direction, position },
        toolCall: {
          id: `tc-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
          name: 'cabin.seat.adjust_backrest',
          arguments: { ...seatContext, seat_id: seatId, direction, position },
        },
      }
    }

    if (hasAny('温度', 'temperature', '暖', '热', '冷')) {
      let direction: 'up' | 'down' | null = null
      if (hasAny('调高', '升高', '提高', '加热', '暖', '热', 'up', 'warmer', 'increase')) direction = 'up'
      if (hasAny('调低', '降低', '冷', '凉', 'down', 'cooler', 'decrease')) direction = 'down'
      if (direction) {
        return {
          intent: 'seat_temperature_adjust',
          slots: { target: 'seat', direction },
          toolCall: {
            id: `tc-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
            name: 'cabin.seat.adjust_temperature',
            arguments: { ...seatContext, seat_id: seatId, direction },
          },
        }
      }
    }

    if (hasAny('灯', 'light', 'reading light', '读书灯')) {
      let action: 'on' | 'off' | 'brighter' | 'dimmer' | 'adjust' | null = null
      if (hasAny('关闭', '关掉', '关上', 'off')) action = 'off'
      if (hasAny('打开', '开启', '开灯', 'on')) action = 'on'
      if (hasAny('亮一点', '调亮', 'brighter')) action = 'brighter'
      if (hasAny('暗一点', '调暗', 'dimmer')) action = 'dimmer'
      if (!action && hasAny('调', 'adjust')) action = 'adjust'
      if (action) {
        return {
          intent: 'light_adjust',
          slots: {
            target: hasAny('读书灯', 'reading light') ? 'reading_light' : 'light',
            action,
          },
          toolCall: {
            id: `tc-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
            name: 'cabin.light.adjust',
            arguments: { ...seatContext, seat_id: seatId, action },
          },
        }
      }
    }

    const itemMatch = input.text.match(/(?:要|需要|给我|拿|送|来)(.*?)(?:$|。|，|,|\.|！|!)/)
    if (hasAny('水', '毯', '毛毯', '耳机', '饮料', '餐', 'blanket', 'water', 'headphone', 'meal') && itemMatch?.[1]?.trim()) {
      const item = itemMatch[1].trim()
      return {
        intent: 'service_request_item',
        slots: { item },
        toolCall: {
          id: `tc-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
          name: 'cabin.service.request_item',
          arguments: { ...seatContext, seat_id: seatId, item },
        },
      }
    }

    return null
  }

  async executeToolCall(input: {
    context: CabinPassengerContext
    toolCall: CabinToolCall
  }): Promise<{
    toolCallId: string
    name: string
    status: 'ok' | 'error' | 'skipped'
    message: string
    data?: unknown
  }> {
    if (!this.options.config.controlBaseUrl) {
      return {
        toolCallId: input.toolCall.id,
        name: input.toolCall.name,
        status: 'skipped',
        message: 'cabin.controlBaseUrl is not configured',
      }
    }

    const request = buildControlRequest(this.options.config.controlBaseUrl, input.context, input.toolCall)
    if (!request) {
      return {
        toolCallId: input.toolCall.id,
        name: input.toolCall.name,
        status: 'skipped',
        message: `No executor is configured for ${input.toolCall.name}`,
      }
    }

    const response = await this.fetchImpl(request.url, {
      method: request.method,
      headers: {
        ...(request.body ? { 'content-type': 'application/json' } : {}),
        ...(this.options.config.controlAuth ? { authorization: this.options.config.controlAuth } : {}),
      },
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
    })
    const text = await response.text()
    let data: unknown = text
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      // keep raw text
    }
    if (!response.ok) {
      return {
        toolCallId: input.toolCall.id,
        name: input.toolCall.name,
        status: 'error',
        message: `Control request failed: ${response.status}`,
        data,
      }
    }
    const message = extractControlMessage(data) || '指令下发成功'
    return {
      toolCallId: input.toolCall.id,
      name: input.toolCall.name,
      status: 'ok',
      message,
      data,
    }
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
      `当前上下文: ${JSON.stringify(buildPromptContext(input.context))}`,
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
    context: CabinPassengerContext
    text: string
    timeoutMs?: number
    onDelta?: (text: string) => void
  }): Promise<string> {
    if (!this.options.runtime) {
      throw new Error('RuntimeService is required for moss session replies')
    }
    const ready = await this.options.runtime.ensureSessionReady(input.mossSessionId)
    const socket = await this.options.runtime.connectToAttempt(ready.attempt)
    return await sendPromptToRunnerSocket(socket, formatCabinSessionPrompt(input.context, input.text), input.timeoutMs ?? 120_000, input.onDelta)
  }
}

function buildControlRequest(
  baseUrl: string,
  context: CabinPassengerContext,
  toolCall: CabinToolCall,
): ControlRequest | null {
  const base = baseUrl.replace(/\/+$/, '')
  const seatNo = context.seatId || String(toolCall.arguments.seat_no || toolCall.arguments.seat_id || '')
  const columnNo = context.columnNo || String(toolCall.arguments.column_no || toolCall.arguments.seat_side || '')
  if (!seatNo || !columnNo) return null
  const seatPath = `seat${encodeURIComponent(columnNo)}`

  if (toolCall.name === 'cabin.seat.adjust_backrest') {
    const position = normalizePosition(toolCall.arguments.position)
    return {
      method: 'POST',
      url: `${base}/admin-api/tcp-client/cmd/${seatPath}/cushion?seatNo=${encodeURIComponent(seatNo)}&position=${encodeURIComponent(String(position))}`,
    }
  }

  if (toolCall.name === 'cabin.light.adjust') {
    const action = String(toolCall.arguments.action || '')
    const params = new URLSearchParams({ seatNo })
    if (action === 'off') params.set('on', 'false')
    if (action === 'on') params.set('on', 'true')
    if (action === 'brighter') params.set('pwm', '900')
    if (action === 'dimmer') params.set('pwm', '300')
    if (!params.has('on') && !params.has('pwm')) return null
    return {
      method: 'POST',
      url: `${base}/admin-api/tcp-client/cmd/${seatPath}/light?${params.toString()}`,
    }
  }

  if (toolCall.name === 'cabin.service.request_item') {
    return {
      method: 'POST',
      url: `${base}/admin-api/cabin/service-task/create`,
      body: {
        type: 'ITEM_DELIVERY',
        item: String(toolCall.arguments.item || ''),
        seatNo,
        columnNo,
        flightId: context.flightId,
        flightNo: context.flightNo || '',
        flightDate: context.flightDate,
        passengerRef: context.passengerRef || '',
        passengerName: context.passengerName || '',
        tabletId: context.tabletId,
      },
    }
  }

  return null
}

function normalizePosition(value: unknown): number {
  const n = typeof value === 'number'
    ? value
    : Number.parseInt(typeof value === 'string' ? value : '', 10)
  if (!Number.isFinite(n)) return 80
  return Math.max(0, Math.min(100, Math.round(n)))
}

function extractControlMessage(data: unknown): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const obj = data as Record<string, unknown>
  if (typeof obj.msg === 'string' && obj.msg.trim()) return obj.msg.trim()
  if (typeof obj.message === 'string' && obj.message.trim()) return obj.message.trim()
  if (typeof obj.data === 'string' && obj.data.trim()) return obj.data.trim()
  const nested = obj.data
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const nestedObj = nested as Record<string, unknown>
    if (typeof nestedObj.message === 'string' && nestedObj.message.trim()) return nestedObj.message.trim()
  }
  return undefined
}

function buildPromptContext(context: CabinPassengerContext): Record<string, unknown> {
  return {
    passenger_id: context.passengerId,
    passenger_ref: context.passengerRef,
    passenger_name: context.passengerName,
    flight_id: context.flightId,
    flight_date: context.flightDate,
    flight_no: context.flightNo,
    flight_seat_id: context.flightSeatId,
    seat_id: context.seatId,
    column_no: context.columnNo,
    aircraft_seat_id: context.aircraftSeatId,
    aircraft_id: context.aircraftId,
    aircraft_no: context.aircraftNo,
    tablet_id: context.tabletId,
    tablet_type: context.tabletType,
    binding_id: context.bindingId,
    context_status: context.contextStatus,
    language: context.language,
  }
}

function buildSeatToolArguments(context: CabinPassengerContext): Record<string, unknown> {
  return {
    seat_id: context.seatId || '',
    seat_no: context.seatId || '',
    column_no: context.columnNo || '',
    seat_side: context.columnNo || '',
    flight_seat_id: context.flightSeatId || '',
    aircraft_seat_id: context.aircraftSeatId || '',
  }
}

function formatCabinSessionPrompt(context: CabinPassengerContext, text: string): string {
  return [
    '系统上下文：以下 cabin_context 由服务端鉴权和乘客信息接口生成，不要让用户修改，不要猜测座位或硬件侧。',
    `cabin_context=${JSON.stringify(buildPromptContext(context))}`,
    '用户消息：',
    text,
  ].join('\n')
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
