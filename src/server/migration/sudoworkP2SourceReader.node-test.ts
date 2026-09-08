import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { SudoworkP2SourceError, SudoworkP2SourceReader } from './sudoworkP2SourceReader.js'

describe('Sudowork P2 冻结源读取器', () => {
  test('只读提取旧配置关系和带来源版本的 Hub 清单', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sudowork-p2-source-'))
    try {
      const dbPath = join(root, 'sudowork.sqlite')
      const source = new DatabaseSync(dbPath)
      source.exec(`
        CREATE TABLE config_items (
          id INTEGER PRIMARY KEY, name TEXT, description TEXT, icon TEXT, pinyin TEXT,
          url_pattern TEXT, scheme TEXT, bearer_prefix TEXT, visible_to_all INTEGER,
          status INTEGER, created_by_id INTEGER, created_by_name TEXT,
          updated_by_id INTEGER, updated_by_name TEXT, created_at TEXT, updated_at TEXT
        );
        CREATE TABLE config_entries (
          id INTEGER PRIMARY KEY, config_item_id INTEGER, config_key TEXT, name TEXT,
          config_desc TEXT, required INTEGER, created_at TEXT, updated_at TEXT
        );
        CREATE TABLE config_enterprise_rel (
          id INTEGER PRIMARY KEY, config_item_id INTEGER, enterprise_id INTEGER
        );
        CREATE TABLE system_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
        INSERT INTO config_items VALUES (
          7, 'GitLab', '代码服务', 'gitlab.png', 'gitlab', 'https://git.example/*',
          'bearer', 'Bearer ', 0, 1, 2, '管理员', 2, '管理员',
          '2026-01-01 00:00:00', '2026-01-02 00:00:00'
        );
        INSERT INTO config_entries VALUES (
          8, 7, 'token', '访问令牌', '个人令牌', 1,
          '2026-01-01 00:00:00', '2026-01-02 00:00:00'
        );
        INSERT INTO config_enterprise_rel VALUES (9, 7, 3);
        INSERT INTO system_config VALUES ('login_method', '1', '2026-01-02 00:00:00');
      `)
      source.close()

      await mkdir(join(root, 'artifacts'), { recursive: true })
      await writeFile(join(root, 'artifacts', 'skill.zip'), Buffer.from('fixture'))
      const imageName = '123e4567-e89b-42d3-a456-426614174000.png'
      await mkdir(join(root, 'uploads', 'config-items'), { recursive: true })
      await writeFile(join(root, 'uploads', 'config-items', imageName), Buffer.from('image-fixture'))
      await writeFile(join(root, 'hub-catalog.json'), JSON.stringify({
        schema_version: 1,
        source: {
          sudowork_server_commit: '311636c7bbfa4fa1c655aa8bd5c7e898f565f263',
          sudowork_client_commit: '13c6229f6b98c50046679a78fa372092024ea3d2',
          hub_provider_id: 'sudohub-production',
          hub_export_id: 'hub-export-1',
          exported_at: '2026-09-07T00:00:00.000Z',
        },
        agents: [],
        skills: [{
          id: 'skill-1', tenant_ids: ['ENT-A'], name: 'writer', display_name: '写作',
          author_id: '42', status: 1, version: '1.0.0', checksum: 'abc',
          artifact_path: 'artifacts/skill.zip',
        }],
      }))

      const reader = new SudoworkP2SourceReader(root)
      assert.deepEqual(reader.readConfigItems(), [{
        id: 7,
        name: 'GitLab',
        description: '代码服务',
        icon: 'gitlab.png',
        pinyin: 'gitlab',
        urlPattern: 'https://git.example/*',
        scheme: 'bearer',
        bearerPrefix: 'Bearer ',
        visibleToAll: false,
        status: 1,
        createdById: 2,
        createdByName: '管理员',
        updatedById: 2,
        updatedByName: '管理员',
        createdAt: Date.parse('2026-01-01T00:00:00Z'),
        updatedAt: Date.parse('2026-01-02T00:00:00Z'),
        entries: [{
          id: 8, configKey: 'token', name: '访问令牌', description: '个人令牌',
          required: true, createdAt: Date.parse('2026-01-01T00:00:00Z'),
          updatedAt: Date.parse('2026-01-02T00:00:00Z'),
        }],
        enterpriseIds: [3],
      }])
      assert.deepEqual(reader.readSystemConfig(), { login_method: '1' })
      const manifest = await reader.readHubManifest()
      assert.equal(manifest.source.hubProviderId, 'sudohub-production')
      assert.equal(manifest.skills[0]?.id, 'skill-1')
      assert.deepEqual(await reader.readArtifact(manifest.skills[0]!.artifactPath), Buffer.from('fixture'))
      assert.deepEqual(await reader.readManagedImages(), [{
        kind: 'config-item', filename: imageName, mimeType: 'image/png', bytes: Buffer.from('image-fixture'),
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('拒绝重复资源 ID、缺失来源版本和逃逸快照目录的制品路径', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sudowork-p2-source-'))
    try {
      new DatabaseSync(join(root, 'sudowork.sqlite')).close()
      await writeFile(join(root, 'hub-catalog.json'), JSON.stringify({
        schema_version: 1,
        source: { hub_export_id: 'missing-commits', exported_at: '2026-09-07T00:00:00.000Z' },
        agents: [],
        skills: [],
      }))
      const reader = new SudoworkP2SourceReader(root)
      await assert.rejects(reader.readHubManifest(), (error: unknown) =>
        error instanceof SudoworkP2SourceError && error.code === 'INVALID_MANIFEST')

      await writeFile(join(root, 'hub-catalog.json'), JSON.stringify({
        schema_version: 1,
        source: {
          sudowork_server_commit: 'server', sudowork_client_commit: 'client',
          hub_export_id: 'hub-export-without-provider', exported_at: '2026-09-07T00:00:00.000Z',
        },
        agents: [],
        skills: [],
      }))
      await assert.rejects(reader.readHubManifest(), /hub_provider_id/)

      await writeFile(join(root, 'hub-catalog.json'), JSON.stringify({
        schema_version: 1,
        source: {
          sudowork_server_commit: 'server', sudowork_client_commit: 'client',
          hub_provider_id: 'hub-production',
          hub_export_id: 'hub', exported_at: '2026-09-07T00:00:00.000Z',
        },
        agents: [],
        skills: [
          { id: 'same', tenant_ids: ['ENT-A'], name: 'one', author_id: '1', status: 1, artifact_path: '../escape.zip' },
          { id: 'same', tenant_ids: ['ENT-A'], name: 'two', author_id: '1', status: 1, artifact_path: 'two.zip' },
        ],
      }))
      await assert.rejects(reader.readHubManifest(), /重复资源 ID/)

      await writeFile(join(root, 'hub-catalog.json'), JSON.stringify({
        schema_version: 1,
        source: {
          sudowork_server_commit: 'server', sudowork_client_commit: 'client',
          hub_provider_id: 'hub-production',
          hub_export_id: 'hub', exported_at: '2026-09-07T00:00:00.000Z',
        },
        agents: [],
        skills: [{ id: 'safe', tenant_ids: ['ENT-A'], name: 'one', author_id: '1', status: 1, artifact_path: '../escape.zip' }],
      }))
      const manifest = await reader.readHubManifest()
      await assert.rejects(reader.readArtifact(manifest.skills[0]!.artifactPath), (error: unknown) =>
        error instanceof SudoworkP2SourceError && error.code === 'UNSAFE_PATH')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
