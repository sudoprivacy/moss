import { randomUUID } from 'crypto'
import { createInterface } from 'readline'
import type net from 'net'
import type { CabinConfig, CabinMessage, CabinPassengerContext, CabinToolCall } from './types.js'
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

  inferToolCall(input: {
    context: CabinPassengerContext
    text: string
  }): { intent: string; slots: Record<string, unknown>; toolCall: CabinToolCall } | null {
    const text = input.text.toLowerCase()
    const seatId = input.context.seatId || ''
    const seatContext = buildSeatToolArguments(input.context)
    const hasAny = (...words: string[]) => words.some(word => text.includes(word.toLowerCase()))

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
    return await sendPromptToRunnerSocket(
      socket,
      formatCabinSessionPrompt(input.context, input.text),
      input.timeoutMs ?? 120_000,
      input.onDelta,
      shouldSuppressPreToolText(input.text),
    )
  }
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

function shouldSuppressPreToolText(text: string): boolean {
  return /小桌板|桌板|tray|灯|light|顶灯|座椅|靠背|坐垫|通风|加热|按摩|seat|温度|temperature|空调|air\s*condition|场景|scene|生理|健康|采集/i.test(text)
}

function sanitizeCabinHardwareReply(text: string): string {
  return text
    .replace(/^(?:现在|正在)?(?:调用|执行)[\s\S]*?(?:：|:\s*)/, '')
    .replace(/^(?:好的，)?我来帮您(?:打开|关闭|调整)?(?:小桌板|桌板)?[。！!，,\s]*/u, '')
    .replace(/^(?:好的，)?我来为您(?:打开|关闭|调整)?(?:小桌板|桌板)?[。！!，,\s]*/u, '')
    .trim()
}

function buildAcceptedHardwareReply(text: string): string {
  if (/阅读灯|读书灯|reading\s*light/i.test(text)) {
    if (/关闭|关上|关掉|close|off/i.test(text)) return '已为您下发关闭阅读灯的指令，请稍候。'
    if (/亮|brightness|调亮|调暗|暗一点/i.test(text)) return '已为您下发调整阅读灯亮度的指令，请稍候。'
    if (/打开|开启|open|on/i.test(text)) return '已为您下发打开阅读灯的指令，请稍候。'
    return '已为您下发阅读灯控制指令，请稍候。'
  }
  if (/小桌板|桌板|tray/i.test(text)) {
    if (/关闭|关上|合上|收起|close/i.test(text)) {
      return '已为您下发关闭小桌板的指令，请稍候。'
    }
    if (/打开|开启|展开|open/i.test(text)) {
      return '已为您下发打开小桌板的指令，请稍候。'
    }
    return '已为您下发小桌板控制指令，请稍候。'
  }
  if (/顶灯|客舱灯|ceiling|cabin light/i.test(text)) {
    return '已为您下发客舱灯光控制指令，请稍候。'
  }
  if (/场景|scene|登机|巡航|休息|睡眠/i.test(text)) {
    return '已为您下发客舱场景控制指令，请稍候。'
  }
  if (/座椅|靠背|坐垫|通风|加热|按摩|seat|ventilation|heating|massage/i.test(text)) {
    return '已为您下发座椅控制指令，请稍候。'
  }
  if (/生理|健康|采集|health/i.test(text)) {
    return '已为您下发生理检测控制指令，请稍候。'
  }
  return ''
}

function shouldUseAcceptedHardwareReply(text: string): boolean {
  if (!text.trim()) return true
  return /已(?:经)?(?:打开|关闭|完成|调好|处理好)|调用|执行|脚本|接口|技能|工具/u.test(text)
}

function sendPromptToRunnerSocket(
  socket: net.Socket,
  text: string,
  timeoutMs: number,
  onDelta?: (text: string) => void,
  suppressPreToolText = false,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    let assistantText = ''
    let pendingText = ''
    let sawToolUse = false
    let releasedDeltas = !suppressPreToolText
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
        if (suppressPreToolText) {
          pendingText += textDelta
        } else if (releasedDeltas) {
          assistantText += textDelta
          onDelta?.(textDelta)
        } else {
          pendingText += textDelta
        }
      }

      try {
        const inner = JSON.parse(message.line) as { type?: string; status?: string }
        if (inner.type === 'tool_use') {
          sawToolUse = true
          if (suppressPreToolText) {
            pendingText = ''
          }
        }
        if (inner.type === 'result') {
          if (inner.status === 'success') {
            if (suppressPreToolText) {
              const cleanedText = sanitizeCabinHardwareReply(pendingText)
              const acceptedHardwareReply = sawToolUse ? buildAcceptedHardwareReply(text) : ''
              assistantText = acceptedHardwareReply && shouldUseAcceptedHardwareReply(cleanedText)
                ? acceptedHardwareReply
                : cleanedText || acceptedHardwareReply || pendingText.trim()
              if (assistantText) {
                onDelta?.(assistantText)
              }
            } else if (!releasedDeltas && pendingText) {
              assistantText += pendingText
              onDelta?.(pendingText)
            }
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
