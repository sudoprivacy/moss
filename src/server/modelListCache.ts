/** Provider-bound model discovery and scode model configuration. */
import { getSystemSettings } from './systemSettings.js'
import {
  clearProviderModelCache,
  discoverProviderModels,
  getStoredProviderApiKeys,
  getProviderModelCacheStatus,
  resolveModelSelection,
  type ProviderModelInfo,
} from './modelProviders.js'
import type { SystemSettingsPayload } from './systemSettings.js'

export type ModelInfo = ProviderModelInfo

export function getModelProviderApiKey(providerId: string, legacyApiKey: string, orgId?: string): string | undefined {
  return providerId === 'legacy-default'
    ? legacyApiKey || undefined
    : getStoredProviderApiKeys(orgId)[providerId]
}

export async function getAvailableModels(
  options: { forceRefresh?: boolean; settings?: SystemSettingsPayload; orgId?: string } = {},
): Promise<ModelInfo[]> {
  const settings = options.settings ?? getSystemSettings()
  const results = await Promise.allSettled(
    settings.modelProviders.filter(provider => provider.enabled).map(provider =>
      discoverProviderModels(provider, getModelProviderApiKey(provider.id, settings.apiKey, options.orgId), options),
    ),
  )
  const models: ModelInfo[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') models.push(...result.value)
    else process.stderr.write(`[ModelCatalog] ${result.reason instanceof Error ? result.reason.message : String(result.reason)}\n`)
  }
  return models
}

export async function getModelsForSelection(
  selection: string | undefined,
  options: { forceRefresh?: boolean; settings?: SystemSettingsPayload; orgId?: string } = {},
): Promise<{ selection: ReturnType<typeof resolveModelSelection>; models: ModelInfo[] }> {
  const settings = options.settings ?? getSystemSettings()
  const selectionInfo = resolveModelSelection(
    settings.modelProviders,
    settings.defaultModelProviderId,
    settings.model,
    selection,
  )
  const models = await discoverProviderModels(
    selectionInfo.provider,
    getModelProviderApiKey(selectionInfo.provider.id, settings.apiKey, options.orgId),
    options,
  )
  if (!models.some(model => model.modelId === selectionInfo.modelId)) {
    throw new Error(
      `Model ${selectionInfo.modelId} is not currently available from provider ${selectionInfo.provider.name}`,
    )
  }
  return { selection: selectionInfo, models }
}

export function clearModelCache(providerId?: string): void {
  clearProviderModelCache(providerId)
}

export async function refreshModelCache(): Promise<ModelInfo[]> {
  clearModelCache()
  return getAvailableModels({ forceRefresh: true })
}

export function getCacheStatus(): { cached: boolean; age: number | null; count: number } {
  return getProviderModelCacheStatus()
}

export function buildModelsConfig(models: Pick<ModelInfo, 'modelId' | 'protocol'>[]): Record<string, unknown> {
  const modelsConfig: Record<string, unknown> = {}
  for (const model of models) {
    const alias = `proxy/${model.modelId}`
    modelsConfig[alias] = {
      alias,
      name: `Moss provider: ${alias}`,
      input: ['text'],
      providers: { proxy: { provider: 'moss-proxy', model: model.modelId, api: model.protocol } },
    }
  }
  return modelsConfig
}

/** Runner processes receive only the selected provider's catalog from RuntimeService. */
export async function buildAllModelsConfig(_baseUrl: string): Promise<Record<string, unknown>> {
  const raw = process.env.MOSS_PROVIDER_MODELS_JSON
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) return buildModelsConfig(parsed.filter(isModelInfo))
    } catch {
      process.stderr.write('[ModelCatalog] Invalid MOSS_PROVIDER_MODELS_JSON; using selected model only\n')
    }
  }
  return ensureOpenAIModelConfig(
    {},
    process.env.MOSS_DEFAULT_MODEL || getSystemSettings().model,
    protocolFromEnvironment(),
  )
}

function protocolFromEnvironment(): ModelInfo['protocol'] {
  const protocol = process.env.MOSS_MODEL_PROVIDER_PROTOCOL
  return protocol === 'openai-responses' || protocol === 'anthropic-messages'
    ? protocol
    : 'openai-completions'
}

export function ensureOpenAIModelConfig(
  modelsConfig: Record<string, unknown>,
  modelId: string,
  protocol: ModelInfo['protocol'] = 'openai-completions',
): Record<string, unknown> {
  const normalized = modelId.startsWith('proxy/') ? modelId.slice('proxy/'.length) : modelId
  const alias = `proxy/${normalized}`
  if (!modelsConfig[alias]) {
    modelsConfig[alias] = {
      alias,
      name: `Moss provider: ${alias}`,
      input: ['text'],
      providers: { proxy: { provider: 'moss-proxy', model: normalized, api: protocol } },
    }
  }
  return modelsConfig
}

function isModelInfo(value: unknown): value is ModelInfo {
  return typeof value === 'object'
    && value !== null
    && typeof (value as ModelInfo).modelId === 'string'
    && typeof (value as ModelInfo).protocol === 'string'
}
