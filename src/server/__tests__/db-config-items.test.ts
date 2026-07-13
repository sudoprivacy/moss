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

  it('persists org_id when writing department authorization policies', async () => {
    // Regression: replaceConfigItemDepartments historically omitted org_id, but
    // the org-scoped readers (getDepartmentPolicies with an orgId) filter
    // WHERE org_id = ?, so NULL rows were invisible and dept credentials never
    // surfaced for their authorized department. The INSERT must include org_id.
    const dbSource = await readFile(
      path.resolve(__dirname, '..', 'db.ts'),
      'utf8',
    )
    const writer = dbSource.slice(
      dbSource.indexOf('replaceConfigItemDepartments('),
      dbSource.indexOf('// --- Secret Audit Log ---'),
    )
    expect(writer).toContain('replaceConfigItemDepartments(configItemId: number, departmentIds: string[], orgId')
    expect(writer).toContain('INSERT INTO department_secret_policies (department_id, config_item_id, org_id, created_at)')
  })

  it('backfills org_id on legacy department_secret_policies rows', async () => {
    const dbSource = await readFile(
      path.resolve(__dirname, '..', 'db.ts'),
      'utf8',
    )
    expect(dbSource).toContain('UPDATE department_secret_policies')
    expect(dbSource).toContain('Backfilled org_id on')
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
