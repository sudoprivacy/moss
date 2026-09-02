/**
 * configStore — 服务器端敏感配置的 Nexus 存储层（namespace: moss:config）
 *
 * 单一职责（计划步骤 1/2/5）：
 *  - 探针三明治 + fail-fast 加载 12 个配置 key 到内存缓存（同步消费链读缓存）
 *  - get（同步）/ put / remove（写 Nexus + 更新缓存；server 字段可选同步回写 config 快照）
 *  - migrateFromFiles：一次性把两个配置文件中的敏感字段迁入 Nexus 并从文件删除
 *    （幂等、顺序保证：putSecret 成功才删文件字段、无明文备份）
 *  - hydrateConfig：启动时按分组条件把 Nexus 值就地写入 ServerConfig 快照
 *
 * 设计约束（对抗审核定稿，勿改）：
 *  - NexusClient 零修改（仅用现有 putSecret/getSecret/deleteSecret）；native read 将一切
 *    错误压平为字符串（native/nexus-napi/src/lib.rs:46-51），fail-fast 不依赖错误形态区分
 *  - hydrate/回写必须就地字段赋值，禁止对象替换——cabin/api.ts:484 等处持有 config.cabin
 *    子对象引用，对象替换会使这些服务永远持有旧值
 *  - "env 未设置"判定一律用 truthiness 语义（与 config.ts 现状 `env || raw` 同款）
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { NexusClient } from '../nexus/nexusClient.js'
import type { ServerConfig } from '../types.js'
import { getDefaultServerConfigPath } from '../config.js'

export const CONFIG_NAMESPACE = 'moss:config'

export const CONFIG_KEYS = [
  'settings.anthropic-auth-token',
  'settings.image-api-key',
  'server.hub-authorization',
  'server.wiki-index-resource-token-secret',
  'server.cabin-token-secret',
  'server.cabin-passenger-info-auth',
  'server.cabin-asr-api-key',
  'server.cabin-tts-api-key',
  'server.cabin-llm-api-key',
  'server.cabin-control-auth',
  'server.cabin-broadcast-api-key',
  'server.cabin-broadcast-auth',
] as const

export type ConfigKey = (typeof CONFIG_KEYS)[number]

/** 供 server-credentials API 使用的脱敏规则：长值显示尾 4 位，短值只显示已设置。 */
export function maskConfigValue(value: string): string {
  return value.length > 8 ? `****${value.slice(-4)}` : '****'
}

const PROBE_KEY = '_health-probe'
const PROBE_VALUE = 'config-store-health-probe'

/**
 * settings.json 路径 —— 与 systemSettings.ts 的 SYSTEM_SETTINGS_PATH 同规则
 * （不 import 该模块以避免循环依赖：systemSettings → configStore）。
 */
function settingsFilePath(): string {
  return join(homedir(), '.moss', 'settings.json')
}

/** server.json 路径 —— 复用 readServerConfig 的同一解析规则（config.ts:272）。 */
function serverConfigFilePath(): string {
  return process.env.MOSS_SERVER_CONFIG || getDefaultServerConfigPath()
}

/**
 * server.json 侧 10 个字段的回填规格。
 *
 * 分组条件（源于代码现状，勿改）：
 *  - hub.authorization：config 值优先于 env（hubConfig.ts:42-49），故 hydrate/PUT
 *    为"Nexus 有值即写"（ignoreEnvGate），保持 config-over-env 现状
 *  - 其余 9 个字段：现状 env 优先于文件值（config.ts `env || raw`），故
 *    "env 未设置 && Nexus 有值才写"
 *
 * 置空回写（remove 带 config 时）复现 resolveServerConfig 的取值语义：
 * env 已设置 → 回写 env 值；env 未设置 → 带 zod 默认值的字段回落默认、optional 置 undefined。
 */
type ServerFieldSpec = {
  key: ConfigKey
  envName: string
  ignoreEnvGate: boolean
  /** 置空时 env 未设置的回落值（仅 resourceTokenSecret / cabin.tokenSecret 两个 zod default 字段） */
  fallbackValue?: string
  /** 就地字段赋值（禁止对象替换） */
  apply: (config: ServerConfig, value: string | undefined) => void
}

