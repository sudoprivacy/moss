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
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
const { ConfigStore, initConfigStore, CONFIG_NAMESPACE, organizationConfigKey } = await import('./configStore.js')
const {
  getOrganizationSystemSettings,
  getSystemSettings,
  SYSTEM_SETTINGS_PATH,
  SystemSettingsScopeError,
  updateOrganizationSystemSettings,
  updateSystemSettings,
} = await import('../systemSettings.js')
const { getModelProviderApiKey } = await import('../modelListCache.js')

// 必须在任何 settings 写入前确认隔离路径，模块 mock 失效时直接终止。
expect(SYSTEM_SETTINGS_PATH).toBe(SETTINGS_PATH)
afterAll(() => rmSync(FAKE_HOME, { recursive: true, force: true }))

/** value 为 null 表示"记录存在但无值"（损坏记录），用于三分支测试。 */
type Rec = { value: string | null }

/** 最小 NexusClient 替身：内存 Map，可模拟 putSecret 失败与损坏记录。 */
class FakeNexus {
  readonly records = new Map<string, Rec>()
  readonly mutations: Array<{ operation: 'put' | 'delete'; key: string }> = []
  failPut = false

  private k(namespace: string, key: string): string {
    return `${namespace}::${key}`
  }

  async putSecret(namespace: string, key: string, value: string): Promise<void> {
    if (this.failPut) throw new Error('simulated putSecret failure')
    this.mutations.push({ operation: 'put', key })
    this.records.set(this.k(namespace, key), { value })
  }

  async getSecret(namespace: string, key: string): Promise<Rec | null> {
    const rec = this.records.get(this.k(namespace, key))
    return rec === undefined ? null : rec
  }

  async deleteSecret(namespace: string, key: string): Promise<void> {
    this.mutations.push({ operation: 'delete', key })
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
    } as unknown as ServerConfig
  }

  it('Nexus 有值 → 采用 Nexus 值，丢弃文件值', async () => {
    clearEnv()
    try {
      const fake = new FakeNexus()
      fake.seed('server.cabin-llm-api-key', 'nexus-llm')
      fake.seed('server.hub-authorization', 'nexus-hub')
      const store = new ConfigStore(asClient(fake))
      await store.loadAll()

      const config = makeConfig({ cabinLlmApiKey: 'file-llm', hubAuthorization: 'file-hub' })
      store.hydrateConfig(config)

      expect(config.cabin.llmApiKey).toBe('nexus-llm')
      expect(config.hubAuthorization).toBe('nexus-hub')
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
    } finally {
      clearEnv()
    }
  })
})

