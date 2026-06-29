import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

export type ThinkingMode = 'adaptive' | 'enabled' | 'disabled'

export type SystemSettingsImage = {
  provider: string
  url: string
  apiKey: string
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

export type SystemSettingsPayload = {
  bypassPermissions: boolean
  model: string
  maxTurns: number
  thinkingMode: ThinkingMode
  thinkingBudgetTokens: number
  url: string
  apiKey: string
  image: SystemSettingsImage
  skillStore: SystemSettingsSkillStore
  oauth2: SystemSettingsOAuth2
  /** Whether enterprise client (sudowork) users may use the cron / scheduled
   *  task feature. Stored in settings.json; surfaced to clients via
   *  GET /api/v1/tenant/config. */
  clientCronEnabled: boolean
  /** Default for whether the enterprise client (sudowork) shows tool calls in
   *  the chat stream. This is only a default — client users may override it
   *  locally. Stored in settings.json; surfaced to clients via
   *  GET /api/v1/tenant/config. */
  clientShowToolCalls: boolean
  /** Max size (bytes) for a single file uploaded into a session workspace via
   *  POST /api/v1/sessions/:id/workspace/file. Enforced server-side (413 when
   *  exceeded). Admin-editable; default 20MB. */
  workspaceUploadLimitBytes: number
  settingsPath: string
  settingsExists: boolean
  settingsLoaded: boolean
  settingsParseError: string
}

type PersistedSystemSettings = Record<string, unknown> & Omit<
  SystemSettingsPayload,
  'settingsPath' | 'settingsExists' | 'settingsLoaded' | 'settingsParseError'
>

const DEFAULT_BYPASS_PERMISSIONS =
  process.env.CLAUDE_CODE_BYPASS_PERMISSIONS === 'true'
const MOSS_HOME = path.join(os.homedir(), '.moss')
export const SYSTEM_SETTINGS_PATH = path.join(MOSS_HOME, 'settings.json')

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
  image: {
    provider: 'minimax',
    url: 'https://api.minimaxi.com/v1/image_generation',
    apiKey: '',
    model: '',
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
    result.bypassPermissions = Boolean(source.bypassPermissions)
  } else if (result.bypassPermissions === undefined) {
    result.bypassPermissions = DEFAULT_SYSTEM_SETTINGS.bypassPermissions
  }

  if (source.clientCronEnabled !== undefined) {
    result.clientCronEnabled = Boolean(source.clientCronEnabled)
  } else if (result.clientCronEnabled === undefined) {
    result.clientCronEnabled = DEFAULT_SYSTEM_SETTINGS.clientCronEnabled
  }

  if (source.clientShowToolCalls !== undefined) {
    result.clientShowToolCalls = Boolean(source.clientShowToolCalls)
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
        ? Boolean(sourceOAuth2.enabled)
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
        ? Boolean(sourceOAuth2.requireState)
        : typeof existingOAuth2.requireState === 'boolean'
          ? existingOAuth2.requireState
          : DEFAULT_SYSTEM_SETTINGS.oauth2.requireState,
  }

  return result as PersistedSystemSettings
}

function readSystemSettingsState(): SystemSettingsState {
  const result: SystemSettingsState = {
    path: SYSTEM_SETTINGS_PATH,
    exists: false,
    loaded: false,
    parseError: '',
    value: { ...DEFAULT_SYSTEM_SETTINGS },
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
    const apiKeyFromEnv =
      typeof env.ANTHROPIC_AUTH_TOKEN === 'string'
        ? env.ANTHROPIC_AUTH_TOKEN.trim()
        : ''
    const normalized = normalizeSystemSettings(rawSettings, rawSettings)

    result.value = {
      ...rawSettings,
      ...normalized,
      url: urlFromEnv || normalized.url || DEFAULT_SYSTEM_SETTINGS.url,
      apiKey:
        apiKeyFromEnv || normalized.apiKey || DEFAULT_SYSTEM_SETTINGS.apiKey,
      image: normalized.image || { ...DEFAULT_SYSTEM_SETTINGS.image },
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
): SystemSettingsPayload {
  return {
    bypassPermissions: state.value.bypassPermissions,
    model: state.value.model,
    maxTurns: state.value.maxTurns,
    thinkingMode: state.value.thinkingMode,
    thinkingBudgetTokens: state.value.thinkingBudgetTokens,
    url: state.value.url,
    apiKey: state.value.apiKey,
    image: state.value.image,
    skillStore: state.value.skillStore,
    oauth2: state.value.oauth2,
    clientCronEnabled: state.value.clientCronEnabled ?? DEFAULT_SYSTEM_SETTINGS.clientCronEnabled,
    clientShowToolCalls: state.value.clientShowToolCalls ?? DEFAULT_SYSTEM_SETTINGS.clientShowToolCalls,
    workspaceUploadLimitBytes: state.value.workspaceUploadLimitBytes ?? DEFAULT_SYSTEM_SETTINGS.workspaceUploadLimitBytes,
    settingsPath: state.path,
    settingsExists: state.exists,
    settingsLoaded: state.loaded,
    settingsParseError: state.parseError,
  }
}

export function getSystemSettings(): SystemSettingsPayload {
  return toSystemSettingsPayload(readSystemSettingsState())
}

export function updateSystemSettings(patch: unknown): SystemSettingsPayload {
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

  const env: Record<string, unknown> = { ...existingEnv }
  if (nextSettings.url) {
    env.ANTHROPIC_BASE_URL = nextSettings.url
  } else {
    delete env.ANTHROPIC_BASE_URL
  }
  if (nextSettings.apiKey) {
    env.ANTHROPIC_AUTH_TOKEN = nextSettings.apiKey
  } else {
    delete env.ANTHROPIC_AUTH_TOKEN
  }

  const toSave: Record<string, unknown> = {
    ...existingFile,
    ...nextSettings,
    env,
  }

  delete toSave.url
  delete toSave.apiKey
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
    image: nextSettings.image,
    skillStore: nextSettings.skillStore,
    oauth2: nextSettings.oauth2,
    clientCronEnabled: nextSettings.clientCronEnabled,
    clientShowToolCalls: nextSettings.clientShowToolCalls,
    workspaceUploadLimitBytes: nextSettings.workspaceUploadLimitBytes,
    settingsPath: SYSTEM_SETTINGS_PATH,
    settingsExists: true,
    settingsLoaded: true,
    settingsParseError: '',
  }
}
