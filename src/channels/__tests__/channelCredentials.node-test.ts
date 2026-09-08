import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  hydrateChannelSecrets,
  persistChannelSecrets,
  stripChannelSecretsForClient,
} from '../core/channelCredentialSecrets.js'

class MemoryNexus {
  readonly values = new Map<string, string>()

  async putSecret(namespace: string, key: string, value: string): Promise<void> {
    this.values.set(`${namespace}:${key}`, value)
  }

  async deleteSecret(namespace: string, key: string): Promise<void> {
    this.values.delete(`${namespace}:${key}`)
  }

  async getSecret(namespace: string, key: string) {
    const value = this.values.get(`${namespace}:${key}`)
    return value === undefined ? null : { value, status: 'enabled', version: 1 }
  }

  async listSecrets(namespace: string) {
    return Array.from(this.values.entries())
      .filter(([identity]) => identity.startsWith(`${namespace}:`))
      .map(([identity, value]) => ({
        namespace,
        key: identity.slice(namespace.length + 1),
        value,
        status: 'enabled',
        version: 1,
      }))
  }
}

describe('Channel 凭据 Nexus 边界', () => {
  it('保存时剥离明文，读取时只采用 Nexus 中的敏感值', async () => {
    const nexus = new MemoryNexus()
    const sanitized = await persistChannelSecrets(
      nexus as never,
      'user-a',
      'telegram_default',
      'telegram',
      { token: 'live-secret', proxyUrl: 'http://proxy' },
    )

    assert.equal(sanitized.token, undefined)
    assert.equal(JSON.stringify(sanitized).includes('live-secret'), false)
    assert.equal(sanitized.proxyUrl, 'http://proxy')

    const hydrated = await hydrateChannelSecrets(
      nexus as never,
      'user-a',
      'telegram_default',
      'telegram',
      { token: 'legacy-plaintext', proxyUrl: 'http://proxy' },
    )
    assert.equal(hydrated.token, 'live-secret')
  })

  it('API 清洗会移除四类平台的敏感字段和内部元数据', () => {
    const cases = [
      ['telegram', { token: 't' }],
      ['lark', { appSecret: 's', encryptKey: 'e', verificationToken: 'v' }],
      ['dingtalk', { clientSecret: 's' }],
      ['wecom', { secret: 's' }],
    ] as const

    for (const [type, secretFields] of cases) {
      const result = stripChannelSecretsForClient(type, {
        ...secretFields,
        visible: 'ok',
        configuredSecretFields: Object.keys(secretFields),
        tokenFingerprint: 'internal',
      })
      assert.deepEqual(result.credentials, { visible: 'ok' })
      assert.deepEqual(result.configuredSecretFields, Object.keys(secretFields))
    }
  })
})
