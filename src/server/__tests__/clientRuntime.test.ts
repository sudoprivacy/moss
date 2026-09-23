import { describe, expect, it } from 'bun:test'
import { buildClientRuntime, resolveExecutionCapabilities } from '../clientRuntime.js'

function fixture(key: string | null = 'personal-key', policy: Record<string, unknown> = {}, isUserLocalAllowed = true) {
  return {
    getOrganizationClientPolicy: async () => policy,
    isUserLocalExecutionAllowed: async () => isUserLocalAllowed,
    getUserModelCredential: async () => key ? { sudorouterKey: key, sudorouterUserId: 'router-user' } : null,
    ensureUserSudorouterAccount: async () => false,
    getOrganizationSystemSettings: async () => ({
      apiKey: 'never-export-this-shared-key', model: 'test-model',
      modelProviders: [{ id: 'legacy-default', enabled: true, baseUrl: 'https://gateway.test/v1', protocol: 'openai-completions' }],
    }),
  } as unknown as Parameters<typeof buildClientRuntime>[0]
}

const user = { id: 'user-a', orgId: 'org-a', localAuth: false }
const discover: NonNullable<Parameters<typeof buildClientRuntime>[2]> = async options => {
  expect(options?.userApiKey).toBe('personal-key')
  expect(options?.settings?.apiKey).toBe('')
  return [{ id: 'legacy-default:test-model', modelId: 'test-model', name: 'Test', providerId: 'legacy-default', providerName: 'Gateway', protocol: 'openai-completions', ratio: 1 }]
}

describe('Moss local runtime', () => {
  it('opens both execution targets by default, independently of password identity', async () => {
    const result = await buildClientRuntime(fixture(), user, discover)
    expect(result.execution).toEqual({ isLocalAllowed: true, isRemoteAllowed: true, defaultTarget: 'local' })
    expect(result.localRuntime.status).toBe('ready')
    expect('sudorouter_key' in result && result.sudorouter_key).toBe('personal-key')
    expect(JSON.stringify(result)).not.toContain('never-export-this-shared-key')
  })

  it('keeps cloud available while a personal credential is pending', async () => {
    const result = await buildClientRuntime(fixture(null), user, discover)
    expect(result.localRuntime.status).toBe('credential_pending')
    expect(result.execution.defaultTarget).toBe('local')
    expect(result).not.toHaveProperty('sudorouter_key')
  })

  it('respects an explicit execution policy without provisioning or discovering models', async () => {
    const result = await buildClientRuntime(fixture(null, { execution: { isLocalAllowed: false } }), user, async () => { throw new Error('must not discover') })
    expect(result.localRuntime.status).toBe('policy_denied')
    expect(result.execution.defaultTarget).toBe('remote')
    expect(resolveExecutionCapabilities({ execution: { isRemoteAllowed: false } }).isRemoteAllowed).toBe(false)
  })

  it('reports model discovery failure without exporting a shared credential', async () => {
    const result = await buildClientRuntime(fixture(), user, async () => { throw new Error('gateway offline') })
    expect(result.localRuntime.status).toBe('models_unavailable')
    expect(result).not.toHaveProperty('sudorouter_key')
  })

  it('honors a revoked user grant while preserving cloud access and withholding credentials', async () => {
    const result = await buildClientRuntime(fixture('personal-key', {}, false), user, async () => { throw new Error('must not discover') })
    expect(result.execution).toEqual({ isLocalAllowed: false, isRemoteAllowed: true, defaultTarget: 'remote' })
    expect(result.localRuntime.status).toBe('policy_denied')
    expect(result).not.toHaveProperty('sudorouter_key')
  })
})
