import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile, rm, readdir, readlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createCatalogTestRepository } from '../testing/compatibilityRepositories.js'
import { SqliteDriver } from '../db/driver.js'
import { withOrganizationResources, listOrganizationResources, saveOrganizationInstallation, updateOrganizationResource, removeOrganizationResource, snapshotOrganizationResources, registerOrganizationCustom, requireOrganizationResource, pinSessionResourceSnapshot, type OrganizationResourceScope } from './organizationResources.js'
import { getAgentSyncProgress, updateAgentSyncProgress } from '../syncProgress.js'
import { syncWorkspaceSkills, resolveWorkspaceSkillsDir } from '../../utils/scodeBridge.js'
import { createSkillSymlinks, getAssistantRuntimeConfig } from '../backends/backendUtils.js'
import { migrateOrganizationResources } from './organizationResourceMigration.js'

void test('organization install state, overlays, artifacts and async jobs remain independent', async () => {
  const db = new DatabaseSync(':memory:')
  createCatalogTestRepository(db)
  const driver = new SqliteDriver(db)
  const a: OrganizationResourceScope = { orgId: 'a', userId: 'a-user', driver }
  const b: OrganizationResourceScope = { orgId: 'b', userId: 'b-user', driver }
  const meta = { id: 'same-hub-id', name: 'same-name', source_type: 'hub', enabled: true, installed_version: '' }
  try {
    await withOrganizationResources(a, () => saveOrganizationInstallation('skill', '/shared/v1', meta))
    assert.deepEqual(await withOrganizationResources(b, () => listOrganizationResources('skill')), [])
    await withOrganizationResources(b, () => saveOrganizationInstallation('skill', '/shared/v1', meta))
    await withOrganizationResources(a, () => updateOrganizationResource('skill', meta.id, { enabled: false, description: 'A only' }))
    assert.equal((await withOrganizationResources(b, () => requireOrganizationResource('skill', meta.id))).meta.enabled, true)
    await withOrganizationResources(a, () => saveOrganizationInstallation('skill', '/shared/v2', { ...meta, installed_version: '2' }))
    assert.equal((await withOrganizationResources(b, () => requireOrganizationResource('skill', meta.id))).path, '/shared/v1')
    await withOrganizationResources(a, () => removeOrganizationResource('skill', meta.id))
    assert.equal((await withOrganizationResources(b, () => listOrganizationResources('skill')))?.length, 1)
    await Promise.all([a, b].map(scope => withOrganizationResources(scope, async () => {
      await new Promise(resolve => setTimeout(resolve, scope.orgId === 'a' ? 12 : 2))
      updateAgentSyncProgress({ installed: scope.orgId === 'a' ? 10 : 20 })
      assert.equal(getAgentSyncProgress().installed, scope.orgId === 'a' ? 10 : 20)
    })))
    const snapshot = await withOrganizationResources(b, snapshotOrganizationResources)
    assert.throws(() => withOrganizationResources({ ...a, snapshot }, () => null), /organization/)
    await withOrganizationResources({ orgId: 'b', userId: 'b-user', snapshot }, async () => {
      assert.equal((await requireOrganizationResource('skill', meta.id)).path, '/shared/v1')
      await assert.rejects(updateOrganizationResource('skill', meta.id, { enabled: false }), /read only/)
    })
  } finally { db.close() }
})

void test('private and custom resources require org ownership before admin ACL bypass', async () => {
  const db = new DatabaseSync(':memory:')
  const catalog = createCatalogTestRepository(db)
  const driver = new SqliteDriver(db)
  const root = await mkdtemp(join(tmpdir(), 'org-resources-'))
  const path = join(root, 'custom')
  await mkdir(path)
  await writeFile(join(path, '_moss_meta.json'), '{}')
  const a = { orgId: 'a', userId: 'a-user', driver }
  const b = { orgId: 'b', userId: 'super-admin', driver, visibility: { isAdmin: true, userId: 'super-admin', departmentId: null, visibleDepartmentIds: null } }
  try {
    await withOrganizationResources(a, () => registerOrganizationCustom('agent', path, { id: 'custom-a', name: 'custom', visible_to: { user_ids: ['a-user'] } }))
    await catalog.createAgent({ id: 'tenant-a', orgId: 'a', name: 'private', authorId: 'a-user', status: 'approved', filePath: path, availability: 'all' })
    await catalog.assignToOrganization('agent', 'tenant-a', 'b')
    assert.deepEqual((await catalog.listAgents({ orgId: 'b' })).items, [])
    assert.equal(await catalog.isAvailableToOrganization('agent', 'tenant-a', 'b'), false)
    assert.deepEqual(await withOrganizationResources(b, () => listOrganizationResources('agent')), [])
    await withOrganizationResources(b, async () => {
      await assert.rejects(requireOrganizationResource('agent', 'custom-a'), /not found/)
      await assert.rejects(updateOrganizationResource('agent', 'tenant-a', { rules: 'bad' }), /not found/)
    })
    await withOrganizationResources(a, () => updateOrganizationResource('agent', 'custom-a', { rules: 'private rules', display_name: 'updated', visible_to: null }))
    const resource = await withOrganizationResources(a, () => requireOrganizationResource('agent', 'custom-a'))
    assert.equal(resource.meta.rules, 'private rules')
    assert.equal(resource.meta.display_name, 'updated')
    assert.deepEqual(resource.meta.visible_to, { user_ids: ['a-user'] })
  } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})

