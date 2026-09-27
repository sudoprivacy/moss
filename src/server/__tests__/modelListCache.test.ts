import { afterEach, describe, expect, it } from 'bun:test'
import { buildModelsConfig, getAvailableModels, getModelsForSelection, refreshModelCache } from '../modelListCache.js'
import type { SystemSettingsPayload } from '../systemSettings.js'
import {
  clearProviderModelCache,
  discoverProviderModels,
  normalizeModelProviders,
  resolveModelSelection,
  toPublicProviders,
  type ModelProvider,
} from '../modelProviders.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  clearProviderModelCache()
  globalThis.fetch = originalFetch
})

describe('provider model discovery', () => {
  it('preserves gateway context and output limits in the runtime model configuration', async () => {
    const [provider] = normalizeModelProviders([], 'https://gateway.example.invalid/v1')
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [
      { id: 'gpt-4o', context_window: 128000, max_output_tokens: 16384 },
      { id: 'alias-model', context_length: 64000, max_tokens: 8000 },
      { id: 'invalid-limits', context_window: -1, max_output_tokens: '64000' },
    ] }))) as typeof fetch
    const models = await discoverProviderModels(provider, 'user-key')
    expect(buildModelsConfig(models)['proxy/gpt-4o']).toMatchObject({ contextWindow: 128000, maxOutputTokens: 16384 })
    expect(buildModelsConfig(models)['proxy/alias-model']).toMatchObject({ contextWindow: 64000, maxOutputTokens: 8000 })
    expect(models[2]?.contextWindow).toBeUndefined()
    expect(models[2]?.maxOutputTokens).toBeUndefined()
  })
  it('normalizes an OpenAI-compatible /models response into provider-scoped selections', async () => {
    const provider: ModelProvider = {
      id: 'local-vllm',
      name: 'Local vLLM',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8000/v1',
      discoveryUrl: 'http://127.0.0.1:8000/v1/models',
      protocol: 'openai-completions',
      enabled: true,
    }
    let authorization = ''
    globalThis.fetch = (async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization') || ''
      return new Response(JSON.stringify({ data: [{ id: 'Qwen3.6-35B-A3B-NVFP4' }] }), { status: 200 })
    }) as typeof fetch

    await expect(discoverProviderModels(provider, 'temporary-key')).resolves.toEqual([
      {
        id: 'local-vllm:Qwen3.6-35B-A3B-NVFP4',
        modelId: 'Qwen3.6-35B-A3B-NVFP4',
        name: 'Qwen3.6-35B-A3B-NVFP4',
        providerId: 'local-vllm',
        providerName: 'Local vLLM',
        protocol: 'openai-completions',
        ratio: 1,
      },
    ])
    expect(authorization).toBe('Bearer temporary-key')
  })

  it('keeps discovery cache entries separated by organization scope', async () => {
    const provider: ModelProvider = {
      id: 'shared-provider',
      name: 'Shared Provider',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8000/v1',
      discoveryUrl: 'http://127.0.0.1:8000/v1/models',
      protocol: 'openai-completions',
      enabled: true,
    }
    const seenAuth: string[] = []
    globalThis.fetch = (async (_input, init) => {
      const authorization = new Headers(init?.headers).get('authorization') || ''
      seenAuth.push(authorization)
      const suffix = authorization.endsWith('org-b-key') ? 'b' : 'a'
      return new Response(JSON.stringify({ data: [{ id: `model-${suffix}` }] }), { status: 200 })
    }) as typeof fetch

    await expect(discoverProviderModels(provider, 'org-a-key', { orgId: 'org-a' })).resolves.toMatchObject([
      { modelId: 'model-a' },
    ])
    await expect(discoverProviderModels(provider, 'org-b-key', { orgId: 'org-b' })).resolves.toMatchObject([
      { modelId: 'model-b' },
    ])
    await expect(discoverProviderModels(provider, 'org-a-key', { orgId: 'org-a' })).resolves.toMatchObject([
      { modelId: 'model-a' },
    ])

    expect(seenAuth).toEqual(['Bearer org-a-key', 'Bearer org-b-key'])
  })

  it('invalidates provider and organization caches without clearing unrelated entries', async () => {
    const [provider] = normalizeModelProviders([], 'https://example.invalid/v1')
    const otherProvider = { ...provider, id: 'other-provider' }
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({ data: [{ id: `model-${calls}` }] }))
    }) as unknown as typeof fetch
    const a = () => discoverProviderModels(provider, 'key-a', { orgId: 'org-a' })
    const b = () => discoverProviderModels(provider, 'key-b', { orgId: 'org-b' })
    const other = () => discoverProviderModels(otherProvider, 'key-a', { orgId: 'org-a' })
    await a()
    await b()
    await other()
    clearProviderModelCache(provider.id, 'org-a')
    await a()
    await b()
    await other()
    expect(calls).toBe(4)
    clearProviderModelCache(provider.id)
    await a()
    await b()
    await other()
    expect(calls).toBe(6)
    clearProviderModelCache(undefined, 'org-a')
    await a()
    await b()
    await other()
    expect(calls).toBe(8)
  })

  it.each(['', 'shared-key'])('uses the user key for discovery, selection and refresh with shared key %j', async (apiKey) => {
    const options = {
      orgId: 'org-a',
      userApiKey: 'user-key',
      settings: {
        apiKey,
        model: 'user-model',
        defaultModelProviderId: 'legacy-default',
        modelProviders: normalizeModelProviders([], 'https://gateway.example.invalid/v1'),
      } as SystemSettingsPayload,
    }
    const seenAuth: string[] = []
    globalThis.fetch = (async (_input, init) => {
      const authorization = new Headers(init?.headers).get('authorization') || ''
      seenAuth.push(authorization)
      return authorization === 'Bearer user-key'
        ? new Response(JSON.stringify({ data: [{ id: 'user-model' }] }))
        : new Response('Unauthorized', { status: 401 })
    }) as typeof fetch

    await expect(getAvailableModels(options)).resolves.toMatchObject([{ id: 'legacy-default:user-model' }])
    clearProviderModelCache()
    await expect(getModelsForSelection('legacy-default:user-model', options)).resolves.toMatchObject({
      selection: { selectionId: 'legacy-default:user-model' },
    })
    await expect(refreshModelCache(options)).resolves.toMatchObject([{ id: 'legacy-default:user-model' }])
    expect(seenAuth).toEqual(Array(3).fill('Bearer user-key'))
  })

  it('isolates user catalogs and selection validation within the same organization', async () => {
    const options = {
      orgId: 'org-a',
      settings: {
        apiKey: '',
        model: 'model-a',
        defaultModelProviderId: 'legacy-default',
        modelProviders: normalizeModelProviders([], 'https://gateway.example.invalid/v1'),
      } as SystemSettingsPayload,
    }
    const seenAuth: string[] = []
    globalThis.fetch = (async (_input, init) => {
      const authorization = new Headers(init?.headers).get('authorization') || ''
      seenAuth.push(authorization)
      const model = authorization === 'Bearer key-a' ? 'model-a' : 'model-b'
      return new Response(JSON.stringify({ data: [{ id: model }] }))
    }) as typeof fetch
    const a = { ...options, userApiKey: 'key-a' }
    const b = { ...options, userApiKey: 'key-b' }

    await expect(getAvailableModels(a)).resolves.toMatchObject([{ modelId: 'model-a' }])
    await expect(getAvailableModels(b)).resolves.toMatchObject([{ modelId: 'model-b' }])
    await expect(getModelsForSelection('model-a', b)).rejects.toThrow('not currently available')
    await expect(getAvailableModels(a)).resolves.toMatchObject([{ modelId: 'model-a' }])
    expect(seenAuth).toEqual(['Bearer key-a', 'Bearer key-b'])
    clearProviderModelCache('legacy-default', 'org-a')
    await getAvailableModels(a)
    await getAvailableModels(b)
    expect(seenAuth).toEqual(['Bearer key-a', 'Bearer key-b', 'Bearer key-a', 'Bearer key-b'])
  })

  it('does not send the user gateway key to an unauthenticated named provider', async () => {
    const [legacy] = normalizeModelProviders([], 'https://local.example.invalid/v1')
    const options = {
      userApiKey: 'user-gateway-key',
      settings: {
        apiKey: 'shared-gateway-key',
        model: 'local-model',
        defaultModelProviderId: 'local',
        modelProviders: [{ ...legacy, id: 'local' }],
      } as SystemSettingsPayload,
    }
    const seenAuth: Array<string | null> = []
    globalThis.fetch = (async (_input, init) => {
      seenAuth.push(new Headers(init?.headers).get('authorization'))
      return new Response(JSON.stringify({ data: [{ id: 'local-model' }] }))
    }) as typeof fetch

    await expect(getAvailableModels(options)).resolves.toMatchObject([{ id: 'local:local-model' }])
    clearProviderModelCache()
    await expect(getModelsForSelection('local:local-model', options)).resolves.toMatchObject({
      selection: { selectionId: 'local:local-model' },
    })
    expect(seenAuth).toEqual([null, null])
  })

  it('refreshes the model cache using the supplied organization settings', async () => {
    const seenAuth: string[] = []
    globalThis.fetch = (async (_input, init) => {
      seenAuth.push(new Headers(init?.headers).get('authorization') || '')
      return new Response(JSON.stringify({ data: [{ id: 'org-model' }] }), { status: 200 })
    }) as typeof fetch

    await expect(refreshModelCache({
      orgId: 'org-a',
      settings: {
        apiKey: 'org-a-key',
        modelProviders: [{
          id: 'legacy-default',
          name: '默认模型服务',
          kind: 'openai-compatible',
          baseUrl: 'https://org-a.example.invalid/v1',
          discoveryUrl: 'https://org-a.example.invalid/v1/models',
          protocol: 'openai-completions',
          enabled: true,
          apiKeyConfigured: true,
        }],
      } as never,
    })).resolves.toMatchObject([
      { modelId: 'org-model', providerId: 'legacy-default' },
    ])
    expect(seenAuth).toEqual(['Bearer org-a-key'])
  })

  it('routes a qualified user choice to its provider and keeps plain legacy choices backward compatible', () => {
    const providers: ModelProvider[] = [
      {
        id: 'local-vllm', name: 'Local vLLM', kind: 'openai-compatible',
        baseUrl: 'http://local/v1', discoveryUrl: 'http://local/v1/models', protocol: 'openai-completions', enabled: true,
      },
      {
        id: 'sudorouter', name: 'Sudorouter', kind: 'openai-compatible',
        baseUrl: 'https://model.sudorouter.ai/v1', discoveryUrl: 'https://model.sudorouter.ai/v1/models', protocol: 'openai-responses', enabled: true,
      },
    ]
    expect(resolveModelSelection(providers, 'local-vllm', 'Qwen', 'sudorouter:gemini-3.5-flash')).toMatchObject({
      provider: { id: 'sudorouter' }, modelId: 'gemini-3.5-flash', selectionId: 'sudorouter:gemini-3.5-flash',
    })
    expect(resolveModelSelection(providers, 'local-vllm', 'Qwen', 'Qwen')).toMatchObject({
      provider: { id: 'local-vllm' }, modelId: 'Qwen', selectionId: 'local-vllm:Qwen',
    })
  })

  it('keeps the configured inference protocol in the generated scode model entry', () => {
    expect(buildModelsConfig([{
      modelId: 'gpt-5.6',
      protocol: 'openai-responses',
    }])).toEqual({
      'proxy/gpt-5.6': {
        alias: 'proxy/gpt-5.6',
        name: 'Moss provider: proxy/gpt-5.6',
        input: ['text'],
        providers: {
          proxy: {
            provider: 'moss-proxy',
            model: 'gpt-5.6',
            api: 'openai-responses',
          },
        },
      },
    })
  })

  it('keeps provider credentials write-only while retaining the configured protocol', () => {
    const [provider] = normalizeModelProviders([{
      id: 'sudorouter',
      name: 'Sudorouter',
      baseUrl: 'https://model.sudorouter.ai/v1',
      discoveryUrl: 'https://model.sudorouter.ai/v1/models',
      protocol: 'openai-responses',
      enabled: true,
    }], '')
    const [publicProvider] = toPublicProviders([provider], { sudorouter: 'not-returned' }, '')

    expect(publicProvider.protocol).toBe('openai-responses')
    expect(publicProvider.apiKeyConfigured).toBe(true)
    expect('apiKey' in publicProvider).toBe(false)
  })

  it('keeps an unconfigured legacy installation on the historical default endpoint', () => {
    const [provider] = normalizeModelProviders([], '')
    expect(provider).toMatchObject({
      id: 'legacy-default',
      baseUrl: 'https://hk.sudorouter.ai/v1',
      discoveryUrl: 'https://hk.sudorouter.ai/v1/models',
    })
  })
})

