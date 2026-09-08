import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  loadMigrationCliConfig,
  parseMigrationCliArgs,
  runMigrationCli,
} from './migrationCli.js'

describe('migration CLI 参数与配置', () => {
  test('四种模式严格互斥，resume/verify 必须携带批次，拒绝未知控制参数', () => {
    const config = '/tmp/migration.json'
    assert.deepEqual(parseMigrationCliArgs(['--config', config, '--dry-run']), { configPath: config, mode: 'dry-run' })
    assert.deepEqual(parseMigrationCliArgs(['--config', config, '--execute']), { configPath: config, mode: 'execute' })
    assert.deepEqual(parseMigrationCliArgs(['--config', config, '--resume', 'run-1']), { configPath: config, mode: 'resume', runId: 'run-1' })
    assert.deepEqual(parseMigrationCliArgs(['--config', config, '--verify', 'run-1']), { configPath: config, mode: 'verify', runId: 'run-1' })
    assert.throws(() => parseMigrationCliArgs(['--config', config, '--dry-run', '--execute']), /只能选择一种/)
    assert.throws(() => parseMigrationCliArgs(['--config', config, '--resume']), /缺少批次/)
    assert.throws(() => parseMigrationCliArgs(['--config', config, '--source', '/tmp/source', '--dry-run']), /未知参数/)
    assert.throws(() => parseMigrationCliArgs(['--config', config, '--effect-policy', 'enqueue', '--dry-run']), /未知参数/)
    assert.throws(() => parseMigrationCliArgs(['--config', 'relative.json', '--dry-run']), /绝对路径/)
  })

  test('加载配置时要求冻结只读源、完整密钥和非开发默认秘密', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moss-migration-cli-'))
    const source = join(root, 'source')
    mkdirSync(source)
    writeFileSync(join(source, 'sudowork.sqlite'), '')
    const path = join(root, 'migration.json')
    const raw = {
      version: 1,
      source: {
        snapshotDir: source,
        redisUrlEnv: 'OLD_REDIS_URL',
        qmsPostgresUrlEnv: 'OLD_QMS_URL',
        legacyJwtSecretEnv: 'OLD_JWT_SECRET',
        fileAllowlist: ['uploads', 'hub-export.json'],
      },
      target: {
        mossDbPath: join(root, 'moss.sqlite'),
        runtimeDir: join(root, 'runtime'),
        publicBaseUrl: 'https://moss.example.test',
        redisUrlEnv: 'NEW_REDIS_URL',
        qmsPostgresUrlEnv: 'NEW_QMS_URL',
        legacyJwtSecretEnv: 'NEW_JWT_SECRET',
        nexusEndpoint: 'http://127.0.0.1:50051',
        loginMethod: 'password',
        skillhubBaseUrl: 'https://hub.example.test',
        smsConfigured: false,
      },
      migration: {
        platformCatalogOrgId: 'platform', platformConfigOrgId: 'platform', qmsBatchSize: 500,
        defaultInitialQuotaEnv: 'OLD_INITIAL_QUOTA',
      },
      reportsDir: join(root, 'reports'),
    }
    writeFileSync(path, JSON.stringify(raw))
    const env = {
      OLD_REDIS_URL: 'redis://old', NEW_REDIS_URL: 'redis://new',
      OLD_QMS_URL: 'postgres://old', NEW_QMS_URL: 'postgres://new',
      OLD_JWT_SECRET: 'production-secret-value', NEW_JWT_SECRET: 'production-secret-value',
      OLD_INITIAL_QUOTA: '100000',
    }
    try {
      await assert.rejects(() => loadMigrationCliConfig(path, env), /只读/)
      chmodSync(source, 0o555)
      const loaded = await loadMigrationCliConfig(path, env)
      assert.equal(loaded.source.snapshotDir, source)
      assert.equal(loaded.secrets.sourceLegacyJwtSecret, 'production-secret-value')
      await assert.rejects(
        () => loadMigrationCliConfig(path, { ...env, NEW_JWT_SECRET: 'sudowork-secret-key' }),
        /开发默认秘密/,
      )
      await assert.rejects(
        () => loadMigrationCliConfig(path, { ...env, OLD_REDIS_URL: '' }),
        /OLD_REDIS_URL/,
      )
      await assert.rejects(
        () => loadMigrationCliConfig(path, { ...env, NEW_REDIS_URL: env.OLD_REDIS_URL }),
        /Redis.*不同/,
      )
      await assert.rejects(
        () => loadMigrationCliConfig(path, { ...env, NEW_JWT_SECRET: 'another-production-secret' }),
        /JWT.*一致/,
      )

      raw.target.mossDbPath = join(source, 'sudowork.sqlite')
      writeFileSync(path, JSON.stringify(raw))
      await assert.rejects(() => loadMigrationCliConfig(path, env), /目标路径.*冻结源目录/)

      raw.target.mossDbPath = join(root, 'moss.sqlite')
      raw.migration.identityResolutions = [{ kind: 'user', sourceId: '', targetId: 'user-a' }]
      writeFileSync(path, JSON.stringify(raw))
      await assert.rejects(() => loadMigrationCliConfig(path, env), /identityResolutions/)
    } finally {
      chmodSync(source, 0o755)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('执行层映射四种模式、退出码且输出不泄漏配置秘密', async () => {
    const calls: string[] = []
    const coordinator = {
      async dryRun() { calls.push('dry-run'); return { status: 'ready' } },
      async execute() { calls.push('execute'); return { runId: 'run-1' } },
      async resume(runId: string) { calls.push(`resume:${runId}`); return { runId } },
      async verify(runId: string) { calls.push(`verify:${runId}`); return { runId, status: 'mismatch' } },
    }
    const output: string[] = []
    const dependencies = {
      loadConfig: async () => ({ redacted: true }),
      createCoordinator: async () => ({ coordinator, close: async () => calls.push('close') }),
      output: (value: unknown) => output.push(JSON.stringify(value)),
    }
    assert.equal(await runMigrationCli({ configPath: '/tmp/a', mode: 'dry-run' }, dependencies as never), 0)
    assert.equal(await runMigrationCli({ configPath: '/tmp/a', mode: 'execute' }, dependencies as never), 0)
    assert.equal(await runMigrationCli({ configPath: '/tmp/a', mode: 'resume', runId: 'run-2' }, dependencies as never), 0)
    assert.equal(await runMigrationCli({ configPath: '/tmp/a', mode: 'verify', runId: 'run-3' }, dependencies as never), 3)
    assert.deepEqual(calls, [
      'dry-run', 'close', 'execute', 'close', 'resume:run-2', 'close', 'verify:run-3', 'close',
    ])
    assert(!output.join('').includes('secret'))
  })
})
