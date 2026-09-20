// Runs under Node (the store uses node:sqlite, which Bun lacks): `tsx --test`.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DirectConnectStore } from '../db.js'
import { createEnterpriseApi } from '../api/enterprise.js'
import { getSystemSettings, updateSystemSettings } from '../systemSettings.js'

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

  it('uses organization-scoped client policy before deployment defaults', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'moss-enterprise-policy-'))
    const orgPolicies = new Map<string, Record<string, unknown>>()
    const cronEnabled = new Map<string, boolean>()
    try {
      const api = createEnterpriseApi(new DirectConnectStore(':memory:'), runtimeDir, {
        getClientCronEnabled: orgId => cronEnabled.get(orgId) ?? true,
        setClientCronEnabled: (orgId, enabled) => { cronEnabled.set(orgId, enabled) },
        getClientPolicy: orgId => orgId ? orgPolicies.get(orgId) ?? {} : {},
        putClientPolicy: (orgId, patch) => {
          orgPolicies.set(orgId, { ...(orgPolicies.get(orgId) ?? {}), ...patch })
        },
      })

      await api.updateConfig('org-a', {
        client_cron_enabled: false,
        client_show_tool_calls: false,
        workspace_upload_limit_bytes: 4096,
      }, 'admin-a')

      const orgA = await api.getConfig('org-a')
      const orgB = await api.getConfig('org-b')

      assert.ok(orgA.data)
      assert.ok(orgB.data)
      assert.equal(orgA.data.client_cron_enabled, false)
      assert.equal(orgA.data.client_show_tool_calls, false)
      assert.equal(orgA.data.workspace_upload_limit_bytes, 4096)
      assert.equal(orgB.data.client_cron_enabled, true)
      assert.equal(orgB.data.client_show_tool_calls, true)
    } finally {
      await rm(runtimeDir, { recursive: true, force: true })
    }
  })

  it('keeps no-hook cron read-after-write on the legacy enterprise store', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'moss-enterprise-no-hook-'))
    const original = getSystemSettings()
    try {
      await updateSystemSettings({ clientCronEnabled: true })
      const store = new DirectConnectStore(':memory:')
      await store.updateEnterprise('org-a', { client_cron_enabled: false } as never)
      const api = createEnterpriseApi(store, runtimeDir)

      assert.equal((await api.getConfig('org-a')).data?.client_cron_enabled, false)
      await api.updateConfig('org-a', { client_cron_enabled: true })
      assert.equal((await api.getConfig('org-a')).data?.client_cron_enabled, true)
      await api.updateConfig({ client_cron_enabled: false }, 'org-a')
      assert.equal((await api.getConfig('org-a')).data?.client_cron_enabled, false)
    } finally {
      await updateSystemSettings({ clientCronEnabled: original.clientCronEnabled })
      await rm(runtimeDir, { recursive: true, force: true })
    }
  })

  it('rejects invalid workspace upload limits instead of widening to defaults', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'moss-enterprise-upload-limit-'))
    const orgPolicies = new Map<string, Record<string, unknown>>()
    try {
      const api = createEnterpriseApi(new DirectConnectStore(':memory:'), runtimeDir, {
        getClientPolicy: orgId => orgId ? orgPolicies.get(orgId) ?? {} : {},
        putClientPolicy: (orgId, patch) => {
          orgPolicies.set(orgId, { ...(orgPolicies.get(orgId) ?? {}), ...patch })
        },
      })
      orgPolicies.set('org-a', { workspaceUploadLimitBytes: 4 * 1024 * 1024 })

      for (const invalid of [0, -1, '4096', Number.NaN, 1024 * 1024 * 1024 + 1]) {
        const response = await api.updateConfig('org-a', { workspace_upload_limit_bytes: invalid }, 'admin-a')
        assert.equal(response.success, false)
        assert.equal(orgPolicies.get('org-a')?.workspaceUploadLimitBytes, 4 * 1024 * 1024)
      }
    } finally {
      await rm(runtimeDir, { recursive: true, force: true })
    }
  })

  it('validates all client policy fields before writing any organization override', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'moss-enterprise-atomic-policy-'))
    const orgPolicies = new Map<string, Record<string, unknown>>()
    const cronEnabled = new Map<string, boolean>()
    let cronWrites = 0
    try {
      const api = createEnterpriseApi(new DirectConnectStore(':memory:'), runtimeDir, {
        getClientCronEnabled: orgId => cronEnabled.get(orgId) ?? true,
        setClientCronEnabled: (orgId, enabled) => {
          cronWrites += 1
          cronEnabled.set(orgId, enabled)
        },
        getClientPolicy: orgId => orgId ? orgPolicies.get(orgId) ?? {} : {},
        putClientPolicy: (orgId, patch) => {
          orgPolicies.set(orgId, { ...(orgPolicies.get(orgId) ?? {}), ...patch })
        },
      })

      const response = await api.updateConfig('org-a', {
        client_cron_enabled: false,
        workspace_upload_limit_bytes: 0,
      }, 'admin-a')

      assert.equal(response.success, false)
      assert.equal(cronWrites, 0)
      assert.equal(cronEnabled.has('org-a'), false)
      assert.deepEqual(orgPolicies.get('org-a'), undefined)
    } finally {
      await rm(runtimeDir, { recursive: true, force: true })
    }
  })

  it('rejects string booleans for client policy fields', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'moss-enterprise-bool-policy-'))
    try {
      const api = createEnterpriseApi(new DirectConnectStore(':memory:'), runtimeDir)

      for (const field of ['client_cron_enabled', 'client_show_tool_calls'] as const) {
        const response = await api.updateConfig('org-a', { [field]: 'false' }, 'admin-a')
        assert.equal(response.success, false)
        assert.match(response.message ?? '', new RegExp(field))
      }
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
