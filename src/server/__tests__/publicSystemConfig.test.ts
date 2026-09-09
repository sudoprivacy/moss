import { describe, expect, it } from 'bun:test'
import { buildPublicSystemConfig, toSudorouterRoot } from '../publicSystemConfig.js'
import { serverFileConfigSchema } from '../types.js'
import type { ServerConfig } from '../types.js'

/**
 * The payload is a wire contract with the sudowork client, so these tests pin
 * the field names and the shape of the defaults rather than just "it returns an
 * object". A rename here silently breaks every client's login screen.
 */

/** Config with only the `systemConfig` section populated — the rest is unused. */
function configWith(section: unknown): ServerConfig {
  const parsed = serverFileConfigSchema().parse(
    section === undefined ? {} : { systemConfig: section },
  )
  return { systemConfig: parsed.systemConfig } as ServerConfig
}

describe('toSudorouterRoot', () => {
  it('strips the /v1 suffix the model-service URL carries', () => {
    // Call sites append their own /v1; passing the SDK form through unchanged
    // produces .../v1/v1/... at every one of them.
    expect(toSudorouterRoot('https://hk.sudorouter.ai/v1')).toBe('https://hk.sudorouter.ai')
    expect(toSudorouterRoot('https://hk.sudorouter.ai/v1/')).toBe('https://hk.sudorouter.ai')
  })

  it('leaves a root URL alone and treats blank input as absent', () => {
    expect(toSudorouterRoot('https://hk.sudorouter.ai')).toBe('https://hk.sudorouter.ai')
    expect(toSudorouterRoot('   ')).toBeUndefined()
    expect(toSudorouterRoot(undefined)).toBeUndefined()
  })

  it('does not strip a path that merely ends in something like v1', () => {
    expect(toSudorouterRoot('https://example.com/api/v10')).toBe('https://example.com/api/v10')
  })
})

describe('buildPublicSystemConfig defaults', () => {
  it('describes a self-hosted deployment when nothing is configured', () => {
    const payload = buildPublicSystemConfig(configWith(undefined))

    // Username/password is the only method moss implements today; claiming 0
    // would advertise a phone-code flow that has no endpoints behind it.
    expect(payload.login_method).toBe(1)
    // moss holds no credit ledger.
    expect(payload.recharge_mode).toBe('disabled')
    expect(payload.third_party_auth).toBeUndefined()
    expect(payload.credit_application).toBeUndefined()
  })

  it('always serialises the phone-home switches as an explicit off', () => {
    const payload = buildPublicSystemConfig(configWith(undefined))

    // The client reads these as `enabled !== 0`, i.e. it fails OPEN. Omitting
    // the blocks would leave telemetry and update checks enabled and pointed at
    // the public cloud's hardcoded fallback hosts — the opposite of what a
    // self-hosted deployment that configured nothing is asking for.
    expect(payload.log_report).toEqual({ enabled: 0 })
    expect(payload.version_update).toEqual({ enabled: 0 })
    expect(payload.product_improvement).toEqual({ enabled: 0 })
  })

  it('carries no secret-bearing field', () => {
    const payload = buildPublicSystemConfig(
      configWith({ loginMethod: 1 }),
      'https://hk.sudorouter.ai/v1',
    )
    const serialised = JSON.stringify(payload)
    // This route is served before the auth wall. Guard the boundary explicitly
    // so a future field addition has to justify itself against a failing test.
    for (const forbidden of ['apiKey', 'api_key', 'token', 'secret', 'password']) {
      expect(serialised.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })
})

describe('buildPublicSystemConfig sudorouter base url', () => {
  it('derives the root from the model-service URL when unset', () => {
    const payload = buildPublicSystemConfig(configWith({}), 'https://hk.sudorouter.ai/v1')
    expect(payload.sudorouter_baseurl).toBe('https://hk.sudorouter.ai')
  })

  it('prefers an explicit override so a deployment can split the two', () => {
    const payload = buildPublicSystemConfig(
      configWith({ sudorouterBaseUrl: 'https://router.internal' }),
      'https://hk.sudorouter.ai/v1',
    )
    expect(payload.sudorouter_baseurl).toBe('https://router.internal')
  })

  it('omits the field entirely when neither source has a value', () => {
    const payload = buildPublicSystemConfig(configWith({}), undefined)
    expect(payload.sudorouter_baseurl).toBeUndefined()
  })
})

describe('buildPublicSystemConfig third-party auth', () => {
  it('maps a CAS provider to the snake_case names the client parses', () => {
    const payload = buildPublicSystemConfig(
      configWith({
        loginMethod: 2,
        thirdPartyAuth: {
          enabled: true,
          defaultProvider: 'acme_cas',
          providers: [{
            id: 'acme_cas',
            name: 'ACME',
            type: 'cas',
            casUrl: 'https://cas.example.com/',
            loginPath: '/cas/login/',
            validatePath: '/cas/p3/serviceValidate',
            callbackMode: 'server_callback',
            serverCallbackUrl: 'https://moss.example.com/cb',
          }],
        },
      }),
    )

    expect(payload.login_method).toBe(2)
    expect(payload.third_party_auth?.enabled).toBe(true)
    expect(payload.third_party_auth?.default_provider).toBe('acme_cas')
    expect(payload.third_party_auth?.providers[0]).toEqual({
      id: 'acme_cas',
      name: 'ACME',
      type: 'cas',
      cas_url: 'https://cas.example.com/',
      login_path: '/cas/login/',
      validate_path: '/cas/p3/serviceValidate',
      callback_mode: 'server_callback',
      server_callback_url: 'https://moss.example.com/cb',
    })
  })

  it('omits unset optional provider fields rather than sending nulls', () => {
    const payload = buildPublicSystemConfig(
      configWith({
        loginMethod: 2,
        thirdPartyAuth: {
          providers: [{ id: 'p', name: 'P', type: 'cas', casUrl: 'https://cas.example.com/' }],
        },
      }),
    )
    // The client fills its own defaults for absent fields; an explicit null or
    // empty string would override that with something unusable.
    expect(payload.third_party_auth?.providers[0]).toEqual({
      id: 'p',
      name: 'P',
      type: 'cas',
      cas_url: 'https://cas.example.com/',
    })
  })
})

describe('buildPublicSystemConfig billing', () => {
  it('passes through the cloud billing mode and credit application bounds', () => {
    const payload = buildPublicSystemConfig(
      configWith({
        rechargeMode: 'approve',
        creditApplication: { minPoints: 100, maxPoints: 5000, allowDuplicatePending: true },
      }),
    )
    expect(payload.recharge_mode).toBe('approve')
    expect(payload.credit_application).toEqual({
      min_points: 100,
      max_points: 5000,
      allow_duplicate_pending: true,
    })
  })
})