describe('non-chat models', () => {
  // The picker was fed a provider's whole /models catalog. That catalog carries
  // embeddings and speech models, an OpenAI-compatible response says nothing
  // about what a model can do, and the failure surfaces far away: a session
  // running a transcription model as its conversation engine.
  it('are hidden from discovery, and chat models that merely sound similar are not', async () => {
    const [provider] = normalizeModelProviders([], 'https://gateway.example.invalid/v1')
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [
      { id: 'gpt-5.5' },
      { id: 'text-embedding-ada-002' },
      { id: 'gpt-4o-transcribe-diarize' },
      { id: 'whisper-1' },
      { id: 'tts-1-hd' },
      { id: 'dall-e-3' },
      { id: 'omni-moderation-latest' },
      { id: 'bge-reranker-v2' },
      // Vision and audio-capable chat models keep chatting; excluding on
      // "image" or "audio" would have taken these with them.
      { id: 'gpt-4o-audio-preview' },
      { id: 'claude-opus-4-6' },
    ] }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

    const models = await discoverProviderModels(provider, 'key')
    const ids = models.map(model => model.modelId)

    expect(ids).toEqual(['gpt-5.5', 'gpt-4o-audio-preview', 'claude-opus-4-6'])
  })

  // Hiding one from the picker does nothing about a preference already saved,
  // and that saved value is what reaches the session.
  it('are refused when they arrive as an already-stored selection', () => {
    const providers = normalizeModelProviders([], 'https://gateway.example.invalid/v1')

    const stale = resolveModelSelection(providers, 'legacy-default', 'gpt-5.5', 'legacy-default:gpt-4o-transcribe-diarize')
    expect(stale.modelId).toBe('gpt-5.5')

    const good = resolveModelSelection(providers, 'legacy-default', 'gpt-5.5', 'legacy-default:claude-opus-4-6')
    expect(good.modelId).toBe('claude-opus-4-6')
  })
})
