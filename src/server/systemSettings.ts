import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { getConfigStore, organizationConfigKey } from './configStore/configStore.js'
import type { ConfigKey } from './configStore/configStore.js'
import {
  getStoredProviderApiKeys,
  clearProviderModelCache,
  normalizeModelProviders,
  providerApiKeysFromInput,
  refreshStoredProviderApiKeys,
  saveProviderApiKeys,
  toPublicProviders,
  type ModelProvider,
  type PublicModelProvider,
} from './modelProviders.js'
import type {
  OrganizationModelSettings,
  OrganizationModelSettingsRepository,
} from './configuration/organizationModelSettingsRepository.js'

/** 敏感字段在 Nexus（namespace moss:config）中的 key。 */
const AUTH_TOKEN_KEY: ConfigKey = 'settings.anthropic-auth-token'
const IMAGE_API_KEY_KEY: ConfigKey = 'settings.image-api-key'

export type ThinkingMode = 'adaptive' | 'enabled' | 'disabled'

export type SystemSettingsImage = {
  provider: string
  url: string
  apiKey: string
  apiKeyConfigured: boolean
  model: string
}

export type SystemSettingsSkillStore = {
  tenantId: string
}

export type SystemSettingsOAuth2 = {
  enabled: boolean
  /**
   * Full authorize URL template. moss substitutes {redirect_uri} (the sudowork
   * deep link) and {response_type}; sudowork fills {state}. Any provider-specific
   * params such as client_id or scope should be written literally into the URL.
   */
  authorizeUrlTemplate: string
  /** Absolute path to the credential script invoked with `resolve` / `refresh`. */
  scriptPath: string
  /**
   * Whether the client must verify the OAuth2 `state` parameter on callback.
   * Default true (CSRF protection). Set false in trusted internal deployments
   * where the desktop app and identity provider both live inside a controlled
   * network. The client still includes `state` in the authorize URL either way
   * (provider compatibility); only the local equality check is skipped.
   */
  requireState: boolean
}

/** A model service plus the model-catalog endpoint associated with it. */
export type SystemSettingsModelProvider = PublicModelProvider

export type SystemSettingsPayload = {
  bypassPermissions: boolean
  model: string
  maxTurns: number
  thinkingMode: ThinkingMode
  thinkingBudgetTokens: number
  url: string
  apiKey: string
  apiKeyConfigured: boolean
  /** Provider metadata only. API keys stay in Nexus and are never returned. */
  modelProviders: SystemSettingsModelProvider[]
  /** The provider used for legacy/plain model IDs and the system default model. */
  defaultModelProviderId: string
  image: SystemSettingsImage
  skillStore: SystemSettingsSkillStore
  oauth2: SystemSettingsOAuth2
  /** Whether enterprise client (sudowork) users may use the cron / scheduled
   *  task feature. Deployment fallback for organizations without an override. */
  clientCronEnabled: boolean
  /** Default for whether the enterprise client (sudowork) shows tool calls in
   *  the chat stream. This is only a default — client users may override it
   *  locally. Deployment fallback for organizations without an override. */
  clientShowToolCalls: boolean
  /** Max size (bytes) for a single file uploaded into a session workspace via
   *  POST /api/v1/sessions/:id/workspace/file. Deployment fallback for
   *  organizations without an override; default 20MB. */
  workspaceUploadLimitBytes: number
  /** Max cron runs a single reuse-mode session serves before CronService retires
   *  it and starts a fresh one. Bounds the runtime's compounding compaction
   *  transcript, which otherwise overflows the model context. Admin-editable;
   *  default 50. 0 (or negative) disables rotation (reuse forever). */
  cronReuseMaxRuns: number
  /** Max user turns a single IM chat accumulates before MossActionExecutor
   *  retires its runtime session and starts a fresh one seeded with a summary
   *  of recent turns. Bounds the same compounding-compaction growth that
   *  cronReuseMaxRuns bounds for cron, but measured in chat turns. IM turns are
   *  far smaller than a cron run, hence the higher default. Admin-editable;
   *  default 200. 0 (or negative) disables rotation (reuse forever). */
  imReuseMaxTurns: number
  /** Directory (inside the moss-server container) holding the per-service login
   *  scripts run by the token minter. For a script-type config item with pinyin
   *  `<pinyin>`, the minter runs `<mintScriptsDir>/<pinyin>_mint.sh`. Empty/null
   *  falls back to '/app/scripts'. Not client-exposed; admin-editable. */
  mintScriptsDir: string
  settingsPath: string
  settingsExists: boolean
  settingsLoaded: boolean
  settingsParseError: string
}

