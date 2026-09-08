import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { migrationCommandContext, onlineCommandContext } from '../application/commandContext.js'
import { DifyDatasetService } from './difyDatasetService.js'
import { DifyHttpAdapter } from './difyHttpAdapter.js'
import { DifyRepository } from './difyRepository.js'

function setup(responseFor?: (url: string, init: RequestInit) => Response) {
  const db = new DatabaseSync(':memory:')
  const repository = new DifyRepository(db)
  const calls: Array<{ url: string; init: RequestInit }> = []
  const ensureCalls: Array<{ orgId: string; context: Record<string, unknown> }> = []
  const adapter = new DifyHttpAdapter({
    baseUrl: 'https://dify.example.test',
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(input), init: init ?? {} }
      calls.push(call)
      return responseFor?.(call.url, call.init) ?? Response.json({ ok: true })
    }) as typeof fetch,
  })
  const service = new DifyDatasetService({
    db,
    repository,
    adapter,
    connections: {
      async resolveOrganizationContext(orgId: string) {
        return {
          orgId, connectionId: `connection-${orgId}`, tenantId: `tenant-${orgId}`,
          systemAccountId: null, apiKey: `key-${orgId}`, baseUrl: 'https://dify.example.test',
        }
      },
    },
    ensureConnection: async (orgId, context) => {
      ensureCalls.push({ orgId, context: context as unknown as Record<string, unknown> })
    },
    idFactory: () => 'resource-new',
  })
  return { db, repository, service, calls, ensureCalls }
}

describe('DifyDatasetService', () => {
  test('preserves dataset and document paging query parameters', async () => {
    const { db, service, calls } = setup(() => Response.json({ data: [], has_more: false, total: 0 }))
    await service.list('org-a', { page: 2, limit: 30, keyword: '产品 文档' })
    await service.listDocuments('org-a', 'dataset/a', { page: 3, limit: 50, keyword: 'guide' })
    assert.equal(calls[0]?.url, 'https://dify.example.test/v1/datasets?page=2&limit=30&keyword=%E4%BA%A7%E5%93%81+%E6%96%87%E6%A1%A3')
    assert.equal(calls[1]?.url, 'https://dify.example.test/v1/datasets/dataset%2Fa/documents?page=3&limit=50&keyword=guide')
    db.close()
  })

  test('auto-provisions a missing tenant through an online-only command boundary', async () => {
    const { db, service, ensureCalls } = setup(() => Response.json({ data: [] }))
    await service.list('org-a', {})
    assert.equal(ensureCalls.length, 1)
    assert.equal(ensureCalls[0]?.orgId, 'org-a')
    assert.deepEqual({
      source: ensureCalls[0]?.context.source,
      externalEffects: ensureCalls[0]?.context.externalEffects,
      idempotencyKey: ensureCalls[0]?.context.idempotencyKey,
    }, {
      source: 'online', externalEffects: 'enqueue',
      idempotencyKey: 'dify:dataset:auto-provision:org-a',
    })
    db.close()
  })

  test('creates a dataset with the legacy permission default and records recoverable local state', async () => {
    const { db, repository, service, calls } = setup(() => Response.json({
      id: 'dataset-1', name: 'Knowledge', description: null, permission: 'all_team_members',
    }))
    const result = await service.create('org-a', {
      name: 'Knowledge', description: undefined, indexingTechnique: undefined, permission: undefined,
    }, onlineCommandContext('dataset:create:1'))

    assert.equal((result as Record<string, unknown>).id, 'dataset-1')
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      name: 'Knowledge', permission: 'all_team_members',
    })
    assert.equal(repository.getResourceByExternalId('org-a', 'connection-org-a', 'dataset', 'dataset-1')?.metadata.name, 'Knowledge')
    assert.equal(repository.getOperationByIdempotencyKey('dataset:create:1')?.status, 'SUCCEEDED')
    db.close()
  })

  test('replays the complete original provider response without a second Dify call', async () => {
    const providerResponse = {
      id: 'dataset-1', name: 'Knowledge', permission: 'all_team_members',
      created_at: 123, document_count: 7,
    }
    const { db, service, calls } = setup(() => Response.json(providerResponse))
    const context = onlineCommandContext('dataset:create:retry')

    const first = await service.create('org-a', { name: 'Knowledge' }, context)
    const replayed = await service.create('org-a', { name: 'Knowledge' }, context)

    assert.deepEqual(first, providerResponse)
    assert.deepEqual(replayed, providerResponse)
    assert.equal(calls.length, 1)
    db.close()
  })

  test('rejects a reused idempotency key with a different dataset request', async () => {
    const { db, service, calls } = setup(() => Response.json({ id: 'dataset-1' }))
    const context = onlineCommandContext('dataset:create:conflict')
    await service.create('org-a', { name: 'First' }, context)
    await assert.rejects(service.create('org-a', { name: 'Different' }, context), /different Dify command/)
    assert.equal(calls.length, 1)
    db.close()
  })

  test('retries a definitively failed provider write with the same idempotency key', async () => {
    let attempt = 0
    const { db, service, calls } = setup(() => {
      attempt += 1
      return attempt === 1
        ? Response.json({ message: 'temporarily unavailable' }, { status: 503 })
        : Response.json({ id: 'dataset-1', name: 'Recovered' })
    })
    const context = onlineCommandContext('dataset:create:recover')
    await assert.rejects(service.create('org-a', { name: 'Recovered' }, context))
    assert.deepEqual(await service.create('org-a', { name: 'Recovered' }, context), {
      id: 'dataset-1', name: 'Recovered',
    })
    assert.equal(calls.length, 2)
    db.close()
  })

  test('suppresses migration writes without invoking Dify', async () => {
    const { db, repository, service, calls } = setup()
    const result = await service.create('org-a', { name: 'Historical' }, migrationCommandContext('run-1', 'dataset:migrate:1'))
    assert.deepEqual(result, { suppressed: true })
    assert.equal(calls.length, 0)
    assert.equal(repository.getOperationByIdempotencyKey('dataset:migrate:1')?.status, 'SUPPRESSED')
    db.close()
  })

  test('keeps text, file and retrieve payload defaults', async () => {
    const { db, service, calls } = setup((url) => url.endsWith('/retrieve')
      ? Response.json({ records: [] })
      : Response.json({ document: { id: 'doc-1' } }))

    await service.createDocumentByText('org-a', 'dataset-1', {
      name: 'Guide', text: 'body', indexingTechnique: undefined,
    }, onlineCommandContext('doc:text:1'))
    await service.createDocumentByFile('org-a', 'dataset-1', {
      fileName: 'guide.txt', contentType: 'text/plain', bytes: new TextEncoder().encode('body'), indexingTechnique: undefined,
    }, onlineCommandContext('doc:file:1'))
    await service.retrieve('org-a', 'dataset-1', { query: 'question' })

    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      indexing_technique: 'economy', process_rule: { mode: 'automatic' }, name: 'Guide', text: 'body',
    })
    const form = calls[1]?.init.body as FormData
    assert.deepEqual(JSON.parse(String(form.get('data'))), {
      indexing_technique: 'economy', process_rule: { mode: 'automatic' },
    })
    assert.equal(await (form.get('file') as File).text(), 'body')
    assert.deepEqual(JSON.parse(String(calls[2]?.init.body)).retrieval_model, {
      search_method: 'semantic_search', top_k: 5, reranking_enable: false, score_threshold_enabled: false,
    })
    db.close()
  })
})
