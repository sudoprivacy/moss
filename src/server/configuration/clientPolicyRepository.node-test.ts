import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { ClientPolicyRepository } from './clientPolicyRepository.js'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'

describe('统一客户端策略仓库', () => {
  test('平台默认与组织覆盖合并且不复制整份策略', () => {
    const db = new DatabaseSync(':memory:')
    const repository = new ClientPolicyRepository(db)
    repository.putPlatform({
      loginMethod: 'password',
      skillhubBaseUrl: 'https://moss.example.test',
      versionUpdate: { enabled: 0, cosDomain: '' },
    }, 'root')
    repository.putOrganization('org-a', {
      loginMethod: 'cas',
      versionUpdate: { enabled: 1, cosDomain: 'https://releases.example.test' },
    }, 'admin-a')

    assert.deepEqual(repository.getEffective('org-a'), {
      loginMethod: 'cas',
      skillhubBaseUrl: 'https://moss.example.test',
      versionUpdate: { enabled: 1, cosDomain: 'https://releases.example.test' },
    })
    assert.equal(repository.getEffective('org-b').loginMethod, 'password')
    assert.deepEqual(
      JSON.parse(String((db.prepare(`
        SELECT policy_json FROM client_delivery_policies
        WHERE scope_type = 'organization' AND scope_id = 'org-a'
      `).get() as { policy_json: string }).policy_json)),
      { loginMethod: 'cas', versionUpdate: { enabled: 1, cosDomain: 'https://releases.example.test' } },
    )
    db.close()
  })

  test('拒绝把密钥材料写入 SQLite，并参加外层 SAVEPOINT 回滚', () => {
    const db = new DatabaseSync(':memory:')
    const repository = new ClientPolicyRepository(db)
    assert.throws(
      () => repository.putPlatform({ logReport: { apiKey: 'plaintext' } }, 'root'),
      /敏感字段不能写入客户端策略/,
    )
    assert.throws(() => runInTransaction(db, () => {
      repository.putPlatform({ loginMethod: 'sms' }, 'root')
      throw new Error('rollback')
    }), /rollback/)
    assert.deepEqual(repository.getPlatform(), {})
    db.close()
  })
})