type PersistedSystemSettings = Record<string, unknown> & Omit<
  SystemSettingsPayload,
  'settingsPath' | 'settingsExists' | 'settingsLoaded' | 'settingsParseError' | 'modelProviders'
> & { modelProviders: ModelProvider[] }

const DEFAULT_BYPASS_PERMISSIONS =
  process.env.CLAUDE_CODE_BYPASS_PERMISSIONS === 'true'
const MOSS_HOME = path.join(os.homedir(), '.moss')
export const SYSTEM_SETTINGS_PATH = path.join(MOSS_HOME, 'settings.json')
/** Fallback for `mintScriptsDir` when unset/empty in settings.json. */
export const DEFAULT_MINT_SCRIPTS_DIR = '/app/scripts'

const DEFAULT_SYSTEM_SETTINGS: Omit<
  SystemSettingsPayload,
  'settingsPath' | 'settingsExists' | 'settingsLoaded' | 'settingsParseError'
> = Object.freeze({
  bypassPermissions: DEFAULT_BYPASS_PERMISSIONS,
  model: 'claude-sonnet-4-6',
  maxTurns: 100,
  thinkingMode: 'adaptive',
  thinkingBudgetTokens: 16000,
  url: '',
  apiKey: '',
  apiKeyConfigured: false,
  modelProviders: [],
  defaultModelProviderId: 'legacy-default',
  image: {
    provider: 'openai',
    url: '',
    apiKey: '',
    apiKeyConfigured: false,
    model: 'gpt-image-1',
  },
  skillStore: {
    tenantId: '',
  },
  oauth2: {
    enabled: false,
    authorizeUrlTemplate: '',
    scriptPath: '',
    requireState: true,
  },
  clientCronEnabled: true,
  clientShowToolCalls: true,
  workspaceUploadLimitBytes: 20 * 1024 * 1024,
  cronReuseMaxRuns: 50,
  imReuseMaxTurns: 200,
  mintScriptsDir: DEFAULT_MINT_SCRIPTS_DIR,
})

type SystemSettingsState = {
  path: string
  exists: boolean
  loaded: boolean
  parseError: string
  value: PersistedSystemSettings
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeThinkingMode(value: unknown): ThinkingMode | null {
  if (
    value === 'adaptive' ||
    value === 'enabled' ||
    value === 'disabled'
  ) {
    return value
  }
  return null
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 0 || value === 1) return value === 1
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1') return true
    if (normalized === 'false' || normalized === '0') return false
  }
  return undefined
}

