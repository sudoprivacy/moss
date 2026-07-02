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

type CabinHardwareRoute = {
  intent: string
  slots: Record<string, unknown>
  toolCall: CabinToolCall
  command: string
  label: string
  path: string
  params: Record<string, string | number | boolean>
}

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

  routeHardwareControl(input: {
    context: CabinPassengerContext
    text: string
  }): CabinHardwareRoute | null {
    if (!this.options.config.controlBaseUrl) return null
    return buildHardwareRoute(input.context, input.text)
  }

  async executeHardwareControl(input: {
    route: CabinHardwareRoute
    logContext?: CabinLogContext
  }): Promise<{ intent: string; slots: Record<string, unknown>; toolCall: CabinToolCall; reply: string }> {
    const baseUrl = this.options.config.controlBaseUrl?.replace(/\/+$/, '')
    if (!baseUrl) {
      return {
        intent: input.route.intent,
        slots: input.route.slots,
        toolCall: input.route.toolCall,
        reply: '当前暂时无法连接客舱设备控制服务，请稍后再试。',
      }
    }

    const url = new URL(`${baseUrl}${input.route.path}`)
    for (const [key, value] of Object.entries(input.route.params)) {
      url.searchParams.set(key, String(value))
    }

    const start = Date.now()
    let response: Response
    let bodyText = ''
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.options.config.controlTimeoutMs ?? 10_000)
      try {
        response = await this.fetchImpl(url, {
          method: 'POST',
          headers: this.options.config.controlAuth
            ? { authorization: this.options.config.controlAuth }
            : undefined,
          signal: controller.signal,
        })
        bodyText = await response.text()
      } finally {
        clearTimeout(timeout)
      }
    } catch (error) {
      this.logOutbound({
        ...input.logContext,
        upstream: 'hardware-control',
        method: 'POST',
        url: url.toString(),
        ok: false,
        elapsedMs: Date.now() - start,
        errorMessage: error instanceof Error ? error.message : String(error),
        details: {
          command: input.route.command,
        },
      })
      return {
        intent: input.route.intent,
        slots: input.route.slots,
        toolCall: input.route.toolCall,
        reply: `${input.route.label}的指令下发失败，请稍后再试。`,
      }
    }

    const payload = parseJsonPayload(bodyText)
    const businessCode = payload && typeof payload === 'object' && 'code' in payload
      ? (payload as { code?: unknown }).code
      : undefined
    const ok = response.ok && (businessCode === 0 || businessCode === '0')
    const executionStatus = ok ? 'dispatched' : 'failed'
    this.logOutbound({
      ...input.logContext,
      upstream: 'hardware-control',
      method: 'POST',
      url: url.toString(),
      status: response.status,
      ok,
      elapsedMs: Date.now() - start,
      details: {
        command: input.route.command,
        execution_status: executionStatus,
        response_code: businessCode,
      },
    })

    return {
      intent: input.route.intent,
      slots: {
        ...input.route.slots,
        execution_status: executionStatus,
      },
      toolCall: input.route.toolCall,
      reply: executionStatus === 'dispatched'
        ? `已为您下发${input.route.label}的指令，请稍候。`
        : `${input.route.label}的指令下发失败，请稍后再试。`,
    }
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
      '你在此模式下无法直接控制硬件，只能确认收到乘客请求并转达。',
      '严禁声称设备已打开/已关闭/已完成/已调好或指令已下发，不要编造任何设备执行结果。',
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
      const { reply, hardwareResult } = await sendPromptToRunnerSocket(
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
      if (hardwareResult) {
        // The hardware HTTP call is issued inside the cabin-control.mjs subprocess, so
        // its own log line only lands in the container. Mirror the dispatch outcome here
        // (from the tool_result) so Path B calls also show up in the server's cabin log.
        this.logOutbound({
          ...input.logContext,
          upstream: 'hardware-control',
          method: 'POST',
          status: hardwareResult.httpStatus,
          ok: hardwareResult.ok,
          elapsedMs: 0,
          details: {
            command: hardwareResult.command,
            execution_status: hardwareResult.executionStatus ?? (hardwareResult.ok ? 'dispatched' : 'failed'),
            routed: 'moss-session',
          },
        })
      }
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

function buildHardwareRoute(context: CabinPassengerContext, userText: string): CabinHardwareRoute | null {
  const text = userText.toLowerCase()
  const seatNo = context.seatId || ''
  if (!seatNo) return null

  const seatContext = buildSeatToolArguments(context)
  const route = (input: {
    intent: string
    command: string
    label: string
    path: string
    params?: Record<string, string | number | boolean>
    slots?: Record<string, unknown>
  }): CabinHardwareRoute => ({
    intent: input.intent,
    command: input.command,
    label: input.label,
    path: input.path,
    params: { seatNo, ...(input.params || {}) },
    slots: {
      ...seatContext,
      command: input.command,
      ...(input.slots || {}),
    },
    toolCall: {
      id: `tc-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      name: 'cabin.hardware.control',
      arguments: {
        ...seatContext,
        command: input.command,
        seat_no: seatNo,
        ...(input.params || {}),
      },
    },
  })

  if (hasAnyText(text, ['小桌板', '桌板', '餐桌板', 'tray'])) {
    if (hasAnyText(text, ['关闭', '关上', '合上', '收起', '收好', 'close'])) {
      return route({
        intent: 'tray_close',
        command: 'seat.tray.close',
        label: '关闭小桌板',
        path: '/admin-api/tcp-client/cmd/seat/tray/close',
        slots: { target: 'tray', action: 'close' },
      })
    }
    if (hasAnyText(text, ['打开', '开启', '展开', '放下', 'open'])) {
      return route({
        intent: 'tray_open',
        command: 'seat.tray.open',
        label: '打开小桌板',
        path: '/admin-api/tcp-client/cmd/seat/tray/open',
        slots: { target: 'tray', action: 'open' },
      })
    }
  }

  const mentionsCeiling = hasAnyText(text, ['顶灯', '客舱灯', '舱灯', 'ceiling'])
  if (mentionsCeiling) {
    const color = extractCeilingColor(text)
    if (color) {
      return route({
        intent: 'ceiling_light_color',
        command: 'cabin.ceiling.color',
        label: `客舱顶灯颜色调整为 RGB(${color.r}, ${color.g}, ${color.b})，亮度 ${color.brightness}%`,
        path: '/admin-api/tcp-client/cmd/cabin/ceiling/color',
        params: { r: color.r, g: color.g, b: color.b, brightness: color.brightness },
        slots: { target: 'ceiling_light', action: 'color', ...color },
      })
    }
    const brightness = extractCeilingBrightness(text)
    if (brightness !== null) {
      return route({
        intent: 'ceiling_light_brightness',
        command: 'cabin.ceiling.color',
        label: `客舱顶灯亮度调整到 ${brightness}%`,
        path: '/admin-api/tcp-client/cmd/cabin/ceiling/color',
        params: { r: 255, g: 255, b: 255, brightness },
        slots: { target: 'ceiling_light', action: 'brightness', r: 255, g: 255, b: 255, brightness },
      })
    }
    if (hasAnyText(text, ['关闭', '关掉', '关上', '熄灭', 'off'])) {
      return route({
        intent: 'ceiling_light_off',
        command: 'cabin.ceiling.light',
        label: '关闭客舱顶灯',
        path: '/admin-api/tcp-client/cmd/cabin/ceiling/light',
        params: { on: false },
        slots: { target: 'ceiling_light', action: 'off' },
      })
    }
    if (hasAnyText(text, ['打开', '开启', '开灯', 'on'])) {
      return route({
        intent: 'ceiling_light_on',
        command: 'cabin.ceiling.light',
        label: '打开客舱顶灯',
        path: '/admin-api/tcp-client/cmd/cabin/ceiling/light',
        params: { on: true },
        slots: { target: 'ceiling_light', action: 'on' },
      })
    }
  }

  if (!mentionsCeiling && (hasAnyText(text, ['阅读灯', '读书灯', 'reading light']) || hasAnyText(text, ['灯', 'light']))) {
    const pwm = extractPwmValue(userText)
    if (pwm !== null || hasAnyText(text, ['亮度', '调亮', '调暗', '亮一点', '暗一点', 'brightness'])) {
      const normalizedPwm = pwm ?? (hasAnyText(text, ['调暗', '暗一点', 'dimmer']) ? 300 : 700)
      return route({
        intent: 'reading_light_brightness',
        command: 'seat.light.brightness',
        label: `阅读灯亮度调整到 ${normalizedPwm}`,
        path: '/admin-api/tcp-client/cmd/seat/light/brightness',
        params: { pwm: normalizedPwm },
        slots: { target: 'reading_light', action: 'brightness', pwm: normalizedPwm },
      })
    }
    if (hasAnyText(text, ['关闭', '关掉', '关上', '熄灭', 'off'])) {
      return route({
        intent: 'reading_light_off',
        command: 'seat.light',
        label: '关闭阅读灯',
        path: '/admin-api/tcp-client/cmd/seat/light',
        params: { on: false },
        slots: { target: 'reading_light', action: 'off' },
      })
    }
    if (hasAnyText(text, ['打开', '开启', '开灯', 'on'])) {
      return route({
        intent: 'reading_light_on',
        command: 'seat.light',
        label: '打开阅读灯',
        path: '/admin-api/tcp-client/cmd/seat/light',
        params: { on: true },
        slots: { target: 'reading_light', action: 'on' },
      })
    }
  }

  if (hasAnyText(text, ['座椅', '靠背', '坐垫', 'seat'])) {
    const position = extractPercentValue(userText)
      ?? (hasAnyText(text, ['调直', '归位', '直立', '收起', 'upright']) ? 0 : null)
      ?? (hasAnyText(text, ['后仰一点', '放倒一点', '往后一点', '往后调一点', '稍微后仰', '稍微放倒']) ? 30 : null)
      ?? (hasAnyText(text, ['放倒', '后仰', '躺', '休息', '舒服', 'recline']) ? 60 : null)
    if (position !== null) {
      return route({
        intent: 'seat_position',
        command: 'seat.cushion',
        label: `座椅位置调整到 ${position}%`,
        path: '/admin-api/tcp-client/cmd/seat/cushion',
        params: { position },
        slots: { target: 'seat', action: 'position', position },
      })
    }
  }

  const level = extractLevelValue(userText)
  if (hasAnyText(text, ['通风', 'ventilation'])) {
    const normalizedLevel = level ?? (hasAnyText(text, ['关闭', '关掉', 'off']) ? 0 : 3)
    return route({
      intent: 'seat_ventilation',
      command: 'seat.ventilation',
      label: `座椅通风调整到 ${normalizedLevel} 档`,
      path: '/admin-api/tcp-client/cmd/seat/ventilation',
      params: { level: normalizedLevel },
      slots: { target: 'seat', action: 'ventilation', level: normalizedLevel },
    })
  }
  if (hasAnyText(text, ['加热', '热一点', '暖一点', 'heating'])) {
    const normalizedLevel = level ?? (hasAnyText(text, ['关闭', '关掉', 'off']) ? 0 : 3)
    return route({
      intent: 'seat_heating',
      command: 'seat.heating',
      label: `座椅加热调整到 ${normalizedLevel} 档`,
      path: '/admin-api/tcp-client/cmd/seat/heating',
      params: { level: normalizedLevel },
      slots: { target: 'seat', action: 'heating', level: normalizedLevel },
    })
  }
  if (hasAnyText(text, ['按摩', 'massage'])) {
    const normalizedLevel = level ?? (hasAnyText(text, ['关闭', '关掉', 'off']) ? 0 : 3)
    return route({
      intent: 'seat_massage',
      command: 'seat.massage',
      label: `座椅按摩调整到 ${normalizedLevel} 档`,
      path: '/admin-api/tcp-client/cmd/seat/massage',
      params: { level: normalizedLevel },
      slots: { target: 'seat', action: 'massage', level: normalizedLevel },
    })
  }

  if (hasAnyText(text, ['生理检测', '健康检测', '健康监测', '生理采集', '体征采集', '体征监测', 'health'])) {
    if (hasAnyText(text, ['停止', '结束', '关闭', '停掉', 'stop'])) {
      return route({
        intent: 'health_stop',
        command: 'seat.health.stop',
        label: '停止生理检测采集',
        path: '/admin-api/tcp-client/cmd/seat/health/stop',
        slots: { target: 'health', action: 'stop' },
      })
    }
    if (hasAnyText(text, ['开始', '启动', '打开', '开启', '采集', 'start'])) {
      return route({
        intent: 'health_start',
        command: 'seat.health.start',
        label: '启动生理检测采集',
        path: '/admin-api/tcp-client/cmd/seat/health/start',
        slots: { target: 'health', action: 'start' },
      })
    }
  }

  if (hasAnyText(text, ['场景', 'scene'])) {
    if (hasAnyText(text, ['清除', '取消', '关闭场景', '退出场景', '默认场景', 'clear'])) {
      return route({
        intent: 'cabin_scene_clear',
        command: 'cabin.scene.clear',
        label: '清除客舱场景',
        path: '/admin-api/tcp-client/cmd/cabin/scene/clear',
        slots: { target: 'cabin_scene', action: 'clear' },
      })
    }
    const preset = extractScenePreset(text)
    if (preset) {
      return route({
        intent: 'cabin_scene_set',
        command: 'cabin.scene',
        label: `切换至 ${preset} 客舱场景`,
        path: '/admin-api/tcp-client/cmd/cabin/scene',
        params: { preset },
        slots: { target: 'cabin_scene', action: 'set', preset },
      })
    }
  }

  return null
}

function hasAnyText(text: string, words: string[]): boolean {
  return words.some(word => text.includes(word.toLowerCase()))
}

function extractPercentValue(text: string): number | null {
  const percentMatch = text.match(/(\d{1,3})\s*(?:%|％|百分之)/)
  if (percentMatch) return clampInt(Number.parseInt(percentMatch[1], 10), 0, 100)
  const chinesePercent = text.match(/百分之\s*([一二三四五六七八九十百零〇两\d]+)/)
  if (chinesePercent) {
    const value = parseLooseNumber(chinesePercent[1])
    if (value !== null) return clampInt(value, 0, 100)
  }
  return null
}

function extractPwmValue(text: string): number | null {
  const percent = extractPercentValue(text)
  if (percent !== null) return clampInt(percent * 10, 0, 1000)
  const explicitPwm = text.match(/(?:pwm|亮度)\s*(?:调)?(?:到|为|=|：|:)?\s*(\d{1,4})/i)
  if (explicitPwm) return clampInt(Number.parseInt(explicitPwm[1], 10), 0, 1000)
  return null
}

function extractLevelValue(text: string): number | null {
  const levelMatch = text.match(/(\d{1,2})\s*(?:档|级|level)/i)
  if (levelMatch) return clampInt(Number.parseInt(levelMatch[1], 10), 0, 10)
  return null
}

// RGB values mirror cabin-control.mjs COLOR_ALIASES so both paths dispatch identical colors.
const CEILING_COLORS: Record<string, { r: number; g: number; b: number }> = {
  蓝: { r: 0, g: 0, b: 255 },
  蓝色: { r: 0, g: 0, b: 255 },
  blue: { r: 0, g: 0, b: 255 },
  红: { r: 255, g: 0, b: 0 },
  红色: { r: 255, g: 0, b: 0 },
  red: { r: 255, g: 0, b: 0 },
  绿: { r: 0, g: 255, b: 0 },
  绿色: { r: 0, g: 255, b: 0 },
  green: { r: 0, g: 255, b: 0 },
  白: { r: 255, g: 255, b: 255 },
  白色: { r: 255, g: 255, b: 255 },
  white: { r: 255, g: 255, b: 255 },
  暖: { r: 255, g: 180, b: 80 },
  暖色: { r: 255, g: 180, b: 80 },
  warm: { r: 255, g: 180, b: 80 },
}

function extractCeilingColor(text: string): { r: number; g: number; b: number; brightness: number } | null {
  for (const [word, rgb] of Object.entries(CEILING_COLORS)) {
    if (text.includes(word)) {
      const percent = extractPercentValue(text)
      return { ...rgb, brightness: percent ?? 100 }
    }
  }
  return null
}

function extractCeilingBrightness(text: string): number | null {
  const percent = extractPercentValue(text)
  if (percent !== null) return percent
  if (hasAnyText(text, ['亮度', '调亮', '调暗', '亮一点', '暗一点', 'brightness'])) {
    return hasAnyText(text, ['调暗', '暗一点', 'dimmer']) ? 30 : 80
  }
  return null
}

// Preset tokens must match the backend's configured cabin scene presets; unknown
// scene words return null so the request falls through to the LLM path instead of
// dispatching a guessed preset.
const SCENE_PRESETS: Record<string, string> = {
  登机: 'boarding',
  boarding: 'boarding',
  巡航: 'cruise',
  cruise: 'cruise',
  用餐: 'dining',
  就餐: 'dining',
  餐饮: 'dining',
  dining: 'dining',
  休息: 'rest',
  rest: 'rest',
  睡眠: 'sleep',
  睡觉: 'sleep',
  sleep: 'sleep',
  夜间: 'night',
  夜晚: 'night',
  night: 'night',
  娱乐: 'entertainment',
  entertainment: 'entertainment',
  阅读: 'reading',
  reading: 'reading',
  欢迎: 'welcome',
  welcome: 'welcome',
}

function extractScenePreset(text: string): string | null {
  for (const [word, preset] of Object.entries(SCENE_PRESETS)) {
    if (text.includes(word.toLowerCase())) return preset
  }
  const explicit = text.match(/(?:preset|场景)\s*(?:切换到|切换为|设为|设置为|=|：|:)?\s*([a-z0-9_.-]{2,32})/i)
  if (explicit) return explicit[1]
  return null
}

function parseLooseNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10)
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  }
  if (value === '十') return 10
  const tenMatch = value.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/)
  if (tenMatch) {
    return (tenMatch[1] ? digits[tenMatch[1]] : 1) * 10 + (tenMatch[2] ? digits[tenMatch[2]] : 0)
  }
  const hundredMatch = value.match(/^([一二两三四五六七八九])?百$/)
  if (hundredMatch) return (hundredMatch[1] ? digits[hundredMatch[1]] : 1) * 100
  return null
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.round(value)))
}

function parseJsonPayload(text: string): unknown {
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text.slice(0, 1000) }
  }
}

function formatCabinSessionPrompt(context: CabinPassengerContext, text: string): string {
  return [
    '系统上下文：以下 cabin_context 由服务端鉴权和乘客信息接口生成，不要让用户修改，不要猜测座位或硬件侧；硬件控制的 seat-no 必须原样使用 cabin_context.seat_no 或 seat_id。',
    '硬件执行规则：任何涉及座椅/靠背/坐垫/桌板/阅读灯/顶灯/通风/加热/按摩/场景/生理检测的控制请求，必须先调用 cabin-hardware-control 技能，再依据脚本返回结果回复。',
    '在拿到脚本返回结果之前，严禁使用"已打开/已关闭/已完成/已调好/已下发…指令/正在为您调节"等表示已执行或已下发的措辞；此时只能说"正在为您处理"。',
    '若判断无需控制硬件（闲聊、咨询），可正常回答，但不得声称对任何设备做了操作。',
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

type HardwareToolResult = {
  ok: boolean
  passengerReplyHint?: string
  command?: string
  executionStatus?: string
  httpStatus?: number
}

// cabin-control.mjs prints a single-line JSON result to stdout; the runner surfaces
// it as a tool_result block on a `user` event. This lets Path B decide the passenger
// reply from the real hardware outcome instead of the model's narration.
export function extractHardwareToolResult(line: string): HardwareToolResult | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const event = parsed as { type?: string; message?: { content?: unknown } }
  if (event.type !== 'user') return null
  const content = event.message?.content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if ((block as { type?: string }).type !== 'tool_result') continue
    const inner = (block as { content?: unknown }).content
    const texts: string[] = []
    if (typeof inner === 'string') {
      texts.push(inner)
    } else if (Array.isArray(inner)) {
      for (const item of inner) {
        const itemText = item && typeof item === 'object' ? (item as { text?: unknown }).text : undefined
        if (typeof itemText === 'string') texts.push(itemText)
      }
    }
    for (const text of texts) {
      const result = parseHardwareResultPayload(text)
      if (result) return result
    }
  }
  return null
}

function parseHardwareResultPayload(text: string): HardwareToolResult | null {
  for (const candidate of text.split(/\r?\n/)) {
    const trimmed = candidate.trim()
    if (!trimmed.startsWith('{')) continue
    let obj: {
      ok?: unknown
      passenger_reply_hint?: unknown
      execution_status?: unknown
      command?: unknown
      http_status?: unknown
    }
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof obj.ok === 'boolean' && (obj.execution_status !== undefined || obj.passenger_reply_hint !== undefined)) {
      return {
        ok: obj.ok,
        passengerReplyHint: typeof obj.passenger_reply_hint === 'string' ? obj.passenger_reply_hint : undefined,
        command: typeof obj.command === 'string' ? obj.command : undefined,
        executionStatus: typeof obj.execution_status === 'string' ? obj.execution_status : undefined,
        httpStatus: typeof obj.http_status === 'number' ? obj.http_status : undefined,
      }
    }
  }
  return null
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

function buildDispatchedHardwareReply(text: string): string {
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

function shouldUseDispatchedHardwareReply(text: string): boolean {
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

// A dispatch/completion claim is only trustworthy when a real tool result backs it.
// When no hardwareResult was observed, any such wording is fabricated and must be dropped.
export function mentionsHardwareActionClaim(text: string): boolean {
  if (!text.trim()) return false
  return /已(?:经)?(?:为您)?(?:打开|关闭|开启|调好|调亮|调暗|调节好|调整好|完成|处理好)|已(?:为您)?下发[^。]*指令|正在(?:为您)?(?:调节|调整|打开|关闭|开启)/u.test(text)
}

// Detects a tool invocation in either stream shape: a top-level `tool_use` event, or a
// `tool_use` block nested inside an assistant message's content array.
export function lineHasToolUse(line: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== 'object') return false
  const event = parsed as { type?: string; message?: { content?: unknown }; content?: unknown }
  if (event.type === 'tool_use') return true
  if (event.type === 'assistant') {
    const content = event.message?.content ?? event.content
    if (Array.isArray(content)) {
      return content.some(
        block => block && typeof block === 'object' && (block as { type?: string }).type === 'tool_use',
      )
    }
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

  const dispatchedHardwareReply = buildDispatchedHardwareReply(input.userText)
  if (dispatchedHardwareReply && shouldUseDispatchedHardwareReply(cleanedText)) {
    return addPassengerSalutation(dispatchedHardwareReply, input.context)
  }

  const reply = cleanedText || dispatchedHardwareReply || input.reply.trim()
  return addPassengerSalutation(reply, input.context)
}

function sendPromptToRunnerSocket(
  socket: net.Socket,
  text: string,
  timeoutMs: number,
  onDelta?: (text: string) => void,
  suppressPreToolText = false,
): Promise<{ reply: string; hardwareResult: HardwareToolResult | null }> {
  return new Promise((resolve, reject) => {
    let settled = false
    let assistantText = ''
    let pendingText = ''
    let hardwareResult: HardwareToolResult | null = null
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

      const toolResult = extractHardwareToolResult(message.line)
      if (toolResult) hardwareResult = toolResult
      if (!sawToolUse && lineHasToolUse(message.line)) sawToolUse = true

      try {
        const inner = JSON.parse(message.line) as { type?: string; status?: string; input?: unknown }
        if (inner.type === 'tool_use') {
          if (suppressPreToolText && typeof inner.input === 'string') {
            pendingText = ''
          }
        }
        if (inner.type === 'result') {
          if (inner.status === 'success') {
            if (suppressPreToolText) {
              const cleanedText = sanitizeCabinHardwareReply(pendingText)
              if (hardwareResult) {
                // Ground the reply in the real hardware outcome, never the model's narration.
                assistantText = hardwareResult.ok
                  ? hardwareResult.passengerReplyHint
                    || buildDispatchedHardwareReply(text)
                    || '已为您下发指令，请稍候。'
                  : '抱歉，刚才的操作没有下发成功，请您稍后再试或联系乘务员。'
              } else if (shouldExposeHardwareReply(cleanedText)) {
                // Model surfaced an explicit unavailable/failure message — pass it through.
                assistantText = cleanedText
              } else if (!sawToolUse && mentionsHardwareActionClaim(cleanedText)) {
                // Model narrated a dispatch/completion without ever invoking a tool — the
                // claim is fabricated, so replace it with a non-committal reply. When a tool
                // WAS invoked but its result just wasn't parseable, we trust the narration.
                assistantText = '收到，我这就为您处理。'
              } else {
                // No hardware tool result observed: do NOT fabricate a "已下发" success.
                assistantText = cleanedText || '收到，我这就为您处理。'
              }
              if (assistantText) {
                onDelta?.(assistantText)
              }
            } else if (!releasedDeltas && pendingText) {
              assistantText += pendingText
              onDelta?.(pendingText)
            }
            finish(() => resolve({ reply: assistantText.trim() || '收到，我会为您处理。', hardwareResult }))
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
