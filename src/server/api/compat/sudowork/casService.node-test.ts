import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { onlineCommandContext } from '../../../application/commandContext.js'
import { AuthCenterDb } from '../../../authCenter/db.js'
import { IdentityRepository } from '../../../identity/identityRepository.js'
import { UnifiedIdentityService } from '../../../identity/unifiedIdentityService.js'
import type { LegacyKeyValueStore } from '../../../identity/legacyToken.js'
import { SudoworkIdentityService } from './identityService.js'
import { HttpCasTicketValidator, SudoworkCasError, SudoworkCasService } from './casService.js'
import type { CasProvider } from './casService.js'

class MemoryStore implements LegacyKeyValueStore {
  readonly values = new Map<string, string>()
  async setex(key: string, _seconds: number, value: string) { this.values.set(key, value) }
  async get(key: string) { return this.values.get(key) ?? null }
  async del(...keys: string[]) { keys.forEach((key) => this.values.delete(key)) }
  async keys() { return [] }
  async rotate(oldKey: string, newKey: string, _seconds: number, value: string) {
    if (!this.values.has(oldKey)) return false
    this.values.delete(oldKey)
    this.values.set(newKey, value)
    return true
  }
}

const casProvider: CasProvider = {
  id: 'cas-main',
  orgId: 'org-a',
  name: '统一认证',
  casUrl: 'https://cas.example.test/base/',
  loginPath: '/cas/login',
  validatePath: '/cas/p3/serviceValidate',
  logoutPath: '/cas/logout',
  logoutServiceUrl: '',
  serviceParam: 'service',
  serviceEncodeMode: 'component',
  callbackMode: 'server_callback',
  serverCallbackUrl: 'https://api.example.test/callback?a=1&b=2',
  appCallbackUrl: 'sudowork://cas-callback/cas-main/callback',
  autoProvision: true,
}

describe('HTTP CAS ticket validator', () => {
  test('parses namespaced XML and decoded attributes with component encoding', async () => {
    let requestedUrl = ''
    const validator = new HttpCasTicketValidator(async (input) => {
      requestedUrl = String(input)
      return new Response(`<?xml version="1.0"?>
        <cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">
          <cas:authenticationSuccess>
            <cas:user>external-1</cas:user>
            <cas:attributes>
              <cas:username>A&amp;B</cas:username>
              <cas:first_name>张</cas:first_name>
              <cas:last_name>三</cas:last_name>
              <cas:is_active>true</cas:is_active>
            </cas:attributes>
          </cas:authenticationSuccess>
        </cas:serviceResponse>`)
    })

    const profile = await validator.validate(casProvider, casProvider.serverCallbackUrl, 'ST-1+a')

    assert.equal(
      requestedUrl,
      'https://cas.example.test/cas/p3/serviceValidate?service=https%3A%2F%2Fapi.example.test%2Fcallback%3Fa%3D1%26b%3D2&ticket=ST-1%2Ba',
    )
    assert.deepEqual(profile, {
      subject: 'external-1',
      account: 'A&B',
      nickname: '张 三',
      active: true,
      attributes: { username: 'A&B', first_name: '张', last_name: '三', is_active: 'true' },
    })
  })

  test('preserves raw service values and rejects CAS authentication failures', async () => {
    let requestedUrl = ''
    const validator = new HttpCasTicketValidator(async (input) => {
      requestedUrl = String(input)
      return new Response(`
        <cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">
          <cas:authenticationFailure code="INVALID_TICKET">票据已失效</cas:authenticationFailure>
        </cas:serviceResponse>`)
    })

    await assert.rejects(
      () => validator.validate({ ...casProvider, serviceEncodeMode: 'raw' }, casProvider.serverCallbackUrl, 'ST-1+a'),
      (error: unknown) => error instanceof SudoworkCasError
        && error.statusCode === 401
        && error.message === 'CAS 认证失败: 票据已失效',
    )
    assert.equal(
      requestedUrl,
      'https://cas.example.test/cas/p3/serviceValidate?service=https://api.example.test/callback?a=1&b=2&ticket=ST-1%2Ba',
    )
  })
})

describe('Sudowork CAS compatibility service', () => {
  test('auto-provisions one canonical user and atomically exchanges a handoff code', async () => {
    const db = new DatabaseSync(':memory:')
    const authDb = new AuthCenterDb(db)
    const identities = new IdentityRepository(db)
    const unified = new UnifiedIdentityService(db, authDb, identities)
    const organization = unified.createOrganization({
      name: '企业 A', code: 'ENT-A', loginMethod: 'cas',
    }, onlineCommandContext('org-a'))
    identities.putIntegrationConnection({
      id: 'cas-main', orgId: organization.organizationId, providerType: 'cas',
      name: '统一认证', enabled: true, config: {
        casUrl: 'https://cas.example.test', validatePath: '/serviceValidate',
        serviceParam: 'service', callbackMode: 'server_callback',
        serverCallbackUrl: 'https://api.example.test/api/v1/auth/third-party/cas/callback/cas-main',
        appCallbackUrl: 'sudowork://cas-callback/cas-main/callback', autoProvision: true,
      },
    })
    const store = new MemoryStore()
    const identity = new SudoworkIdentityService({
      authDb, identities, tokenStore: store, legacyJwtSecret: 'secret',
      refreshTokenFactory: () => 'refresh-cas',
    })
    const service = new SudoworkCasService({
      authDb, identities, unifiedIdentity: unified, identity, tokenStore: store,
      codeFactory: () => 'handoff-code',
      ticketValidator: {
        async validate() {
          return {
            subject: 'external-1', account: 'cas-user', nickname: 'CAS 用户', active: true,
            attributes: { email: 'cas@example.test' },
          }
        },
      },
    })

    const callback = await service.createHandoff({ providerId: 'cas-main', ticket: 'ST-1' })
    assert.equal(callback.redirectUrl, 'sudowork://cas-callback/cas-main/callback?code=handoff-code')
    const session = await service.exchange({ providerId: 'cas-main', code: 'handoff-code', deviceId: 'desktop-a' })
    assert.equal(session.user.phone, 'cas-user')
    assert(identities.findAuthIdentity('cas', 'cas-main', 'external-1'))
    await assert.rejects(() => service.exchange({
      providerId: 'cas-main', code: 'handoff-code', deviceId: 'desktop-a',
    }))
    db.close()
  })
})
