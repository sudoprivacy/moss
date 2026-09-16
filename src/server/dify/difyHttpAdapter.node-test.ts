import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { describe, test } from 'node:test'
import { DifyHttpAdapter, DifyProviderError } from './difyHttpAdapter.js'

type Captured = { url: string; init: RequestInit }

function fakeFetch(response: Response, captured: Captured[], preserveResponse = false): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {} })
    return preserveResponse ? response : response.clone()
  }) as typeof fetch
}

describe('DifyHttpAdapter', () => {
  test('provision signs the exact JSON bytes and does not send a bearer token', async () => {
    const captured: Captured[] = []
    const adapter = new DifyHttpAdapter({
      baseUrl: 'https://dify.example.test/',
      systemToken: 'system-token',
      provisionSecret: 'provision-secret',
      fetchImpl: fakeFetch(Response.json({ dify_tenant_id: 'tenant-1', system_account_id: 'account-1', service_api_key: 'key-1' }), captured),
    })

    await adapter.provisionTenant({ enterpriseCode: 'ENT-A', enterpriseName: '企业 A' })

    assert.equal(captured[0]?.url, 'https://dify.example.test/sudowork/system/tenants')
    const body = JSON.stringify({ enterprise_code: 'ENT-A', enterprise_name: '企业 A' })
    assert.equal(captured[0]?.init.body, body)
    const headers = new Headers(captured[0]?.init.headers)
    assert.equal(headers.get('X-Sudowork-Signature'), createHmac('sha256', 'provision-secret').update(body).digest('hex'))
    assert.equal(headers.get('Authorization'), null)
  })

  test('system calls carry tenant and actor headers while service calls carry only the app key', async () => {
    const captured: Captured[] = []
    const adapter = new DifyHttpAdapter({
      baseUrl: 'https://dify.example.test', systemToken: 'system-token', provisionSecret: 'secret',
      fetchImpl: fakeFetch(Response.json({ ok: true }), captured),
    })

    await adapter.systemJson('tenant-1', 'POST', '/sudowork/system/apps', { name: 'Agent' }, 'account-1')
    await adapter.serviceJson('app-secret', 'GET', '/v1/meta')

    const systemHeaders = new Headers(captured[0]?.init.headers)
    assert.equal(systemHeaders.get('Authorization'), 'Bearer system-token')
    assert.equal(systemHeaders.get('X-Sudowork-Tenant'), 'tenant-1')
    assert.equal(systemHeaders.get('X-Sudowork-Actor'), 'account-1')
    const serviceHeaders = new Headers(captured[1]?.init.headers)
    assert.equal(serviceHeaders.get('Authorization'), 'Bearer app-secret')
    assert.equal(serviceHeaders.get('X-Sudowork-Tenant'), null)
  })

  test('streaming calls return the original body and force streaming mode', async () => {
    const captured: Captured[] = []
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: first\n\n'))
        controller.close()
      },
    })
    const upstream = new Response(source, { headers: { 'Content-Type': 'text/event-stream', 'X-Dify-Upstream': 'yes' } })
    const adapter = new DifyHttpAdapter({
      baseUrl: 'https://dify.example.test', systemToken: 'system-token', provisionSecret: 'secret',
      fetchImpl: fakeFetch(upstream, captured, true), streamTimeoutMs: 1_000,
    })

    const result = await adapter.streamChat('app-secret', { query: 'hello', response_mode: 'blocking' })

    assert.equal(result.body, upstream.body)
    assert.equal(JSON.parse(String(captured[0]?.init.body)).response_mode, 'streaming')
    assert(captured[0]?.init.signal instanceof AbortSignal)
  })

  test('raw calls preserve non-success responses for the compatibility route to serialize', async () => {
    const upstream = new Response('upstream rejected', { status: 429, headers: { 'Retry-After': '3' } })
    const adapter = new DifyHttpAdapter({
      baseUrl: 'https://dify.example.test', systemToken: 'system-token', provisionSecret: 'secret',
      fetchImpl: fakeFetch(upstream, [], true),
    })

    const result = await adapter.serviceRaw('app-secret', 'POST', '/v1/text-to-audio', { text: 'hello' })

    assert.equal(result, upstream)
    assert.equal(result.status, 429)
    assert.equal(await result.text(), 'upstream rejected')
  })

  test('multipart injection owns the user field and preserves file bytes', async () => {
    const captured: Captured[] = []
    const adapter = new DifyHttpAdapter({
      baseUrl: 'https://dify.example.test', systemToken: 'system-token', provisionSecret: 'secret',
      fetchImpl: fakeFetch(Response.json({ id: 'file-1' }), captured),
    })

    await adapter.uploadServiceFile('app-secret', '/v1/files/upload', {
      user: 'sudowork:9:17', fileName: 'a.txt', contentType: 'text/plain', bytes: new TextEncoder().encode('abc'),
    })

    const form = captured[0]?.init.body as FormData
    assert.equal(form.get('user'), 'sudowork:9:17')
    assert.equal(await (form.get('file') as File).text(), 'abc')
    assert.equal(new Headers(captured[0]?.init.headers).has('content-type'), false)
  })

  test('non-success responses expose status and sanitized detail without credentials', async () => {
    const adapter = new DifyHttpAdapter({
      baseUrl: 'https://dify.example.test', systemToken: 'system-secret-token', provisionSecret: 'secret',
      fetchImpl: fakeFetch(Response.json({ message: 'bad request' }, { status: 422 }), []),
    })

    await assert.rejects(
      () => adapter.serviceJson('app-secret-value', 'POST', '/v1/chat-messages', { query: 'x' }),
      (error: unknown) => {
        assert(error instanceof DifyProviderError)
        assert.equal(error.status, 422)
        assert.deepEqual(error.detail, { message: 'bad request' })
        assert.equal(error.message.includes('app-secret-value'), false)
        assert.equal(error.message.includes('system-secret-token'), false)
        return true
      },
    )
  })
})
