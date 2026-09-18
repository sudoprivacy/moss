// Runs under Node (the store uses node:sqlite, which Bun lacks): `tsx --test`.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DirectConnectStore } from '../db.js'
import { createEnterpriseApi } from '../api/enterprise.js'

describe('enterprise configuration organization isolation', () => {
  it('keeps organization writes isolated and retains the legacy default as a fallback', async () => {
    const store = new DirectConnectStore(':memory:')
    await store.updateEnterprise('org-a', { app_name: 'Organization A', top_name: 'A' })

    assert.equal((await store.getEnterprise('org-a')).app_name, 'Organization A')
    assert.equal((await store.getEnterprise('org-a')).top_name, 'A')
    assert.equal((await store.getEnterprise('org-b')).app_name, null)
    assert.equal((await store.getEnterprise('org-b')).top_name, null)
    assert.equal((await store.getEnterprise()).app_name, null)

    await store.updateEnterprise('org-b', { app_name: 'Organization B', top_name: 'B' })

    assert.equal((await store.getEnterprise('org-a')).app_name, 'Organization A')
    assert.equal((await store.getEnterprise('org-b')).app_name, 'Organization B')
    assert.equal((await store.getEnterprise()).app_name, null)
  })

  it('copies pre-migration defaults only when an organization first saves', async () => {
    const store = new DirectConnectStore(':memory:')
    store.db.prepare(`
      UPDATE enterprises SET app_name = ?, top_name = ? WHERE id = 'default'
    `).run('Legacy deployment name', 'Legacy')

    // Read-only tenants still inherit the public deployment default.
    assert.equal((await store.getEnterprise('org-a')).app_name, 'Legacy deployment name')

    await store.updateEnterprise('org-a', { top_name: 'Organization A' })

    assert.equal((await store.getEnterprise('org-a')).app_name, 'Legacy deployment name')
    assert.equal((await store.getEnterprise('org-a')).top_name, 'Organization A')
    assert.equal((await store.getEnterprise('org-b')).top_name, 'Legacy')
    assert.equal((await store.getEnterprise()).top_name, 'Legacy')
  })
})

describe('enterprise configuration API', () => {
  it('uses the server-supplied organization id for reads and writes', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'moss-enterprise-config-'))
    try {
      const api = createEnterpriseApi(new DirectConnectStore(':memory:'), runtimeDir)
      await api.updateConfig('org-a', { app_name: 'Organization A' })
      await api.updateConfig('org-b', { app_name: 'Organization B' })

      const orgA = await api.getConfig('org-a')
      const orgB = await api.getConfig('org-b')
      const publicDefault = await api.getConfig()

      assert.equal(orgA.success, true)
      assert.ok(orgA.data)
      assert.ok(orgB.data)
      assert.ok(publicDefault.data)
      assert.equal(orgA.data.app_name, 'Organization A')
      assert.equal(orgB.data.app_name, 'Organization B')
      assert.equal(publicDefault.data.app_name, null)
    } finally {
      await rm(runtimeDir, { recursive: true, force: true })
    }
  })

  it('reads each organization logo from its own storage directory', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'moss-enterprise-logo-'))
    try {
      const api = createEnterpriseApi(new DirectConnectStore(':memory:'), runtimeDir)
      for (const [orgId, filename, contents] of [
        ['org-a', 'logo-a.png', 'A'],
        ['org-b', 'logo-b.png', 'B'],
      ] as const) {
        const uploadDir = join(runtimeDir, 'uploads', 'enterprise', encodeURIComponent(orgId))
        await mkdir(uploadDir, { recursive: true })
        await writeFile(join(uploadDir, filename), contents)
        await api.updateConfig(orgId, { logo: filename })
      }

      const orgA = await api.getConfig('org-a')
      const orgB = await api.getConfig('org-b')

      assert.ok(orgA.data)
      assert.ok(orgB.data)
      assert.equal(orgA.data.logo, 'data:image/png;base64,QQ==')
      assert.equal(orgB.data.logo, 'data:image/png;base64,Qg==')
    } finally {
      await rm(runtimeDir, { recursive: true, force: true })
    }
  })
})
