import { readFile } from 'node:fs/promises'
import type { DbDriver } from '../db/driver.js'

interface BuildMetadata { components: Record<string, { version?: string; source_sha256?: string }> }

export async function readBoxBuild(): Promise<BuildMetadata | null> {
  if (!process.env.PARK_BOX_BUILD_FILE) return null
  return JSON.parse(await readFile(process.env.PARK_BOX_BUILD_FILE, 'utf8')) as BuildMetadata
}

/** Record only after the existing startup migrations completed successfully. */
export async function recordBoxDatabaseRevision(driver: DbDriver): Promise<void> {
  const build = await readBoxBuild()
  const revision = build?.components.database_migration?.source_sha256
  if (!revision) return
  await driver.exec('CREATE TABLE IF NOT EXISTS park_box_database_revisions (revision TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)')
  await driver.run('INSERT INTO park_box_database_revisions (revision, applied_at) VALUES (?, ?) ON CONFLICT (revision) DO NOTHING', [revision, Date.now()])
}
