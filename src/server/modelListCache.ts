/**
 * Model list cache with 24-hour TTL
 * Fetches available models from sudorouter API
 */

const MODEL_CACHE_DURATION = 24 * 60 * 60 * 1000 // 24 hours in milliseconds

interface ModelInfo {
  id: string
  name: string
  ratio: number
}

interface ModelCache {
  data: ModelInfo[]
  fetchedAt: number
}

let modelCache: ModelCache | null = null

/**
 * Fetch available models from sudorouter API
 * Returns cached data if valid (within 24 hours)
 */
export async function getAvailableModels(): Promise<ModelInfo[]> {
  // Check cache validity
  if (modelCache && Date.now() - modelCache.fetchedAt < MODEL_CACHE_DURATION) {
    const age = Math.round((Date.now() - modelCache.fetchedAt) / 1000)
    process.stderr.write(`[ModelListCache] Using cached model list (age: ${age}s)\n`)
    return modelCache.data
  }

  try {
    process.stderr.write(`[ModelListCache] Fetching fresh model list from sudorouter...\n`)
    const response = await fetch('https://hk.sudorouter.ai/api/specific_pricing', {
      signal: AbortSignal.timeout(10000),
    })

    if (!response.ok) {
      throw new Error(`sudorouter API returned ${response.status}`)
    }

    const data = (await response.json()) as {
      success?: boolean
      data?: Array<{ model_id: string; model?: string; ratio?: number }>
    }

    if (!data.success || !Array.isArray(data.data)) {
      throw new Error('Invalid response from sudorouter API')
    }

    const models: ModelInfo[] = data.data.map((item) => ({
      id: item.model_id,
      name: item.model || item.model_id,
      ratio: item.ratio || 1,
    }))

    // Update cache
    modelCache = {
      data: models,
      fetchedAt: Date.now(),
    }

    process.stderr.write(`[ModelListCache] Model list cached: ${models.length} models\n`)

    return models
  } catch (error) {
    process.stderr.write(`[ModelListCache] Failed to fetch available models: ${error}\n`)

    // If we have expired cache, still use it as fallback
    if (modelCache) {
      process.stderr.write(`[ModelListCache] Falling back to expired cache\n`)
      return modelCache.data
    }

    return []
  }
}

/**
 * Force refresh the model cache
 */
export async function refreshModelCache(): Promise<ModelInfo[]> {
  modelCache = null
  return getAvailableModels()
}

/**
 * Clear the model cache
 */
export function clearModelCache(): void {
  modelCache = null
}

/**
 * Get cache status
 */
export function getCacheStatus(): { cached: boolean; age: number | null; count: number } {
  if (!modelCache) {
    return { cached: false, age: null, count: 0 }
  }
  return {
    cached: true,
    age: Math.round((Date.now() - modelCache.fetchedAt) / 1000),
    count: modelCache.data.length,
  }
}

/**
 * Build sudocode.json models config from available models
 * Each model gets a proxy/ prefix
 */
export async function buildAllModelsConfig(baseUrl: string): Promise<Record<string, unknown>> {
  const models = await getAvailableModels()

  const modelsConfig: Record<string, unknown> = {}

  for (const model of models) {
    const scodeModelName = `proxy/${model.id}`

    modelsConfig[scodeModelName] = {
      alias: scodeModelName,
      name: `Moss Dynamic: ${scodeModelName}`,
      input: ['text'],
      providers: {
        proxy: {
          provider: 'moss-proxy',
          model: model.id,
          api: 'openai-completions',
        },
      },
    }
  }

  return modelsConfig
}
