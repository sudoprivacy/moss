import type { IncomingMessage } from 'node:http'
import type { DbDriver } from '../db/driver.js'
import { ParkApiError } from './parkAuthorization.js'

/** Shared plumbing for the park route dispatchers (user side + agent side). */

export type ParkRouteResult = { status: number; body: unknown } | null

export type ParkVectorSearchOptions = { modelId: string; cacheDir: string; mirror?: string }

export type ParkApiDeps = {
  driver: DbDriver
  /** Optional vector arm for policy.search; omit for grep-only (test default). */
  vectorSearchOptions?: ParkVectorSearchOptions | null
}

export async function readParkBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/** Map ParkApiError (and unknown errors) to an HTTP result shape. */
export function parkErrorToResponse(err: unknown): { status: number; body: unknown } {
  if (err instanceof ParkApiError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message } } }
  }
  const message = err instanceof Error ? err.message : String(err)
  return { status: 500, body: { error: { code: 'internal', message } } }
}