function normalizeSystemSettings(
  input: unknown,
  existing: Record<string, unknown> = {},
): PersistedSystemSettings {
  const source = isRecord(input) ? input : {}
  const result: Record<string, unknown> = { ...existing }

  if (typeof source.model === 'string' && source.model.trim()) {
    result.model = source.model.trim()
  } else if (result.model === undefined) {
    result.model = DEFAULT_SYSTEM_SETTINGS.model
  }

  if (source.maxTurns !== undefined) {
    const maxTurns = Number.parseInt(String(source.maxTurns), 10)
    if (Number.isFinite(maxTurns) && maxTurns >= 1) {
      result.maxTurns = Math.min(maxTurns, 10_000)
    }
  } else if (result.maxTurns === undefined) {
    result.maxTurns = DEFAULT_SYSTEM_SETTINGS.maxTurns
  }

  if (source.bypassPermissions !== undefined) {
    const value = normalizeBoolean(source.bypassPermissions)
    if (value !== undefined) result.bypassPermissions = value
  } else if (result.bypassPermissions === undefined) {
    result.bypassPermissions = DEFAULT_SYSTEM_SETTINGS.bypassPermissions
  }

  if (source.clientCronEnabled !== undefined) {
    const value = normalizeBoolean(source.clientCronEnabled)
    if (value !== undefined) result.clientCronEnabled = value
  } else if (result.clientCronEnabled === undefined) {
    result.clientCronEnabled = DEFAULT_SYSTEM_SETTINGS.clientCronEnabled
  }

  if (source.clientShowToolCalls !== undefined) {
    const value = normalizeBoolean(source.clientShowToolCalls)
    if (value !== undefined) result.clientShowToolCalls = value
  } else if (result.clientShowToolCalls === undefined) {
    result.clientShowToolCalls = DEFAULT_SYSTEM_SETTINGS.clientShowToolCalls
  }

  if (source.workspaceUploadLimitBytes !== undefined) {
    const limit = Number.parseInt(String(source.workspaceUploadLimitBytes), 10)
    if (Number.isFinite(limit) && limit >= 1) {
      // Cap at 1GB to keep a single base64 upload from exhausting server memory.
      result.workspaceUploadLimitBytes = Math.min(limit, 1024 * 1024 * 1024)
    }
  } else if (result.workspaceUploadLimitBytes === undefined) {
    result.workspaceUploadLimitBytes = DEFAULT_SYSTEM_SETTINGS.workspaceUploadLimitBytes
  }

  if (source.cronReuseMaxRuns !== undefined) {
    const runs = Number.parseInt(String(source.cronReuseMaxRuns), 10)
    // 0 (or negative, clamped to 0) disables rotation; otherwise cap at 10000 so
    // a fat-fingered value can't defeat the guard entirely.
    if (Number.isFinite(runs)) {
      result.cronReuseMaxRuns = Math.min(Math.max(runs, 0), 10_000)
    }
  } else if (result.cronReuseMaxRuns === undefined) {
    result.cronReuseMaxRuns = DEFAULT_SYSTEM_SETTINGS.cronReuseMaxRuns
  }

  if (source.imReuseMaxTurns !== undefined) {
    const turns = Number.parseInt(String(source.imReuseMaxTurns), 10)
    // Same shape as cronReuseMaxRuns: 0 disables rotation, upper bound stops a
    // fat-fingered value from defeating the guard.
    if (Number.isFinite(turns)) {
      result.imReuseMaxTurns = Math.min(Math.max(turns, 0), 10_000)
    }
  } else if (result.imReuseMaxTurns === undefined) {
    result.imReuseMaxTurns = DEFAULT_SYSTEM_SETTINGS.imReuseMaxTurns
  }

  if (source.thinkingMode !== undefined) {
    result.thinkingMode =
      normalizeThinkingMode(source.thinkingMode) ??
      DEFAULT_SYSTEM_SETTINGS.thinkingMode
  } else if (
    result.thinkingMode === undefined ||
    normalizeThinkingMode(result.thinkingMode) === null
  ) {
    result.thinkingMode = DEFAULT_SYSTEM_SETTINGS.thinkingMode
  }

  if (source.thinkingBudgetTokens !== undefined) {
    const tokens = Number.parseInt(String(source.thinkingBudgetTokens), 10)
    if (Number.isFinite(tokens) && tokens >= 1024) {
      result.thinkingBudgetTokens = Math.min(tokens, 128_000)
    }
  } else if (result.thinkingBudgetTokens === undefined) {
    result.thinkingBudgetTokens = DEFAULT_SYSTEM_SETTINGS.thinkingBudgetTokens
  }

  if (typeof source.mintScriptsDir === 'string') {
    const dir = source.mintScriptsDir.trim()
    result.mintScriptsDir = dir || DEFAULT_MINT_SCRIPTS_DIR
  } else if (result.mintScriptsDir === undefined) {
    result.mintScriptsDir = DEFAULT_MINT_SCRIPTS_DIR
  }

  if (typeof source.url === 'string') {
    result.url = source.url.trim()
  } else if (result.url === undefined) {
    result.url = DEFAULT_SYSTEM_SETTINGS.url
  }

  if (typeof source.apiKey === 'string') {
    result.apiKey = source.apiKey.trim()
  } else if (result.apiKey === undefined) {
    result.apiKey = DEFAULT_SYSTEM_SETTINGS.apiKey
  }

  const legacyUrl = typeof result.url === 'string' ? result.url : ''
  // Keep a missing legacy field empty until the final payload has resolved the
  // base URL from `env.ANTHROPIC_BASE_URL`; otherwise legacy installs would
  // accidentally create a provider with an empty URL.
  result.modelProviders = source.modelProviders === undefined && result.modelProviders === undefined
    ? []
    : normalizeModelProviders(
      source.modelProviders === undefined ? result.modelProviders : source.modelProviders,
      legacyUrl,
    )
  const requestedDefaultProviderId = typeof source.defaultModelProviderId === 'string'
    ? source.defaultModelProviderId
    : typeof result.defaultModelProviderId === 'string'
      ? result.defaultModelProviderId
      : 'legacy-default'
  result.defaultModelProviderId = (result.modelProviders as ModelProvider[]).some(
    provider => provider.id === requestedDefaultProviderId && provider.enabled,
  )
    ? requestedDefaultProviderId
    : (result.modelProviders as ModelProvider[]).find(provider => provider.enabled)?.id || 'legacy-default'

  const sourceImage = isRecord(source.image) ? source.image : {}
  const existingImage = isRecord(result.image) ? result.image : {}
  result.image = {
    provider:
      typeof sourceImage.provider === 'string'
        ? sourceImage.provider.trim()
        : typeof existingImage.provider === 'string'
          ? existingImage.provider
          : DEFAULT_SYSTEM_SETTINGS.image.provider,
    url:
      typeof sourceImage.url === 'string'
        ? sourceImage.url.trim()
        : typeof existingImage.url === 'string'
          ? existingImage.url
          : DEFAULT_SYSTEM_SETTINGS.image.url,
    apiKey:
      typeof sourceImage.apiKey === 'string'
        ? sourceImage.apiKey.trim()
        : typeof existingImage.apiKey === 'string'
          ? existingImage.apiKey
          : DEFAULT_SYSTEM_SETTINGS.image.apiKey,
    apiKeyConfigured:
      typeof existingImage.apiKey === 'string'
        ? existingImage.apiKey.length > 0
        : DEFAULT_SYSTEM_SETTINGS.image.apiKeyConfigured,
    model:
      typeof sourceImage.model === 'string'
        ? sourceImage.model.trim()
        : typeof existingImage.model === 'string'
          ? existingImage.model
          : DEFAULT_SYSTEM_SETTINGS.image.model,
  }

  const sourceSkillStore = isRecord(source.skillStore) ? source.skillStore : {}
  const existingSkillStore = isRecord(result.skillStore)
    ? result.skillStore
    : {}
  result.skillStore = {
    tenantId:
      typeof sourceSkillStore.tenantId === 'string'
        ? sourceSkillStore.tenantId.trim()
        : typeof existingSkillStore.tenantId === 'string'
          ? existingSkillStore.tenantId
          : DEFAULT_SYSTEM_SETTINGS.skillStore.tenantId,
  }

  const sourceOAuth2 = isRecord(source.oauth2) ? source.oauth2 : {}
  const existingOAuth2 = isRecord(result.oauth2) ? result.oauth2 : {}
  const pickString = (a: unknown, b: unknown, fallback: string): string =>
    typeof a === 'string'
      ? a.trim()
      : typeof b === 'string'
        ? b
        : fallback
  result.oauth2 = {
    enabled:
      sourceOAuth2.enabled !== undefined
        ? normalizeBoolean(sourceOAuth2.enabled) ?? (
          typeof existingOAuth2.enabled === 'boolean'
            ? existingOAuth2.enabled
            : DEFAULT_SYSTEM_SETTINGS.oauth2.enabled
        )
        : typeof existingOAuth2.enabled === 'boolean'
          ? existingOAuth2.enabled
          : DEFAULT_SYSTEM_SETTINGS.oauth2.enabled,
    authorizeUrlTemplate: pickString(
      sourceOAuth2.authorizeUrlTemplate,
      existingOAuth2.authorizeUrlTemplate,
      DEFAULT_SYSTEM_SETTINGS.oauth2.authorizeUrlTemplate,
    ),
    scriptPath: pickString(
      sourceOAuth2.scriptPath,
      existingOAuth2.scriptPath,
      DEFAULT_SYSTEM_SETTINGS.oauth2.scriptPath,
    ),
    requireState:
      sourceOAuth2.requireState !== undefined
        ? normalizeBoolean(sourceOAuth2.requireState) ?? (
          typeof existingOAuth2.requireState === 'boolean'
            ? existingOAuth2.requireState
            : DEFAULT_SYSTEM_SETTINGS.oauth2.requireState
        )
        : typeof existingOAuth2.requireState === 'boolean'
          ? existingOAuth2.requireState
          : DEFAULT_SYSTEM_SETTINGS.oauth2.requireState,
  }

  return result as PersistedSystemSettings
}

