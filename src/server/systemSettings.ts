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
    settingsPath: SYSTEM_SETTINGS_PATH,
    settingsExists: true,
    settingsLoaded: true,
    settingsParseError: '',
  }
}
