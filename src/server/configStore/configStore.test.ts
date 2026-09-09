/**
 * configStore 单元测试（计划「验证方案」第 1 项）：
 *  - configStore 读写 / 缓存
 *  - hydrateConfig：Nexus/env 生效、文件值一律丢弃
 *  - updateSystemSettings 敏感字段写 Nexus、文件不落盘
 *
 * 隔离方式（计划要求）：SYSTEM_SETTINGS_PATH 为模块级常量（取自 os.homedir()），
 * 用模块级 mock（bun test）把 os.homedir() 指向临时目录，避免读写真实用户目录。
 * mock 必须在动态 import 被测模块之前完成。
 */
import { describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import * as nodeOs from 'os'
import { join } from 'path'
import type { NexusClient } from '../nexus/nexusClient.js'
import type { ServerConfig } from '../types.js'

const FAKE_HOME = mkdtempSync(join(nodeOs.tmpdir(), 'moss-configstore-test-'))
const MOSS_DIR = join(FAKE_HOME, '.moss')
mkdirSync(MOSS_DIR, { recursive: true })
const SETTINGS_PATH = join(MOSS_DIR, 'settings.json')

mock.module('os', () => {
  const patched = { ...nodeOs, homedir: () => FAKE_HOME }
  return { ...patched, default: patched }
})

// mock 生效后再动态加载被测模块（systemSettings 的 SYSTEM_SETTINGS_PATH 基于 os.homedir()）。
const { ConfigStore, initConfigStore, CONFIG_KEYS, CONFIG_NAMESPACE } = await import('./configStore.js')
const { updateSystemSettings } = await import('../systemSettings.js')

/** value 为 null 表示"记录存在但无值"（损坏记录），用于三分支测试。 */
type Rec = { value: string | null }

/** 最小 NexusClient 替身：内存 Map，可模拟 putSecret 失败与损坏记录。 */
class FakeNexus {
  readonly records = new Map<string, Rec>()
  failPut = false

  private k(namespace: string, key: string): string {
    return `${namespace}::${key}`
  }

  async putSecret(namespace: string, key: string, value: string): Promise<void> {
    if (this.failPut) throw new Error('simulated putSecret failure')
    this.records.set(this.k(namespace, key), { value })
  }

  async getSecret(namespace: string, key: string): Promise<Rec | null> {
    const rec = this.records.get(this.k(namespace, key))
    return rec === undefined ? null : rec
  }

  async deleteSecret(namespace: string, key: string): Promise<void> {
    this.records.delete(this.k(namespace, key))
  }

  // --- 测试辅助 ---
  seed(key: string, value: string): void {
    this.records.set(this.k(CONFIG_NAMESPACE, key), { value })
  }
  seedCorrupt(key: string): void {
    this.records.set(this.k(CONFIG_NAMESPACE, key), { value: null })
  }
  read(key: string): Rec | undefined {
    return this.records.get(this.k(CONFIG_NAMESPACE, key))
  }
}

function asClient(fake: FakeNexus): NexusClient {
  return fake as unknown as NexusClient
}

describe('configStore 读写与缓存', () => {
  it('富友和 Sudorouter 敏感值属于 Nexus 配置清单', () => {
    expect(CONFIG_KEYS).toContain('server.fuiou-merchant-private-key')
    expect(CONFIG_KEYS).toContain('server.fuiou-public-key')
    expect(CONFIG_KEYS).toContain('server.sudorouter-api-token')
  })

  it('put 后 get 读缓存，并写入 Nexus', async () => {
    const fake = new FakeNexus()
    const store = new ConfigStore(asClient(fake))
    await store.put('server.cabin-llm-api-key', 'llm-key')
    expect(store.get('server.cabin-llm-api-key')).toBe('llm-key')
    expect(fake.read('server.cabin-llm-api-key')).toEqual({ value: 'llm-key' })
  })

  it('loadAll 从 Nexus 填充缓存；未设置的 key 返回 undefined', async () => {
    const fake = new FakeNexus()
    fake.seed('settings.anthropic-auth-token', 'tok')
    const store = new ConfigStore(asClient(fake))
    await store.loadAll()
    expect(store.get('settings.anthropic-auth-token')).toBe('tok')
    expect(store.get('settings.image-api-key')).toBeUndefined()
  })

  it('loadAll 采用空串值（与未设置区分，不致命）', async () => {
    const fake = new FakeNexus()
    fake.seed('server.cabin-asr-api-key', '')
    const store = new ConfigStore(asClient(fake))
    await store.loadAll()
    expect(store.keys().has('server.cabin-asr-api-key')).toBe(true)
    expect(store.get('server.cabin-asr-api-key')).toBe('')
  })

  it('loadAll 遇损坏记录（存在但无值）抛错，不静默降级', async () => {
    const fake = new FakeNexus()
    fake.seedCorrupt('server.cabin-token-secret')
    const store = new ConfigStore(asClient(fake))
    await expect(store.loadAll()).rejects.toThrow(/记录损坏/)
  })
})

describe('hydrateConfig：Nexus/env 生效，文件值一律丢弃', () => {
  // 会用到的 env（用例结束必须清理，避免残留翻转后续断言、使整套运行依赖顺序）
  const ENV_KEYS = [
    'CABIN_LLM_API_KEY',
    'CABIN_TOKEN_SECRET',
    'MOSS_RESOURCE_TOKEN_SECRET',
    'MOSS_HUB_AUTHORIZATION',
    'SUDOWORK_LEGACY_JWT_SECRET',
    'SUDOWORK_REDIS_URL',
    'SUDOWORK_TENCENT_SECRET_ID',
    'SUDOWORK_TENCENT_SECRET_KEY',
    'DIFY_SYSTEM_TOKEN',
    'DIFY_SYSTEM_SECRET',
    'DIFY_SSO_SECRET',
    'QMS_POSTGRES_URL',
    'QMS_REDIS_URL',
    'QMS_API_KEY',
    'QMS_TELEMETRY_PRIVATE_KEY',
    'QMS_TELEMETRY_PUBLIC_KEY',
    'QMS_LARK_WEBHOOK_URL',
    'QMS_SMTP_URL',
  ]
  function clearEnv(): void {
    for (const k of ENV_KEYS) delete process.env[k]
  }

  // 最小 ServerConfig 替身：仅含 hydrate 会就地赋值的字段，预置为"文件旧值"用于验证被丢弃。
  function makeConfig(file: {
    hubAuthorization?: string
    resourceTokenSecret?: string
    cabinTokenSecret?: string
    cabinLlmApiKey?: string
    sudoworkLegacyJwtSecret?: string
    sudoworkRedisUrl?: string
    sudoworkTencentSecretId?: string
    sudoworkTencentSecretKey?: string
    difySystemToken?: string
    difyProvisionSecret?: string
    difySsoSecret?: string
  }): ServerConfig {
    return {
      hubAuthorization: file.hubAuthorization,
      wikiIndex: { resourceTokenSecret: file.resourceTokenSecret ?? 'dev-resource-token-secret' },
      cabin: {
        tokenSecret: file.cabinTokenSecret ?? 'dev-cabin-token-secret',
        passengerInfoAuth: undefined,
        asrApiKey: undefined,
        ttsApiKey: undefined,
        llmApiKey: file.cabinLlmApiKey,
        controlAuth: undefined,
        broadcastApiKey: undefined,
        broadcastAuth: undefined,
      },
      sudoworkCompatibility: {
        enabled: true,
        hosts: ['api.sudowork.test'],
        legacyJwtSecret: file.sudoworkLegacyJwtSecret,
        redisUrl: file.sudoworkRedisUrl,
        dify: {
          baseUrl: 'http://localhost:5001',
          systemToken: file.difySystemToken,
          provisionSecret: file.difyProvisionSecret,
          ssoSecret: file.difySsoSecret,
        },
        sms: {
          provider: 'tencent', sdkAppId: '', signName: '', templateId: '', signId: '',
          region: 'ap-beijing', codeLength: 6, expireMinutes: 5,
          sendIntervalSeconds: 60, maxPerDay: 10,
          secretId: file.sudoworkTencentSecretId,
          secretKey: file.sudoworkTencentSecretKey,
        },
      },
      qms: {
        enabled: true,
        apiKeyHeader: 'X-API-Key',
        queue: { flushIntervalMs: 3000, batchSize: 50, visibilityTimeoutMs: 60_000 },
        retention: { perfDays: 90, conversationDays: 180, crashDays: 90, aggregateDays: 365 },
        encryptionRequired: false,
        secrets: {},
      },
    } as unknown as ServerConfig
  }

  it('Nexus 有值 → 采用 Nexus 值，丢弃文件值', async () => {
    clearEnv()
    try {
      const fake = new FakeNexus()
      fake.seed('server.cabin-llm-api-key', 'nexus-llm')
      fake.seed('server.hub-authorization', 'nexus-hub')
      fake.seed('server.sudowork-legacy-jwt-secret', 'nexus-jwt')
      fake.seed('server.sudowork-redis-url', 'redis://nexus')
      fake.seed('server.sudowork-tencent-secret-id', 'nexus-secret-id')
      fake.seed('server.sudowork-tencent-secret-key', 'nexus-secret-key')
      fake.seed('server.sudowork-dify-system-token', 'nexus-dify-token')
      fake.seed('server.sudowork-dify-provision-secret', 'nexus-dify-provision')
      fake.seed('server.sudowork-dify-sso-secret', 'nexus-dify-sso')
      fake.seed('server.qms-postgres-url', 'postgres://qms:secret@db/qms')
      fake.seed('server.qms-redis-url', 'redis://cache/3')
      fake.seed('server.qms-api-key', 'nexus-qms-key')
      fake.seed('server.qms-telemetry-private-key', 'nexus-private-key')
      fake.seed('server.qms-telemetry-public-key', 'nexus-public-key')
      const store = new ConfigStore(asClient(fake))
      await store.loadAll()

      const config = makeConfig({
        cabinLlmApiKey: 'file-llm',
        hubAuthorization: 'file-hub',
        sudoworkLegacyJwtSecret: 'file-jwt',
        sudoworkRedisUrl: 'redis://file',
        sudoworkTencentSecretId: 'file-secret-id',
        sudoworkTencentSecretKey: 'file-secret-key',
        difySystemToken: 'file-dify-token',
        difyProvisionSecret: 'file-dify-provision',
        difySsoSecret: 'file-dify-sso',
      })
      store.hydrateConfig(config)

      expect(config.cabin.llmApiKey).toBe('nexus-llm')
      expect(config.hubAuthorization).toBe('nexus-hub')
      expect(config.sudoworkCompatibility.legacyJwtSecret).toBe('nexus-jwt')
      expect(config.sudoworkCompatibility.redisUrl).toBe('redis://nexus')
      expect(config.sudoworkCompatibility.sms.secretId).toBe('nexus-secret-id')
      expect(config.sudoworkCompatibility.sms.secretKey).toBe('nexus-secret-key')
      expect(config.sudoworkCompatibility.dify.systemToken).toBe('nexus-dify-token')
      expect(config.sudoworkCompatibility.dify.provisionSecret).toBe('nexus-dify-provision')
      expect(config.sudoworkCompatibility.dify.ssoSecret).toBe('nexus-dify-sso')
      expect(config.qms.secrets.postgresUrl).toBe('postgres://qms:secret@db/qms')
      expect(config.qms.secrets.redisUrl).toBe('redis://cache/3')
      expect(config.qms.secrets.apiKey).toBe('nexus-qms-key')
      expect(config.qms.secrets.privateKeyPem).toBe('nexus-private-key')
      expect(config.qms.secrets.publicKeyPem).toBe('nexus-public-key')
    } finally {
      clearEnv()
    }
  })

  it('env 设置（非 hub）→ 保持 env 值，不被 Nexus 覆盖', async () => {
    clearEnv()
    process.env.CABIN_LLM_API_KEY = 'env-llm'
    try {
      const fake = new FakeNexus()
      fake.seed('server.cabin-llm-api-key', 'nexus-llm')
      const store = new ConfigStore(asClient(fake))
      await store.loadAll()

      // resolveServerConfig 现状：env 已设置时 config 取 env 值。此处预置模拟之。
      const config = makeConfig({ cabinLlmApiKey: 'env-llm' })
      store.hydrateConfig(config)

      expect(config.cabin.llmApiKey).toBe('env-llm')
    } finally {
      clearEnv()
    }
  })

  it('Nexus 与 env 均无 → 回落 zod 默认/undefined，文件值被丢弃', async () => {
    clearEnv()
    try {
      const fake = new FakeNexus()
      const store = new ConfigStore(asClient(fake))
      await store.loadAll()

      const config = makeConfig({
        cabinTokenSecret: 'file-ts',
        cabinLlmApiKey: 'file-llm',
        resourceTokenSecret: 'file-rts',
      })
      store.hydrateConfig(config)

      // 非可选字段回落 zod 默认（文件值被丢弃）
      expect(config.cabin.tokenSecret).toBe('dev-cabin-token-secret')
      expect(config.wikiIndex.resourceTokenSecret).toBe('dev-resource-token-secret')
      // optional 字段回落 undefined（文件值被丢弃）
      expect(config.cabin.llmApiKey).toBeUndefined()
      expect(config.sudoworkCompatibility.legacyJwtSecret).toBeUndefined()
      expect(config.sudoworkCompatibility.redisUrl).toBeUndefined()
      expect(config.sudoworkCompatibility.sms.secretId).toBeUndefined()
      expect(config.sudoworkCompatibility.sms.secretKey).toBeUndefined()
      expect(config.sudoworkCompatibility.dify.systemToken).toBeUndefined()
      expect(config.sudoworkCompatibility.dify.provisionSecret).toBeUndefined()
      expect(config.sudoworkCompatibility.dify.ssoSecret).toBeUndefined()
    } finally {
      clearEnv()
    }
  })
})

describe('updateSystemSettings 敏感字段写 Nexus、文件不落盘', () => {
  it('apiKey/image.apiKey 写入 Nexus，落盘文件无敏感字段', async () => {
    const fake = new FakeNexus()
    initConfigStore(asClient(fake)) // 单例：systemSettings 经 getConfigStore 读到同一实例
    writeFileSync(SETTINGS_PATH, JSON.stringify({ model: 'm', env: {} }), 'utf8')

    await updateSystemSettings({
      apiKey: 'sk-secret-text',
      image: { provider: 'openai', url: 'http://img', apiKey: 'img-secret', model: 'dall-e' },
    })

    expect(fake.read('settings.anthropic-auth-token')).toEqual({ value: 'sk-secret-text' })
    expect(fake.read('settings.image-api-key')).toEqual({ value: 'img-secret' })

    const saved = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
    expect(saved.apiKey).toBeUndefined()
    expect(saved.image?.apiKey).toBeUndefined()
    expect(saved.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(saved.image?.provider).toBe('openai')
  })
})