describe('updateSystemSettings 敏感字段写 Nexus、文件不落盘', () => {
  const AUTH_KEY = 'settings.anthropic-auth-token'
  const IMAGE_KEY = 'settings.image-api-key'
  const fake = new FakeNexus()
  const store = initConfigStore(asClient(fake))

  beforeEach(async () => {
    // initConfigStore 是单例；每个用例重置内存 Nexus 及缓存，不创建真实客户端。
    fake.failPut = false
    fake.records.clear()
    await store.remove(AUTH_KEY)
    await store.remove(IMAGE_KEY)
    fake.mutations.length = 0
    writeFileSync(SETTINGS_PATH, JSON.stringify({ model: 'm', env: {} }), 'utf8')
  })

  async function seedSecrets(): Promise<void> {
    fake.seed(AUTH_KEY, 'saved-auth')
    fake.seed(IMAGE_KEY, 'saved-image')
    await store.loadAll()
    fake.mutations.length = 0 // 不计入 loadAll 的健康探针。
  }

  function expectSecretsPreserved(): void {
    expect(fake.read(AUTH_KEY)).toEqual({ value: 'saved-auth' })
    expect(fake.read(IMAGE_KEY)).toEqual({ value: 'saved-image' })
    expect(store.get(AUTH_KEY)).toBe('saved-auth')
    expect(store.get(IMAGE_KEY)).toBe('saved-image')
    expect(fake.mutations).toEqual([])
  }

  function expectFileHasNoSecrets(): void {
    const saved = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
    expect(saved.apiKey).toBeUndefined()
    expect(saved.image?.apiKey).toBeUndefined()
    expect(saved.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  }

  it('apiKey/image.apiKey 写入 Nexus，落盘文件无敏感字段', async () => {
    await updateSystemSettings({
      apiKey: 'sk-secret-text',
      image: { provider: 'openai', url: 'http://img', apiKey: 'img-secret', model: 'dall-e' },
    })

    expect(fake.read(AUTH_KEY)).toEqual({ value: 'sk-secret-text' })
    expect(fake.read(IMAGE_KEY)).toEqual({ value: 'img-secret' })
    expectFileHasNoSecrets()
    expect(JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')).image.provider).toBe('openai')
  })

  for (const fileState of ['valid', 'malformed', 'missing'] as const) {
    describe(`settings.json ${fileState}`, () => {
      beforeEach(async () => {
        await seedSecrets()
        if (fileState === 'malformed') writeFileSync(SETTINGS_PATH, '{broken json', 'utf8')
        if (fileState === 'missing') rmSync(SETTINGS_PATH)
      })

      it('读取 Nexus 密钥与文件加载状态互不影响', () => {
        const settings = getSystemSettings()
        expect(settings.apiKey).toBe('saved-auth')
        expect(settings.image.apiKey).toBe('saved-image')
        expect(settings.settingsExists).toBe(fileState !== 'missing')
        expect(settings.settingsLoaded).toBe(fileState === 'valid')
        expect(Boolean(settings.settingsParseError)).toBe(fileState === 'malformed')
        expectSecretsPreserved()
      })

      it.each([
        { model: 'updated-model' },
        { image: { model: 'updated-image-model' } },
        { clientCronEnabled: false, clientShowToolCalls: false },
      ])('非密钥 PATCH %j 保留密钥，且不调用 put/delete', async patch => {
        const settings = await updateSystemSettings(patch)
        expectSecretsPreserved()
        expect(settings.apiKey).toBe('saved-auth')
        expect(settings.image.apiKey).toBe('saved-image')
        expect(settings.settingsLoaded).toBe(true)
        expect(settings.settingsParseError).toBe('')
        const saved = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
        if ('model' in patch) expect(saved.model).toBe(patch.model)
        if (patch.image) expect(saved.image.model).toBe(patch.image.model)
        if ('clientCronEnabled' in patch) {
          expect(saved.clientCronEnabled).toBe(false)
          expect(saved.clientShowToolCalls).toBe(false)
        }
        expect(getSystemSettings().apiKey).toBe('saved-auth')
        expect(getSystemSettings().image.apiKey).toBe('saved-image')
        expectFileHasNoSecrets()
      })

      it.each(['', ' \t '])('显式 apiKey=%j 只清除文本密钥', async apiKey => {
        const settings = await updateSystemSettings({ apiKey })
        expect(fake.read(AUTH_KEY)).toBeUndefined()
        expect(store.get(AUTH_KEY)).toBeUndefined()
        expect(settings.apiKey).toBe('')
        expect(fake.read(IMAGE_KEY)).toEqual({ value: 'saved-image' })
        expect(settings.image.apiKey).toBe('saved-image')
        expect(fake.mutations).toEqual([{ operation: 'delete', key: AUTH_KEY }])
        expectFileHasNoSecrets()
      })

      it.each(['', ' \t '])('显式 image.apiKey=%j 只清除图片密钥', async apiKey => {
        const settings = await updateSystemSettings({ image: { apiKey } })
        expect(fake.read(IMAGE_KEY)).toBeUndefined()
        expect(store.get(IMAGE_KEY)).toBeUndefined()
        expect(settings.image.apiKey).toBe('')
        expect(fake.read(AUTH_KEY)).toEqual({ value: 'saved-auth' })
        expect(settings.apiKey).toBe('saved-auth')
        expect(fake.mutations).toEqual([{ operation: 'delete', key: IMAGE_KEY }])
        expectFileHasNoSecrets()
      })
    })
  }

  it.each([
    null,
    [],
    {},
    { apiKey: undefined, image: { apiKey: undefined } },
    { apiKey: null, image: { apiKey: null } },
    { apiKey: 123, image: { apiKey: false } },
    { image: null },
    { image: [{ apiKey: '' }] },
  ])('未明确提供密钥字符串的 PATCH %j 不写入或删除密钥', async patch => {
    await seedSecrets()
    await updateSystemSettings(patch)
    expectSecretsPreserved()
  })

  it('仅修改 apiKey 不重写图片密钥，字符串仍执行 trim', async () => {
    await seedSecrets()
    const settings = await updateSystemSettings({ apiKey: ' new-auth ' })
    expect(fake.read(AUTH_KEY)).toEqual({ value: 'new-auth' })
    expect(settings.apiKey).toBe('new-auth')
    expect(fake.read(IMAGE_KEY)).toEqual({ value: 'saved-image' })
    expect(fake.mutations).toEqual([{ operation: 'put', key: AUTH_KEY }])
    expectFileHasNoSecrets()
  })

  it('仅修改 image.apiKey 不重写文本密钥，字符串仍执行 trim', async () => {
    await seedSecrets()
    const settings = await updateSystemSettings({ image: { apiKey: ' new-image ' } })
    expect(fake.read(IMAGE_KEY)).toEqual({ value: 'new-image' })
    expect(settings.image.apiKey).toBe('new-image')
    expect(fake.read(AUTH_KEY)).toEqual({ value: 'saved-auth' })
    expect(fake.mutations).toEqual([{ operation: 'put', key: IMAGE_KEY }])
    expectFileHasNoSecrets()
  })

  it.each([false, true])('env 不写入 Nexus 或配置文件，也不受 PATCH 清除（已存密钥=%j）', async hasSecrets => {
    const envKeys = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'] as const
    const previous = envKeys.map(key => process.env[key])
    try {
      process.env.ANTHROPIC_AUTH_TOKEN = 'env-auth'
      process.env.ANTHROPIC_API_KEY = 'env-api-key'
      process.env.ANTHROPIC_BASE_URL = 'https://env.example.test'
      if (hasSecrets) await seedSecrets()
      writeFileSync(SETTINGS_PATH, '{broken json', 'utf8')

      const settings = await updateSystemSettings({ model: 'updated-model' })
      expect(settings.apiKey).toBe(hasSecrets ? 'saved-auth' : '')
      expect(settings.image.apiKey).toBe(hasSecrets ? 'saved-image' : '')
      expect(fake.mutations).toEqual([])
      expectFileHasNoSecrets()
      const saved = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
      expect(saved.env).toBeUndefined()

      await updateSystemSettings({ apiKey: '', image: { apiKey: '' } })
      expect(fake.read(AUTH_KEY)).toBeUndefined()
      expect(fake.read(IMAGE_KEY)).toBeUndefined()
      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('env-auth')
      expect(process.env.ANTHROPIC_API_KEY).toBe('env-api-key')
      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://env.example.test')
    } finally {
      envKeys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key]
        else process.env[key] = previous[index]
      })
    }
  })

  it('非密钥 PATCH 保留配置文件中的 URL、其他 env 及未知字段', async () => {
    await seedSecrets()
    const env = { ANTHROPIC_BASE_URL: 'https://settings.example.test', CUSTOM_FLAG: 'keep' }
    writeFileSync(SETTINGS_PATH, JSON.stringify({ env, custom: { keep: true } }), 'utf8')
    const settings = await updateSystemSettings({ model: 'updated-model' })
    expect(settings.url).toBe(env.ANTHROPIC_BASE_URL)
    const saved = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
    expect(saved.env).toEqual(env)
    expect(saved.custom).toEqual({ keep: true })
    expectSecretsPreserved()
  })

  it('Nexus 没有密钥时不采用旧文件密钥，也不执行空值删除', async () => {
    writeFileSync(SETTINGS_PATH, JSON.stringify({
      apiKey: 'old-file-auth',
      image: { apiKey: 'old-file-image' },
    }), 'utf8')
    expect(getSystemSettings().apiKey).toBe('')
    expect(getSystemSettings().image.apiKey).toBe('')
    await updateSystemSettings({ model: 'updated-model' })
    expect(fake.mutations).toEqual([])
    expectFileHasNoSecrets()
  })

  it('parses string boolean settings without treating "false" as true', async () => {
    const settings = await updateSystemSettings({
      bypassPermissions: 'false',
      clientCronEnabled: 'false',
      clientShowToolCalls: 'false',
      oauth2: {
        enabled: 'false',
        requireState: 'false',
      },
    })

    expect(settings.bypassPermissions).toBe(false)
    expect(settings.clientCronEnabled).toBe(false)
    expect(settings.clientShowToolCalls).toBe(false)
    expect(settings.oauth2.enabled).toBe(false)
    expect(settings.oauth2.requireState).toBe(false)
  })

  it('组织模型设置按 orgId 隔离，并且 API 响应不返回密钥原文', async () => {
    await updateSystemSettings({
      model: 'platform-model',
      apiKey: 'platform-text-key',
      image: { apiKey: 'platform-image-key' },
      modelProviders: [{
        id: 'platform-provider',
        name: 'Platform Provider',
        kind: 'openai-compatible',
        baseUrl: 'https://platform.example.invalid/v1',
        discoveryUrl: 'https://platform.example.invalid/v1/models',
        protocol: 'openai-completions',
        enabled: true,
        apiKey: 'platform-provider-key',
      }],
      defaultModelProviderId: 'platform-provider',
    })
    fake.mutations.length = 0

    const repository = new FakeOrganizationModelSettingsRepository() as never
    const orgA = await updateOrganizationSystemSettings('org-a', repository, {
      model: 'org-a-model',
      apiKey: 'org-a-text-key',
      image: { model: 'org-a-image', apiKey: 'org-a-image-key' },
      modelProviders: [{
        id: 'org-a-provider',
        name: 'Org A Provider',
        kind: 'openai-compatible',
        baseUrl: 'https://org-a.example.invalid/v1',
        discoveryUrl: 'https://org-a.example.invalid/v1/models',
        protocol: 'openai-responses',
        enabled: true,
        apiKey: 'org-a-provider-key',
      }],
      defaultModelProviderId: 'org-a-provider',
    }, 'admin-a', { redactSecrets: true })

    expect(orgA.model).toBe('org-a-model')
    expect(orgA.apiKey).toBe('')
    expect(orgA.apiKeyConfigured).toBe(true)
    expect(orgA.image.apiKey).toBe('')
    expect(orgA.image.apiKeyConfigured).toBe(true)
    expect(orgA.image.model).toBe('org-a-image')
    expect(orgA.modelProviders[0]?.id).toBe('org-a-provider')
    expect(orgA.modelProviders[0]?.apiKeyConfigured).toBe(true)
    expect(fake.read(organizationConfigKey('org-a', 'settings.anthropic-auth-token'))).toEqual({ value: 'org-a-text-key' })
    expect(fake.read(organizationConfigKey('org-a', 'settings.image-api-key'))).toEqual({ value: 'org-a-image-key' })
    expect(fake.read(organizationConfigKey('org-a', 'settings.model-provider-api-keys'))?.value).toContain('org-a-provider-key')
    expect(getModelProviderApiKey('org-a-provider', orgA.apiKey, 'org-a')).toBe('org-a-provider-key')
    expect(getModelProviderApiKey('org-a-provider', orgA.apiKey, 'org-a', 'user-gateway-key')).toBe('org-a-provider-key')

    const orgB = await getOrganizationSystemSettings('org-b', repository, { redactSecrets: true })
    expect(orgB.model).toBe('platform-model')
    expect(orgB.apiKey).toBe('')
    expect(orgB.apiKeyConfigured).toBe(false)
    expect(orgB.image.apiKeyConfigured).toBe(false)
    expect(orgB.modelProviders[0]?.id).toBe('platform-provider')
    expect(orgB.modelProviders[0]?.apiKeyConfigured).toBe(false)
    expect(getModelProviderApiKey('platform-provider', orgB.apiKey, 'org-b')).toBeUndefined()
  })

  it('组织系统设置入口拒绝部署级字段且不修改全局设置', async () => {
    await updateSystemSettings({ clientCronEnabled: false, bypassPermissions: false })
    const repository = new FakeOrganizationModelSettingsRepository() as never

    await expect(updateOrganizationSystemSettings('org-a', repository, {
      model: 'org-a-model',
      clientCronEnabled: true,
    }, 'admin-a')).rejects.toThrow(SystemSettingsScopeError)

    expect(getSystemSettings().clientCronEnabled).toBe(false)
    expect(getSystemSettings().bypassPermissions).toBe(false)
    expect((repository as FakeOrganizationModelSettingsRepository).get('org-a')).toEqual({})
  })
})

class FakeOrganizationModelSettingsRepository {
  private readonly records = new Map<string, Record<string, unknown>>()

  get(orgId: string): Record<string, unknown> {
    return this.records.get(orgId) ?? {}
  }

  put(orgId: string, patch: Record<string, unknown>): Record<string, unknown> {
    const next = deepMerge(this.get(orgId), patch)
    this.records.set(orgId, next)
    return next
  }
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(base)
  for (const [key, value] of Object.entries(patch)) {
    result[key] = typeof value === 'object' && value !== null && !Array.isArray(value)
      && typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])
      ? deepMerge(result[key] as Record<string, unknown>, value as Record<string, unknown>)
      : structuredClone(value)
  }
  return result
}