const SERVER_FIELDS: readonly ServerFieldSpec[] = [
  {
    key: 'server.hub-authorization',
    envName: 'MOSS_HUB_AUTHORIZATION',
    ignoreEnvGate: true,
    apply: (config, value) => {
      config.hubAuthorization = value || undefined
    },
  },
  {
    key: 'server.wiki-index-resource-token-secret',
    envName: 'MOSS_RESOURCE_TOKEN_SECRET',
    ignoreEnvGate: false,
    fallbackValue: 'dev-resource-token-secret',
    apply: (config, value) => {
      config.wikiIndex.resourceTokenSecret = value ?? 'dev-resource-token-secret'
    },
  },
  {
    key: 'server.cabin-token-secret',
    envName: 'CABIN_TOKEN_SECRET',
    ignoreEnvGate: false,
    fallbackValue: 'dev-cabin-token-secret',
    apply: (config, value) => {
      config.cabin.tokenSecret = value ?? 'dev-cabin-token-secret'
    },
  },
  {
    key: 'server.cabin-passenger-info-auth',
    envName: 'CABIN_PASSENGER_INFO_AUTH',
    ignoreEnvGate: false,
    apply: (config, value) => {
      config.cabin.passengerInfoAuth = value || undefined
    },
  },
  {
    key: 'server.cabin-asr-api-key',
    envName: 'CABIN_ASR_API_KEY',
    ignoreEnvGate: false,
    apply: (config, value) => {
      config.cabin.asrApiKey = value || undefined
    },
  },
  {
    key: 'server.cabin-tts-api-key',
    envName: 'CABIN_TTS_API_KEY',
    ignoreEnvGate: false,
    apply: (config, value) => {
      config.cabin.ttsApiKey = value || undefined
    },
  },
  {
    key: 'server.cabin-llm-api-key',
    envName: 'CABIN_LLM_API_KEY',
    ignoreEnvGate: false,
    apply: (config, value) => {
      config.cabin.llmApiKey = value || undefined
    },
  },
  {
    key: 'server.cabin-control-auth',
    envName: 'CABIN_CONTROL_AUTH',
    ignoreEnvGate: false,
    apply: (config, value) => {
      config.cabin.controlAuth = value || undefined
    },
  },
  {
    key: 'server.cabin-broadcast-api-key',
    envName: 'CABIN_BROADCAST_API_KEY',
    ignoreEnvGate: false,
    apply: (config, value) => {
      config.cabin.broadcastApiKey = value || undefined
    },
  },
  {
    key: 'server.cabin-broadcast-auth',
    envName: 'CABIN_BROADCAST_AUTH',
    ignoreEnvGate: false,
    apply: (config, value) => {
      config.cabin.broadcastAuth = value || undefined
    },
  },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class ConfigStore {
  private readonly client: NexusClient | null
  private readonly cache = new Map<ConfigKey, string>()

  constructor(client: NexusClient | null) {
    this.client = client
  }

  /** 同步读缓存；未初始化（runner 子进程）或未设置时返回 undefined，不抛错。 */
  get(key: ConfigKey): string | undefined {
    return this.cache.get(key)
  }

  /** 当前缓存的 key 集合（测试/诊断用）。 */
  keys(): Set<ConfigKey> {
    return new Set(this.cache.keys())
  }

  /**
   * 探针三明治 + fail-fast 加载（计划步骤 1）。
   *
   * 前探针（put→get→delete）证通道健康后才读 12 个 key——此时 getSecret 的 null
   * 才可信任为"未设置"；读取按三分支判定（null=未设置 / 非 null 且 value null=
   * 记录损坏→启动失败 / 其余字符串含空串=采用）；后探针捕获"读取中 nexusd 崩溃"
   * 的窗口。任一致命条件触发即 throw（启动失败，不静默降级 dev 默认密钥）。
   */
  async loadAll(): Promise<void> {
    if (!this.client) return
    await this.probe()
    for (const key of CONFIG_KEYS) {
      const record = await this.client.getSecret(CONFIG_NAMESPACE, key)
      if (record === null) continue
      if (record.value === null) {
        throw new Error(
          `[ConfigStore] Nexus 记录损坏（存在但无值）: ${key}。` +
            `恢复方法：停止 moss-server，用 native NexusGrpcClient 删除 ` +
            `/secrets/moss/config/${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.json 后重启重新录入`,
        )
      }
      this.cache.set(key, record.value)
    }
    await this.probe()
  }

  /** put→get→delete 探针：put/get 任一失败或读回值不符 → throw；delete 尽力而为。 */
  private async probe(): Promise<void> {
    if (!this.client) return
    await this.client.putSecret(CONFIG_NAMESPACE, PROBE_KEY, PROBE_VALUE)
    const record = await this.client.getSecret(CONFIG_NAMESPACE, PROBE_KEY)
    if (!record || record.value !== PROBE_VALUE) {
      throw new Error('[ConfigStore] Nexus 健康探针失败（写入后读回值不符）')
    }
    await this.client.deleteSecret(CONFIG_NAMESPACE, PROBE_KEY)
  }

  /**
   * 写值：写 Nexus + 更新缓存；携带 config 时按分组条件同步回写快照（就地赋值）。
   * 仅用于 server.json 侧 10 个字段时才传 config。
   */
  async put(key: ConfigKey, value: string, config?: ServerConfig): Promise<void> {
    if (!this.client) {
      throw new Error('[ConfigStore] 未初始化（initConfigStore 未调用），无法写入')
    }
    await this.client.putSecret(CONFIG_NAMESPACE, key, value)
    this.cache.set(key, value)
    this.applyToConfig(config, key, value)
  }

  /**
   * 置空：deleteSecret + 清缓存；携带 config 时就地回写（env 已设置→env 值；
   * 未设置→zod default 字段回落默认、optional 置 undefined）——复现
   * resolveServerConfig 的取值语义，与现状"从文件删键"运行时等价。
   */
  async remove(key: ConfigKey, config?: ServerConfig): Promise<void> {
    if (!this.client) {
      throw new Error('[ConfigStore] 未初始化（initConfigStore 未调用），无法删除')
    }
    await this.client.deleteSecret(CONFIG_NAMESPACE, key)
    this.cache.delete(key)
    const field = SERVER_FIELDS.find(f => f.key === key)
    if (config && field) {
      field.apply(config, process.env[field.envName] || field.fallbackValue)
    }
  }

  /** PUT 写值的分组条件回写（hub 有值即写；其余 9 个字段 env 未设置才写）。 */
  private applyToConfig(config: ServerConfig | undefined, key: ConfigKey, value: string): void {
    if (!config) return
    const field = SERVER_FIELDS.find(f => f.key === key)
    if (!field) return
    if (!field.ignoreEnvGate && process.env[field.envName]) return
    field.apply(config, value)
  }

  /**
   * 启动 hydrate（计划步骤 2）：按分组条件把 Nexus 值就地写入 config 快照。
   * Nexus 无值的字段不动（保留 resolveServerConfig 的文件值/env 值/zod 默认值——
   * 防止 undefined 击穿非可选 string）。
   */
  hydrateConfig(config: ServerConfig): void {
    for (const field of SERVER_FIELDS) {
      const value = this.cache.get(field.key)
      if (!value) continue
      if (!field.ignoreEnvGate && process.env[field.envName]) continue
      field.apply(config, value)
    }
  }

  /**
   * 一次性迁移（计划步骤 5，幂等，无明文备份）。
   *
   * 顺序保证：putSecret 写入成功后才从文件删除对应字段；任一 putSecret 失败 →
   * throw（启动失败，文件保持原样下次重试）；文件写回失败 → throw（同样启动失败，
   * 吞错会形成"文件残留明文敏感字段"的假成功）。Nexus 已有值则跳过写入、仅删
   * 文件字段。空字符串来源值跳过写入、仅删文件键。
   */
  async migrateFromFiles(): Promise<void> {
    if (!this.client) return
    await this.migrateSettingsFile()
    await this.migrateServerConfigFile()
  }

  private readJsonFile(path: string): Record<string, unknown> | null {
    try {
      if (!existsSync(path)) return null
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      return isRecord(parsed) ? parsed : null
    } catch (error) {
      throw new Error(
        `[ConfigStore] 迁移前读取配置文件失败: ${path} (${error instanceof Error ? error.message : String(error)})`,
      )
    }
  }

  private writeJsonFile(path: string, data: Record<string, unknown>): void {
    try {
      writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    } catch (error) {
      throw new Error(
        `[ConfigStore] 迁移后写回配置文件失败（敏感字段已入 Nexus，但文件字段删除未完成，请检查路径/权限）: ${path} ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      )
    }
  }

  /** 迁移一个来源值：非空且 Nexus 未有 → putSecret；返回文件是否被修改。 */
  private async migrateValue(
    key: ConfigKey,
    value: string,
    removeFromFile: () => void,
  ): Promise<void> {
    if (!this.client) return
    if (value && !this.cache.has(key)) {
      await this.client.putSecret(CONFIG_NAMESPACE, key, value)
      this.cache.set(key, value)
    }
    removeFromFile()
  }

  private async migrateSettingsFile(): Promise<void> {
    const path = settingsFilePath()
    const raw = this.readJsonFile(path)
    if (!raw) return
    let mutated = false

    // --- settings.anthropic-auth-token：三源（ANTHROPIC_AUTH_TOKEN > ANTHROPIC_API_KEY > 顶层 apiKey，与 backendUtils.ts:75 现状一致）
    const env = isRecord(raw.env) ? raw.env : {}
    // 删除前先捕获原始存在性：removeFromFile 会就地删除这些键，若在其后再判定
    // 会恒为 false，导致文件删字段不落盘（明文 token 残留在 settings.json）
    const hadTokenField =
      env.ANTHROPIC_AUTH_TOKEN !== undefined ||
      env.ANTHROPIC_API_KEY !== undefined ||
      raw.apiKey !== undefined
    const tokenValue =
      (typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN.trim()) ||
      (typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.trim()) ||
      (typeof raw.apiKey === 'string' && raw.apiKey.trim()) ||
      ''
    await this.migrateValue('settings.anthropic-auth-token', tokenValue, () => {
      if (env.ANTHROPIC_AUTH_TOKEN !== undefined) delete env.ANTHROPIC_AUTH_TOKEN
      if (env.ANTHROPIC_API_KEY !== undefined) delete env.ANTHROPIC_API_KEY
      if (raw.env !== undefined) raw.env = env
      if (raw.apiKey !== undefined) delete raw.apiKey
    })
    if (hadTokenField) {
      mutated = true
    }
    // env 删空后整体移除（对齐 updateSystemSettings 现状的"空 env 删除"行为）
    if (raw.env !== undefined && isRecord(raw.env) && Object.keys(raw.env).length === 0) {
      delete raw.env
      mutated = true
    }

    // --- settings.image-api-key
    if (isRecord(raw.image) && raw.image.apiKey !== undefined) {
      const imageValue = typeof raw.image.apiKey === 'string' ? raw.image.apiKey.trim() : ''
      await this.migrateValue('settings.image-api-key', imageValue, () => {
        delete (raw.image as Record<string, unknown>).apiKey
      })
      mutated = true
    }

    if (mutated) this.writeJsonFile(path, raw)
  }

  private async migrateServerConfigFile(): Promise<void> {
    const path = serverConfigFilePath()
    const raw = this.readJsonFile(path)
    if (!raw) return
    let mutated = false

    const sourceSpecs: Array<{ parent: Record<string, unknown> | undefined; field: string; key: ConfigKey }> = [
      { parent: isRecord(raw.hub) ? raw.hub : undefined, field: 'authorization', key: 'server.hub-authorization' },
      { parent: isRecord(raw.wikiIndex) ? raw.wikiIndex : undefined, field: 'resourceTokenSecret', key: 'server.wiki-index-resource-token-secret' },
      { parent: isRecord(raw.cabin) ? raw.cabin : undefined, field: 'tokenSecret', key: 'server.cabin-token-secret' },
      { parent: isRecord(raw.cabin) ? raw.cabin : undefined, field: 'passengerInfoAuth', key: 'server.cabin-passenger-info-auth' },
      { parent: isRecord(raw.cabin) ? raw.cabin : undefined, field: 'asrApiKey', key: 'server.cabin-asr-api-key' },
      { parent: isRecord(raw.cabin) ? raw.cabin : undefined, field: 'ttsApiKey', key: 'server.cabin-tts-api-key' },
      { parent: isRecord(raw.cabin) ? raw.cabin : undefined, field: 'llmApiKey', key: 'server.cabin-llm-api-key' },
      { parent: isRecord(raw.cabin) ? raw.cabin : undefined, field: 'controlAuth', key: 'server.cabin-control-auth' },
      { parent: isRecord(raw.cabin) ? raw.cabin : undefined, field: 'broadcastApiKey', key: 'server.cabin-broadcast-api-key' },
      { parent: isRecord(raw.cabin) ? raw.cabin : undefined, field: 'broadcastAuth', key: 'server.cabin-broadcast-auth' },
    ]

    for (const spec of sourceSpecs) {
      if (!spec.parent || spec.parent[spec.field] === undefined) continue
      const rawValue = spec.parent[spec.field]
      const value = typeof rawValue === 'string' ? rawValue.trim() : ''
      await this.migrateValue(spec.key, value, () => {
        delete spec.parent![spec.field]
      })
      mutated = true
    }

    if (mutated) this.writeJsonFile(path, raw)
  }
}

let instance: ConfigStore | null = null

/** 主进程启动时创建单例（与 startStandaloneServer 的 nexusClient 同源）。 */
export function initConfigStore(client: NexusClient): ConfigStore {
  if (!instance) instance = new ConfigStore(client)
  return instance
}

/**
 * 获取单例。未初始化（runner 子进程等场景）时返回未连接 Nexus 的空实例：
 * get 返回 undefined、hydrateConfig 无操作、不在模块顶层连接 Nexus。
 */
export function getConfigStore(): ConfigStore {
  return instance ?? new ConfigStore(null)
}
