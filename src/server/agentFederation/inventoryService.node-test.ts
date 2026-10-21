import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthService } from '../auth/service.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import { AuthCenterDb, hashPassword } from '../authCenter/db.js'
import { createCatalogTestRepository, createIdentityTestRepository } from '../testing/compatibilityRepositories.js'
import { dispatchAgentInventory } from './inventoryRoutes.js'
import { ProductRegistryClient, type RegistryRequest, type InventoryCommand } from './registryClient.js'
import { stableJson } from './provider/protocol.js'
import fixture from '../../../contracts/agent-registry/v1alpha1/signed-version.fixture.json' with { type: 'json' }
import {
  AGENT_REGISTRY_API,
  type AssetRecord,
  type AssetMetadata,
} from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'

const metadata = (owner = 'alice'): AssetMetadata => ({
  name: 'Support',
  source_platform: 'dify',
  source_instance: 'test-instance',
  source_agent_id: 'app-1',
  owner_user_id: owner,
  department_id: null,
  purpose: 'Synthetic test registration',
  domain: 'office',
  hosting: 'external_hosted',
  requested_level: 'L1',
  data_connections: [],
  tool_refs: [],
  model_paths: [],
  risk_note: '',
})
function asset(id = 'asset-a', owner = 'alice', zone = 'zone-a'): AssetRecord {
  const value = metadata(owner)
  return {
    api_version: AGENT_REGISTRY_API,
    kind: 'AgentAsset',
    id,
    owner_zone: zone,
    metadata: value,
    metadata_digest: `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`,
    revision: 1,
    status: 'draft',
    actual_level: 'L0',
    recommended_level: 'L1',
    recommendation_reasons: ['office_gateway_control'],
    risk: 'low',
    external_domain: false,
    observations: [],
    created_at: 1000,
    updated_at: 1000,
    evidence_status: 'none',
  }
}
const command = (owner = 'alice') => ({
  kind: 'SaveAsset',
  request_id: randomUUID(),
  asset_id: 'asset-a',
  expected_revision: 0,
  metadata: metadata(owner),
})