function readSystemSettingsState(): SystemSettingsState {
  // 密钥只从 Nexus 缓存读，不依赖配置文件存在或解析成功，也不回退文件值。
  const store = getConfigStore()
  const storedApiKey = store.get(AUTH_TOKEN_KEY) || DEFAULT_SYSTEM_SETTINGS.apiKey
  const storedImageApiKey = store.get(IMAGE_API_KEY_KEY) || DEFAULT_SYSTEM_SETTINGS.image.apiKey
  const result: SystemSettingsState = {
    path: SYSTEM_SETTINGS_PATH,
    exists: false,
    loaded: false,
    parseError: '',
    value: {
      ...DEFAULT_SYSTEM_SETTINGS,
      apiKey: storedApiKey,
      apiKeyConfigured: Boolean(storedApiKey),
      image: {
        ...DEFAULT_SYSTEM_SETTINGS.image,
        apiKey: storedImageApiKey,
        apiKeyConfigured: Boolean(storedImageApiKey),
      },
    },
  }

  try {
    if (!existsSync(SYSTEM_SETTINGS_PATH)) {
      return result
    }

    result.exists = true
    const raw = readFileSync(SYSTEM_SETTINGS_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    const rawSettings = isRecord(parsed) ? parsed : {}
    const env = isRecord(rawSettings.env) ? rawSettings.env : {}
    const urlFromEnv =
      typeof env.ANTHROPIC_BASE_URL === 'string'
        ? env.ANTHROPIC_BASE_URL.trim()
        : ''
    const normalized = normalizeSystemSettings(rawSettings, rawSettings)

    result.value = {
      ...rawSettings,
      ...normalized,
      url: urlFromEnv || normalized.url || DEFAULT_SYSTEM_SETTINGS.url,
      apiKey: storedApiKey,
      apiKeyConfigured: Boolean(storedApiKey),
      image: {
        ...(normalized.image || { ...DEFAULT_SYSTEM_SETTINGS.image }),
        apiKey: storedImageApiKey,
        apiKeyConfigured: Boolean(storedImageApiKey),
      },
      skillStore: normalized.skillStore || {
        ...DEFAULT_SYSTEM_SETTINGS.skillStore,
      },
      oauth2: normalized.oauth2 || { ...DEFAULT_SYSTEM_SETTINGS.oauth2 },
    }
    result.loaded = true
    return result
  } catch (error) {
    result.parseError = error instanceof Error ? error.message : String(error)
    return result
  }
}

function toSystemSettingsPayload(
  state: SystemSettingsState,
  orgId?: string,
): SystemSettingsPayload {
  const providers = normalizeModelProviders(state.value.modelProviders, state.value.url)
  const apiKeys = getStoredProviderApiKeys(orgId)
  return {
    bypassPermissions: state.value.bypassPermissions,
    model: state.value.model,
    maxTurns: state.value.maxTurns,
    thinkingMode: state.value.thinkingMode,
    thinkingBudgetTokens: state.value.thinkingBudgetTokens,
    url: state.value.url,
    apiKey: state.value.apiKey,
    apiKeyConfigured: Boolean(state.value.apiKey),
    modelProviders: toPublicProviders(providers, apiKeys, state.value.apiKey),
    defaultModelProviderId: providers.some(provider => provider.id === state.value.defaultModelProviderId && provider.enabled)
      ? state.value.defaultModelProviderId
      : providers.find(provider => provider.enabled)?.id || 'legacy-default',
    image: {
      ...state.value.image,
      apiKeyConfigured: Boolean(state.value.image.apiKey),
    },
    skillStore: state.value.skillStore,
    oauth2: state.value.oauth2,
    clientCronEnabled: state.value.clientCronEnabled ?? DEFAULT_SYSTEM_SETTINGS.clientCronEnabled,
    clientShowToolCalls: state.value.clientShowToolCalls ?? DEFAULT_SYSTEM_SETTINGS.clientShowToolCalls,
    workspaceUploadLimitBytes: state.value.workspaceUploadLimitBytes ?? DEFAULT_SYSTEM_SETTINGS.workspaceUploadLimitBytes,
    cronReuseMaxRuns: state.value.cronReuseMaxRuns ?? DEFAULT_SYSTEM_SETTINGS.cronReuseMaxRuns,
    imReuseMaxTurns: state.value.imReuseMaxTurns ?? DEFAULT_SYSTEM_SETTINGS.imReuseMaxTurns,
    mintScriptsDir: state.value.mintScriptsDir || DEFAULT_SYSTEM_SETTINGS.mintScriptsDir,
    settingsPath: state.path,
    settingsExists: state.exists,
    settingsLoaded: state.loaded,
    settingsParseError: state.parseError,
  }
}

export function getSystemSettings(): SystemSettingsPayload {
  return toSystemSettingsPayload(readSystemSettingsState())
}

export async function getOrganizationSystemSettings(
  orgId: string | undefined,
  repository: OrganizationModelSettingsRepository,
  options: { redactSecrets?: boolean } = {},
): Promise<SystemSettingsPayload> {
  if (!orgId?.trim()) {
    const platform = getSystemSettings()
    return options.redactSecrets ? redactSystemSettingsSecrets(platform) : platform
  }
  await refreshOrganizationModelCredentials(orgId)
  const state = readOrganizationSystemSettingsState(orgId, repository.get(orgId))
  const payload = toSystemSettingsPayload(state, orgId)
  return options.redactSecrets ? redactSystemSettingsSecrets(payload) : payload
}

/**
 * updateSystemSettings — async 化 + 模块级 promise 链串行化。
 *
 * 敏感字段（apiKey / image.apiKey）仅在 PATCH 显式提供字符串时写 Nexus
 * （清空即 deleteSecret，对齐现状 "清空即从文件删除"）；文件不再落盘
 * 这两个值（image 剥离 apiKey、env 不写 ANTHROPIC_AUTH_TOKEN）。
 * 串行化原因：AdminHub 600ms 自动保存与 enterprise
 * PATCH 可能并发，await putSecret 落在文件读与写之间，无串行化会丢失更新
 * （现状同步执行无此窗口）。
 */
let updateSystemSettingsQueue: Promise<unknown> = Promise.resolve()

export function updateSystemSettings(patch: unknown): Promise<SystemSettingsPayload> {
  const run = updateSystemSettingsQueue.then(() => performUpdateSystemSettings(patch))
  // 队列只保证顺序，不向后传播前一次的错误
  updateSystemSettingsQueue = run.then(() => undefined, () => undefined)
  return run
}

export function updateOrganizationSystemSettings(
  orgId: string | undefined,
  repository: OrganizationModelSettingsRepository,
  patch: unknown,
  updatedBy: string,
  options: { redactSecrets?: boolean } = {},
): Promise<SystemSettingsPayload> {
  if (!orgId?.trim()) {
    const run = updateSystemSettingsQueue.then(async () => {
      const platform = await performUpdateSystemSettings(patch)
      return options.redactSecrets ? redactSystemSettingsSecrets(platform) : platform
    })
    updateSystemSettingsQueue = run.then(() => undefined, () => undefined)
    return run
  }
  const run = updateSystemSettingsQueue.then(async () => {
    await performUpdateOrganizationModelSettings(orgId, repository, patch, updatedBy)
    return getOrganizationSystemSettings(orgId, repository, options)
  })
  updateSystemSettingsQueue = run.then(() => undefined, () => undefined)
  return run
}

function readOrganizationSystemSettingsState(
  orgId: string,
  organizationSettings: OrganizationModelSettings,
): SystemSettingsState {
  const state = readSystemSettingsState()
  const store = getConfigStore()
  const apiKey = store.get(organizationScopedConfigKey(orgId, 'settings.anthropic-auth-token')) || ''
  const imageApiKey = store.get(organizationScopedConfigKey(orgId, 'settings.image-api-key')) || ''
  const scoped = normalizeSystemSettings(organizationSettings, state.value)
  return {
    ...state,
    value: {
      ...state.value,
      model: scoped.model,
      url: scoped.url,
      modelProviders: scoped.modelProviders,
      defaultModelProviderId: scoped.defaultModelProviderId,
      apiKey,
      apiKeyConfigured: Boolean(apiKey),
      image: {
        ...scoped.image,
        apiKey: imageApiKey,
        apiKeyConfigured: Boolean(imageApiKey),
      },
    },
  }
}

async function refreshOrganizationModelCredentials(orgId: string): Promise<void> {
  const store = getConfigStore()
  await store.refreshKey(organizationScopedConfigKey(orgId, 'settings.anthropic-auth-token'))
  await store.refreshKey(organizationScopedConfigKey(orgId, 'settings.image-api-key'))
  await refreshStoredProviderApiKeys(orgId)
}

async function performUpdateOrganizationModelSettings(
  orgId: string,
  repository: OrganizationModelSettingsRepository,
  patch: unknown,
  updatedBy: string,
): Promise<void> {
  const source = isRecord(patch) ? patch : {}
  const globalPatch = deploymentSettingsPatchFromInput(source)
  if (Object.keys(globalPatch).length > 0) {
    await performUpdateSystemSettings(globalPatch)
  }

  await refreshOrganizationModelCredentials(orgId)
  const currentState = readOrganizationSystemSettingsState(orgId, repository.get(orgId))
  const currentSettings = currentState.value
  const nextSettings = normalizeSystemSettings(source, currentSettings)
  const store = getConfigStore()

  if (typeof source.apiKey === 'string') {
    const nextApiKey = source.apiKey.trim()
    const key = organizationScopedConfigKey(orgId, 'settings.anthropic-auth-token')
    if (nextApiKey) await store.put(key, nextApiKey)
    else await store.remove(key)
  }

  const sourceImage = isRecord(source.image) ? source.image : {}
  if (typeof sourceImage.apiKey === 'string') {
    const nextApiKey = sourceImage.apiKey.trim()
    const key = organizationScopedConfigKey(orgId, 'settings.image-api-key')
    if (nextApiKey) await store.put(key, nextApiKey)
    else await store.remove(key)
  }

  if (Array.isArray(source.modelProviders)) {
    await saveProviderApiKeys(
      providerApiKeysFromInput(source.modelProviders, getStoredProviderApiKeys(orgId)),
      orgId,
    )
  }
  clearProviderModelCache()

  const organizationPatch = modelSettingsPatchFromInput(source, nextSettings)
  if (Object.keys(organizationPatch).length > 0) {
    repository.put(orgId, organizationPatch, updatedBy)
  }
}

function deploymentSettingsPatchFromInput(source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (isOrganizationModelSettingsKey(key)) continue
    result[key] = value
  }
  return result
}

