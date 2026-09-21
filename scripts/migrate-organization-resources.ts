#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { PgDriver, SqliteDriver } from '../src/server/db/driver.js'
import { inventoryOrganizationResources, migrateOrganizationResources, type ResourceMigrationEntry } from '../src/server/catalog/organizationResourceMigration.js'

const { values } = parseArgs({ options: {
  home: { type: 'string' }, db: { type: 'string' }, postgres: { type: 'boolean' },
  manifest: { type: 'string' }, inventory: { type: 'boolean' }, apply: { type: 'boolean' },
} })
if (!values.home) throw new Error('--home is required')
if (values.inventory) {
  if (values.apply) throw new Error('Inventory cannot apply changes')
  process.stdout.write(JSON.stringify(await inventoryOrganizationResources(values.home), null, 2) + '\n')
} else {
  if (!values.manifest || (Boolean(values.db) === Boolean(values.postgres))) throw new Error('Use --manifest and either --db or --postgres; default is dry-run')
  const entries = JSON.parse(await readFile(values.manifest, 'utf8')) as ResourceMigrationEntry[]
  if (!Array.isArray(entries)) throw new Error('Manifest must be an array of explicit mappings')
  const driver = values.postgres
    ? new PgDriver(new (await import('pg')).Pool({ connectionString: process.env.MOSS_DATABASE_URL || (() => { throw new Error('MOSS_DATABASE_URL is required') })() }))
    : new SqliteDriver(new DatabaseSync(values.db!, { readOnly: !values.apply }))
  try { process.stdout.write(JSON.stringify(await migrateOrganizationResources(driver, values.home, entries, values.apply), null, 2) + '\n') }
  finally { await driver.close() }
}
