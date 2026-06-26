import http from 'http'
import { randomUUID } from 'crypto'
import type { RuntimeService } from '../runtimeService.js'
import type { ServerConfig } from '../types.js'
import { issueCabinToken, verifyCabinTokenDetailed } from './auth.js'
import { CabinServices, normalizeCabinPassengerReply, shouldBufferCabinReply } from './service.js'
import { CabinStore } from './store.js'
import type { CabinPassengerContext, CabinTokenPayload } from './types.js'

type JsonBody = Record<string, unknown>

type UploadedFile = {
  fieldName: string
  filename: string
  contentType: string
  data: Buffer
}

type MultipartForm = {
  file: UploadedFile
  fields: Record<string, string>
}

class CabinHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function mapServiceError(error: unknown): CabinHttpError {
  const message = error instanceof Error ? error.message : String(error)
  if (/ASR response missing text/i.test(message)) {
    return new CabinHttpError(400, 'ASR_NO_SPEECH', 'No valid speech was detected in the audio')
  }
  if (/ASR request failed/i.test(message)) {
    return new CabinHttpError(500, 'ASR_FAILED', message)
  }
  if (/LLM request failed|Moss session|runner|socket/i.test(message)) {
    return new CabinHttpError(500, 'AGENT_FAILED', message)
  }
  return new CabinHttpError(500, 'INTERNAL_ERROR', message)
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function writeSse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function getHeader(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()]
  return typeof value === 'string' ? value : undefined
}

function getBearerToken(req: http.IncomingMessage): string | null {
  const header = getHeader(req, 'authorization')
  if (!header) return null
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1] ?? null
}

function requireTabletHeaders(req: http.IncomingMessage): { tabletToken: string; tabletId: string } {
  const tabletToken = getHeader(req, 'x-cabin-tablet-token')
  const tabletId = getHeader(req, 'x-cabin-tablet-id')
  if (!tabletToken) {
    throw new CabinHttpError(401, 'MISSING_TABLET_TOKEN', 'X-Cabin-Tablet-Token is required')
  }
  if (!tabletId) {
    throw new CabinHttpError(400, 'MISSING_TABLET_ID', 'X-Cabin-Tablet-Id is required')
  }
  return { tabletToken, tabletId }
}

function requireCabinToken(req: http.IncomingMessage, config: ServerConfig['cabin']): CabinTokenPayload {
  const token = getBearerToken(req)
  if (!token) {
    throw new CabinHttpError(401, 'MISSING_AUTHORIZATION', 'Authorization bearer token is required')
  }
  const result = verifyCabinTokenDetailed(token, { secret: config.tokenSecret })
  const payload = result.payload
  if (!payload) {
    if (result.reason === 'expired') {
      throw new CabinHttpError(401, 'TOKEN_EXPIRED', 'Cabin token expired')
    }
    throw new CabinHttpError(403, 'INVALID_AUTHORIZATION', 'Invalid cabin token')
  }
  return payload
}

function readRawBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', chunk => {
      const buf = Buffer.from(chunk)
      total += buf.length
      if (total > maxBytes) {
        reject(new CabinHttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large'))
        req.destroy()
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req: http.IncomingMessage): Promise<JsonBody> {
  const raw = await readRawBody(req, 1024 * 1024)
  if (!raw.toString('utf8').trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new CabinHttpError(400, 'INVALID_JSON', 'Invalid JSON body')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CabinHttpError(400, 'INVALID_JSON', 'JSON body must be an object')
  }
  return parsed as JsonBody
}

function parseContentDisposition(value: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const part of value.split(';')) {
    const [rawKey, ...rawRest] = part.trim().split('=')
    const key = rawKey?.trim().toLowerCase()
    if (!key || rawRest.length === 0) continue
    result[key] = rawRest.join('=').trim().replace(/^"|"$/g, '')
  }
  return result
}

