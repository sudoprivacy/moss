import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { createServer, type IncomingMessage, type Server } from 'http'
import type { AuthProxyRule, AuthProxyServer } from '../authProxy/authProxyServer.js'
import type { NexusClient } from '../nexus/nexusClient.js'
import type { TokenMinter } from '../authProxy/tokenMinter.js'
import { injectMintedToken } from '../authProxy/authInjectors.js'

/**
 * A login-type 凭据 mints an access_token and injects it upstream. Services
 * differ in where they expect it — `Authorization: Bearer`, a bare `Token:`
 * header, or a query param — so the placement is configured per item (scheme +
 * token_param). These pin that placement end to end through the proxy,
 * including the 401 re-mint retry, which must put the fresh token in the same
 * place rather than falling back to Bearer.
 */

describe('injectMintedToken', () => {
  it('defaults to Authorization: Bearer', () => {
    expect(injectMintedToken({}, 't1').headers).toEqual({ Authorization: 'Bearer t1' })
    expect(injectMintedToken({ scheme: 'bearer', prefix: 'Token' }, 't1').headers)
      .toEqual({ Authorization: 'Token t1' })
  })

  it('places the token in a custom header, without a prefix', () => {
    expect(injectMintedToken({ scheme: 'header', tokenParam: 'Token', prefix: 'Bearer' }, 't1'))
      .toEqual({ headers: { Token: 't1' } })
  })

  it('places the token in a query param', () => {
    expect(injectMintedToken({ scheme: 'query', tokenParam: 'access_token' }, 'a b'))
      .toEqual({ headers: {}, url: 'access_token=a%20b' })
  })

  it('falls back to Bearer when header/query has no name', () => {
    expect(injectMintedToken({ scheme: 'header', tokenParam: ' ' }, 't1').headers)
      .toEqual({ Authorization: 'Bearer t1' })
  })
})

type Seen = { headers: IncomingMessage['headers']; url: string }

