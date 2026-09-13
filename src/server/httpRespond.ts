// Extracted from server.ts for testability: importing the whole server.js
// pulls in node:sqlite (bun cannot load it) AND bun:bundle (node cannot load
// it), so its unit tests ran under neither runner. This module may transitively
// reach node:sqlite (via ServerDrainingError's home in runtimeService.ts), so
// it is Node-loadable only — that is fine for its sole test (lbDraining, which
// already needs node:sqlite for DirectConnectStore and therefore runs under
// `tsx --test`).
import type http from 'http'
import { ServerDrainingError } from './runtimeService.js'
import { AuthServiceError } from './auth/service.js'
import type { ServerLogger } from './serverLog.js'

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export function writeJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

// Exported for unit testing the ServerDrainingError → 503 mapping (same
// test-only export convention as computeReadiness / setRouteCookieHeader).
export function writeError(
  logger: ServerLogger,
  res: http.ServerResponse,
  error: unknown,
): void {
  // Graceful drain: reject during the SIGTERM grace window with 503 (instance
  // unavailable). Kept as the first check and before the fallback 500 below so
  // ServerDrainingError never degrades to a 500. Flat `{ error: <string> }`
  // matches every other writeError branch.
  if (error instanceof ServerDrainingError) {
    writeJson(res, 503, { error: error.message })
    return
  }
  if (error instanceof AuthServiceError || error instanceof HttpError) {
    writeJson(res, error.statusCode, { error: error.message })
    return
  }

  logger.error(error instanceof Error ? error.message : String(error))
  writeJson(res, 500, {
    error: error instanceof Error ? error.message : String(error),
  })
}
