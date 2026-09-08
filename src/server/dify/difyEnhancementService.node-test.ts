import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { IdentityActor } from '../identity/organizationIdentityService.js'
import type { VisibilityFilter } from '../visibilityFilter.js'
import type { DifyEnhancementContext } from './difyConnectionService.js'
import { DifyEnhancementService } from './difyEnhancementService.js'
import { DifyHttpAdapter } from './difyHttpAdapter.js'

const actor: IdentityActor = { userId: 'user-a', orgId: 'org-a', role: 'user' }
const visibility: VisibilityFilter = {
  isAdmin: false, userId: 'user-a', role: 'user', departmentId: null, visibleDepartmentIds: new Set(),
}
const base: Omit<DifyEnhancementContext, 'appId' | 'mode' | 'appApiKey' | 'datasetIds'> = {
  orgId: 'org-a', userId: 'user-a', legacyEnterpriseId: 9, legacyUserId: 17,
  endUserId: 'sudowork:9:17', connectionId: 'dify-a', tenantId: 'tenant-a',
  systemAccountId: 'account-a', apiKey: 'tenant-key', baseUrl: 'https://dify.example.test',
}

function context(mode: DifyEnhancementContext['mode']): DifyEnhancementContext {
  return {
    ...base,
    mode,
    appId: mode === 'rag-only' || mode === null ? null : 'app-a',
    appApiKey: mode === 'rag-only' || mode === null ? null : 'app-key',
    datasetIds: mode === 'rag-only' ? ['dataset-a', 'dataset-b'] : [],
  }
}

function setup(mode: DifyEnhancementContext['mode'], responder: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const adapter = new DifyHttpAdapter({
    baseUrl: 'https://dify.example.test',
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(input), init: init ?? {} }
      calls.push(call)
      return responder(call.url, call.init)
    }) as typeof fetch,
  })
  const service = new DifyEnhancementService({
    adapter,
    connections: {
      describeEnhancement: () => ({ enabled: mode !== null, mode }),
      resolveEnhancementContext: async () => context(mode),
    },
    clock: () => 1_100,
  })
  return { service, calls }
}

describe('DifyEnhancementService', () => {
  test('collects agent-chat SSE tokens into the old blocking result', async () => {
    const { service, calls } = setup('agent-chat', () => new Response([
      'data: {"event":"agent_message","answer":"hello "}\n\n',
      'data: {"event":"message","answer":"world"}\n\n',
      'data: {"event":"message_end"}\n\n',
    ].join('')))

    const result = await service.invokeBlocking({ actor, visibility, assistantId: 'agent-a', query: 'question', startedAt: 1_000 })

    assert.deepEqual(result, { text: 'hello world', mode: 'agent-chat', elapsedMs: 100 })
    assert.equal(calls[0]?.url.endsWith('/v1/chat-messages'), true)
    assert.equal(JSON.parse(String(calls[0]?.init.body)).user, 'sudowork:9:17')
  })

  test('runs workflow blocking and flattens knowledge chunks', async () => {
    const { service, calls } = setup('workflow', () => Response.json({
      data: { outputs: { result: [{ content: 'first' }, { text: 'second' }] } },
    }))

    const result = await service.invokeBlocking({ actor, visibility, assistantId: 'agent-a', query: 'question', startedAt: 1_000 })

    assert.equal(result.text, 'first\n\n---\n\nsecond')
    assert.equal(result.mode, 'workflow')
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      inputs: { query: 'question' }, user: 'sudowork:9:17', response_mode: 'blocking',
    })
  })

  test('queries every attached dataset and concatenates retrieved passages', async () => {
    const { service, calls } = setup('rag-only', url => Response.json({
      records: [{ segment: { content: url.includes('dataset-a') ? 'alpha' : 'beta' } }],
    }))

    const result = await service.invokeBlocking({ actor, visibility, assistantId: 'rag-a', query: 'question', startedAt: 1_000 })

    assert.deepEqual(result, { text: 'alpha\n\n---\n\nbeta', mode: 'dataset', elapsedMs: 100 })
    assert.deepEqual(calls.map(call => call.url), [
      'https://dify.example.test/v1/datasets/dataset-a/retrieve',
      'https://dify.example.test/v1/datasets/dataset-b/retrieve',
    ])
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)).retrieval_model, {
      search_method: 'semantic_search', top_k: 5, reranking_enable: false,
      score_threshold_enabled: true, score_threshold: 0.3,
    })
  })

  test('converts workflow SSE into progress and result events', async () => {
    const { service } = setup('workflow', () => new Response([
      'data: {"event":"node_started","data":{"title":"检索","node_id":"n1","node_type":"knowledge"}}\n\n',
      'data: {"event":"workflow_finished","data":{"outputs":{"answer":"done"}}}\n\n',
    ].join('')))

    const events = []
    for await (const event of service.invokeStreaming({
      actor, visibility, assistantId: 'agent-a', query: 'question', startedAt: 1_000,
    })) events.push(event)

    assert.deepEqual(events, [
      { kind: 'progress', step: '检索', nodeId: 'n1', nodeType: 'knowledge' },
      { kind: 'result', text: 'done', mode: 'workflow', elapsedMs: 100 },
    ])
  })
})