void test('runner snapshot resolves only authorized resources and clears skills on workspace reuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'org-runtime-'))
  const skillPath = join(root, 'artifact')
  await mkdir(skillPath)
  await writeFile(join(skillPath, 'SKILL.md'), 'Authorized skill')
  const a = { orgId: 'a', resources: [
    { kind: 'skill' as const, id: 's', name: 'skill', path: skillPath, sourceType: 'hub', meta: { enabled: true } },
    { kind: 'agent' as const, id: 'a', name: 'agent', path: skillPath, sourceType: 'hub', meta: { enabled: true, enabledSkills: ['s'], rules: 'Original' } },
  ] }
  const b = { orgId: 'b', resources: [] }
  const workspace = join(root, 'workspace')
  try {
    await withOrganizationResources({ orgId: 'a', userId: 'a-user', snapshot: a }, async () => {
      assert.deepEqual((await getAssistantRuntimeConfig('a')).enabledSkills, ['skill'])
      const links = await syncWorkspaceSkills(workspace, ['s'])
      assert.equal(links.length, 1)
      assert.equal(await readlink(links[0]!.workspacePath), skillPath)
      await createSkillSymlinks(workspace, ['s'])
    })
    await withOrganizationResources({ orgId: 'b', userId: 'b-user', snapshot: b }, async () => {
      await assert.rejects(getAssistantRuntimeConfig('a'), /not found/)
      await assert.rejects(syncWorkspaceSkills(workspace, ['s']), /not available/)
      assert.deepEqual(await syncWorkspaceSkills(workspace), [])
      await createSkillSymlinks(workspace, [])
      assert.deepEqual(await readdir(resolveWorkspaceSkillsDir(workspace)), [])
      assert.deepEqual(await readdir(join(workspace, '.claude', 'commands')), [])
    })
    await pinSessionResourceSnapshot(join(root, 'session'), a, ['s'])
    const upgraded = structuredClone(a)
    upgraded.resources[1]!.meta.rules = 'New rules'
    const pinned = await pinSessionResourceSnapshot(join(root, 'session'), upgraded)
    assert.equal(pinned.snapshot.resources[1]!.meta.rules, 'Original')
    assert.deepEqual(pinned.enabledSkills, ['s'])
    assert.deepEqual((await pinSessionResourceSnapshot(join(root, 'session'), { orgId: 'a', resources: [] })).snapshot.resources, [])
    await assert.rejects(pinSessionResourceSnapshot(join(root, 'session'), b), /organization/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

void test('legacy migration requires explicit ownership, dry-runs, freezes bytes and is repeatable', async () => {
  const db = new DatabaseSync(':memory:')
  createCatalogTestRepository(db)
  db.exec("CREATE TABLE organizations (id TEXT PRIMARY KEY); CREATE TABLE users (id TEXT PRIMARY KEY, org_id TEXT); INSERT INTO organizations VALUES ('a'), ('b'); INSERT INTO users VALUES ('u', 'a')")
  const driver = new SqliteDriver(db)
  const root = await mkdtemp(join(tmpdir(), 'org-migration-'))
  const path = join(root, 'legacy')
  await mkdir(path)
  await writeFile(join(path, '_moss_meta.json'), JSON.stringify({ id: 's', name: 'skill', enabled: true }))
  await writeFile(join(path, 'SKILL.md'), 'Original skill')
  const mapping = { kind: 'skill' as const, sourceType: 'hub' as const, id: 's', orgId: 'a', userId: 'u', path, provider: 'fixture' }
  try {
    await assert.rejects(migrateOrganizationResources(driver, root, [{ ...mapping, orgId: '' }]), /requires/)
    await assert.rejects(migrateOrganizationResources(driver, root, [{ ...mapping, orgId: 'b' }]), /User does not belong/)
    const dry = await migrateOrganizationResources(driver, root, [mapping])
    assert.equal(dry.applied, false)
    assert.equal((await driver.all('SELECT * FROM org_resource_installations')).length, 0)
    assert.deepEqual(await readdir(root), ['legacy'])
    await migrateOrganizationResources(driver, root, [mapping], true)
    const repeated = await migrateOrganizationResources(driver, root, [mapping], true)
    assert.equal(repeated.unchanged, 1)
    await writeFile(join(path, 'SKILL.md'), 'Mutated legacy source')
    assert.equal(await readFile(join(repeated.entries[0]!.artifact, 'SKILL.md'), 'utf8'), 'Original skill')
    assert.equal((await driver.all('SELECT * FROM org_resource_installations')).length, 1)
    assert.equal((await driver.all('SELECT * FROM org_resource_installations WHERE org_id = ?', ['b'])).length, 0)
    const custom = { ...mapping, id: 'custom', sourceType: 'custom' as const }
    await migrateOrganizationResources(driver, root, [custom], true)
    assert.equal((await migrateOrganizationResources(driver, root, [custom], true)).unchanged, 1)
  } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})