void test('inventory gateway enforces real AuthCenter identity, owner, department and organization boundaries', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-auth-'))
  const previousConfig = process.env.MOSS_AGENT_REGISTRY_CONFIG_FILE
  const tokenFile = join(directory, 'token'),
    configFile = join(directory, 'registry.json')
  await writeFile(tokenFile, 'synthetic-inventory-management-token', { mode: 0o600 })
  await writeFile(
    configFile,
    JSON.stringify({
      endpoint: 'http://127.0.0.1:12345',
      tokenFile,
      publicKeys: [fixture.public_key_pem],
      organizations: {
        'org-a': { trustDomain: 'a.example', zoneId: 'zone-a' },
        'org-b': { trustDomain: 'b.example', zoneId: 'zone-b' },
      },
    }),
  )
  process.env.MOSS_AGENT_REGISTRY_CONFIG_FILE = configFile
  const db = new DatabaseSync(':memory:'),
    authDb = new AuthCenterDb(db)
  createIdentityTestRepository(db, {}, authDb.driver)
  createCatalogTestRepository(db, authDb.driver)
  await authDb.setConfig('issuer', 'inventory-auth-test')
  await authDb.setConfig('jwt_secret', 'synthetic-inventory-auth-secret')
  await authDb.createOrganization('org-a', 'Organization A', 1)
  await authDb.createOrganization('org-b', 'Organization B', 2)
  const password = 'StrongPass123!'
  const base = {
    displayName: null,
    departmentId: null,
    status: 'active' as const,
    localAuth: true,
    tokenLimit: null,
    createdAt: 1,
    passwordHash: hashPassword(password),
    passwordUpdatedAt: null,
    lastLoginAt: null,
    extUserId: null,
    phone: null,
  }
  for (const [id, orgId, role] of [
    ['root', 'org-a', 'super_admin'],
    ['admin-a', 'org-a', 'admin'],
    ['alice', 'org-a', 'user'],
    ['bob', 'org-a', 'user'],
    ['charlie', 'org-b', 'user'],
  ] as const) {
    await authDb.createUser({ ...base, id, orgId, role, name: id, email: `${id}@example.test` })
  }
  const auth = new AuthService(authDb, 3600)
  t.after(async () => {
    auth.destroy()
    db.close()
    if (previousConfig === undefined) delete process.env.MOSS_AGENT_REGISTRY_CONFIG_FILE
    else process.env.MOSS_AGENT_REGISTRY_CONFIG_FILE = previousConfig
    await rm(directory, { recursive: true, force: true })
  })
  await auth.initializeCompatibilityRecords()
  const login = async (username: string) =>
    (await auth.verifyAccessToken((await auth.issueTokenFromPassword({ username, password })).access_token))!
  const alice = await login('alice'),
    bob = await login('bob'),
    admin = await login('admin-a'),
    root = await login('root')
  const switched = (await auth.verifyAccessToken((await auth.switchOrg(root, 'org-b')).access_token))!
  const outbound: { zone: string; path: string; body: InventoryCommand | null }[] = []
  const unclaimed = asset('asset-unclaimed')
  unclaimed.metadata.owner_user_id = null
  unclaimed.metadata_digest = `sha256:${createHash('sha256').update(stableJson(unclaimed.metadata)).digest('hex')}`
  unclaimed.status = 'discovered'
  const rows = [asset(), asset('asset-b', 'bob'), asset('asset-c', 'charlie', 'zone-b'), unclaimed]
  t.mock.method(globalThis, 'fetch', (url: string, init: Parameters<RegistryRequest>[1]) => {
    const target = new URL(url),
      zone = init.headers['X-Nexus-Zone-ID']
    assert.equal(init.headers.Authorization, 'Bearer synthetic-inventory-management-token')
    assert.equal(init.redirect, 'error')
    assert.equal(init.cache, 'no-store')
    const body = init.body ? (JSON.parse(init.body) as InventoryCommand) : null
    outbound.push({ zone, path: target.pathname, body })
    if (body) {
      const result = asset(
        body.asset_id,
        body.kind === 'SaveAsset'
          ? (body.metadata.owner_user_id ?? undefined)
          : body.kind === 'ClaimAsset'
            ? body.owner_user_id
            : 'alice',
        zone,
      )
      result.revision = body.expected_revision + 1
      return Promise.resolve(Response.json(result))
    }
    if (target.pathname.endsWith('/history'))
      return Promise.resolve(
        Response.json({
          api_version: AGENT_REGISTRY_API,
          kind: 'AgentAssetHistory',
          asset_id: 'asset-a',
          events: [],
          next_revision: null,
        }),
      )
    if (target.pathname.endsWith('/assets'))
      return Promise.resolve(
        Response.json({
          api_version: AGENT_REGISTRY_API,
          kind: 'AgentAssetPage',
          items: rows.filter(
            (row) =>
              row.owner_zone === zone &&
              (!target.searchParams.has('owner') ||
                (row.metadata.owner_user_id ?? '') === target.searchParams.get('owner')),
          ),
          next_cursor: null,
        }),
      )
    const row = rows.find((row) => row.owner_zone === zone && target.pathname.endsWith('/' + row.id))
    return Promise.resolve(
      row ? Response.json(row) : Response.json({ detail: { code: 'AGENT_ASSET_NOT_FOUND' } }, { status: 404 }),
    )
  })
  const service = auth.createAgentInventoryService()
  const call = (actor: typeof alice, path: string, method = 'GET', body: unknown = {}) =>
    dispatchAgentInventory(service, actor, method, new URL('http://moss.test/api/v1/agent-inventory' + path), body)
  assert.equal((await service.access(alice)).can_manage, false)
  assert.equal((await service.access(admin)).can_manage, true)
  assert.equal((await service.access(switched)).can_own, false)
  assert.deepEqual(
    (await service.list(alice)).items.map((row) => row.id),
    ['asset-a'],
  )
  assert.equal((await service.list(admin)).items.length, 3)
  assert.deepEqual(
    (await service.list(switched)).items.map((row) => row.id),
    ['asset-c'],
  )
  assert.equal((await call(bob, '/assets/asset-a')).status, 404)
  assert.equal((await call(bob, '/assets/asset-a/history')).status, 404)
  assert.equal((await call(alice, '/assets/asset-c')).status, 404)
  assert.equal((await call(alice, '/assets/asset-unclaimed')).status, 404)
  assert.deepEqual((await service.discovered(alice)).items, [
    { id: 'asset-unclaimed', revision: 1, name: 'Support', platform: 'dify', external_domain: false },
  ])
  assert.equal((await service.discovered(switched)).items.length, 0)
  const claim = { kind: 'ClaimAsset', asset_id: 'asset-unclaimed', expected_revision: 1, request_id: randomUUID() }
  assert.equal((await call(bob, '/commands', 'POST', claim)).status, 200)
  assert.equal(outbound.at(-1)?.body?.kind, 'ClaimAsset')
  assert.equal((outbound.at(-1)?.body as { owner_user_id: string }).owner_user_id, 'bob')
  assert.equal((await call(bob, '/commands', 'POST', { ...claim, owner_user_id: 'alice' })).status, 400)
  assert.equal((await call(bob, '/commands', 'POST', { ...claim, asset_id: 'asset-a' })).status, 409)
  assert.equal((await call(alice, '/sources')).status, 403)
  assert.equal((await call(alice, '/discover', 'POST', { source_id: 'catalog' })).status, 403)
  const beforeReads = outbound.length
  await service.get(alice, 'asset-a')
  await service.history(alice, 'asset-a')
  assert.ok(outbound.slice(beforeReads).every((item) => item.body === null))
  assert.equal((await call(alice, '/commands', 'POST', command())).status, 200)
  assert.equal(outbound.at(-1)?.body?.initiated_by, 'alice')
  assert.equal((await call(alice, '/commands', 'POST', command('bob'))).status, 403)
  assert.equal(
    (await call(alice, '/commands', 'POST', { ...command(), expected_revision: 1, asset_id: 'asset-b' })).status,
    404,
  )
  for (const patch of [
    { initiated_by: 'root' },
    { actual_level: 'L3' },
    { is_admin: true },
    { kind: 'RecordAcceptance' },
    { kind: 'ObserveAsset' },
  ]) {
    assert.equal((await call(alice, '/commands', 'POST', { ...command(), ...patch })).status, 400)
  }
  assert.equal(
    (
      await call(alice, '/commands', 'POST', {
        kind: 'ReviewAsset',
        asset_id: 'asset-a',
        request_id: randomUUID(),
        expected_revision: 1,
        decision: 'approve',
        reason: 'Forged reviewer',
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await call(admin, '/commands', 'POST', {
        ...command(),
        metadata: { ...metadata(), department_id: 'foreign-department' },
      })
    ).status,
    400,
  )
  assert.equal((await call(admin, '/commands', 'POST', command('charlie'))).status, 400)
  assert.equal((await call(switched, '/commands', 'POST', command('charlie'))).status, 200)
  assert.equal(outbound.at(-1)?.zone, 'zone-b')
  assert.equal((await call(alice, '/members')).status, 403)
  assert.deepEqual(
    (await service.members(switched)).items.map((row) => row.id),
    ['charlie'],
  )
  // Native conversion reads share live inventory authorization; only a manager can
  // register a target and both source and target must still have active owners.
  const target = asset('native-a')
  target.metadata = { ...target.metadata, source_platform: 'native', hosting: 'internal_hosted', requested_level: 'L3' }
  target.metadata_digest = `sha256:${createHash('sha256').update(stableJson(target.metadata)).digest('hex')}`
  rows.push(target)
  let nativeReads = 0, nativeWrites = 0
  t.mock.method(ProductRegistryClient.prototype, 'nativeList', async (org: string, id: string) => {
    assert.equal(org, 'org-a'); assert.equal(id, target.id); nativeReads++
    return { items: [], next_cursor: null }
  })
  t.mock.method(ProductRegistryClient.prototype, 'hostedGet', async () => ({ asset_id: 'asset-b' }))
  t.mock.method(ProductRegistryClient.prototype, 'nativeRegister', async (org: string, input: { initiated_by: string }) => {
    assert.equal(org, 'org-a'); assert.equal(input.initiated_by, 'admin-a'); nativeWrites++
    return { id: 'conversion-a' }
  })
  const nativeInput = { request_id: randomUUID(), asset_id: target.id, metadata_digest: target.metadata_digest, source_artifact_id: 'source-a', image: {} }
  assert.equal((await call(alice, '/assets/native-a/native-conversions')).status, 200)
  assert.equal((await call(bob, '/assets/native-a/native-conversions')).status, 404)
  assert.equal((await call(switched, '/assets/native-a/native-conversions')).status, 404)
  assert.equal(nativeReads, 1); assert.equal(nativeWrites, 0)
  assert.equal((await call(alice, '/native/conversions', 'POST', nativeInput)).status, 403)
  assert.equal((await call(admin, '/native/conversions', 'POST', { ...nativeInput, initiated_by: 'root' })).status, 400)
  assert.equal((await call(admin, '/native/conversions', 'POST', { ...nativeInput, metadata_digest: 'stale' })).status, 409)
  await authDb.updateUser('bob', { status: 'disabled' })
  assert.equal((await call(admin, '/native/conversions', 'POST', nativeInput)).status, 409)
  await authDb.updateUser('bob', { status: 'active' })
  assert.equal((await call(admin, '/native/conversions', 'POST', nativeInput)).status, 200)
  assert.equal(nativeWrites, 1)
  const previousOrigins = process.env.MOSS_AGENT_DISCOVERY_ORIGINS
  const secrets = new Map<string, string>()
  process.env.MOSS_AGENT_DISCOVERY_ORIGINS = JSON.stringify({ 'org-a': ['http://127.0.0.1:19999'] })
  try {
    const withSources = auth.createAgentInventoryService({
      putSecret: async (namespace, key, value) => {
        secrets.set(namespace + '/' + key, value)
      },
      getSecret: async (namespace, key) => ({
        value: secrets.get(namespace + '/' + key) ?? null,
        status: 'enabled',
        version: 1,
      }),
      deleteSecret: async (namespace, key) => {
        secrets.delete(namespace + '/' + key)
      },
    })
    const source = await withSources.createSource(admin, {
      name: 'Local discovery',
      kind: 'dify',
      origin: 'http://127.0.0.1:19999',
      scope: 'workspace-a',
      external_domain: false,
      api_key: 'synthetic-console-token',
      csrf_token: 'synthetic-csrf',
    })
    assert.equal(secrets.size, 1)
    assert.ok([...secrets.keys()][0].startsWith('org:org-a:agent-discovery:'))
    const sourceList = await withSources.listSources(admin)
    assert.equal(sourceList.items.length, 1)
    assert.ok(!JSON.stringify(sourceList).includes('synthetic-console-token'))
    await assert.rejects(withSources.listSources(alice), /ADMIN_REQUIRED/)
    await assert.rejects(withSources.disableSource(switched, source.id), /DISCOVERY_SOURCE_NOT_FOUND/)
    assert.equal((await withSources.listSources(switched)).items.length, 0)
    await withSources.disableSource(admin, source.id)
    assert.equal((await withSources.listSources(admin)).items[0].enabled, false)
    assert.equal((await withSources.discover(admin, { source_id: source.id })).error, 'DISCOVERY_SOURCE_DISABLED')
    const audits = await new IdentityRepository(authDb.driver).listOperationAudits({ orgId: 'org-a', limit: 100, offset: 0 })
    assert.equal(audits.items.filter(row => row.resourceId === source.id).length, 2)
    assert.ok(!JSON.stringify(audits).includes('synthetic-console-token'))
  } finally {
    if (previousOrigins === undefined) delete process.env.MOSS_AGENT_DISCOVERY_ORIGINS
    else process.env.MOSS_AGENT_DISCOVERY_ORIGINS = previousOrigins
  }
  // A role or status revoked after token issuance is checked again at the gateway.
  await authDb.updateUser('admin-a', { role: 'user' })
  assert.equal((await service.access(admin)).can_manage, false)
  assert.equal((await call(admin, '/native/conversions', 'POST', nativeInput)).status, 403)
  assert.equal(nativeWrites, 1)
  await authDb.updateUser('alice', { status: 'disabled' })
  assert.equal((await call(alice, '/assets')).status, 401)
  const beforeInactiveApproval = outbound.filter((item) => item.body).length
  assert.equal(
    (
      await call(root, '/commands', 'POST', {
        kind: 'ReviewAsset',
        asset_id: 'asset-a',
        request_id: randomUUID(),
        expected_revision: 1,
        decision: 'approve',
        reason: 'Owner has left the organization',
      })
    ).status,
    400,
  )
  assert.equal(outbound.filter((item) => item.body).length, beforeInactiveApproval)
})

void test('inventory client rejects wrong owner, zone, digest, cursor and read response types', async () => {
  const options = {
    endpoint: 'http://127.0.0.1:12345',
    token: 'synthetic-token',
    publicKeys: [fixture.public_key_pem],
    organizations: { org: { trustDomain: 'a.example', zoneId: 'zone-a' } },
  }
  const invalid = [
    { ...asset(), owner_zone: 'zone-b' },
    { ...asset(), metadata_digest: 'sha256:' + 'f'.repeat(64) },
    { ...asset(), principal: { trust_domain: 'b.example', agent_name: 'external-test' } },
    { ...asset(), actual_level: 'L4' },
  ]
  for (const value of invalid) {
    const client = new ProductRegistryClient({ ...options, request: async () => Response.json(value) })
    await assert.rejects(() => client.inventoryGet('org', 'asset-a'), /REGISTRY_RESPONSE_INVALID/)
  }
  for (const [items, cursor] of [
    [[asset('asset-b', 'bob')], null],
    [[asset(), asset()], null],
    [[asset()], 'different'],
  ] as const) {
    const client = new ProductRegistryClient({
      ...options,
      request: async () =>
        Response.json({ api_version: AGENT_REGISTRY_API, kind: 'AgentAssetPage', items, next_cursor: cursor }),
    })
    await assert.rejects(() => client.inventoryList('org', '', 'alice'), /REGISTRY_RESPONSE_INVALID/)
  }
})

void test('admitted asset lookup is read-only, validates the exact principal and denies L0 or unapproved authority results', async () => {
  const ref = { trust_domain: 'a.example', agent_name: 'external-test' }, digest = 'sha256:' + 'a'.repeat(64)
  const admitted = { ...asset(), status: 'approved', actual_level: 'L1', principal: ref }
  const requests: { path: string; method?: string }[] = []
  let value = admitted
  const client = new ProductRegistryClient({ endpoint: 'http://127.0.0.1:12345', token: 'synthetic-token', publicKeys: [fixture.public_key_pem],
    organizations: { org: { trustDomain: 'a.example', zoneId: 'zone-a' } }, request: async (url, init) => { requests.push({ path: String(url), method: init?.method }); return Response.json(value) } })
  assert.equal((await client.admittedAsset('org', ref, digest)).id, admitted.id)
  assert(requests[0].path.includes('/admitted-asset?spec_digest=sha256%3A')); assert(!requests[0].method || requests[0].method === 'GET')
  for (const patch of [{ actual_level: 'L0' }, { status: 'suspended' }, { principal: { ...ref, agent_name: 'other' } }]) {
    value = { ...admitted, ...patch }; await assert.rejects(client.admittedAsset('org', ref, digest), /AGENT_ASSET_NOT_ADMITTED/)
  }
  const before = requests.length
  await assert.rejects(client.admittedAsset('org', { ...ref, trust_domain: 'other.example' }, digest), /REGISTRY_ORGANIZATION_MISMATCH/)
  assert.equal(requests.length, before)
})
