import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { describe, test } from 'node:test'
import type { DifyRuntimeService } from '../../../dify/difyRuntimeService.js'
import type { DifyEnhancementService } from '../../../dify/difyEnhancementService.js'
import { registerSudoworkDifyRuntimeRoutes } from './difyRoutes.js'

const actor = { userId: 'user-a', orgId: 'org-a', role: 'user' }
const visibility = { isAdmin: false, userId: 'user-a', departmentId: null, visibleDepartmentIds: new Set<string>() }

function createRuntime(overrides: Partial<Record<keyof DifyRuntimeService, (...args: any[]) => any>> = {}) {
  const ok = async () => ({ value: 'ok' })
  return {
    chat: async () => new Response('data: first\n\n'),
    stopChat: ok,
    listConversations: ok,
    renameConversation: ok,
    deleteConversation: async () => undefined,
    listMessages: ok,
    feedback: ok,
    suggested: ok,
    parameters: ok,
    meta: ok,
    uploadFile: ok,
    audioToText: ok,
    textToAudio: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/ogg' } }),
    ...overrides,
  } as unknown as DifyRuntimeService
}

function createEnhancement() {
  return {
    describe: () => ({ enabled: true, mode: 'workflow' }),
    invokeBlocking: async () => ({ text: 'enhanced', mode: 'workflow', elapsedMs: 10 }),
    async *invokeStreaming() {
      yield { kind: 'progress', step: '检索' }
      yield { kind: 'result', text: 'enhanced', mode: 'workflow', elapsedMs: 10 }
    },
  } as unknown as DifyEnhancementService
}

function setup(runtime = createRuntime(), enhancement = createEnhancement()) {
  const app = new Hono()
  registerSudoworkDifyRuntimeRoutes(app, {
    runtime,
    enhancement,
    getActor: authorization => authorization === 'Bearer access-token' ? actor : null,
    buildVisibility: received => {
      assert.deepEqual(received, actor)
      return visibility
    },
    upstreamBaseUrl: 'https://dify.example.test',
  })
  return app
}

