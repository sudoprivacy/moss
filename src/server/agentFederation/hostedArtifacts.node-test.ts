import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { ProductRegistryClient, type RegistryRequest } from './registryClient.js'
import { AgentInventoryService } from './inventoryService.js'
import { dispatchAgentInventory } from './inventoryRoutes.js'
import fixture from '../../../contracts/agent-registry/v1alpha1/signed-version.fixture.json' with { type: 'json' }
import type { HostedArtifact, DifyTextPlan } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import type { AuthContext } from '../auth/token.js'

const hash = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`
const plan: DifyTextPlan = {
  api_version: 'agent-registry.sudo.dev/v1alpha1', kind: 'DifyTextPlan', profile: 'dify-0.6.0-linear-text-v1',
  source_digest: hash('source'), source_model: 'model', source_provider: 'provider', source_plugin: 'plugin', llm_node: 'llm',
  prompts: [{ role: 'system', content: 'answer' }], temperature: 0, max_tokens: null, conversation_mode: 'independent_turns',
}
function record(): HostedArtifact {
  const image = { api_version: 'agent-registry.sudo.dev/v1alpha1' as const, kind: 'HostedImage' as const,
    profile: 'dify-0.6.0-linear-text-v1' as const, image_id: hash('image'), source_digest: hash('source'),
    dependency_lock_digest: hash('lock'), protocol: 'agent-hosted-stdio/v1' as const, model_resource: 'model-resource', model_name: 'model', max_output_tokens: 128 }
  // Python canonical bytes retain 0.0. JS reserialization would change the digest.
  const payload = JSON.stringify({ image, dify_plan: plan }).replace('"temperature":0,', '"temperature":0.0,')
  return { api_version: 'agent-registry.sudo.dev/v1alpha1', kind: 'HostedArtifact', id: 'artifact-a', zone: 'zone-a', asset_id: 'asset-a',
    metadata_digest: hash('metadata'), spec_digest: hash(payload), spec_payload_base64: Buffer.from(payload).toString('base64'), image, dify_plan: plan,
    created_by: 'agent:gateway', initiated_by: 'admin', created_at: 1000, evidence: 'registered_only' }
}
function client(request: RegistryRequest) {
  return new ProductRegistryClient({ endpoint: 'http://127.0.0.1:12345', token: 'test-management-token', publicKeys: [fixture.public_key_pem], organizations: { 'org-a': { trustDomain: 'a.example', zoneId: 'zone-a' } }, request })
}
void test('hosted client validates exact Python spec bytes, source and organization', async () => {
  let result: unknown = record()
  const registry = client(async () => Response.json(result))
  assert.equal((await registry.hostedGet('org-a', 'artifact-a')).spec_digest, record().spec_digest)
  for (const patch of [
    { zone: 'zone-b' }, { id: 'artifact-b' }, { spec_digest: hash('wrong') },
    { image: { ...record().image, model_name: 'changed' } },
    { dify_plan: { ...plan, prompts: [{ role: 'system', content: 'changed' }] } },
  ]) {
    result = { ...record(), ...patch }
    await assert.rejects(registry.hostedGet('org-a', 'artifact-a'), { code: 'HOSTED_RESPONSE_INVALID' })
  }
})
void test('DSL inspection is bounded and verifies the submitted source digest', async () => {
  let value = plan, calls = 0
  const registry = client(async (url, init) => {
    calls++
    assert.ok(url.endsWith('/hosted/dify/inspect')); assert.equal(init.body, 'source')
    assert.equal(init.headers['Content-Type'], 'application/yaml')
    assert.equal(init.headers['X-Nexus-Zone-ID'], 'zone-a')
    return Response.json(value)
  })
  assert.deepEqual(await registry.hostedInspectDify('org-a', 'source'), plan)
  value = { ...plan, source_digest: hash('different') }
  await assert.rejects(registry.hostedInspectDify('org-a', 'source'), { code: 'HOSTED_RESPONSE_INVALID' })
  await assert.rejects(registry.hostedInspectDify('org-a', 'x'.repeat(256001)), { code: 'DIFY_SOURCE_SIZE' })
  assert.equal(calls, 2)
})
void test('DSL diagnostics expose a bounded field path without source content', async () => {
  const registry = client(async () => Response.json({ detail: { code: 'DIFY_UNSUPPORTED', path: 'nodes[1].data.type', secret: 'never-forward' } }, { status: 400 }))
  await assert.rejects(registry.hostedInspectDify('org-a', 'source'), { code: 'DIFY_UNSUPPORTED', fieldPath: 'nodes[1].data.type' })
  const service = { hostedInspect: () => registry.hostedInspectDify('org-a', 'source') } as unknown as AgentInventoryService
  const response = await dispatchAgentInventory(service, {} as AuthContext, 'POST', new URL('http://localhost/api/v1/agent-inventory/hosted/dify/inspect'), {})
  assert.deepEqual(response.body, { success: false, error: { code: 'DIFY_UNSUPPORTED', message: 'DSL_FIELD:nodes[1].data.type' } })
})
void test('artifact list rejects foreign assets and invalid pagination', async () => {
  let result: unknown = { kind: 'HostedArtifactPage', items: [record()], next_cursor: null }
  const registry = client(async () => Response.json(result))
  assert.equal((await registry.hostedList('org-a', 'asset-a')).items.length, 1)
  result = { kind: 'HostedArtifactPage', items: [record()], next_cursor: 'unrelated' }
  await assert.rejects(registry.hostedList('org-a', 'asset-a'), { code: 'HOSTED_RESPONSE_INVALID' })
  result = { kind: 'HostedArtifactPage', items: [{ ...record(), asset_id: 'asset-b' }], next_cursor: null }
  await assert.rejects(registry.hostedList('org-a', 'asset-a'), { code: 'HOSTED_RESPONSE_INVALID' })
})
void test('management gateway denies member writes and foreign owner reads before artifact access', async () => {
  let artifactCalls = 0
  const registry = { scope() {}, async inventoryGet() { return { metadata: { owner_user_id: 'owner' } } }, async hostedList() { artifactCalls++; return {} } }
  const service = new AgentInventoryService({ registry: registry as never, catalog: {} as never,
    authorize: async () => ({ canManage: false }), member: async () => null, members: async () => [], labels: async () => ({ users: new Map(), departments: new Map() }) })
  const actor = { userId: 'other', orgId: 'org-a' } as AuthContext
  for (const suffix of ['hosted/artifacts', 'hosted/dify/inspect']) {
    const result = await dispatchAgentInventory(service, actor, 'POST', new URL(`http://localhost/api/v1/agent-inventory/${suffix}`), {})
    assert.equal(result.status, 403)
  }
  await assert.rejects(service.hostedList(actor, 'asset-a'), { code: 'AGENT_ASSET_NOT_FOUND' })
  assert.equal(artifactCalls, 0)
})

