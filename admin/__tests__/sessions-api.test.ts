import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

type Call = { path: string }

class ApiRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

let calls: Call[] = []
let responses = new Map<string, unknown>()

const dcClient = {
  async get<T>(path: string): Promise<T> {
    calls.push({ path })
    const response = responses.get(path)
    if (response instanceof Error) throw response
    if (response === undefined) throw new Error(`Unexpected GET ${path}`)
    return response as T
  },
}

mock.module('../lib/api/client', () => ({ ApiRequestError, dcClient }))

let sessions: typeof import('../lib/api/sessions')

beforeAll(async () => {
  sessions = await import('../lib/api/sessions')
})

beforeEach(() => {
  calls = []
  responses = new Map()
})

describe('session context', () => {
  test('keeps a committed session visible when it has no transcript', async () => {
    responses.set('/api/v1/sessions/session-a/context', new ApiRequestError(404, 'Session context not found'))
    responses.set('/api/v1/sessions/session-a', { session: { sessionId: 'session-a' } })

    const result = await sessions.getSessionContext('session-a')

    expect(result.session).toEqual({ sessionId: 'session-a' })
    expect(result.context.messages).toEqual([])
    expect(result.usage.totalTokens).toBe(0)
    expect(calls).toEqual([
      { path: '/api/v1/sessions/session-a/context' },
      { path: '/api/v1/sessions/session-a' },
    ])
  })

  test('preserves a genuine missing-session failure', async () => {
    responses.set('/api/v1/sessions/missing/context', new ApiRequestError(404, 'Session context not found'))
    responses.set('/api/v1/sessions/missing', new ApiRequestError(404, 'Session not found'))

    await expect(sessions.getSessionContext('missing')).rejects.toMatchObject({
      status: 404,
      message: 'Session not found',
    })
  })

  test('does not hide context authorization or transport failures', async () => {
    responses.set('/api/v1/sessions/session-a/context', new ApiRequestError(403, 'Forbidden'))

    await expect(sessions.getSessionContext('session-a')).rejects.toMatchObject({
      status: 403,
      message: 'Forbidden',
    })
    expect(calls).toEqual([{ path: '/api/v1/sessions/session-a/context' }])
  })
})
