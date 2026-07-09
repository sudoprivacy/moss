import { basename } from 'path'
import { readFile } from 'fs/promises'

import type { CabinConfig } from './types.js'
import { fetchWithTimeout } from './http.js'

export type CabinBroadcastResult = {
  ok: boolean
  skipped?: boolean
  status?: number
  payload?: unknown
  elapsedMs: number
  error?: string
  url?: string
}

export class CabinBroadcastClient {
  constructor(private readonly config: CabinConfig) {}

  isConfigured(): boolean {
    return this.config.broadcastEnabled !== false &&
      Boolean(this.baseUrl()) &&
      Boolean(this.config.broadcastApiKey)
  }

  async sendAudioAll(input: {
    aircraftNo: string
    title: string
    filePath: string
  }): Promise<CabinBroadcastResult> {
    const baseUrl = this.baseUrl()
    if (!this.isConfigured() || !baseUrl) {
      return { ok: false, skipped: true, elapsedMs: 0, error: 'broadcast API is not configured' }
    }
    const url = `${baseUrl}/admin-api/cabin/broadcast/audio-all`
    const start = Date.now()
    try {
      const audio = await readFile(input.filePath)
      const form = new FormData()
      form.set('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), basename(input.filePath))
      form.set('title', input.title)
      form.set('aircraftNo', input.aircraftNo)
      const response = await fetchWithTimeout(fetch, url, {
        method: 'POST',
        headers: this.headers(),
        body: form,
      }, this.config.controlTimeoutMs ?? 10_000, 'broadcast audio-all')
      const payload = await parseResponse(response)
      return {
        ok: response.ok && isOkEnvelope(payload),
        status: response.status,
        payload,
        elapsedMs: Date.now() - start,
        url,
      }
    } catch (error) {
      return {
        ok: false,
        elapsedMs: Date.now() - start,
        error: stringifyError(error),
        url,
      }
    }
  }

  async sendErrorSeat(input: {
    aircraftNo: string
    seatNo: string
    title: string
    content: string
  }): Promise<CabinBroadcastResult> {
    const baseUrl = this.baseUrl()
    if (!this.isConfigured() || !baseUrl) {
      return { ok: false, skipped: true, elapsedMs: 0, error: 'broadcast API is not configured' }
    }
    const url = `${baseUrl}/admin-api/cabin/broadcast/error-seat`
    const start = Date.now()
    try {
      const response = await fetchWithTimeout(fetch, url, {
        method: 'POST',
        headers: {
          ...this.headers(),
          'content-type': 'application/json',
        },
        body: JSON.stringify(input),
      }, this.config.controlTimeoutMs ?? 10_000, 'broadcast error-seat')
      const payload = await parseResponse(response)
      return {
        ok: response.ok && isOkEnvelope(payload),
        status: response.status,
        payload,
        elapsedMs: Date.now() - start,
        url,
      }
    } catch (error) {
      return {
        ok: false,
        elapsedMs: Date.now() - start,
        error: stringifyError(error),
        url,
      }
    }
  }

  private baseUrl(): string | null {
    const baseUrl = this.config.broadcastApiBaseUrl || this.config.controlBaseUrl
    return baseUrl ? baseUrl.replace(/\/+$/, '') : null
  }

  private headers(): Record<string, string> {
    return {
      'x-hardware-api-key': this.config.broadcastApiKey || '',
      ...(this.config.broadcastAuth || this.config.controlAuth
        ? { authorization: this.config.broadcastAuth || this.config.controlAuth! }
        : {}),
    }
  }
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function isOkEnvelope(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return true
  const code = (payload as Record<string, unknown>).code
  return code === undefined || code === 0 || code === '0'
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
