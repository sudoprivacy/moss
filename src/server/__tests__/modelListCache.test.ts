import { afterEach, describe, expect, it } from 'bun:test'
import { buildModelsConfig, refreshModelCache } from '../modelListCache.js'
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
    }) as typeof fetch
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
