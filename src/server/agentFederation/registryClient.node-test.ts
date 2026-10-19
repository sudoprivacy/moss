import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import fixture from '../../../contracts/agent-registry/v1alpha1/signed-version.fixture.json' with { type: 'json' }
import { ProductRegistryClient } from './registryClient.js'

const ref = fixture.version.manifest.principal
const options = { endpoint: 'http://127.0.0.1:12345', token: 'test-registry-key', publicKeys: [fixture.public_key_pem], organizations: { org: { trustDomain: ref.trust_domain, zoneId: 'fixture-zone' } } }
function resolution() {
  return { api_version: 'agent-registry.sudo.dev/v1alpha1', kind: 'RegistryResolution',
    principal: { principal: ref, owner_zone: 'fixture-zone', display_name: 'Fixture', status: 'active', revision: 4, created_at: 1000 },
    version: structuredClone(fixture.version),
    approval: { id: 'approval', version: 'v1', decision: 'approved', actor: 'user:admin', reason: 'reviewed', expires_at: Date.now() + 100_000, created_at: Date.now(), registry_revision: 3 },
    channel: { name: 'stable', version: 'v1', spec_digest: fixture.version.manifest.spec_digest, enabled: true, revision: 1, updated_at: Date.now() }, evaluated_at: Date.now() }
}
void test('Registry client verifies Python owner bytes and rejects tampered projections, signatures and scope', () => {
  const client = new ProductRegistryClient(options)
  assert.equal(client.verifyVersion(fixture.version, 'org', ref, 'v1').manifest.version, 'v1')
  for (const field of ['signature_base64', 'payload_base64', 'digest', 'key_id'] as const) {
    const changed = structuredClone(fixture.version); changed[field] += 'a'
    assert.throws(() => client.verifyVersion(changed, 'org', ref), /REGISTRY_SIGNATURE_INVALID/)
  }
  const changed = structuredClone(fixture.version); changed.manifest.spec_ref.path = '/changed'
  assert.throws(() => client.verifyVersion(changed, 'org', ref), /REGISTRY_SIGNATURE_INVALID/)
  assert.throws(() => client.verifyVersion(fixture.version, 'org', { ...ref, agent_name: 'other' }), /REGISTRY_SIGNATURE_INVALID/)
  assert.throws(() => client.verifyVersion(fixture.version, 'org', ref, 'v2'), /REGISTRY_SIGNATURE_INVALID/)
  assert.throws(() => client.verifyVersion(fixture.version, 'unknown', ref), /REGISTRY_ORGANIZATION_UNCONFIGURED/)
})
void test('Registry resolution uses fixed server credentials, no redirects or cache, and live approval', async () => {
  let calls = 0
  const client = new ProductRegistryClient({ ...options, request: (async (url, init) => {
    calls++
    assert.equal(new URL(String(url)).pathname, '/api/v2/product-agents/fixture.example/assistant/resolve')
    assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store')
    assert.equal((init?.headers as Record<string, string>)['X-Nexus-Zone-ID'], 'fixture-zone')
    return Response.json(resolution())
  }) })
  assert.equal((await client.resolve('org', ref)).version.manifest.version, 'v1')
  await client.resolve('org', ref)
  assert.equal(calls, 2)
})
void test('Registry fails closed on stale, withdrawn, mismatched and invalid responses', async () => {
  const mutations = [
    (value: ReturnType<typeof resolution>) => { value.evaluated_at = 1000 },
    (value: ReturnType<typeof resolution>) => { value.approval.decision = 'withdrawn' },
    (value: ReturnType<typeof resolution>) => { value.approval.expires_at = 1000 },
    (value: ReturnType<typeof resolution>) => { value.channel.version = 'v2' },
    (value: ReturnType<typeof resolution>) => { value.principal.status = 'suspended' },
    (value: ReturnType<typeof resolution>) => { value.principal.owner_zone = 'other-zone' },
  ]
  for (const mutate of mutations) {
    const value = resolution(); mutate(value)
    const client = new ProductRegistryClient({ ...options, request: (async () => Response.json(value)) })
    await assert.rejects(() => client.resolve('org', ref), /REGISTRY_RESPONSE_INVALID|AGENT_VERSION_APPROVAL_EXPIRED/)
  }
  const unavailable = new ProductRegistryClient({ ...options, request: (async () => { throw new Error('network contains private information') }) })
  await assert.rejects(() => unavailable.resolve('org', ref), error => error instanceof Error && error.message === 'REGISTRY_UNAVAILABLE')
  const malicious = new ProductRegistryClient({ ...options, request: (async () => Response.json({ detail: { code: 'private credential' } }, { status: 500 })) })
  await assert.rejects(() => malicious.resolve('org', ref), /REGISTRY_REQUEST_FAILED/)
})
void test('Registry endpoint configuration rejects insecure remote addresses and embedded credentials', () => {
  for (const endpoint of ['http://10.0.1.158:9000', 'https://user:pass@example.com', 'https://example.com?key=secret', 'file:///tmp/registry']) {
    assert.throws(() => new ProductRegistryClient({ ...options, endpoint }), /REGISTRY_CONFIGURATION_INVALID/)
  }
})