void test('hosted publication stores exact evaluated bytes, reads back and refuses altered or foreign input before writes', async () => {
  const artifact = record(), content = artifact.spec_payload_base64
  const ref = { ...fixture.version.manifest.spec_ref, zone_id: 'zone-a', path: '/agent-snapshots/hosted/asset-a/v1.json', digest: artifact.spec_digest }
  const files = new Map<string, string>(); let writes = 0, calls = 0, corruptRead = false
  const registry = client(async (target, init) => {
    calls++
    const url = new URL(target), body = init.body ? JSON.parse(init.body) : undefined
    const path = String(body?.path ?? url.searchParams.get('path'))
    if (url.pathname.endsWith('/mkdir')) return Response.json({ created: true })
    if (url.pathname.endsWith('/write')) {
      assert.equal(body.if_none_match, true); assert.equal(body.encoding, 'base64')
      assert.equal(body.content, content); assert.equal(files.has(path), false)
      writes++; files.set(path, body.content)
      return Response.json({ revision: 'revision-1' })
    }
    assert.ok(url.pathname.endsWith('/read'))
    return files.has(path) ? Response.json({ content: corruptRead ? Buffer.from('{}').toString('base64') : files.get(path), encoding: 'base64' })
      : Response.json({ detail: 'missing' }, { status: 404 })
  })
  await registry.putHostedSnapshot('org-a', ref, artifact)
  assert.equal(writes, 1)
  assert.ok(Buffer.from(files.get(ref.path)!, 'base64').toString().includes('"temperature":0.0,'))
  await registry.putHostedSnapshot('org-a', ref, artifact)
  assert.equal(writes, 1, 'immutable replay does not write again')
  const before = calls
  for (const changed of [{ ...artifact, zone: 'zone-b' }, { ...artifact, spec_digest: hash('different') },
    { ...artifact, image: { ...artifact.image, model_name: 'changed' } }]) {
    await assert.rejects(registry.putHostedSnapshot('org-a', ref, changed), { code: 'HOSTED_RESPONSE_INVALID' })
  }
  await assert.rejects(registry.putHostedSnapshot('org-a', { ...ref, digest: hash('different') }, artifact), { code: 'REGISTRY_RESOURCE_DIGEST_MISMATCH' })
  await assert.rejects(registry.putHostedSnapshot('org-a', { ...ref, zone_id: 'zone-b' }, artifact), { code: 'REGISTRY_REFERENCE_MISMATCH' })
  assert.equal(calls, before)
  corruptRead = true
  await assert.rejects(registry.putHostedSnapshot('org-a', ref, artifact), { code: 'REGISTRY_RESOURCE_DIGEST_MISMATCH' })
  assert.equal(writes, 1, 'corrupted immutable content is never overwritten')
})
