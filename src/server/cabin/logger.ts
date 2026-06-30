import { mkdir, appendFile } from 'fs/promises'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'

import type { ServerConfig } from '../types.js'

export type CabinLogLevel = 'info' | 'warn' | 'error'

export type CabinLogContext = {
  requestId?: string
  tabletId?: string
  seatNo?: string
  flightId?: string
  conversationId?: string
}

type CabinLogEvent = CabinLogContext & {
  level?: CabinLogLevel
  type: 'inbound' | 'outbound'
  method?: string
  path?: string
  endpoint?: string
  upstream?: string
  url?: string
  status?: number
  ok?: boolean
  elapsedMs?: number
  errorCode?: string
  errorMessage?: string
  model?: string
  command?: string
  details?: Record<string, unknown>
}

export class CabinLogger {
  private readonly filePath: string
  private readonly enabled: boolean

  constructor(config: ServerConfig) {
    this.filePath = config.cabin.logFile || join(config.rootDir, 'logs', 'cabin.jsonl')
    this.enabled = config.cabin.logEnabled !== false
  }

  createRequestId(): string {
    return `req_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  }

  log(event: CabinLogEvent): void {
    if (!this.enabled) return
    const payload = {
      time: new Date().toISOString(),
      level: event.level || (event.ok === false ? 'error' : 'info'),
      type: event.type,
      request_id: event.requestId,
      tablet_id: event.tabletId,
      seat_no: event.seatNo,
      flight_id: event.flightId,
      conversation_id: event.conversationId,
      method: event.method,
      path: event.path,
      endpoint: event.endpoint,
      upstream: event.upstream,
      status: event.status,
      ok: event.ok,
      elapsed_ms: event.elapsedMs,
      error_code: event.errorCode,
      model: event.model,
      command: event.command,
      details: event.details,
      ...(event.url ? { url: sanitizeUrl(event.url) } : {}),
      ...(event.errorMessage ? { error_message: truncate(event.errorMessage, 600) } : {}),
    }
    void this.append(payload)
  }

  private async append(payload: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await appendFile(this.filePath, `${JSON.stringify(payload)}\n`, 'utf8')
    } catch (error) {
      console.warn('[CabinLogger] Failed to write cabin log:', error)
    }
  }
}

export function summarizeContext(context?: CabinLogContext): CabinLogContext {
  if (!context) return {}
  return {
    requestId: context.requestId,
    tabletId: context.tabletId,
    seatNo: context.seatNo,
    flightId: context.flightId,
    conversationId: context.conversationId,
  }
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value)
    for (const key of Array.from(url.searchParams.keys())) {
      if (/token|authorization|auth|key|secret|password/i.test(key)) {
        url.searchParams.set(key, '[redacted]')
      }
    }
    return url.toString()
  } catch {
    return value.replace(/([?&][^=]*(?:token|authorization|auth|key|secret|password)[^=]*=)[^&]+/gi, '$1[redacted]')
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value
}
