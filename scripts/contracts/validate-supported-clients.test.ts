import { describe, expect, it } from 'bun:test'
import { validateSupportedClients, type SupportedClientsDocument } from './validate-supported-clients.js'

function validDocument(): SupportedClientsDocument {
  return {
    schema_version: 1,
    policy_status: 'candidate',
    clients: [
      {
        product_version: '0.2.17',
        git_ref: 'v0.2.17',
        commit: '0123456789abcdef0123456789abcdef01234567',
        channel: 'stable',
        targets: [{ platform: 'darwin', architecture: 'arm64' }],
        auth_profiles: ['password', 'refresh_token'],
        capabilities: ['local', 'cloud'],
        support_status: 'candidate',
      },
    ],
  }
}

describe('validateSupportedClients', () => {
  it('accepts a well-formed candidate matrix', () => {
    expect(validateSupportedClients(validDocument())).toEqual([])
  })

  it('rejects a client without a product version', () => {
    const document = validDocument()
    document.clients[0]!.product_version = ''

    expect(validateSupportedClients(document)).toContain(
      'clients[0].product_version must be a non-empty string',
    )
  })

  it('rejects empty platform coverage', () => {
    const document = validDocument()
    document.clients[0]!.targets = []

    expect(validateSupportedClients(document)).toContain(
      'clients[0].targets must contain at least one value',
    )
  })

  it('rejects unknown authentication profiles', () => {
    const document = validDocument()
    document.clients[0]!.auth_profiles = ['magic_link'] as never

    expect(validateSupportedClients(document)).toContain(
      'clients[0].auth_profiles[0] has unsupported value: magic_link',
    )
  })

  it('rejects duplicate version, platform and architecture coverage', () => {
    const document = validDocument()
    document.clients.push({
      ...document.clients[0]!,
      targets: [{ ...document.clients[0]!.targets[0]! }],
    })

    expect(validateSupportedClients(document)).toContain(
      'duplicate client coverage: v0.2.17/darwin/arm64',
    )
  })

  it('rejects a confirmed policy while candidate entries remain', () => {
    const document = validDocument()
    document.policy_status = 'confirmed'

    expect(validateSupportedClients(document)).toContain(
      'confirmed policy cannot contain candidate clients',
    )
  })
})
