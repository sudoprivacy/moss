import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { IdentityActor } from '../identity/organizationIdentityService.js'
import type { VisibilityFilter } from '../visibilityFilter.js'
import type { DifyRuntimeContext } from './difyConnectionService.js'
import { DifyHttpAdapter } from './difyHttpAdapter.js'
import { DifyRuntimeService } from './difyRuntimeService.js'

const actor: IdentityActor = { userId: 'user-a', orgId: 'org-a', role: 'user' }
const visibility: VisibilityFilter = {
  isAdmin: false, userId: 'user-a', departmentId: null, visibleDepartmentIds: new Set(),
}
const runtimeContext: DifyRuntimeContext = {
  orgId: 'org-a', userId: 'user-a', legacyEnterpriseId: 9, legacyUserId: 17,
  endUserId: 'sudowork:9:17', connectionId: 'dify-a', tenantId: 'tenant-a',
  systemAccountId: 'account-a', appId: 'app-a', mode: 'agent-chat',
  apiKey: 'api-key-a', baseUrl: 'https://dify.example.test',
}

function setup(responseFor?: (url: string) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const contexts: string[] = []
  const adapter = new DifyHttpAdapter({
    baseUrl: 'https://dify.example.test', systemToken: 'system', provisionSecret: 'provision',
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      return responseFor?.(url) ?? Response.json({ ok: true })
    }) as typeof fetch,
  })
  const service = new DifyRuntimeService({
    adapter,
    connections: {
      async resolveRuntimeContext(receivedActor, assistantId, receivedVisibility) {
        assert.deepEqual(receivedActor, actor)
        assert.equal(receivedVisibility, visibility)
        contexts.push(assistantId)
        return runtimeContext
      },
    },
  })
  return { service, calls, contexts }
}

describe('DifyRuntimeService', () => {
  test('chat forces the authenticated legacy user and returns upstream SSE bytes unchanged', async () => {
    const upstream = new Response('data: {"event":"message"}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    })
    const { service, calls, contexts } = setup(() => upstream)

    const response = await service.chat({
      actor, visibility, assistantId: 'agent-a', query: 'hello', conversationId: undefined,
      inputs: undefined, files: undefined, autoGenerateName: undefined,
    })

    assert.equal(response, upstream)
    assert.deepEqual(contexts, ['agent-a'])
    assert.equal(calls[0]?.url, 'https://dify.example.test/v1/chat-messages')
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      query: 'hello', conversation_id: '', inputs: {}, files: [],
      user: 'sudowork:9:17', auto_generate_name: true, response_mode: 'streaming',
    })
  })

  test('conversation reads preserve legacy defaults and URL encoding', async () => {
    const { service, calls } = setup()

    await service.listConversations({
      actor, visibility, assistantId: 'agent-a', lastId: 'last/id', limit: undefined, sortBy: undefined,
    })
    await service.listMessages({
      actor, visibility, assistantId: 'agent-a', conversationId: 'conv/a', firstId: undefined, limit: 7,
    })

    assert.equal(calls[0]?.url, 'https://dify.example.test/v1/conversations?user=sudowork%3A9%3A17&last_id=last%2Fid&limit=20&sort_by=-updated_at')
    assert.equal(calls[1]?.url, 'https://dify.example.test/v1/messages?conversation_id=conv%2Fa&user=sudowork%3A9%3A17&limit=7')
  })

  test('all mutation methods overwrite user ownership with the authenticated EndUser', async () => {
    const { service, calls } = setup()

    await service.stopChat({ actor, visibility, assistantId: 'agent-a', taskId: 'task-1' })
    await service.renameConversation({
      actor, visibility, assistantId: 'agent-a', conversationId: 'conv-1', name: undefined, autoGenerate: undefined,
    })
    await service.deleteConversation({ actor, visibility, assistantId: 'agent-a', conversationId: 'conv-1' })
    await service.feedback({
      actor, visibility, assistantId: 'agent-a', messageId: 'msg-1', rating: 'like', content: undefined,
    })

    assert.deepEqual(calls.map(call => JSON.parse(String(call.init.body))), [
      { user: 'sudowork:9:17' },
      { user: 'sudowork:9:17', name: null, auto_generate: false },
      { user: 'sudowork:9:17' },
      { user: 'sudowork:9:17', rating: 'like', content: null },
    ])
  })

  test('supports app metadata, file, speech-to-text and raw text-to-audio contracts', async () => {
    const audio = new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mpeg' } })
    const { service, calls } = setup(url => url.endsWith('/v1/text-to-audio') ? audio : Response.json({ ok: true }))

    await service.parameters({ actor, visibility, assistantId: 'agent-a' })
    await service.meta({ actor, visibility, assistantId: 'agent-a' })
    await service.suggested({ actor, visibility, assistantId: 'agent-a', messageId: 'msg-1' })
    await service.uploadFile({
      actor, visibility, assistantId: 'agent-a', fileName: 'a.txt', contentType: 'text/plain', bytes: new TextEncoder().encode('a'),
    })
    await service.audioToText({
      actor, visibility, assistantId: 'agent-a', fileName: 'a.mp3', contentType: 'audio/mpeg', bytes: new Uint8Array([1]),
    })
    const result = await service.textToAudio({
      actor, visibility, assistantId: 'agent-a', messageId: undefined, text: 'hello', voice: undefined, streaming: undefined,
    })

    assert.equal(calls[0]?.url.endsWith('/v1/parameters'), true)
    assert.equal(calls[1]?.url.endsWith('/v1/meta'), true)
    assert.equal(calls[2]?.url.endsWith('/v1/messages/msg-1/suggested?user=sudowork%3A9%3A17'), true)
    assert.equal((calls[3]?.init.body as FormData).get('user'), 'sudowork:9:17')
    assert.equal((calls[4]?.init.body as FormData).get('user'), 'sudowork:9:17')
    assert.equal(result, audio)
    assert.deepEqual(JSON.parse(String(calls[5]?.init.body)), {
      user: 'sudowork:9:17', message_id: null, text: 'hello', voice: null, streaming: false,
    })
  })
})
