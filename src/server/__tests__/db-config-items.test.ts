import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

describe('DirectConnectStore config_items bootstrap ordering', () => {
  it('creates config_items before running config item column migrations', async () => {
    const dbSource = await readFile(
      path.resolve(__dirname, '..', 'db.ts'),
      'utf8',
    )
    const firstCreate = dbSource.indexOf('CREATE TABLE IF NOT EXISTS config_items')
    const migration = dbSource.indexOf('Migration: config_items mint/auth columns')

    expect(firstCreate).toBeGreaterThan(-1)
    expect(migration).toBeGreaterThan(-1)
    expect(firstCreate).toBeLessThan(migration)
  })

  it('adds org_id before creating org-scoped indexes on legacy tables', async () => {
    const dbSource = await readFile(
      path.resolve(__dirname, '..', 'db.ts'),
      'utf8',
    )

    const tenantOrgColumnMigration = dbSource.indexOf("for (const table of ['tenant_skills', 'tenant_assistants'])")
    const tenantOrgIndex = dbSource.indexOf('idx_${table}_org')
    const configOrgColumnMigration = dbSource.indexOf("['org_id', 'org_id TEXT']")
    const configOrgIndex = dbSource.indexOf('idx_config_items_org')

    expect(dbSource).not.toContain('idx_tenant_skills_org')
    expect(dbSource).not.toContain('idx_tenant_assistants_org')
    expect(tenantOrgColumnMigration).toBeGreaterThan(-1)
    expect(tenantOrgIndex).toBeGreaterThan(tenantOrgColumnMigration)
    expect(configOrgColumnMigration).toBeGreaterThan(-1)
    expect(configOrgIndex).toBeGreaterThan(configOrgColumnMigration)
  })
})
