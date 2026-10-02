import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { DbDriver } from '../db/driver.js'
import { registerOrganizationCustom, saveOrganizationInstallation, withOrganizationResources, type ResourceKind, type ResourceMetadata } from './organizationResources.js'

export type ResourceMigrationEntry = {
  kind: ResourceKind
  sourceType: 'hub' | 'custom' | 'tenant'
  id: string
  orgId: string
  userId: string
  path: string
  provider?: string
}

// Inventory is deliberately unassigned. A shared directory cannot tell us
// which organization installed it, including when its creator is an admin.
export async function inventoryOrganizationResources(home: string) {
  const entries: Array<Record<string, unknown>> = []
  for (const kind of ['agent', 'skill'] as const) {
    for (const sourceType of ['hub', 'custom', 'tenant', 'tenant-pending', 'system'] as const) {
      const root = join(home, kind === 'agent' ? 'assistants' : 'skills', sourceType)
      for (const child of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!child.isDirectory()) continue
        const path = join(root, child.name)
        const meta = JSON.parse(await readFile(join(path, '_moss_meta.json'), 'utf8').catch(() => '{}')) as ResourceMetadata
        entries.push({ kind, sourceType, id: meta.id || '', name: meta.name || child.name, path, orgId: null, userId: null })
      }
    }
  }
  return entries
}

async function contentHash(path: string): Promise<string> {
  const hash = createHash('sha256')
  async function visit(dir: string, prefix: string) {
    const children = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      const relative = `${prefix}${child.name}`
      if (child.isDirectory()) await visit(join(dir, child.name), `${relative}/`)
      else if (child.isFile()) {
        const bytes = await readFile(join(dir, child.name))
        hash.update(JSON.stringify([relative, bytes.length])).update(bytes)
      } else throw new Error(`Migration requires ordinary files: ${relative}`)
    }
  }
  await visit(path, '')
  return hash.digest('hex')
}

export async function migrateOrganizationResources(driver: DbDriver, home: string, entries: ResourceMigrationEntry[], apply = false) {
  const seen = new Set<string>()
  const prepared: Array<{ entry: ResourceMigrationEntry; meta: ResourceMetadata; target: string; hash: string; skip: boolean; table: string }> = []
  for (const entry of entries) {
    if (!['agent', 'skill'].includes(entry.kind) || !['hub', 'custom', 'tenant'].includes(entry.sourceType)
      || !entry.orgId?.trim() || !entry.userId?.trim() || !entry.id?.trim() || !entry.path?.trim()
      || (entry.sourceType === 'hub' && !entry.provider?.trim())) throw new Error('Every mapping requires a kind, sourceType, stable ID, organization, user, path and Hub provider')
    const identity = JSON.stringify([entry.kind, entry.sourceType === 'hub' ? entry.orgId : '', entry.sourceType, entry.provider, entry.id])
    if (seen.has(identity)) throw new Error(`Duplicate migration mapping: ${entry.id}`)
    seen.add(identity)
    if (!await driver.get('SELECT id FROM organizations WHERE id = ?', [entry.orgId])) throw new Error(`Unknown organization: ${entry.orgId}`)
    if (!await driver.get('SELECT id FROM users WHERE id = ? AND org_id = ?', [entry.userId, entry.orgId])) throw new Error(`User does not belong to mapped organization: ${entry.userId}`)
    const table = entry.kind === 'agent' ? 'tenant_assistants' : 'tenant_skills'
    const current = entry.sourceType === 'hub'
      ? await driver.get('SELECT id FROM org_resource_installations WHERE org_id = ? AND resource_type = ? AND source_provider = ? AND source_resource_id = ?', [entry.orgId, entry.kind, entry.provider!, entry.id])
      : await driver.get(`SELECT org_id, source_type, file_path FROM ${table} WHERE id = ?`, [entry.id])
    if (current && entry.sourceType !== 'hub' && (current.org_id != null && current.org_id !== entry.orgId || current.source_type !== entry.sourceType)) throw new Error(`Conflicting existing ownership: ${entry.id}`)
    if (entry.sourceType === 'tenant' && !current) throw new Error(`Tenant mapping requires its existing database row: ${entry.id}`)
    const meta = JSON.parse(await readFile(join(entry.path, '_moss_meta.json'), 'utf8')) as ResourceMetadata
    if (typeof meta.name !== 'string' || !meta.name.trim()) throw new Error(`Resource has no name: ${entry.id}`)
    const hash = await contentHash(entry.path)
    const artifactId = entry.sourceType === 'hub' ? hash : createHash('sha256').update(JSON.stringify([entry.kind, entry.id, hash])).digest('hex')
    const target = resolve(home, 'artifacts', 'migrated', artifactId)
    const skip = Boolean(current && (entry.sourceType !== 'tenant' || current.org_id === entry.orgId && current.file_path === target))
    prepared.push({ entry, meta, target, hash, skip, table })
  }
  if (apply) {
    // Freeze package bytes before committing references. Failed transactions may
    // leave an unused artifact, but never a false installation or deleted source.
    for (const item of prepared.filter(item => !item.skip)) {
      const root = resolve(home, 'artifacts', 'migrated')
      await mkdir(root, { recursive: true })
      const staging = await mkdtemp(join(root, '.staging-'))
      try {
        await cp(item.entry.path, staging, { recursive: true })
        if (await contentHash(staging) !== item.hash) throw new Error('Resource changed during migration; retry with writers stopped')
        try { await rename(staging, item.target) } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')) throw error
        }
      } finally { await rm(staging, { recursive: true, force: true }) }
    }
    await driver.transaction(async () => {
      for (const { entry, meta, target, skip, table } of prepared) {
        if (skip) continue
        await withOrganizationResources({ driver, orgId: entry.orgId, userId: entry.userId }, async () => {
          if (entry.sourceType === 'hub') await saveOrganizationInstallation(entry.kind, target, { ...meta, id: entry.id }, entry.provider)
          else if (entry.sourceType === 'custom') {
            await registerOrganizationCustom(entry.kind, target, { ...meta, id: entry.id, visible_to: { user_ids: [entry.userId] } })
          } else {
            await driver.run(`UPDATE ${table} SET org_id = ?, file_path = ? WHERE id = ? AND (org_id IS NULL OR org_id = ?)`, [entry.orgId, target, entry.id, entry.orgId])
          }
        })
      }
    })
  }
  return { applied: apply, total: prepared.length, unchanged: prepared.filter(item => item.skip).length,
    entries: prepared.map(({ entry, target, skip }) => ({ ...entry, artifact: target, action: skip ? 'unchanged' : 'register' })) }
}
