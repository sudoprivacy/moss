/**
 * configStore — 服务器端敏感配置的 Nexus 存储层（namespace: moss:config）
 *
 * 单一职责：
 *  - 探针三明治 + fail-fast 加载 12 个配置 key 到内存缓存（同步消费链读缓存）
 *  - get（同步）/ put / remove（写 Nexus + 更新缓存；server 字段可选同步回写 config 快照）
 *  - hydrateConfig：启动时把 Nexus 值就地写入 ServerConfig 快照，并丢弃这些字段的文件值
 *    （Nexus + env 为唯一来源；不做任何文件迁移或写回）
 *
 * 设计约束（对抗审核定稿，勿改）：
 *  - 仅用 NexusClient 的 putSecret/getSecret/deleteSecret 门面方法（底层已切换
 *    vault 插件加密服务，语义适配收在门面层）；通道故障经方法抛错上抛，
 *    fail-fast 不依赖错误形态区分
 *  - hydrate/回写必须就地字段赋值，禁止对象替换——cabin/api.ts:484 等处持有 config.cabin
 *    子对象引用，对象替换会使这些服务永远持有旧值
 *  - "env 未设置"判定一律用 truthiness 语义（与 config.ts 现状 `env || raw` 同款）
 */

import type { NexusClient } from '../nexus/nexusClient.js'
import type { ServerConfig } from '../types.js'

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
            `恢复方法：停止 moss-server，经加密服务删除该记录 ` +
            `（password-vault.secret_delete，namespace=${CONFIG_NAMESPACE}）后重启重新录入`,
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
   * 启动 hydrate：把这 10 个字段解析为 env > Nexus > 默认（hub 为 Nexus > env > 默认，
   * 见 ignoreEnvGate），就地写入 config 快照并丢弃 resolveServerConfig 读入的文件值
   * （Nexus + env 为唯一来源）。Nexus 无值时回落 fallbackValue（zod 默认）或 undefined，
   * 避免 undefined 击穿非可选 string。必须就地字段赋值、禁止对象替换（消费者持有
   * config / config.cabin 引用）。
   */
  hydrateConfig(config: ServerConfig): void {
    for (const field of SERVER_FIELDS) {
      // env 优先（hub 除外）：config 已由 resolveServerConfig 置为 env 值，保持不动
      if (!field.ignoreEnvGate && process.env[field.envName]) continue
      // Nexus 有值用 Nexus，否则回落默认/undefined —— 覆盖并丢弃文件值
      field.apply(config, this.cache.get(field.key) || field.fallbackValue)
    }
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
