import { createHash } from 'node:crypto'
import { getConfigStore, organizationConfigKey, type ConfigKey } from './configStore/configStore.js'

export type ModelProviderKind = 'openai-compatible'
/**
 * Wire protocol used by scode when it calls a provider.  Model discovery is
 * deliberately independent from this: an OpenAI-style `/models` endpoint can
 * describe models whose inference endpoint is Responses or Messages.
 */
export type ModelProviderProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'

const MODEL_PROVIDER_PROTOCOLS: ReadonlySet<ModelProviderProtocol> = new Set([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
])

export type ModelProvider = {
  id: string
  name: string
  kind: ModelProviderKind
  /** URL used by session runtimes to call the provider. */
  baseUrl: string
  /** Optional URL used by moss-server to discover models. Defaults to `${baseUrl}/models`. */
  discoveryUrl: string
  /** The provider's actual inference API; never infer this from a model ID. */
  protocol: ModelProviderProtocol
  enabled: boolean
}

export type PublicModelProvider = ModelProvider & {
  apiKeyConfigured: boolean
}

export type ProviderModelInfo = {
  /** Stable client selection value: `${providerId}:${modelId}`. */
  id: string
  modelId: string
  name: string
  providerId: string
  providerName: string
  protocol: ModelProviderProtocol
  ratio: number
  contextWindow?: number
  maxOutputTokens?: number
}

export type ResolvedModelSelection = {
  provider: ModelProvider
  modelId: string
  selectionId: string
}

type CatalogCacheEntry = { models: ProviderModelInfo[]; fetchedAt: number }

const CACHE_TTL_MS = 5 * 60 * 1000
const PROVIDER_API_KEYS_KEY: ConfigKey = 'settings.model-provider-api-keys'
const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{0,62}$/
const LEGACY_DEFAULT_BASE_URL = 'https://hk.sudorouter.ai/v1'
const catalogCache = new Map<string, CatalogCacheEntry>()

export function createLegacyProvider(baseUrl: string): ModelProvider {
  const resolvedBaseUrl = baseUrl.trim() || process.env.ANTHROPIC_BASE_URL?.trim() || LEGACY_DEFAULT_BASE_URL
  return {
    id: 'legacy-default',
    name: '默认模型服务',
    kind: 'openai-compatible',
    baseUrl: resolvedBaseUrl,
    discoveryUrl: toModelsUrl(resolvedBaseUrl),
    protocol: 'openai-completions',
    enabled: true,
  }
}

