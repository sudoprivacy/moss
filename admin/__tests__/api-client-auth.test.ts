import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { loginWithPhone, requestPhoneCode } from '../lib/api/auth'
import {
  ApiClient,
  ApiRequestError,
  UNAUTHORIZED_EVENT,
  getRefreshToken,
  getToken,
  setRefreshToken,
  setToken,
  setTokenExpiresAt,
} from '../lib/api/client'

const originalFetch = globalThis.fetch
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

function installSession() {
  const browser = new EventTarget()
  const storage = new MemoryStorage()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  setToken('access-old')
  setRefreshToken('refresh-old')
  setTokenExpiresAt(Date.now() + 3_600_000)
  let unauthorized = 0
  browser.addEventListener(UNAUTHORIZED_EVENT, () => { unauthorized++ })
  return { browser, storage, unauthorized: () => unauthorized }
}

function refreshedSession() {
  return {
    access_token: 'access-new',
    refresh_token: 'refresh-new',
    expires_in: 3600,
    user: { id: 'root', orgId: 'org-a', role: 'super_admin' },
    organization: { id: 'org-b' },
    scopes: ['*'],
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

test('a domain 401 forces one refresh even when the access token is not near expiry', async () => {
  const session = installSession()
  const calls: string[] = []
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/api/v1/auth/token')) return Response.json(refreshedSession())
    const authorization = new Headers(init?.headers).get('Authorization')
    if (authorization === 'Bearer access-old') return Response.json({ error: 'expired' }, { status: 401 })
    return Response.json({ ok: true })
  }) as typeof fetch

  assert.deepEqual(await new ApiClient('http://moss.test').get('/resource'), { ok: true })
  assert.equal(calls.filter(url => url.endsWith('/api/v1/auth/token')).length, 1)
  assert.equal(getToken(), 'access-new')
  assert.equal(getRefreshToken(), 'refresh-new')
  assert.equal(session.unauthorized(), 0)
})

test('an explicitly rejected refresh clears the session and emits one logout event', async () => {
  const session = installSession()
  globalThis.fetch = (async (input) => String(input).endsWith('/api/v1/auth/token')
    ? Response.json({ error: 'invalid refresh' }, { status: 401 })
    : Response.json({ error: 'unauthorized' }, { status: 401 })) as typeof fetch

  await assert.rejects(new ApiClient('http://moss.test').get('/resource'), ApiRequestError)
  assert.equal(getToken(), null)
  assert.equal(getRefreshToken(), null)
  assert.equal(session.unauthorized(), 1)
})

test('refresh network and service failures preserve local credentials', async () => {
  for (const failure of ['network', 'service'] as const) {
    const session = installSession()
    globalThis.fetch = (async (input) => {
      if (!String(input).endsWith('/api/v1/auth/token')) return Response.json({ error: 'unauthorized' }, { status: 401 })
      if (failure === 'network') throw new TypeError('network unavailable')
      return Response.json({ error: 'temporarily unavailable' }, { status: 503 })
    }) as typeof fetch

    await assert.rejects(new ApiClient('http://moss.test').get('/resource'), (error) => {
      assert.ok(error instanceof ApiRequestError)
      assert.equal(error.status, failure === 'network' ? 0 : 503)
      return true
    })
    assert.equal(getToken(), 'access-old')
    assert.equal(getRefreshToken(), 'refresh-old')
    assert.equal(session.unauthorized(), 0)
  }
})

test('a second domain 401 preserves or clears the session according to the raw auth probe', async () => {
  for (const meStatus of [200, 401]) {
    const session = installSession()
    globalThis.fetch = (async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/token')) return Response.json(refreshedSession())
      if (url.endsWith('/api/v1/auth/me')) return Response.json(meStatus === 200 ? { user: { id: 'root' } } : { error: 'invalid' }, { status: meStatus })
      return Response.json({ error: { code: 'USER_NOT_ACTIVE' } }, { status: 401 })
    }) as typeof fetch

    await assert.rejects(new ApiClient('http://moss.test').get('/resource'), (error) => {
      assert.ok(error instanceof ApiRequestError)
      assert.equal(error.code, 'USER_NOT_ACTIVE')
      return true
    })
    assert.equal(getToken(), meStatus === 200 ? 'access-new' : null)
    assert.equal(session.unauthorized(), meStatus === 200 ? 0 : 1)
  }
})

test('concurrent and late old-token 401 responses share the refresh and retry with the current token', async () => {
  const session = installSession()
  let refreshCalls = 0
  let releaseLate!: () => void
  const lateBarrier = new Promise<void>(resolve => { releaseLate = resolve })
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    const authorization = new Headers(init?.headers).get('Authorization')
    if (url.endsWith('/api/v1/auth/token')) {
      refreshCalls++
      await new Promise(resolve => setTimeout(resolve, 5))
      return Response.json(refreshedSession())
    }
    if (url.endsWith('/late') && authorization === 'Bearer access-old') {
      await lateBarrier
      return Response.json({ error: 'late unauthorized' }, { status: 401 })
    }
    if (authorization === 'Bearer access-old') return Response.json({ error: 'unauthorized' }, { status: 401 })
    return Response.json({ path: new URL(url).pathname })
  }) as typeof fetch

  const client = new ApiClient('http://moss.test')
  const late = client.get<{ path: string }>('/late')
  const [first, second] = await Promise.all([
    client.get<{ path: string }>('/first'),
    client.get<{ path: string }>('/second'),
  ])
  releaseLate()
  assert.deepEqual(await late, { path: '/late' })
  assert.deepEqual([first.path, second.path], ['/first', '/second'])
  assert.equal(refreshCalls, 1)
  assert.equal(session.unauthorized(), 0)
})