describe('auth proxy minted-token placement', () => {
  let upstream: Server
  let upstreamPort = 0
  let proxy: AuthProxyServer
  const seen: Seen[] = []
  // Tokens the upstream rejects with 401 (simulates an invalidated session).
  const rejected = new Set<string>()
  let mintCount = 0

  const SESSION = 'session-token'

  function rule(overrides: Partial<AuthProxyRule>): AuthProxyRule {
    return {
      configItemId: 7,
      name: 'rbox',
      urlPattern: `http://127.0.0.1:${upstreamPort}/*`,
      scheme: '',
      bearerPrefix: '',
      scope: 'user',
      orgId: null,
      secretNamespace: 'user:{userId}:rbox',
      entries: [
        { configKey: 'username', name: 'u', required: true },
        { configKey: 'password', name: 'p', required: true },
      ],
      authType: 'script',
      pinyin: 'rbox',
      ...overrides,
    }
  }

  async function call(path: string, headers: Record<string, string> = {}) {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/proxy`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SESSION}`,
        'X-Remote-URL': `http://127.0.0.1:${upstreamPort}${path}`,
        'X-Remote-Method': 'GET',
        ...headers,
      },
    })
    await res.text()
    return res.status
  }

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      seen.push({ headers: req.headers, url: req.url ?? '' })
      const url = new URL(req.url ?? '/', 'http://x')
      const presented = [
        req.headers.token,
        req.headers['x-rbox-token'] as string | undefined,
        req.headers.authorization?.replace(/^\S+ /, ''),
        url.searchParams.get('access_token'),
      ].find(Boolean) as string | undefined
      const ok = presented && !rejected.has(presented)
      res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok }))
    })
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()))
    upstreamPort = (upstream.address() as { port: number }).port

    process.env.MOSS_AUTH_PROXY_PORT = '0'
    const mod = await import(`../authProxy/authProxyServer.js?minted-${Date.now()}`)
    proxy = new mod.AuthProxyServer() as AuthProxyServer
    proxy.setNexusClient({
      getSecret: async (_ns: string, key: string) => ({ value: `${key}-value` }),
    } as unknown as NexusClient)
    const mint = async () => ({ token: `tok${++mintCount}`, expiresAt: Math.floor(Date.now() / 1000) + 3600 })
    let cached: { token: string; expiresAt: number } | null = null
    proxy.setTokenMinter({
      getOrMint: async () => (cached ??= await mint()),
      forceMint: async () => (cached = await mint()),
    } as unknown as TokenMinter)
    await proxy.start()
    proxy.registerToken(SESSION, 'u1', 'org1', null, false, null)
  })

  afterAll(async () => {
    await proxy?.stop()
    await new Promise<void>(r => upstream.close(() => r()))
    delete process.env.MOSS_AUTH_PROXY_PORT
  })

  beforeEach(() => {
    seen.length = 0
  })

  it('keeps Authorization: Bearer for items without a placement (existing rows)', async () => {
    proxy.updateRules([rule({})])
    expect(await call('/a')).toBe(200)
    expect(seen[0].headers.authorization).toMatch(/^Bearer tok\d+$/)
    expect(seen[0].headers.token).toBeUndefined()
  })

  it('injects a custom Token header and does not leak the session bearer', async () => {
    proxy.updateRules([rule({ scheme: 'header', tokenParam: 'Token' })])
    expect(await call('/a', { token: 'from-skill' })).toBe(200)
    expect(seen[0].headers.token).toMatch(/^tok\d+$/)
    // The proxy's own session token must never reach upstream.
    expect(seen[0].headers.authorization).toBeUndefined()
  })

  it('re-mints on 401 and retries with the fresh token in the same header', async () => {
    proxy.updateRules([rule({ scheme: 'header', tokenParam: 'Token' })])
    await call('/warm')
    const stale = seen[0].headers.token as string
    rejected.add(stale)
    seen.length = 0

    expect(await call('/b')).toBe(200)
    expect(seen).toHaveLength(2)
    expect(seen[0].headers.token).toBe(stale)
    expect(seen[1].headers.token).not.toBe(stale)
    expect(seen[1].headers.authorization).toBeUndefined()
  })

  it('injects into the query string and replaces it on retry', async () => {
    proxy.updateRules([rule({ scheme: 'query', tokenParam: 'access_token' })])
    await call('/q?x=1')
    const stale = new URL(seen[0].url, 'http://x').searchParams.get('access_token')!
    rejected.add(stale)
    seen.length = 0

    expect(await call('/q?x=1')).toBe(200)
    expect(seen).toHaveLength(2)
    const retried = new URL(seen[1].url, 'http://x').searchParams
    expect(retried.get('x')).toBe('1')
    expect(retried.getAll('access_token')).toHaveLength(1)
    expect(retried.get('access_token')).not.toBe(stale)
  })

  // One login-type 凭据 whose URL pattern spans several systems: the caller
  // (fetchurl --token-header / --token-query) picks the placement per request.
  it('per-request X-Token-Header overrides the configured placement', async () => {
    proxy.updateRules([rule({})])
    expect(await call('/o', { 'X-Token-Header': 'X-Rbox-Token' })).toBe(200)
    expect(seen[0].headers['x-rbox-token']).toMatch(/^tok\d+$/)
    expect(seen[0].headers.authorization).toBeUndefined()
    // Control headers never reach upstream.
    expect(seen[0].headers['x-token-header']).toBeUndefined()
  })

  it('per-request override survives the 401 re-mint retry', async () => {
    proxy.updateRules([rule({ scheme: 'header', tokenParam: 'Token' })])
    await call('/warm', { 'X-Token-Query': 'access_token' })
    const stale = new URL(seen[0].url, 'http://x').searchParams.get('access_token')!
    expect(seen[0].headers.token).toBeUndefined()
    rejected.add(stale)
    seen.length = 0

    expect(await call('/r', { 'X-Token-Query': 'access_token' })).toBe(200)
    expect(seen).toHaveLength(2)
    const retried = new URL(seen[1].url, 'http://x').searchParams
    expect(retried.getAll('access_token')).toHaveLength(1)
    expect(retried.get('access_token')).not.toBe(stale)
    expect(seen[1].headers['x-token-query']).toBeUndefined()
  })

  it('rejects an invalid or ambiguous per-request override', async () => {
    proxy.updateRules([rule({})])
    expect(await call('/x', { 'X-Token-Header': 'Host' })).toBe(400)
    expect(await call('/x', { 'X-Token-Header': 'bad name' })).toBe(400)
    expect(await call('/x', { 'X-Token-Header': 'Token', 'X-Token-Query': 't' })).toBe(400)
    expect(seen).toHaveLength(0)
  })

  it('rejects a per-request override on a static credential', async () => {
    proxy.updateRules([rule({ authType: 'static', scheme: 'bearer' })])
    expect(await call('/s', { 'X-Token-Header': 'Token' })).toBe(400)
    expect(seen).toHaveLength(0)
  })
})