describe('Sudowork Dify runtime compatibility routes', () => {
  test('registers all 16 Dify runtime and enhancement routes', () => {
    const app = setup()
    const actual = new Set(app.routes.map(route => `${route.method} ${route.path}`))
    const expected = [
      'POST /api/v1/agents/:assistantId/chat',
      'POST /api/v1/agents/:assistantId/chat/:taskId/stop',
      'GET /api/v1/agents/:assistantId/conversations',
      'PATCH /api/v1/agents/:assistantId/conversations/:conversationId',
      'DELETE /api/v1/agents/:assistantId/conversations/:conversationId',
      'GET /api/v1/agents/:assistantId/conversations/:conversationId/messages',
      'POST /api/v1/agents/:assistantId/messages/:messageId/feedback',
      'GET /api/v1/agents/:assistantId/messages/:messageId/suggested',
      'GET /api/v1/agents/:assistantId/parameters',
      'GET /api/v1/agents/:assistantId/meta',
      'POST /api/v1/agents/:assistantId/files',
      'POST /api/v1/agents/:assistantId/audio-to-text',
      'POST /api/v1/agents/:assistantId/text-to-audio',
      'GET /api/v1/agents/:assistantId/enhancement',
      'POST /api/v1/agents/:assistantId/enhancement/invoke',
      'POST /api/v1/agents/:assistantId/enhancement/invoke-stream',
    ]
    assert.equal(expected.length, 16)
    for (const route of expected) assert(actual.has(route), `missing route: ${route}`)
  })

  test('keeps enhancement probe, blocking result and encoded SSE events', async () => {
    const app = setup()
    const headers = { authorization: 'Bearer access-token' }
    const probe = await app.request('/api/v1/agents/agent-a/enhancement', { headers })
    assert.deepEqual(await probe.json(), { success: true, data: { enabled: true, mode: 'workflow' } })

    const invalid = await app.request('/api/v1/agents/agent-a/enhancement/invoke', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(invalid.status, 400)
    assert.deepEqual(await invalid.json(), { success: false, msg: 'query is required' })

    const blocking = await app.request('/api/v1/agents/agent-a/enhancement/invoke', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'hello' }),
    })
    assert.deepEqual(await blocking.json(), {
      success: true, data: { text: 'enhanced', mode: 'workflow', elapsedMs: 10 },
    })

    const streaming = await app.request('/api/v1/agents/agent-a/enhancement/invoke-stream', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'hello' }),
    })
    assert.equal(streaming.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    assert.equal(await streaming.text(), [
      'event: progress\ndata: {"kind":"progress","step":"检索"}\n\n',
      'event: result\ndata: {"kind":"result","text":"enhanced","mode":"workflow","elapsedMs":10}\n\n',
    ].join(''))
  })

  test('keeps Dify authentication and request validation errors', async () => {
    const app = setup()
    const unauthorized = await app.request('/api/v1/agents/agent-a/meta')
    assert.equal(unauthorized.status, 401)
    assert.deepEqual(await unauthorized.json(), { success: false, msg: '未授权，请先登录' })

    const invalidChat = await app.request('/api/v1/agents/agent-a/chat', {
      method: 'POST', headers: { authorization: 'Bearer access-token', 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(invalidChat.status, 400)
    assert.deepEqual(await invalidChat.json(), { success: false, msg: 'query is required' })
  })

  test('forwards chat bytes and legacy SSE headers without buffering', async () => {
    const received: Array<Record<string, unknown>> = []
    const upstream = new Response('data: first\n\ndata: second\n\n')
    const app = setup(createRuntime({ chat: async input => {
      received.push(input)
      return upstream
    } }))

    const response = await app.request('/api/v1/agents/agent-a/chat', {
      method: 'POST',
      headers: { authorization: 'Bearer access-token', 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'hello', user: 'spoofed' }),
    })

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform')
    assert.equal(response.headers.get('x-accel-buffering'), 'no')
    assert.equal(response.headers.get('x-dify-upstream'), 'https://dify.example.test')
    assert.equal(await response.text(), 'data: first\n\ndata: second\n\n')
    assert.equal(received[0]?.actor, actor)
    assert.equal(received[0]?.visibility, visibility)
    assert.equal('user' in (received[0] ?? {}), false)
  })

  test('keeps upstream chat failures in the old status and body shape', async () => {
    const app = setup(createRuntime({
      chat: async () => new Response('rate limited', { status: 429 }),
    }))
    const response = await app.request('/api/v1/agents/agent-a/chat', {
      method: 'POST', headers: { authorization: 'Bearer access-token', 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'hello' }),
    })
    assert.equal(response.status, 429)
    assert.deepEqual(await response.json(), { success: false, status: 429, msg: 'rate limited' })
  })

  test('wraps JSON operations and preserves multipart and binary media', async () => {
    const calls: Array<Record<string, unknown>> = []
    const app = setup(createRuntime({
      listConversations: async input => { calls.push(input); return { data: [{ id: 'conv-1' }] } },
      uploadFile: async input => { calls.push(input); return { id: 'file-1' } },
      textToAudio: async input => {
        calls.push(input)
        return new Response(new Uint8Array([4, 5, 6]), { headers: { 'Content-Type': 'audio/ogg' } })
      },
    }))

    const conversations = await app.request('/api/v1/agents/agent-a/conversations?limit=5', {
      headers: { authorization: 'Bearer access-token' },
    })
    assert.deepEqual(await conversations.json(), { success: true, data: { data: [{ id: 'conv-1' }] } })

    const form = new FormData()
    form.set('file', new File(['abc'], 'a.txt', { type: 'text/plain' }))
    const upload = await app.request('/api/v1/agents/agent-a/files', {
      method: 'POST', headers: { authorization: 'Bearer access-token' }, body: form,
    })
    assert.deepEqual(await upload.json(), { success: true, data: { id: 'file-1' } })
    assert.equal(calls[1]?.fileName, 'a.txt')

    const audio = await app.request('/api/v1/agents/agent-a/text-to-audio', {
      method: 'POST', headers: { authorization: 'Bearer access-token', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    })
    assert.equal(audio.headers.get('content-type'), 'audio/ogg')
    assert.deepEqual([...new Uint8Array(await audio.arrayBuffer())], [4, 5, 6])
  })
})