test('blob requests use the same bounded 401 recovery', async () => {
  const session = installSession()
  let refreshCalls = 0
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (url.endsWith('/api/v1/auth/token')) {
      refreshCalls++
      return Response.json(refreshedSession())
    }
    if (new Headers(init?.headers).get('Authorization') === 'Bearer access-old') {
      return new Response(null, { status: 401 })
    }
    return new Response('report')
  }) as typeof fetch

  assert.equal(await (await new ApiClient('http://moss.test').getBlob('/report')).text(), 'report')
  assert.equal(refreshCalls, 1)
  assert.equal(session.unauthorized(), 0)
})

test('403 responses neither refresh nor clear the session', async () => {
  const session = installSession()
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }) as typeof fetch

  await assert.rejects(new ApiClient('http://moss.test').get('/resource'), (error) => error instanceof ApiRequestError && error.status === 403)
  assert.equal(calls, 1)
  assert.equal(getToken(), 'access-old')
  assert.equal(session.unauthorized(), 0)
})

for (const path of ['/api/v1/auth/login', '/api/v1/moss/auth/login', '/api/v1/auth/token', '/api/v1/auth/send-code']) {
  test(`${path} does not inherit another identity or replay credentials after a 401`, async () => {
    const session = installSession()
    const calls: string[] = []
    globalThis.fetch = (async (input, init) => {
      calls.push(String(input))
      assert.equal(new Headers(init?.headers).get('Authorization'), null)
      return Response.json({ success: false, msg: 'Verification code is incorrect or expired' }, { status: 401 })
    }) as typeof fetch
    await assert.rejects(new ApiClient('http://moss.test').post(path, { phone: '13800138000', code: '123456' }),
      (error) => error instanceof ApiRequestError && error.status === 401 && error.message === 'Verification code is incorrect or expired')
    assert.deepEqual(calls, ['http://moss.test' + path])
    assert.equal(getToken(), 'access-old')
    assert.equal(getRefreshToken(), 'refresh-old')
    assert.equal(session.unauthorized(), 0)
  })
}

test('SMS cooldown retains the server delay and message without refreshing a previous session', async () => {
  installSession()
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return Response.json({ success: false, msg: 'Please wait before sending again', next_send_in: 17 }, { status: 429 })
  }) as typeof fetch
  await assert.rejects(requestPhoneCode('13800138000'), (error) => error instanceof ApiRequestError
    && error.status === 429 && error.retryAfterSeconds === 17 && error.message === 'Please wait before sending again')
  assert.equal(calls, 1)
})

test('SMS success exposes its cooldown without creating a login session', async () => {
  const session = installSession()
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), '/api/v1/auth/send-code')
    assert.deepEqual(JSON.parse(String(init?.body)), { phone: '13800138000' })
    return Response.json({ success: true, next_send_in: 29 })
  }) as typeof fetch
  assert.deepEqual(await requestPhoneCode(' 13800138000 '), { nextSendIn: 29 })
  assert.equal(getToken(), 'access-old')
  assert.equal(session.unauthorized(), 0)
})

test('phone login unwraps the human token pair and retains its real organization and role', async () => {
  installSession()
  const tokens = { ...refreshedSession(), user: { id: 'human-alice', orgId: 'org-a', role: 'user' },
    organization: { id: 'org-a' }, scopes: ['sessions:read'] }
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), '/api/v1/auth/login')
    assert.deepEqual(JSON.parse(String(init?.body)), { phone: '13800138000', code: '123456' })
    assert.equal(new Headers(init?.headers).get('Authorization'), null)
    return Response.json({ success: true, data: tokens })
  }) as typeof fetch
  assert.deepEqual(await loginWithPhone(' 13800138000 ', ' 123456 '), tokens)
  assert.equal(getToken(), 'access-new')
  assert.equal(getRefreshToken(), 'refresh-new')
})

test('a refused or incomplete phone response cannot replace the saved identity', async () => {
  for (const body of [{ success: false, msg: 'Phone login unavailable' },
    { success: true, data: { access_token: 'partial' } },
    { success: true, data: { access_token: true, refresh_token: 'invalid' } }]) {
    installSession()
    globalThis.fetch = (async () => Response.json(body)) as typeof fetch
    await assert.rejects(loginWithPhone('13800138000', '123456'))
    assert.equal(getToken(), 'access-old')
    assert.equal(getRefreshToken(), 'refresh-old')
  }
})
