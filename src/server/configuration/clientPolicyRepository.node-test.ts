import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { SqliteDriver } from '../db/driver.js'
import { ClientPolicyRepository, ensureClientPolicySchema } from './clientPolicyRepository.js'

void describe('统一客户端策略仓库', () => {
  void test('平台默认与组织覆盖合并且不复制整份策略', async () => {
    const db = new DatabaseSync(':memory:')
    const driver = new SqliteDriver(db)
    ensureClientPolicySchema(db)
    const repository = new ClientPolicyRepository(driver)
    await repository.putPlatform({
      loginMethod: 'password',
      skillhubBaseUrl: 'https://moss.example.test',
      versionUpdate: { enabled: 0, cosDomain: '' },
    }, 'root')
    await repository.putOrganization('org-a', {
      loginMethod: 'cas',
      versionUpdate: { enabled: 1, cosDomain: 'https://releases.example.test' },
    }, 'admin-a')

    assert.deepEqual(await repository.getEffective('org-a'), {
      loginMethod: 'cas',
      skillhubBaseUrl: 'https://moss.example.test',
      versionUpdate: { enabled: 1, cosDomain: 'https://releases.example.test' },
    })
    assert.equal((await repository.getEffective('org-b')).loginMethod, 'password')
    assert.deepEqual(
      JSON.parse(String((db.prepare(`
        SELECT policy_json FROM client_delivery_policies
        WHERE scope_type = 'organization' AND scope_id = 'org-a'
      `).get() as { policy_json: string }).policy_json)),
      { loginMethod: 'cas', versionUpdate: { enabled: 1, cosDomain: 'https://releases.example.test' } },
    )
    db.close()
  })

  void test('拒绝把密钥材料写入 SQLite，并参加外层 SAVEPOINT 回滚', async () => {
    const db = new DatabaseSync(':memory:')
    const driver = new SqliteDriver(db)
    ensureClientPolicySchema(db)
    const repository = new ClientPolicyRepository(driver)
    await assert.rejects(
      repository.putPlatform({ logReport: { apiKey: 'plaintext' } }, 'root'),
      /敏感字段不能写入客户端策略/,
    )
    await assert.rejects(driver.transaction(async () => {
      await repository.putPlatform({ loginMethod: 'sms' }, 'root')
      throw new Error('rollback')
    }), /rollback/)
    assert.deepEqual(await repository.getPlatform(), {})
    db.close()
  })
})
