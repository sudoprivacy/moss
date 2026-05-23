/* eslint-disable eslint-plugin-n/no-unsupported-features/node-builtins */

import { z } from 'zod/v4'
import { errorMessage } from '../utils/errors.js'
import { jsonStringify } from '../utils/slowOperations.js'
import type { DirectConnectConfig } from './directConnectManager.js'
import {
  attachSessionResponseSchema,
  connectResponseSchema,
} from './types.js'
import { resolveDirectConnectAccessToken } from './client/authClient.js'
import type { SessionRuntimeOptions } from './sessionManager.js'

type AttachSessionResponse = z.infer<
  ReturnType<typeof attachSessionResponseSchema>
>

/**
 * Errors thrown by createDirectConnectSession when the connection fails.
 */
export class DirectConnectError extends Error {
  readonly statusCode?: number

  constructor(message: string, statusCode?: number) {
    super(message)
    this.name = 'DirectConnectError'
    this.statusCode = statusCode
  }
}

async function formatErrorResponse(
  prefix: string,
  resp: Response,
): Promise<string> {
  let detail = ''
  try {
    const text = await resp.text()
    if (text.trim()) {
      try {
        const parsed = JSON.parse(text) as { error?: unknown }
        if (typeof parsed.error === 'string' && parsed.error.trim()) {
          detail = parsed.error.trim()
        } else {
          detail = text.trim()
        }
      } catch {
        detail = text.trim()
      }
    }
  } catch {}
  return detail
    ? `${prefix}: ${resp.status} ${resp.statusText}: ${detail}`
    : `${prefix}: ${resp.status} ${resp.statusText}`
}

async function resolveDirectConnectHeaders(options: {
  authToken?: string
  serverUrl: string
  apiKey?: string
  username?: string
  email?: string
  password?: string
}): Promise<{
  headers: Record<string, string>
  resolvedToken?: string
}> {
  const resolvedToken = await resolveDirectConnectAccessToken(options)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (resolvedToken) {
    headers['authorization'] = `Bearer ${resolvedToken}`
  }
  return {
    headers,
    resolvedToken,
  }
}

/**
 * Create a session on a direct-connect server.
 *
 * Posts to `${serverUrl}/api/v1/sessions`, validates the response, and returns
 * a DirectConnectConfig ready for use by the REPL or headless runner.
 *
 * Throws DirectConnectError on network, HTTP, or response-parsing failures.
 */
export async function createDirectConnectSession({
  serverUrl,
  authToken,
  apiKey,
  username,
  email,
  password,
  cwd,
  dangerouslySkipPermissions,
  runtime,
  assistantName,
}: {
  serverUrl: string
  authToken?: string
  apiKey?: string
  username?: string
  email?: string
  password?: string
  cwd: string
  dangerouslySkipPermissions?: boolean
  runtime?: SessionRuntimeOptions
  assistantName?: string
}): Promise<{
  config: DirectConnectConfig
  workDir?: string
}> {
  const { headers, resolvedToken } = await resolveDirectConnectHeaders({
    authToken,
    serverUrl,
    apiKey,
    username,
    email,
    password,
  })

  let resp: Response
  try {
    resp = await fetch(`${serverUrl}/api/v1/sessions`, {
      method: 'POST',
      headers,
      body: jsonStringify({
        cwd,
        ...(dangerouslySkipPermissions && {
          dangerously_skip_permissions: true,
        }),
        ...(runtime ? { runtime } : {}),
        ...(assistantName && { assistant_name: assistantName }),
      }),
    })
  } catch (err) {
    throw new DirectConnectError(
      `Failed to connect to server at ${serverUrl}: ${errorMessage(err)}`,
    )
  }

  if (!resp.ok) {
    throw new DirectConnectError(
      await formatErrorResponse('Failed to create session', resp),
      resp.status,
    )
  }

  const result = connectResponseSchema().safeParse(await resp.json())
  if (!result.success) {
    throw new DirectConnectError(
      `Invalid session response: ${result.error.message}`,
    )
  }

  const data = result.data
  return {
    config: {
      serverUrl,
      sessionId: data.session_id,
      wsUrl: data.ws_url,
      authToken: resolvedToken,
    },
    workDir: data.work_dir,
  }
}

export async function attachDirectConnectSession({
  serverUrl,
  sessionId,
  authToken,
  apiKey,
  username,
  email,
  password,
}: {
  serverUrl: string
  sessionId: string
  authToken?: string
  apiKey?: string
  username?: string
  email?: string
  password?: string
}): Promise<{
  config: DirectConnectConfig
  workDir?: string
  session: AttachSessionResponse['session']
}> {
  const { headers, resolvedToken } = await resolveDirectConnectHeaders({
    authToken,
    serverUrl,
    apiKey,
    username,
    email,
    password,
  })

  let resp: Response
  try {
    resp = await fetch(
      `${serverUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: 'GET',
        headers,
      },
    )
  } catch (err) {
    throw new DirectConnectError(
      `Failed to connect to server at ${serverUrl}: ${errorMessage(err)}`,
    )
  }

  if (!resp.ok) {
    throw new DirectConnectError(
      await formatErrorResponse(
        `Failed to attach session ${sessionId}`,
        resp,
      ),
      resp.status,
    )
  }

  const result = attachSessionResponseSchema().safeParse(await resp.json())
  if (!result.success) {
    throw new DirectConnectError(
      `Invalid session attach response: ${result.error.message}`,
    )
  }

  const data = result.data
  return {
    config: {
      serverUrl,
      sessionId: data.session.sessionId,
      wsUrl: data.ws_url,
      authToken: resolvedToken,
    },
    workDir: data.session.workDir,
    session: data.session,
  }
}
