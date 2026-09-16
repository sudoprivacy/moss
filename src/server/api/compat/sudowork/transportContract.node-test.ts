import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createSudoworkCompatibilityApp } from './app.js'

function identity() {
  return {
    async loginAdminByPassword() {
      return {
        accessToken: 'access', legacyToken: 'legacy', refreshToken: 'refresh', expiresIn: 7_200,
        user: {
          id: 1, phone: 'admin', nickname: 'Admin', role: 'SUPER_ADMIN', status: 1,
          enterpriseId: 1, enterpriseCode: 'ROOT',
        },
      }
    },
    getActor(token: string) {
      return token === 'access' ? { userId: 'admin', orgId: 'org', role: 'super_admin' } : null
    },
  } as never
}

describe('Sudowork transport contract', () => {
  test('CORS 预检不消耗登录限额，第 11 次同 IP 登录保持旧 429 响应', async () => {
    const counters = new Map<string, number>()
    const app = createSudoworkCompatibilityApp({
      identity: identity(),
      rateLimit: {
        async incrementWithExpiry(key: string) {
          const next = (counters.get(key) ?? 0) + 1
          counters.set(key, next)
          return next
        },
        async ttl() { return 899 },
      },
    } as never)

    const preflight = await app.request('/api/v1/admin/login', {
      method: 'OPTIONS',
      headers: { origin: 'https://client.example', 'access-control-request-method': 'POST' },
    })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*')

    const request = () => app.request('/api/v1/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify({ phone: 'admin', password: 'correct' }),
    })
    for (let index = 0; index < 10; index += 1) assert.equal((await request()).status, 200)
    const blocked = await request()
    assert.equal(blocked.status, 429)
    assert.deepEqual(await blocked.json(), {
      success: false,
      msg: '登录尝试过于频繁，请 15 分钟后再试',
      retry_after: 899,
    })
    assert.equal([...counters.values()].reduce((total, value) => total + value, 0), 11)
  })

  test('CAS HTML、Dify 302、ZIP 文件、SSE 与音频保持非 JSON 传输语义', async () => {
    const app = createSudoworkCompatibilityApp({
      identity: identity(),
      cas: {
        async createHandoff() { return { redirectUrl: 'sudowork://callback?code=one' } },
      } as never,
      catalog: {
        async getArtifact() { return { bytes: Buffer.from('archive'), filename: '技能 包.zip' } },
      } as never,
      difyAdministration: {
        async buildSsoLink() { return { url: 'https://dify.example/sso', expiresAt: 1 } },
      } as never,
      resolveEnterpriseAlias: () => ({ resourceId: 'org', orgId: 'org' }),
      difyRuntime: {
        async chat() { return new Response('data: ok\n\n') },
        async textToAudio() {
          return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/ogg' } })
        },
      } as never,
      difyEnhancement: {} as never,
      buildVisibility: () => ({}) as never,
    })
    const html = await app.request('/api/v1/auth/third-party/cas/callback/main?ticket=ticket')
    assert.match(html.headers.get('content-type') ?? '', /^text\/html/)
    assert.match(await html.text(), /sudowork:\/\/callback\?code=one/)

    const redirect = await app.request('/api/v1/admin/dify/sso?enterprise_id=1&format=redirect', {
      headers: { authorization: 'Bearer access' }, redirect: 'manual',
    })
    assert.equal(redirect.status, 302)
    assert.equal(redirect.headers.get('location'), 'https://dify.example/sso')

    const archive = await app.request('/api/catalog/artifacts/skill/skill-1')
    assert.equal(archive.headers.get('content-type'), 'application/zip')
    assert.match(archive.headers.get('content-disposition') ?? '', /filename\*=UTF-8''/)
    assert.equal(await archive.text(), 'archive')

    const chat = await app.request('/api/v1/agents/agent-1/chat', {
      method: 'POST', headers: { authorization: 'Bearer access', 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'hello' }),
    })
    assert.equal(chat.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    assert.equal(chat.headers.get('x-accel-buffering'), 'no')
    assert.equal(await chat.text(), 'data: ok\n\n')

    const audio = await app.request('/api/v1/agents/agent-1/text-to-audio', {
      method: 'POST', headers: { authorization: 'Bearer access', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    })
    assert.equal(audio.headers.get('content-type'), 'audio/ogg')
    assert.deepEqual([...new Uint8Array(await audio.arrayBuffer())], [1, 2, 3])
  })
})