async function readMultipartForm(req: http.IncomingMessage): Promise<MultipartForm> {
  const contentType = getHeader(req, 'content-type') || ''
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2]
  if (!boundary) {
    throw new CabinHttpError(400, 'INVALID_MULTIPART', 'multipart boundary is required')
  }

  const body = await readRawBody(req, 25 * 1024 * 1024)
  const delimiter = Buffer.from(`--${boundary}`)
  const fields: Record<string, string> = {}
  let file: UploadedFile | null = null
  let offset = 0
  while (offset < body.length) {
    const start = body.indexOf(delimiter, offset)
    if (start < 0) break
    const next = body.indexOf(delimiter, start + delimiter.length)
    if (next < 0) break
    let part = body.subarray(start + delimiter.length, next)
    if (part.subarray(0, 2).toString() === '\r\n') part = part.subarray(2)
    if (part.subarray(part.length - 2).toString() === '\r\n') part = part.subarray(0, part.length - 2)
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd > 0) {
      const headerText = part.subarray(0, headerEnd).toString('utf8')
      const data = part.subarray(headerEnd + 4)
      const headers = new Map<string, string>()
      for (const line of headerText.split('\r\n')) {
        const colon = line.indexOf(':')
        if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
      }
      const disposition = headers.get('content-disposition')
      if (disposition) {
        const params = parseContentDisposition(disposition)
        if ((params.name === 'audio' || params.name === 'file') && params.filename) {
          file = {
            fieldName: params.name,
            filename: params.filename,
            contentType: headers.get('content-type') || 'application/octet-stream',
            data,
          }
        } else if (params.name && !params.filename) {
          fields[params.name] = data.toString('utf8').trim()
        }
      }
    }
    offset = next
  }

  if (!file) throw new CabinHttpError(400, 'MISSING_AUDIO', 'multipart field "audio" is required')
  if (file.data.length > 10 * 1024 * 1024) {
    throw new CabinHttpError(400, 'AUDIO_TOO_LARGE', 'audio file exceeds 10 MB')
  }
  const isWav = /\.wav$/i.test(file.filename) || /audio\/(wav|x-wav|wave)/i.test(file.contentType)
  if (!isWav) {
    throw new CabinHttpError(400, 'INVALID_AUDIO_FORMAT', 'audio must be a wav file')
  }
  return { file, fields }
}

