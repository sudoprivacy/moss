import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { SudoworkP4SourceReader } from './sudoworkP4SourceReader.js'

test('只读提取 Dify 连接、App、Dataset、ACL 与元数据并生成稳定校验和', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sudowork-p4-source-'))
  const path = join(dir, 'sudowork.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE dify_tenant_binding (
      enterprise_id INTEGER PRIMARY KEY, dify_tenant_id TEXT, dify_system_account_id TEXT,
      api_key TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE dify_app_binding (
      id INTEGER PRIMARY KEY, enterprise_id INTEGER, assistant_id TEXT, dify_tenant_id TEXT,
      dify_app_id TEXT, app_api_key TEXT, dify_app_mode TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE dify_dataset_binding (
      id INTEGER PRIMARY KEY, enterprise_id INTEGER, assistant_id TEXT, dify_tenant_id TEXT,
      dify_dataset_id TEXT, created_at INTEGER
    );
    CREATE TABLE assistant_acl (
      id INTEGER PRIMARY KEY, enterprise_id INTEGER, assistant_id TEXT,
      subject_type TEXT, subject_id TEXT, created_at INTEGER
    );
    CREATE TABLE assistant_metadata_overrides (
      id INTEGER PRIMARY KEY, enterprise_id INTEGER, assistant_id TEXT, name TEXT, profession TEXT,
      description TEXT, default_init_prompt TEXT, prompts_i18n TEXT, categories TEXT, skills TEXT,
      prompt_file TEXT, avatar TEXT, skillhub_version TEXT, created_at INTEGER, updated_at INTEGER
    );
  `)
  db.prepare('INSERT INTO dify_tenant_binding VALUES (?, ?, ?, ?, ?, ?)')
    .run(9, 'tenant-9', 'system-9', 'service-secret', 10, 20)
  db.prepare('INSERT INTO dify_app_binding VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(1, 9, 'agent-1', 'tenant-9', 'app-1', 'app-secret', 'agent-chat', 11, 21)
  db.prepare('INSERT INTO dify_app_binding VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(5, 9, 'agent-without-key', 'tenant-9', 'app-2', null, 'agent-chat', 15, 25)
  db.prepare('INSERT INTO dify_dataset_binding VALUES (?, ?, ?, ?, ?, ?)')
    .run(2, 9, 'agent-2', 'tenant-9', 'dataset-1', 12)
  db.prepare('INSERT INTO assistant_acl VALUES (?, ?, ?, ?, ?, ?)')
    .run(3, 9, 'agent-1', 'user', '17', 13)
  db.prepare('INSERT INTO assistant_metadata_overrides VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(4, 9, 'agent-1', '助手', '研发', '说明', '提示', '{"zh-CN":["你好"]}', '["开发"]', '["git"]', 'prompt.md', '/avatar.png', '1.2.3', 14, 24)
  db.close()

  try {
    const reader = new SudoworkP4SourceReader(dir)
    const first = reader.readSnapshot()
    const second = reader.readSnapshot()
    assert.equal(first.checksum, second.checksum)
    assert.match(first.checksum, /^[0-9a-f]{64}$/)
    assert.deepEqual(first.connections[0], {
      enterpriseId: 9, tenantId: 'tenant-9', systemAccountId: 'system-9',
      apiKey: 'service-secret', createdAt: 10, updatedAt: 20,
    })
    assert.equal(first.apps[0]?.appApiKey, 'app-secret')
    assert.equal(first.apps[1]?.appApiKey, null)
    assert.equal(first.datasets[0]?.datasetId, 'dataset-1')
    assert.deepEqual(first.metadata[0]?.promptsI18n, { 'zh-CN': ['你好'] })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