export function toModelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/models`
}

export function normalizeModelProviders(value: unknown, legacyBaseUrl: string): ModelProvider[] {
  if (!Array.isArray(value)) return [createLegacyProvider(legacyBaseUrl)]

  const seen = new Set<string>()
  const providers: ModelProvider[] = []
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || !PROVIDER_ID_RE.test(candidate.id)) continue
    if (seen.has(candidate.id) || typeof candidate.baseUrl !== 'string' || !isHttpUrl(candidate.baseUrl)) continue
    const baseUrl = candidate.baseUrl.trim().replace(/\/+$/, '')
    const discoveryUrl = typeof candidate.discoveryUrl === 'string' && isHttpUrl(candidate.discoveryUrl)
      ? candidate.discoveryUrl.trim()
      : toModelsUrl(baseUrl)
    providers.push({
      id: candidate.id,
      name: typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : candidate.id,
      kind: 'openai-compatible',
      baseUrl,
      discoveryUrl,
      protocol: isModelProviderProtocol(candidate.protocol)
        ? candidate.protocol
        : 'openai-completions',
      enabled: candidate.enabled !== false,
    })
    seen.add(candidate.id)
  }
  return providers.length > 0 ? providers : [createLegacyProvider(legacyBaseUrl)]
}

export function providerApiKeysFromInput(value: unknown, existing: Record<string, string>): Record<string, string> {
  if (!Array.isArray(value)) return existing
  const next = { ...existing }
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || !PROVIDER_ID_RE.test(candidate.id)) continue
    if (typeof candidate.apiKey === 'string') {
      const key = candidate.apiKey.trim()
      if (key) next[candidate.id] = key
      else delete next[candidate.id]
    }
  }
  const configuredIds = new Set(value.filter(isRecord).map(item => item.id).filter((id): id is string => typeof id === 'string'))
  for (const id of Object.keys(next)) {
    if (!configuredIds.has(id)) delete next[id]
  }
  return next
}

export function providerApiKeysConfigKey(orgId?: string): ConfigKey {
  return orgId?.trim()
    ? organizationConfigKey(orgId, 'settings.model-provider-api-keys')
    : PROVIDER_API_KEYS_KEY
}

export async function refreshStoredProviderApiKeys(orgId?: string): Promise<void> {
  await getConfigStore().refreshKey(providerApiKeysConfigKey(orgId))
}

export function getStoredProviderApiKeys(orgId?: string): Record<string, string> {
  const raw = getConfigStore().get(providerApiKeysConfigKey(orgId))
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0))
  } catch {
    return {}
  }
}

export async function saveProviderApiKeys(keys: Record<string, string>, orgId?: string): Promise<void> {
  const store = getConfigStore()
  const key = providerApiKeysConfigKey(orgId)
  if (Object.keys(keys).length === 0) await store.remove(key)
  else await store.put(key, JSON.stringify(keys))
}

export function toPublicProviders(providers: ModelProvider[], apiKeys: Record<string, string>, legacyApiKey: string): PublicModelProvider[] {
  return providers.map(provider => ({
    ...provider,
    apiKeyConfigured: provider.id === 'legacy-default' ? Boolean(legacyApiKey) : Boolean(apiKeys[provider.id]),
  }))
}

export function resolveModelSelection(
  providers: ModelProvider[],
  defaultProviderId: string,
  defaultModel: string,
  selection: string | undefined,
): ResolvedModelSelection {
  const enabled = providers.filter(provider => provider.enabled)
  const fallbackProvider = enabled.find(provider => provider.id === defaultProviderId) || enabled[0]
  if (!fallbackProvider) throw new Error('No enabled model provider is configured')

  const separator = selection?.indexOf(':') ?? -1
  if (selection && separator > 0) {
    const provider = enabled.find(item => item.id === selection.slice(0, separator))
    const modelId = selection.slice(separator + 1)
    // A stored preference outlives the catalog it was chosen from. Hiding these
    // from the picker stops new ones being made; it does nothing for a choice
    // already saved, and that choice is what actually reaches the session.
    if (provider && modelId && !isChatCapable(modelId)) {
      process.stderr.write(
        `[modelProviders] stored selection '${selection}' is not a chat model — falling back to '${defaultModel}'\n`,
      )
    } else if (provider && modelId) {
      return { provider, modelId, selectionId: `${provider.id}:${modelId}` }
    }
  }

  const modelId = selection && isChatCapable(selection) ? selection : defaultModel
  return { provider: fallbackProvider, modelId, selectionId: `${fallbackProvider.id}:${modelId}` }
}

/**
 * Model families that cannot hold a conversation, matched on the id.
 *
 * An OpenAI-compatible `/models` response says nothing about what a model can
 * do, so there is no metadata to filter on — only the naming convention every
 * provider follows for these families. That makes this a heuristic, and a
 * heuristic that hides things silently is how a legitimate model goes missing
 * with nobody able to say why. So it is deliberately narrow (no `image`: a
 * vision model still chats) and every exclusion is logged.
 *
 * Without it the picker offered embeddings and speech models as if they were
 * chat engines. Someone picked one, and their sessions ran a transcription
 * model as the conversation engine — it fails at the far end of the system,
 * where the cause is invisible.
 */
const NON_CHAT_MODEL_PATTERNS = [
  /embedding/i,
  /(^|[-_])embed([-_]|$)/i,
  /transcribe/i,
  /(^|[-_])whisper/i,
  /(^|[-_])tts([-_]|$)/i,
  /(^|[-_])dall-?e/i,
  /moderation/i,
  /rerank/i,
]

function isChatCapable(modelId: string): boolean {
  return !NON_CHAT_MODEL_PATTERNS.some(pattern => pattern.test(modelId))
}

export async function discoverProviderModels(
  provider: ModelProvider,
  apiKey: string | undefined,
  options: { forceRefresh?: boolean; orgId?: string } = {},
): Promise<ProviderModelInfo[]> {
  const orgScope = options.orgId?.trim() || 'platform'
  const credentialScope = apiKey ? createHash('sha256').update(apiKey).digest('hex') : 'no-key'
  const cacheKey = `${orgScope}\u0000${provider.id}\u0000${provider.discoveryUrl}\u0000${credentialScope}`
  const cached = catalogCache.get(cacheKey)
  if (!options.forceRefresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.models

  const headers: Record<string, string> = {}
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const response = await fetch(provider.discoveryUrl, { headers, signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`Model provider ${provider.name} returned ${response.status} from /models`)
  const payload = await response.json() as { data?: unknown }
  if (!Array.isArray(payload.data)) throw new Error(`Model provider ${provider.name} returned an invalid /models response`)

  const named = payload.data
    .filter(isRecord)
    .filter(item => typeof item.id === 'string' && item.id.trim())
  const excluded = named
    .map(item => (item.id as string).trim())
    .filter(modelId => !isChatCapable(modelId))
  if (excluded.length > 0) {
    process.stderr.write(
      `[modelProviders] ${provider.name}: hiding ${excluded.length} non-chat model(s) from selection: ${excluded.join(', ')}\n`,
    )
  }

  const models = named
    .filter(item => isChatCapable((item.id as string).trim()))
    .map(item => {
      const modelId = (item.id as string).trim()
      const contextWindow = positiveInteger(item.context_window ?? item.context_length)
      const maxOutputTokens = positiveInteger(item.max_output_tokens ?? item.max_tokens)
      return {
        id: `${provider.id}:${modelId}`,
        modelId,
        name: modelId,
        providerId: provider.id,
        providerName: provider.name,
        protocol: provider.protocol,
        ratio: 1,
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
      }
    })
  catalogCache.set(cacheKey, { models, fetchedAt: Date.now() })
  return models
}

export function clearProviderModelCache(providerId?: string, orgId?: string): void {
  if (!providerId && !orgId) return void catalogCache.clear()
  for (const key of catalogCache.keys()) {
    const [scope, cachedProviderId] = key.split('\u0000')
    if ((!orgId || scope === orgId) && (!providerId || cachedProviderId === providerId)) catalogCache.delete(key)
  }
}

export function getProviderModelCacheStatus(): { cached: boolean; age: number | null; count: number } {
  if (catalogCache.size === 0) return { cached: false, age: null, count: 0 }
  let newestFetchedAt = 0
  let count = 0
  for (const entry of catalogCache.values()) {
    newestFetchedAt = Math.max(newestFetchedAt, entry.fetchedAt)
    count += entry.models.length
  }
  return {
    cached: true,
    age: Math.round((Date.now() - newestFetchedAt) / 1000),
    count,
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function isModelProviderProtocol(value: unknown): value is ModelProviderProtocol {
  return typeof value === 'string' && MODEL_PROVIDER_PROTOCOLS.has(value as ModelProviderProtocol)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}
