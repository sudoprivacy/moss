import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { createDifyTestRepository } from '../testing/compatibilityRepositories.js'
import { DifyRepositoryError } from './difyRepository.js'

void describe('DifyRepository', () => {
  void test('upserts and lists organization-scoped provider resources', async () => {
    const db = new DatabaseSync(':memory:')
    const repository = createDifyTestRepository(db)
    await repository.putResource({
      id: 'resource-a', orgId: 'org-a', connectionId: 'connection-a', resourceType: 'dataset',
      externalId: 'dataset-1', metadata: { name: 'Knowledge' }, createdAt: 1, updatedAt: 2,
    })
    await repository.putResource({
      id: 'resource-a', orgId: 'org-a', connectionId: 'connection-a', resourceType: 'dataset',
      externalId: 'dataset-1', metadata: { name: 'Updated' }, createdAt: 1, updatedAt: 3,
    })
    await repository.putResource({
      id: 'resource-b', orgId: 'org-b', connectionId: 'connection-b', resourceType: 'dataset',
      externalId: 'dataset-2', metadata: { name: 'Other' }, createdAt: 1, updatedAt: 2,
    })

    assert.deepEqual((await repository.listResources('org-a', 'dataset')).map(item => item.metadata.name), ['Updated'])
    assert.equal((await repository.getResourceByExternalId('org-b', 'connection-b', 'dataset', 'dataset-2'))?.id, 'resource-b')
    db.close()
  })

  void test('persists idempotent operation state transitions', async () => {
    const db = new DatabaseSync(':memory:')
    const repository = createDifyTestRepository(db)
    const first = await repository.createOperation({
      id: 'op-a', orgId: 'org-a', operationType: 'create_app', aggregateId: 'agent-a',
      idempotencyKey: 'create:agent-a', status: 'PENDING', request: { name: 'Agent' }, contextSource: 'online',
    })
    const replay = await repository.createOperation({
      id: 'op-b', orgId: 'org-a', operationType: 'create_app', aggregateId: 'agent-a',
      idempotencyKey: 'create:agent-a', status: 'PENDING', request: { name: 'Agent' }, contextSource: 'online',
    })
    assert.equal(replay.id, first.id)

    await repository.updateOperation('op-a', { status: 'PROCESSING', attempts: 1 })
    await repository.updateOperation('op-a', { status: 'SUCCEEDED', result: { appId: 'app-a' } })
    const completed = await repository.getOperationByIdempotencyKey('create:agent-a')
    assert.deepEqual(completed, {
      ...first, status: 'SUCCEEDED', result: { appId: 'app-a' }, attempts: 1, updatedAt: completed?.updatedAt,
    })
    db.close()
  })

  void test('rejects secret material recursively before writing SQLite', async () => {
    const db = new DatabaseSync(':memory:')
    const repository = createDifyTestRepository(db)
    await assert.rejects(repository.putResource({
      id: 'unsafe', orgId: 'org-a', connectionId: 'connection-a', resourceType: 'dataset',
      externalId: 'dataset-1', metadata: { nested: { api_key: 'plaintext' } },
    }), (error: unknown) => error instanceof DifyRepositoryError && error.code === 'SECRET_MATERIAL_FORBIDDEN')
    await assert.rejects(repository.createOperation({
      id: 'unsafe-op', orgId: 'org-a', operationType: 'provision', aggregateId: 'org-a',
      idempotencyKey: 'unsafe', status: 'PENDING', request: { serviceToken: 'plaintext' }, contextSource: 'online',
    }), /Secret material/)
    db.close()
  })
})
