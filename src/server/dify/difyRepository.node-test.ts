import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { DifyRepository, DifyRepositoryError } from './difyRepository.js'

describe('DifyRepository', () => {
  test('upserts and lists organization-scoped provider resources', () => {
    const db = new DatabaseSync(':memory:')
    const repository = new DifyRepository(db)
    repository.putResource({
      id: 'resource-a', orgId: 'org-a', connectionId: 'connection-a', resourceType: 'dataset',
      externalId: 'dataset-1', metadata: { name: 'Knowledge' }, createdAt: 1, updatedAt: 2,
    })
    repository.putResource({
      id: 'resource-a', orgId: 'org-a', connectionId: 'connection-a', resourceType: 'dataset',
      externalId: 'dataset-1', metadata: { name: 'Updated' }, createdAt: 1, updatedAt: 3,
    })
    repository.putResource({
      id: 'resource-b', orgId: 'org-b', connectionId: 'connection-b', resourceType: 'dataset',
      externalId: 'dataset-2', metadata: { name: 'Other' }, createdAt: 1, updatedAt: 2,
    })

    assert.deepEqual(repository.listResources('org-a', 'dataset').map(item => item.metadata.name), ['Updated'])
    assert.equal(repository.getResourceByExternalId('org-b', 'connection-b', 'dataset', 'dataset-2')?.id, 'resource-b')
    db.close()
  })

  test('persists idempotent operation state transitions', () => {
    const db = new DatabaseSync(':memory:')
    const repository = new DifyRepository(db)
    const first = repository.createOperation({
      id: 'op-a', orgId: 'org-a', operationType: 'create_app', aggregateId: 'agent-a',
      idempotencyKey: 'create:agent-a', status: 'PENDING', request: { name: 'Agent' }, contextSource: 'online',
    })
    const replay = repository.createOperation({
      id: 'op-b', orgId: 'org-a', operationType: 'create_app', aggregateId: 'agent-a',
      idempotencyKey: 'create:agent-a', status: 'PENDING', request: { name: 'Agent' }, contextSource: 'online',
    })
    assert.equal(replay.id, first.id)

    repository.updateOperation('op-a', { status: 'PROCESSING', attempts: 1 })
    repository.updateOperation('op-a', { status: 'SUCCEEDED', result: { appId: 'app-a' } })
    assert.deepEqual(repository.getOperationByIdempotencyKey('create:agent-a'), {
      ...first, status: 'SUCCEEDED', result: { appId: 'app-a' }, attempts: 1, updatedAt: repository.getOperationByIdempotencyKey('create:agent-a')?.updatedAt,
    })
    db.close()
  })

  test('rejects secret material recursively before writing SQLite', () => {
    const db = new DatabaseSync(':memory:')
    const repository = new DifyRepository(db)
    assert.throws(() => repository.putResource({
      id: 'unsafe', orgId: 'org-a', connectionId: 'connection-a', resourceType: 'dataset',
      externalId: 'dataset-1', metadata: { nested: { api_key: 'plaintext' } },
    }), (error: unknown) => error instanceof DifyRepositoryError && error.code === 'SECRET_MATERIAL_FORBIDDEN')
    assert.throws(() => repository.createOperation({
      id: 'unsafe-op', orgId: 'org-a', operationType: 'provision', aggregateId: 'org-a',
      idempotencyKey: 'unsafe', status: 'PENDING', request: { serviceToken: 'plaintext' }, contextSource: 'online',
    }), /Secret material/)
    db.close()
  })
})
