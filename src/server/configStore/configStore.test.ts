/**
 * configStore 单元测试（计划「验证方案」第 1 项）：
 *  - configStore 读写 / 缓存
 *  - migrateFromFiles() 幂等（跑两遍结果一致）
 *  - updateSystemSettings 后文件无敏感字段
 *  - putSecret 失败时文件字段保留
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

const FAKE_HOME = mkdtempSync(join(nodeOs.tmpdir(), 'moss-configstore-test-'))
const MOSS_DIR = join(FAKE_HOME, '.moss')
mkdirSync(MOSS_DIR, { recursive: true })
const SETTINGS_PATH = join(MOSS_DIR, 'settings.json')

mock.module('os', () => {
  const patched = { ...nodeOs, homedir: () => FAKE_HOME }
  return { ...patched, default: patched }
})

// mock 生效后再动态加载被测模块（configStore 的 settingsFilePath / systemSettings 的
// SYSTEM_SETTINGS_PATH 都基于 os.homedir()）。
const { ConfigStore, initConfigStore, CONFIG_NAMESPACE } = await import('./configStore.js')
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

describe('migrateFromFiles 幂等 + 迁移后文件无敏感字段', () => {
  it('迁移写 Nexus 并从文件删字段；二次运行幂等', async () => {
    writeFileSync(
      SETTINGS_PATH,
      JSON.stringify({
        model: 'm',
        env: { ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'http://x' },
        image: { provider: 'p', apiKey: 'img', model: 'im' },
      }),
      'utf8',
    )
    const serverPath = join(FAKE_HOME, 'server.json')
    process.env.MOSS_SERVER_CONFIG = serverPath
    writeFileSync(
      serverPath,
      JSON.stringify({
        hub: { authorization: 'hubauth' },
        cabin: { llmApiKey: 'cabinllm', tokenSecret: 'ts' },
      }),
      'utf8',
    )

    try {
      const fake = new FakeNexus()
      const store = new ConfigStore(asClient(fake))
      await store.loadAll()
      await store.migrateFromFiles()

      // Nexus 已有值
      expect(fake.read('settings.anthropic-auth-token')).toEqual({ value: 'tok' })
      expect(fake.read('settings.image-api-key')).toEqual({ value: 'img' })
      expect(fake.read('server.hub-authorization')).toEqual({ value: 'hubauth' })
      expect(fake.read('server.cabin-llm-api-key')).toEqual({ value: 'cabinllm' })
      expect(fake.read('server.cabin-token-secret')).toEqual({ value: 'ts' })

      // 文件已删敏感字段，非敏感字段保留
      const s1 = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
      expect(s1.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
      expect(s1.env?.ANTHROPIC_BASE_URL).toBe('http://x')
      expect(s1.image?.apiKey).toBeUndefined()
      expect(s1.image?.provider).toBe('p')
      const c1 = JSON.parse(readFileSync(serverPath, 'utf8'))
      expect(c1.hub?.authorization).toBeUndefined()
      expect(c1.cabin?.llmApiKey).toBeUndefined()
      expect(c1.cabin?.tokenSecret).toBeUndefined()

      // 二次运行幂等：文件字节不变、Nexus 不变
      const s1raw = readFileSync(SETTINGS_PATH, 'utf8')
      const c1raw = readFileSync(serverPath, 'utf8')
      await store.migrateFromFiles()
      expect(readFileSync(SETTINGS_PATH, 'utf8')).toBe(s1raw)
      expect(readFileSync(serverPath, 'utf8')).toBe(c1raw)
      expect(fake.read('settings.anthropic-auth-token')).toEqual({ value: 'tok' })
    } finally {
      delete process.env.MOSS_SERVER_CONFIG
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

describe('putSecret 失败时文件字段保留（fail-fast）', () => {
  it('迁移 putSecret 失败则抛错且文件敏感字段不删除', async () => {
    writeFileSync(SETTINGS_PATH, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'tok' } }), 'utf8')
    const serverPath = join(FAKE_HOME, 'server-fail.json')
    process.env.MOSS_SERVER_CONFIG = serverPath
    writeFileSync(serverPath, JSON.stringify({ hub: { authorization: 'hubauth' } }), 'utf8')

    try {
      const fake = new FakeNexus()
      const store = new ConfigStore(asClient(fake))
      await store.loadAll() // 探针在 putSecret 正常时通过
      fake.failPut = true // 之后模拟迁移 putSecret 失败
      await expect(store.migrateFromFiles()).rejects.toThrow(/putSecret failure/)

      const saved = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
      expect(saved.env?.ANTHROPIC_AUTH_TOKEN).toBe('tok')
      const c = JSON.parse(readFileSync(serverPath, 'utf8'))
      expect(c.hub?.authorization).toBe('hubauth')
    } finally {
      delete process.env.MOSS_SERVER_CONFIG
    }
  })
})