function stringField(body: JsonBody, key: string): string | undefined {
  const value = body[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringBodyField(body: JsonBody, key: string): string | undefined {
  const value = body[key]
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function requiredBodyField(body: JsonBody, key: string): string {
  const value = stringBodyField(body, key)
  if (!value) {
    throw new CabinHttpError(400, 'INVALID_REQUEST', `${key} is required`)
  }
  return value
}

function optionalCabinTokenFields(body: JsonBody): Omit<CabinTokenPayload, 'tabletToken' | 'tabletId' | 'issuedAt' | 'expiresAt'> {
  return {
    seatNo: requiredBodyField(body, 'seatNo'),
    columnNo: requiredBodyField(body, 'columnNo'),
    flightSeatId: requiredBodyField(body, 'flightSeatId'),
    aircraftSeatId: stringBodyField(body, 'aircraftSeatId'),
    aircraftId: stringBodyField(body, 'aircraftId'),
    aircraftNo: stringBodyField(body, 'aircraftNo'),
    tabletType: stringBodyField(body, 'tabletType'),
    bindingId: stringBodyField(body, 'bindingId'),
    contextStatus: stringBodyField(body, 'contextStatus'),
  }
}

function validateLanguage(value: string | undefined): string {
  const language = value || 'auto'
  if (!['auto', 'zh', 'en', 'fr', 'ja', 'ko'].includes(language)) {
    throw new CabinHttpError(400, 'INVALID_LANGUAGE', 'language must be one of auto/zh/en/fr/ja/ko')
  }
  return language
}

function normalizeLanguage(value: string | undefined): string {
  if (!value || value === 'auto') return 'unknown'
  const normalized = value.toLowerCase()
  if (normalized.startsWith('zh')) return 'zh'
  if (normalized.startsWith('en')) return 'en'
  if (normalized.startsWith('fr')) return 'fr'
  if (normalized.startsWith('ja')) return 'ja'
  if (normalized.startsWith('ko')) return 'ko'
  return 'unknown'
}

function parseMessageSource(value: string | undefined): 'voice' | 'text' {
  if (!value) return 'text'
  if (value === 'voice' || value === 'text') return value
  throw new CabinHttpError(400, 'INVALID_REQUEST', 'source must be voice or text')
}

function formatCabinTime(ms: number): string {
  const date = new Date(ms + 8 * 60 * 60 * 1000)
  return `${date.toISOString().slice(0, 19)}+08:00`
}

function objectField(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const child = (value as Record<string, unknown>)[key]
  return child && typeof child === 'object' && !Array.isArray(child)
    ? child as Record<string, unknown>
    : null
}

function stringFromObject(value: unknown, ...keys: string[]): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const obj = value as Record<string, unknown>
  for (const key of keys) {
    const raw = obj[key]
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  }
  return undefined
}

async function fetchPassengerContext(
  config: ServerConfig['cabin'],
  tablet: { tabletToken: string; tabletId: string },
): Promise<CabinPassengerContext> {
  if (!config.passengerInfoUrl) {
    throw new CabinHttpError(500, 'PASSENGER_INFO_NOT_CONFIGURED', 'cabin.passengerInfoUrl is required')
  }
  let response: Response | null = null
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      response = await fetch(config.passengerInfoUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'tablet-token': tablet.tabletToken,
          'x-cabin-tablet-token': tablet.tabletToken,
          ...(config.passengerInfoAuth ? { authorization: config.passengerInfoAuth } : {}),
        },
        body: JSON.stringify({
          privacyLevel: config.passengerInfoPrivacyLevel,
        }),
      })
      break
    } catch (error) {
      lastError = error
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 300))
    } finally {
      clearTimeout(timeout)
    }
  }
  if (!response) {
    const message = lastError instanceof Error ? lastError.message : String(lastError)
    throw new CabinHttpError(502, 'PASSENGER_INFO_FAILED', `Passenger info request failed: ${message}`)
  }
  if (!response.ok) {
    throw new CabinHttpError(502, 'PASSENGER_INFO_FAILED', `Passenger info request failed: ${response.status}`)
  }
  const envelope = await response.json() as unknown
  if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
    const code = (envelope as Record<string, unknown>).code
    const msg = (envelope as Record<string, unknown>).msg
    if (code !== undefined && code !== 0 && code !== '0') {
      const message = typeof msg === 'string' && msg.trim()
        ? msg.trim()
        : 'Invalid tablet token'
      throw new CabinHttpError(401, 'INVALID_TABLET_TOKEN', message)
    }
  }
  const data = objectField(envelope, 'data') || (envelope && typeof envelope === 'object' ? envelope as Record<string, unknown> : null)
  if (!data) {
    throw new CabinHttpError(502, 'PASSENGER_INFO_INVALID', 'Passenger info response missing data')
  }
  const flight = objectField(data, 'flight')
  const passenger = objectField(data, 'passenger')
  const flightId = stringFromObject(data, 'flightId', 'flight_id') || stringFromObject(flight, 'flightId', 'flight_id')
  const flightDate = stringFromObject(data, 'flightDate', 'flight_date') || stringFromObject(flight, 'flightDate', 'flight_date')
  const seatId = stringFromObject(data, 'seatNo', 'seat_id', 'seatId') || stringFromObject(passenger, 'seatNo', 'seat_id', 'seatId')
  if (!flightId) throw new CabinHttpError(502, 'PASSENGER_INFO_INVALID', 'Passenger info response missing flightId')
  if (!flightDate) throw new CabinHttpError(502, 'PASSENGER_INFO_INVALID', 'Passenger info response missing flightDate')
  return {
    passengerId: stringFromObject(passenger, 'passengerId', 'id'),
    passengerRef: stringFromObject(passenger, 'passengerRef', 'passenger_ref') || stringFromObject(data, 'passengerRef', 'passenger_ref'),
    passengerName: stringFromObject(passenger, 'displayName', 'passengerName', 'passengerNameMasked')
      || stringFromObject(data, 'displayName', 'passengerName', 'passengerNameMasked'),
    flightId,
    flightDate,
    flightNo: stringFromObject(flight, 'flightNo', 'flight_no') || stringFromObject(data, 'flightNo', 'flight_no'),
    flightSeatId: stringFromObject(data, 'flightSeatId', 'flight_seat_id'),
    seatId,
    tabletId: tablet.tabletId,
    language: stringFromObject(passenger, 'language') || stringFromObject(data, 'language'),
  }
}

