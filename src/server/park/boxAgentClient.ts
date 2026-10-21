import http from 'node:http'
import { HttpError } from '../httpError.js'

export interface BoxTask {
  id: string
  action: string
  status: 'queued' | 'running' | 'verifying' | 'recovering' | 'succeeded' | 'failed'
  phase: string
  result?: unknown
  error?: string
  recovery_error?: string
}

/** Fixed protocol to the independent container; never transports shell commands. */
export class BoxAgentClient {
  constructor(private readonly socketPath: string) {}

  request<T>(path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const request = http.request({ socketPath: this.socketPath, path, method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(JSON.stringify(body)) } : undefined }, response => {
        let value = ''
        response.on('data', chunk => { value += String(chunk); if (value.length > 2_000_000) response.destroy() })
        response.on('error', () => reject(new HttpError(502, 'Box agent response was interrupted')))
        response.on('end', () => {
          try {
            const parsed = JSON.parse(value) as T & { error?: string }
            if ((response.statusCode ?? 500) >= 400) reject(new HttpError(response.statusCode!, parsed.error ?? 'Box agent request failed'))
            else resolve(parsed)
          } catch { reject(new HttpError(502, 'Invalid box agent response')) }
        })
      })
      request.setTimeout(10_000, () => request.destroy(new Error('timeout')))
      request.on('error', () => reject(new HttpError(503, 'Box agent is unavailable; check the operations container and shared socket')))
      request.end(body ? JSON.stringify(body) : undefined)
    })
  }
}
