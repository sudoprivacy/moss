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

type ModelCatalogOptions = {
  forceRefresh?: boolean
  settings?: SystemSettingsPayload
  orgId?: string
  userApiKey?: string
  /**
   * 4A 降级（默认 false）：仅"无自定义 Provider + legacy-default"时生效——
   * 发现调用失败不抛出，requestedModel 原样透传并标记 unverified。不内置
   * 任何 catalog；已配置 Provider 的路由边界语义不变（仍抛错）。
   */
  allowUnverified?: boolean
}

export function getModelProviderApiKey(providerId: string, legacyApiKey: string, orgId?: string, userApiKey?: string): string | undefined {
  return providerId === 'legacy-default'
    ? userApiKey || legacyApiKey || undefined
    : getStoredProviderApiKeys(orgId)[providerId]
}

export async function getAvailableModels(
  options: ModelCatalogOptions = {},
): Promise<ModelInfo[]> {
  const settings = options.settings ?? getSystemSettings()
  const results = await Promise.allSettled(
    settings.modelProviders.filter(provider => provider.enabled).map(provider =>
      discoverProviderModels(provider, getModelProviderApiKey(provider.id, settings.apiKey, options.orgId, options.userApiKey), options),
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
  options: ModelCatalogOptions = {},
): Promise<{ selection: ReturnType<typeof resolveModelSelection>; models: ModelInfo[]; unverified?: boolean }> {
  const settings = options.settings ?? getSystemSettings()
  const selectionInfo = resolveModelSelection(
    settings.modelProviders,
    settings.defaultModelProviderId,
    settings.model,
    selection,
  )
  // 4A：零自定义 Provider 走 legacy-default（无路由边界可守）——发现失败允许
  // 以 requestedModel 原样透传（unverified 标记），由调用方决定是否启用。
  // 注意 normalizeModelProviders 会合成 legacy-default 条目：判定口径是
  // "不存在启用中的非 legacy-default Provider"，而非"数组为空"。
  const unverifiedEligible = options.allowUnverified === true
    && selectionInfo.provider.id === 'legacy-default'
    && !settings.modelProviders.some(provider => provider.enabled && provider.id !== 'legacy-default')
  let models: ModelInfo[]
  if (unverifiedEligible) {
    try {
      models = await discoverProviderModels(
        selectionInfo.provider,
        getModelProviderApiKey(selectionInfo.provider.id, settings.apiKey, options.orgId, options.userApiKey),
        options,
      )
    } catch (error) {
      process.stderr.write(`[ModelCatalog] discovery failed, passing through unverified model ${selectionInfo.modelId}: ${error instanceof Error ? error.message : String(error)}\n`)
      return { selection: selectionInfo, models: [], unverified: true }
    }
  } else {
    models = await discoverProviderModels(
      selectionInfo.provider,
      getModelProviderApiKey(selectionInfo.provider.id, settings.apiKey, options.orgId, options.userApiKey),
      options,
    )
  }
  if (!models.some(model => model.modelId === selectionInfo.modelId)) {
    throw new Error(
      `Model ${selectionInfo.modelId} is not currently available from provider ${selectionInfo.provider.name}`,
    )
  }
  return { selection: selectionInfo, models }
}

export function clearModelCache(providerId?: string, orgId?: string): void {
  clearProviderModelCache(providerId, orgId)
}

export async function refreshModelCache(
  options: ModelCatalogOptions = {},
): Promise<ModelInfo[]> {
  clearModelCache(undefined, options.orgId)
  return getAvailableModels({ ...options, forceRefresh: true })
}

export function getCacheStatus(): { cached: boolean; age: number | null; count: number } {
  return getProviderModelCacheStatus()
}