async function contextFromToken(config: ServerConfig['cabin'], payload: CabinTokenPayload, headers: { tabletToken: string; tabletId: string }): Promise<CabinPassengerContext> {
  if (payload.tabletId !== headers.tabletId || payload.tabletToken !== headers.tabletToken) {
    throw new CabinHttpError(401, 'UNAUTHORIZED', 'Cabin token does not match tablet headers')
  }
  const passengerContext = await fetchPassengerContext(config, headers)
  return {
    ...passengerContext,
    tabletToken: payload.tabletToken,
    tabletId: payload.tabletId,
    seatId: passengerContext.seatId || payload.seatNo,
    flightSeatId: passengerContext.flightSeatId || payload.flightSeatId,
    columnNo: payload.columnNo,
    aircraftSeatId: payload.aircraftSeatId,
    aircraftId: payload.aircraftId,
    aircraftNo: payload.aircraftNo,
    tabletType: payload.tabletType,
    bindingId: payload.bindingId,
    contextStatus: payload.contextStatus,
  }
}

export function createCabinApi(options: {
  config: ServerConfig
  runtime: RuntimeService
}): {
  handle: (req: http.IncomingMessage, res: http.ServerResponse, pathname: string) => Promise<boolean>
} {
  const cabinConfig = options.config.cabin
  const store = new CabinStore(options.runtime.store.db)
  const services = new CabinServices({
    config: cabinConfig,
    store,
    runtime: options.runtime,
    createMossSession: async (context) => {
      if (!cabinConfig.createMossSession) return `cabin-${randomUUID()}`
      const orgId = options.runtime.authService.listAllOrganizations().organizations[0]?.id
      if (!orgId) throw new Error('No organization available for cabin moss session')
      const created = await options.runtime.createSession({
        cwd: options.config.workspace,
        dangerouslySkipPermissions: true,
        userId: 'cabin-system',
        orgId,
        role: 'user',
        scopes: ['sessions:create'],
        assistantName: cabinConfig.assistantName,
        assistantDisplayName: cabinConfig.assistantDisplayName,
        source: 'cabin',
        channelChatId: `${context.flightId}:${context.passengerId || context.passengerRef || context.tabletId}`,
        runtime: {
          type: options.config.defaultRuntime,
          engine: 'scode',
          hostMode: 'user',
          model: cabinConfig.llmModel,
        },
      })
      return created.sessionId
    },
  })

  async function handleAuthToken(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const tablet = requireTabletHeaders(req)
    const body = await readJsonBody(req)
    const tokenContext = optionalCabinTokenFields(body)
    const token = issueCabinToken({
      ...tablet,
      ...tokenContext,
    }, {
      secret: cabinConfig.tokenSecret,
      ttlSeconds: cabinConfig.tokenTtlSeconds,
    })
    writeJson(res, 200, {
      status: 'ok',
      access_token: token,
      token_type: 'Bearer',
      expires_in: cabinConfig.tokenTtlSeconds,
    })
  }

  async function handleVoiceQuery(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const payload = requireCabinToken(req, cabinConfig)
    const tablet = requireTabletHeaders(req)
    const form = await readMultipartForm(req)
    const file = form.file
    const language = validateLanguage(form.fields.language)
    const context = await contextFromToken(cabinConfig, payload, tablet)
    const conversation = await services.ensureConversation(context)
    let result: Awaited<ReturnType<CabinServices['transcribe']>>
    try {
      result = await services.transcribe({
        audio: file.data,
        filename: file.filename,
        contentType: file.contentType,
        language: language === 'auto' ? undefined : language,
      })
    } catch (error) {
      throw mapServiceError(error)
    }
    const message = store.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      source: 'voice',
      content: result.text,
    })
    store.insertVoiceLog({
      conversationId: conversation.id,
      messageId: message.id,
      type: 'asr',
      text: result.text,
      status: 'ok',
      elapsedMs: result.elapsedMs,
    })
    writeJson(res, 200, {
      status: 'ok',
      seat_id: context.seatId || '',
      language: normalizeLanguage(language === 'auto' ? context.language : language),
      text: result.text,
    })
  }

  async function streamChatReply(input: {
    res: http.ServerResponse
    context: CabinPassengerContext
    conversation: Awaited<ReturnType<CabinServices['ensureConversation']>>
    text: string
    source: 'voice' | 'text'
  }): Promise<void> {
    const { res, context, conversation, text, source } = input
    store.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      source,
      content: text,
    })
    const inferredTool = cabinConfig.createMossSession
      ? null
      : services.inferToolCall({ context, text })

    if (inferredTool) {
      writeSse(res, 'tool_call', inferredTool.toolCall)
    }
    let reply: string
    const shouldBufferReply = shouldBufferCabinReply(text)
    const bufferedDeltas: string[] = []
    const writeDelta = (delta: string): void => {
      if (shouldBufferReply) {
        bufferedDeltas.push(delta)
        return
      }
      writeSse(res, 'delta', { content: delta })
    }
    try {
      reply = cabinConfig.createMossSession
        ? await services.generateReplyWithMossSession({
            mossSessionId: conversation.mossSessionId,
            context,
            text,
            onDelta: writeDelta,
          })
        : await services.generateReply({
            context,
            messages: store.listMessages(conversation.id, 30),
            text,
          })
    } catch (error) {
      const mapped = mapServiceError(error)
      writeSse(res, 'error', {
        code: mapped.code,
        message: mapped.message,
        retriable: mapped.statusCode >= 500,
      })
      res.end()
      return
    }
    reply = normalizeCabinPassengerReply({ userText: text, reply, context })
    const assistantMessage = store.appendMessage({
      conversationId: conversation.id,
      role: 'assistant',
      source: 'agent',
      content: reply,
      intent: inferredTool?.intent,
      slots: inferredTool?.slots,
      toolCalls: inferredTool ? [inferredTool.toolCall] : null,
    })
    if (shouldBufferReply || !cabinConfig.createMossSession) {
      writeSse(res, 'delta', { content: reply })
    }
    writeSse(res, 'done', {
      intent: assistantMessage.intent || '',
      slots: assistantMessage.slots || {},
      reply_text: reply,
    })
    res.end()
  }

  async function handleChatSend(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const payload = requireCabinToken(req, cabinConfig)
    const tablet = requireTabletHeaders(req)
    const body = await readJsonBody(req)
    const text = stringField(body, 'content') || stringField(body, 'text')
    if (!text) throw new CabinHttpError(400, 'MISSING_CONTENT', 'content is required')
    const source = parseMessageSource(stringField(body, 'source'))
    validateLanguage(stringField(body, 'language'))

    const context = await contextFromToken(cabinConfig, payload, tablet)
    const conversation = await services.ensureConversation(context)
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    writeSse(res, 'start', { status: 'ok' })
    await streamChatReply({
      res,
      context,
      conversation,
      text,
      source,
    })
  }

  async function handleVoiceChatSend(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const payload = requireCabinToken(req, cabinConfig)
    const tablet = requireTabletHeaders(req)
    const form = await readMultipartForm(req)
    const file = form.file
    const language = validateLanguage(form.fields.language)
    const source = form.fields.source
      ? parseMessageSource(form.fields.source)
      : 'voice'
    const context = await contextFromToken(cabinConfig, payload, tablet)
    const conversation = await services.ensureConversation(context)

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    writeSse(res, 'start', { status: 'ok' })

    let result: Awaited<ReturnType<CabinServices['transcribe']>>
    try {
      result = await services.transcribe({
        audio: file.data,
        filename: file.filename,
        contentType: file.contentType,
        language: language === 'auto' ? undefined : language,
      })
    } catch (error) {
      const mapped = mapServiceError(error)
      store.insertVoiceLog({
        conversationId: conversation.id,
        type: 'asr',
        status: 'error',
        errorMessage: mapped.message,
      })
      writeSse(res, 'error', {
        code: mapped.code,
        message: mapped.message,
        retriable: mapped.statusCode >= 500,
      })
      res.end()
      return
    }

    store.insertVoiceLog({
      conversationId: conversation.id,
      type: 'asr',
      text: result.text,
      status: 'ok',
      elapsedMs: result.elapsedMs,
    })
    writeSse(res, 'asr_result', {
      status: 'ok',
      seat_id: context.seatId || '',
      language: normalizeLanguage(language === 'auto' ? context.language : language),
      text: result.text,
    })

    await streamChatReply({
      res,
      context,
      conversation,
      text: result.text,
      source,
    })
  }

  async function handleHistory(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const payload = requireCabinToken(req, cabinConfig)
    const tablet = requireTabletHeaders(req)
    const context = await contextFromToken(cabinConfig, payload, tablet)
    const conversation = await services.ensureConversation(context)
    const limit = Number.parseInt(url.searchParams.get('limit') || '20', 10)
    const normalizedLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 20, 100))
    const messages = store.listMessages(conversation.id, normalizedLimit, {
      beforeId: url.searchParams.get('before_id') || undefined,
      afterId: url.searchParams.get('after_id') || undefined,
    })
    writeJson(res, 200, {
      status: 'ok',
      mode: 'CABIN_AI_CHAT',
      messages: messages
        .filter(message => message.role !== 'system')
        .map(message => ({
          id: message.id,
          role: message.role,
          content: message.content,
          source: message.source,
          ...(message.intent ? { intent: message.intent } : {}),
          ...(message.slots ? { slots: message.slots } : {}),
          ...(message.toolCalls ? { tool_calls: message.toolCalls } : {}),
          create_time: formatCabinTime(message.createdAt),
        })),
      next_cursor: messages.length >= normalizedLimit
        ? messages[0]?.id || null
        : null,
    })
  }

  async function handleReset(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const payload = requireCabinToken(req, cabinConfig)
    const tablet = requireTabletHeaders(req)
    const context = await contextFromToken(cabinConfig, payload, tablet)
    const conversation = await services.ensureConversation(context)
    store.resetConversation(conversation.id)
    writeJson(res, 200, { status: 'ok', cleared: true })
  }

  async function handleSpeech(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const payload = requireCabinToken(req, cabinConfig)
    const tablet = requireTabletHeaders(req)
    const body = await readJsonBody(req)
    const text = stringField(body, 'text') || stringField(body, 'content')
    if (!text) throw new CabinHttpError(400, 'MISSING_TEXT', 'text is required')
    const context = await contextFromToken(cabinConfig, payload, tablet)
    const conversation = await services.ensureConversation(context)
    const result = await services.speech(text)
    store.insertVoiceLog({
      conversationId: conversation.id,
      type: 'tts',
      text,
      status: 'ok',
      elapsedMs: result.elapsedMs,
    })
    res.writeHead(200, {
      'content-type': result.contentType,
      'content-length': result.audio.length,
    })
    res.end(result.audio)
  }

  return {
    async handle(req, res, pathname) {
      if (!cabinConfig.enabled || !pathname.startsWith('/v1/')) return false
      try {
        const url = new URL(req.url || '/', 'http://localhost')
        if (req.method === 'POST' && pathname === '/v1/auth/token') {
          await handleAuthToken(req, res)
          return true
        }
        if (req.method === 'POST' && pathname === '/v1/voice/query') {
          await handleVoiceQuery(req, res)
          return true
        }
        if (req.method === 'POST' && pathname === '/v1/voice-chat/send') {
          await handleVoiceChatSend(req, res)
          return true
        }
        if (req.method === 'POST' && pathname === '/v1/ai-chat/send') {
          await handleChatSend(req, res)
          return true
        }
        if (req.method === 'GET' && pathname === '/v1/ai-chat/history') {
          await handleHistory(req, res, url)
          return true
        }
        if (req.method === 'POST' && pathname === '/v1/ai-chat/reset') {
          await handleReset(req, res)
          return true
        }
        if (req.method === 'POST' && pathname === '/v1/tts/speech') {
          await handleSpeech(req, res)
          return true
        }
        return false
      } catch (error) {
        if (res.headersSent) {
          try {
            writeSse(res, 'error', {
              code: 'INTERNAL_ERROR',
              message: error instanceof Error ? error.message : String(error),
            })
          } catch {
            // ignore secondary write failures
          }
          res.end()
          return true
        }
        if (error instanceof CabinHttpError) {
          writeJson(res, error.statusCode, {
            status: 'error',
            code: error.code,
            message: error.message,
          })
          return true
        }
        const mapped = mapServiceError(error)
        writeJson(res, mapped.statusCode, {
          status: 'error',
          code: mapped.code,
          message: mapped.message,
        })
        return true
      }
    },
  }
}