function isOrganizationModelSettingsKey(key: string): boolean {
  return key === 'model'
    || key === 'url'
    || key === 'apiKey'
    || key === 'modelProviders'
    || key === 'defaultModelProviderId'
    || key === 'image'
}

function modelSettingsPatchFromInput(
  source: Record<string, unknown>,
  nextSettings: PersistedSystemSettings,
): OrganizationModelSettings {
  const patch: OrganizationModelSettings = {}
  if (typeof source.model === 'string' && source.model.trim()) patch.model = nextSettings.model
  if (typeof source.url === 'string') patch.url = nextSettings.url
  if (Array.isArray(source.modelProviders)) patch.modelProviders = nextSettings.modelProviders
  if (typeof source.defaultModelProviderId === 'string') patch.defaultModelProviderId = nextSettings.defaultModelProviderId
  const sourceImage = isRecord(source.image) ? source.image : {}
  const imagePatch: Record<string, unknown> = {}
  if (typeof sourceImage.provider === 'string') imagePatch.provider = nextSettings.image.provider
  if (typeof sourceImage.url === 'string') imagePatch.url = nextSettings.image.url
  if (typeof sourceImage.model === 'string') imagePatch.model = nextSettings.image.model
  if (Object.keys(imagePatch).length > 0) patch.image = imagePatch
  return patch
}

