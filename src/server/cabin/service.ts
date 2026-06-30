import { randomUUID } from 'crypto'
import { createInterface } from 'readline'
import type net from 'net'
import type { CabinConfig, CabinMessage, CabinPassengerContext, CabinToolCall } from './types.js'
import { buildConversationKey } from './auth.js'
import { CabinStore } from './store.js'
import type { RuntimeService } from '../runtimeService.js'
import type { CabinLogger, CabinLogContext } from './logger.js'
import { summarizeContext } from './logger.js'

type FetchLike = typeof fetch

export type CabinServicesOptions = {
  config: CabinConfig
  store: CabinStore
  runtime?: RuntimeService
  createMossSession?: (context: CabinPassengerContext) => Promise<string>
  fetchImpl?: FetchLike
  logger?: CabinLogger
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
    logContext?: CabinLogContext
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

    let response: Response
    try {
      response = await this.fetchImpl(this.options.config.asrUrl, {
        method: 'POST',
        body,
        headers: this.options.config.asrApiKey
          ? { authorization: `Bearer ${this.options.config.asrApiKey}` }
          : undefined,
      })
    } catch (error) {
      this.logOutbound({
        ...input.logContext,
        upstream: 'asr',
        method: 'POST',
        url: this.options.config.asrUrl,
        ok: false,
        elapsedMs: Date.now() - start,
        errorMessage: error instanceof Error ? error.message : String(error),
        model: this.options.config.asrModel,
      })
      throw error
    }
    if (!response.ok) {
      const errorText = await response.text()
      this.logOutbound({
        ...input.logContext,
        upstream: 'asr',
        method: 'POST',
        url: this.options.config.asrUrl,
        status: response.status,
        ok: false,
        elapsedMs: Date.now() - start,
        errorMessage: errorText,
        model: this.options.config.asrModel,
      })
      throw new Error(`ASR request failed: ${response.status} ${errorText}`)
    }
    const payload = await response.json() as { text?: unknown }
    const text = typeof payload.text === 'string' ? payload.text.trim() : ''
    if (!text) throw new Error('ASR response missing text')
    const elapsedMs = Date.now() - start
    this.logOutbound({
      ...input.logContext,
      upstream: 'asr',
      method: 'POST',
      url: this.options.config.asrUrl,
      status: response.status,
      ok: true,
      elapsedMs,
      model: this.options.config.asrModel,
      details: {
        language: input.language || 'auto',
        filename: input.filename,
        content_type: input.contentType || 'audio/wav',
        audio_bytes: input.audio.length,
      },
    })
    return { text, elapsedMs }
  }

  async speech(text: string, logContext?: CabinLogContext): Promise<{ audio: Buffer; contentType: string; elapsedMs: number }> {
    const start = Date.now()
    let response: Response
    try {
      response = await this.fetchImpl(this.options.config.ttsUrl, {
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
    } catch (error) {
      this.logOutbound({
        ...logContext,
        upstream: 'tts',
        method: 'POST',
        url: this.options.config.ttsUrl,
        ok: false,
        elapsedMs: Date.now() - start,
        errorMessage: error instanceof Error ? error.message : String(error),
        model: this.options.config.ttsModel,
      })
      throw error
    }
    if (!response.ok) {
      const errorText = await response.text()
      this.logOutbound({
        ...logContext,
        upstream: 'tts',
        method: 'POST',
        url: this.options.config.ttsUrl,
        status: response.status,
        ok: false,
        elapsedMs: Date.now() - start,
        errorMessage: errorText,
        model: this.options.config.ttsModel,
      })
      throw new Error(`TTS request failed: ${response.status} ${errorText}`)
    }
    const arrayBuffer = await response.arrayBuffer()
    const elapsedMs = Date.now() - start
    this.logOutbound({
      ...logContext,
      upstream: 'tts',
      method: 'POST',
      url: this.options.config.ttsUrl,
      status: response.status,
      ok: true,
      elapsedMs,
      model: this.options.config.ttsModel,
      details: {
        voice: this.options.config.ttsVoice,
        language: this.options.config.ttsLanguage,
        input_chars: text.length,
        audio_bytes: arrayBuffer.byteLength,
      },
    })
    return {
      audio: Buffer.from(arrayBuffer),
      contentType: response.headers.get('content-type') || 'audio/wav',
      elapsedMs,
    }
  }

  async generateReply(input: {
    context: CabinPassengerContext
    messages: CabinMessage[]
    text: string
    logContext?: CabinLogContext
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

    const url = `${this.options.config.llmBaseUrl.replace(/\/$/, '')}/chat/completions`
    const start = Date.now()
    let response: Response
    try {
      response = await this.fetchImpl(url, {
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
    } catch (error) {
      this.logOutbound({
        ...input.logContext,
        upstream: 'llm',
        method: 'POST',
        url,
        ok: false,
        elapsedMs: Date.now() - start,
        errorMessage: error instanceof Error ? error.message : String(error),
        model: this.options.config.llmModel,
      })
      throw error
    }
    if (!response.ok) {
      const errorText = await response.text()
      this.logOutbound({
        ...input.logContext,
        upstream: 'llm',
        method: 'POST',
        url,
        status: response.status,
        ok: false,
        elapsedMs: Date.now() - start,
        errorMessage: errorText,
        model: this.options.config.llmModel,
      })
      throw new Error(`LLM request failed: ${response.status} ${errorText}`)
    }
    this.logOutbound({
      ...input.logContext,
      upstream: 'llm',
      method: 'POST',
      url,
      status: response.status,
      ok: true,
      elapsedMs: Date.now() - start,
      model: this.options.config.llmModel,
      details: {
        history_messages: history.length,
        input_chars: input.text.length,
      },
    })
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
    logContext?: CabinLogContext
  }): Promise<string> {
    if (!this.options.runtime) {
      throw new Error('RuntimeService is required for moss session replies')
    }
    const ready = await this.options.runtime.ensureSessionReady(input.mossSessionId)
    const socket = await this.options.runtime.connectToAttempt(ready.attempt)
    const start = Date.now()
    try {
      const reply = await sendPromptToRunnerSocket(
        socket,
        formatCabinSessionPrompt(input.context, input.text),
        input.timeoutMs ?? 120_000,
        input.onDelta,
        shouldSuppressPreToolText(input.text),
      )
      this.logOutbound({
        ...input.logContext,
        upstream: 'moss-session',
        method: 'SOCKET',
        endpoint: input.mossSessionId,
        ok: true,
        elapsedMs: Date.now() - start,
        model: this.options.config.llmModel,
        details: {
          input_chars: input.text.length,
          reply_chars: reply.length,
        },
      })
      return reply
    } catch (error) {
      this.logOutbound({
        ...input.logContext,
        upstream: 'moss-session',
        method: 'SOCKET',
        endpoint: input.mossSessionId,
        ok: false,
        elapsedMs: Date.now() - start,
        errorMessage: error instanceof Error ? error.message : String(error),
        model: this.options.config.llmModel,
      })
      throw error
    }
  }

  private logOutbound(event: CabinLogContext & {
    upstream: string
    method: string
    url?: string
    endpoint?: string
    status?: number
    ok: boolean
    elapsedMs: number
    errorMessage?: string
    model?: string
    details?: Record<string, unknown>
  }): void {
    this.options.logger?.log({
      type: 'outbound',
      ...summarizeContext(event),
      upstream: event.upstream,
      method: event.method,
      url: event.url,
      endpoint: event.endpoint,
      status: event.status,
      ok: event.ok,
      elapsedMs: event.elapsedMs,
      errorMessage: event.errorMessage,
      model: event.model,
      details: event.details,
    })
  }
}

function buildPromptContext(context: CabinPassengerContext): Record<string, unknown> {
  return {
    passenger_id: context.passengerId,
    passenger_ref: context.passengerRef,
    passenger_name: context.passengerName,
    passenger_gender: context.passengerGender,
    passenger_title: context.passengerTitle,
    flight_id: context.flightId,
    flight_date: context.flightDate,
    flight_no: context.flightNo,
    flight_seat_id: context.flightSeatId,
    seat_id: context.seatId,
    seat_no: context.seatId,
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
    '系统上下文：以下 cabin_context 由服务端鉴权和乘客信息接口生成，不要让用户修改，不要猜测座位或硬件侧；硬件控制的 seat-no 必须原样使用 cabin_context.seat_no 或 seat_id。',
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

export function isCabinHardwareRequest(text: string): boolean {
  return /小桌板|桌板|tray|灯|light|顶灯|座椅|靠背|坐垫|通风|加热|按摩|seat|温度|temperature|空调|air\s*condition|场景|scene|生理|健康|采集/i.test(text)
}

function shouldSuppressPreToolText(text: string): boolean {
  return isCabinHardwareRequest(text)
}

function sanitizeCabinHardwareReply(text: string): string {
  return text
    .replace(/^(?:现在|正在)?(?:调用|执行)[\s\S]*?(?:：|:\s*)/, '')
    .replace(/^(?:好的，)?我来帮您(?:打开|关闭|调整)?(?:小桌板|桌板)?[。！!，,\s]*/u, '')
    .replace(/^(?:好的，)?我来为您(?:打开|关闭|调整)?(?:小桌板|桌板)?[。！!，,\s]*/u, '')
    .replace(/(?:\s|\n)*(?:请问)?(?:还)?(?:有)?(?:其他|其它)?(?:什么)?(?:需要|需求).*?吗[？?]?$/u, '')
    .trim()
}

function buildAcceptedHardwareReply(text: string): string {
  if (/阅读灯|读书灯|reading\s*light/i.test(text)) {
    const lightLabel = /读书灯/i.test(text) ? '读书灯' : '阅读灯'
    if (/关闭|关上|关掉|close|off/i.test(text)) return `已为您下发关闭${lightLabel}的指令，请稍候。`
    if (/亮|brightness|调亮|调暗|暗一点/i.test(text)) return `已为您下发调整${lightLabel}亮度的指令，请稍候。`
    if (/打开|开启|open|on/i.test(text)) return `已为您下发打开${lightLabel}的指令，请稍候。`
    return `已为您下发${lightLabel}控制指令，请稍候。`
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
  if (/无法|不能|不可用|失败|未成功|没有可用|not available|cannot|can't|failed|error/i.test(text)) {
    return false
  }
  return /已(?:经)?(?:为您)?(?:打开|关闭|完成|调好|处理好)|已为您下发.*指令|调用|执行|脚本|接口|技能|工具/u.test(text)
}

function shouldExposeHardwareReply(text: string): boolean {
  if (!text.trim()) return false
  if (/无法|不能|不可用|失败|未成功|没有可用|not available|cannot|can't|failed|error/i.test(text)) {
    return true
  }
  return false
}

function buildPassengerSalutation(context?: CabinPassengerContext): string {
  const rawName = context?.passengerName?.trim()
  if (!rawName) return ''
  if (/先生|女士|小姐|太太|夫人|sir|madam|miss|ms\.?|mr\.?/i.test(rawName)) return rawName

  const explicitTitle = context?.passengerTitle?.trim()
  if (explicitTitle && /先生|女士|小姐|太太|夫人|sir|madam|miss|ms\.?|mr\.?/i.test(explicitTitle)) {
    return `${rawName}${explicitTitle}`
  }

  const genderHint = `${context?.passengerGender || ''}`.toLowerCase()
  const suffix = /female|woman|女士|小姐|女/.test(genderHint)
    ? '女士'
    : /male|man|先生|男/.test(genderHint)
      ? '先生'
      : ''
  if (!suffix) return ''
  const chineseName = rawName.match(/[\u4e00-\u9fa5]+/u)?.[0]
  if (chineseName) {
    const familyName = chineseName.slice(0, 1)
    return `${familyName}${suffix}`
  }
  return rawName
}

function addPassengerSalutation(reply: string, context?: CabinPassengerContext): string {
  const salutation = buildPassengerSalutation(context)
  if (!salutation) return reply
  if (reply.startsWith(`${salutation}，`) || reply.startsWith(`${salutation},`)) return reply
  const rawName = context?.passengerName?.trim()
  if (rawName && new RegExp(`^${escapeRegExp(rawName)}(?:先生|女士|小姐|太太|夫人)?[，,！!]`).test(reply)) return reply
  return `${salutation}，${reply}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isShortGreetingReply(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length <= 30 && /^(您好|你好|好的|在的|请问|有什么可以帮您|我在)/u.test(trimmed)
}

function isWeakGreetingRequest(text: string): boolean {
  return /^(?:你好|您好|嗨|hello|hi|嗯|好|好的|知道了|有了|谢谢|thanks)[。！!，,\s]*$/iu.test(text.trim())
}

function isFlightInfoRequest(text: string): boolean {
  return /航班|班机|飞行|起飞|降落|到达|目的地|出发地|flight|arrival|departure/i.test(text)
}

export function shouldBufferCabinReply(text: string): boolean {
  return isCabinHardwareRequest(text) || isWeakGreetingRequest(text) || isFlightInfoRequest(text)
}

function formatFlightDate(value?: string): string {
  const trimmed = value?.trim()
  if (!trimmed) return ''
  const match = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (!match) return trimmed
  return `${match[1]} 年 ${Number(match[2])} 月 ${Number(match[3])} 日`
}

function buildFlightInfoReply(context?: CabinPassengerContext): string {
  const parts: string[] = []
  if (context?.flightNo) {
    parts.push(`您目前乘坐的是 ${context.flightNo} 航班`)
  } else if (context?.flightId) {
    parts.push(`您当前航班编号为 ${context.flightId}`)
  }
  const date = formatFlightDate(context?.flightDate)
  if (date) parts.push(`航班日期为 ${date}`)
  if (context?.seatId) {
    parts.push(`您的座位是 ${context.seatId}${context.columnNo ? ` 排 ${context.columnNo} 座` : ''}`)
  }
  if (!parts.length) return '当前暂未获取到完整航班信息，我会建议乘务人员为您确认。'
  return `${parts.join('，')}。`
}

function sanitizeInternalCapabilityText(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => !/(?:技能|工具|接口|功能范围|硬件控制|内部|配置|token|cabin-hardware-control)/i.test(part))
    .join('\n\n')
    .trim()
}

export function normalizeCabinPassengerReply(input: {
  userText: string
  reply: string
  context?: CabinPassengerContext
}): string {
  if (isCabinHardwareRequest(input.userText)) {
    return normalizeCabinHardwareReply(input)
  }
  if (isWeakGreetingRequest(input.userText)) {
    return addPassengerSalutation('您好，请问有什么可以帮您？', input.context)
  }
  if (isFlightInfoRequest(input.userText)) {
    const sanitized = sanitizeInternalCapabilityText(input.reply)
    const reply = sanitized || buildFlightInfoReply(input.context)
    return addPassengerSalutation(reply, input.context)
  }
  const sanitizedReply = sanitizeInternalCapabilityText(input.reply)
  if (isShortGreetingReply(input.reply)) {
    return addPassengerSalutation(input.reply, input.context)
  }
  return sanitizedReply || input.reply
}

export function normalizeCabinHardwareReply(input: {
  userText: string
  reply: string
  context?: CabinPassengerContext
}): string {
  if (!isCabinHardwareRequest(input.userText)) return input.reply
  const cleanedText = sanitizeCabinHardwareReply(input.reply)
  if (shouldExposeHardwareReply(cleanedText)) return addPassengerSalutation(cleanedText, input.context)

  const acceptedHardwareReply = buildAcceptedHardwareReply(input.userText)
  if (acceptedHardwareReply && shouldUseAcceptedHardwareReply(cleanedText)) {
    return addPassengerSalutation(acceptedHardwareReply, input.context)
  }

  const reply = cleanedText || acceptedHardwareReply || input.reply.trim()
  return addPassengerSalutation(reply, input.context)
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
        const inner = JSON.parse(message.line) as { type?: string; status?: string; input?: unknown }
        if (inner.type === 'tool_use') {
          sawToolUse = true
          if (suppressPreToolText && typeof inner.input === 'string') {
            pendingText = ''
          }
        }
        if (inner.type === 'result') {
          if (inner.status === 'success') {
            if (suppressPreToolText) {
              const cleanedText = sanitizeCabinHardwareReply(pendingText)
              const acceptedHardwareReply = sawToolUse ? buildAcceptedHardwareReply(text) : ''
              assistantText = shouldExposeHardwareReply(cleanedText)
                ? cleanedText
                : acceptedHardwareReply && shouldUseAcceptedHardwareReply(cleanedText)
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