function organizationScopedConfigKey(
  orgId: string,
  suffix: 'settings.anthropic-auth-token' | 'settings.image-api-key',
): ConfigKey {
  return organizationConfigKey(orgId, suffix)
}

function redactSystemSettingsSecrets(settings: SystemSettingsPayload): SystemSettingsPayload {
  return {
    ...settings,
    apiKey: '',
    image: {
      ...settings.image,
      apiKey: '',
    },
  }
}

async function performUpdateSystemSettings(patch: unknown): Promise<SystemSettingsPayload> {
  const state = readSystemSettingsState()
  const currentSettings = state.value
  const nextSettings = {
    ...currentSettings,
    ...normalizeSystemSettings(patch, currentSettings),
  }

  let existingFile: Record<string, unknown> = {}
  let existingEnv: Record<string, unknown> = {}

  try {
    if (existsSync(SYSTEM_SETTINGS_PATH)) {
      const raw = readFileSync(SYSTEM_SETTINGS_PATH, 'utf8')
      const parsed = JSON.parse(raw)
      if (isRecord(parsed)) {
        existingFile = parsed
        if (isRecord(parsed.env)) {
          existingEnv = { ...parsed.env }
        }
      }
    }
  } catch {
    // Preserve the current save path even when the previous file is malformed.
  }

  // 仅 PATCH 显式提供对应字符串时写入/清除；合并值不能代表修改密钥的意图。
  const source = isRecord(patch) ? patch : {}
  const sourceImage = isRecord(source.image) ? source.image : {}
  const store = getConfigStore()
  if (typeof source.apiKey === 'string') {
    if (nextSettings.apiKey) {
      await store.put(AUTH_TOKEN_KEY, nextSettings.apiKey)
    } else {
      await store.remove(AUTH_TOKEN_KEY)
    }
  }
  if (typeof sourceImage.apiKey === 'string') {
    if (nextSettings.image.apiKey) {
      await store.put(IMAGE_API_KEY_KEY, nextSettings.image.apiKey)
    } else {
      await store.remove(IMAGE_API_KEY_KEY)
    }
  }
  // Provider credentials are write-only. Just like the legacy text/image
  // credentials above, do not touch their Nexus record unless this PATCH
  // explicitly includes the Provider list; otherwise an unrelated settings
  // save would create/delete a secret record and violate partial-update
  // semantics.
  if (Array.isArray(source.modelProviders)) {
    await saveProviderApiKeys(providerApiKeysFromInput(source.modelProviders, getStoredProviderApiKeys()))
  }
  // Discovery entries are credential- and endpoint-bound. A settings update
  // may replace either, so never serve the old Provider's catalog afterward.
  clearProviderModelCache()

  const env: Record<string, unknown> = { ...existingEnv }
  if (nextSettings.url) {
    env.ANTHROPIC_BASE_URL = nextSettings.url
  } else {
    delete env.ANTHROPIC_BASE_URL
  }

  // 文件落盘：image 剥离 apiKey（保留 provider/url/model）
  const {
    apiKey: _strippedImageApiKey,
    apiKeyConfigured: _strippedImageApiKeyConfigured,
    ...imageToSave
  } = nextSettings.image
  const toSave: Record<string, unknown> = {
    ...existingFile,
    ...nextSettings,
    image: imageToSave,
    env,
  }

  delete toSave.url
  delete toSave.apiKey
  delete toSave.apiKeyConfigured
  if (Object.keys(env).length === 0) {
    delete toSave.env
  }

  mkdirSync(MOSS_HOME, { recursive: true })
  writeFileSync(SYSTEM_SETTINGS_PATH, `${JSON.stringify(toSave, null, 2)}\n`, 'utf8')

  return {
    bypassPermissions: nextSettings.bypassPermissions,
    model: nextSettings.model,
    maxTurns: nextSettings.maxTurns,
    thinkingMode: nextSettings.thinkingMode,
    thinkingBudgetTokens: nextSettings.thinkingBudgetTokens,
    url: nextSettings.url,
    apiKey: nextSettings.apiKey,
    apiKeyConfigured: Boolean(nextSettings.apiKey),
    modelProviders: toPublicProviders(
      normalizeModelProviders(nextSettings.modelProviders, nextSettings.url),
      getStoredProviderApiKeys(),
      nextSettings.apiKey,
    ),
    defaultModelProviderId: nextSettings.defaultModelProviderId,
    image: {
      ...nextSettings.image,
      apiKeyConfigured: Boolean(nextSettings.image.apiKey),
    },
    skillStore: nextSettings.skillStore,
    oauth2: nextSettings.oauth2,
    clientCronEnabled: nextSettings.clientCronEnabled,
    clientShowToolCalls: nextSettings.clientShowToolCalls,
    workspaceUploadLimitBytes: nextSettings.workspaceUploadLimitBytes,
    cronReuseMaxRuns: nextSettings.cronReuseMaxRuns ?? DEFAULT_SYSTEM_SETTINGS.cronReuseMaxRuns,
    imReuseMaxTurns: nextSettings.imReuseMaxTurns ?? DEFAULT_SYSTEM_SETTINGS.imReuseMaxTurns,
    mintScriptsDir: nextSettings.mintScriptsDir || DEFAULT_SYSTEM_SETTINGS.mintScriptsDir,
    settingsPath: SYSTEM_SETTINGS_PATH,
    settingsExists: true,
    settingsLoaded: true,
    settingsParseError: '',
  }
}
