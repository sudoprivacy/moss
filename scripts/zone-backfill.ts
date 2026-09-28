#!/usr/bin/env bun
/** Existing Org Zone backfill. Defaults to dry-run. For SQLite, run during a quiet maintenance window. */
import { SqliteDriver, PgDriver, type DbDriver } from '../src/server/db/driver.js'
import { applyOrgZoneBackfill, planOrgZoneBackfill } from '../src/server/zones/binding/backfill.js'

type Options = { db?: string; databaseUrl?: string; deployment: string; batchSize: number; apply: boolean; json: boolean }

function parseArgs(args: string[]): Options {
  const options: Options = { deployment: process.env.MOSS_NEXUS_DEPLOYMENT_ID ?? '', batchSize: 100, apply: false, json: false }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--apply') options.apply = true
    else if (arg === '--json') options.json = true
    else if (['--db', '--database-url', '--deployment', '--batch-size'].includes(arg)) {
      const value = args[++i]
      if (!value) throw new Error(`missing value for ${arg}`)
      if (arg === '--db') options.db = value
      else if (arg === '--database-url') options.databaseUrl = value
      else if (arg === '--deployment') options.deployment = value
      else options.batchSize = Number(value)
    } else throw new Error(`unknown argument ${arg}`)
  }
  if (Boolean(options.db) === Boolean(options.databaseUrl)) throw new Error('provide exactly one of --db or --database-url')
  if (!options.deployment.trim()) throw new Error('provide --deployment or MOSS_NEXUS_DEPLOYMENT_ID')
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize <= 0) throw new Error('--batch-size must be a positive integer')
  return options
}

async function openDriver(options: Options): Promise<DbDriver> {
  if (options.databaseUrl) {
    const { Pool } = await import('pg')
    return new PgDriver(new Pool({ connectionString: options.databaseUrl }))
  }
  if (process.versions.bun) {
    const { Database } = await import('bun:sqlite')
    return new SqliteDriver(new Database(options.db!) as never)
  }
  const { DatabaseSync } = await import('node:sqlite')
  return new SqliteDriver(new DatabaseSync(options.db!))
}

async function run(): Promise<number> {
  let options: Options
  try { options = parseArgs(process.argv.slice(2)) }
  catch (error) { console.error(String(error)); return 2 }
  let driver: DbDriver
  try { driver = await openDriver(options) }
  catch (error) { console.error(`database open failed: ${String(error)}`); return 2 }
  try {
    try { await driver.all('SELECT binding_id FROM org_zone_bindings LIMIT 1') }
    catch { throw new Error('org_zone_bindings is unavailable; start the new server once to run DDL migration') }

    if (options.apply) {
      const rows = await driver.all('SELECT DISTINCT nexus_deployment_id FROM org_zone_bindings')
      const mismatched = rows.map((row) => String(row.nexus_deployment_id)).filter((id) => id !== options.deployment)
      if (mismatched.length) throw new Error(`deployment mismatch: selected ${options.deployment}; existing ${mismatched.join(', ')}`)
    }

    let plan = await planOrgZoneBackfill(driver, { nexusDeploymentId: options.deployment })
    const created: string[] = []
    const skipped: string[] = []
    const failed: Array<{ orgId: string; error: string }> = []
    let stalled = false
    if (options.apply) {
      while (plan.wouldCreate > 0) {
        const before = plan.wouldCreate
        const batch = await applyOrgZoneBackfill(driver, { nexusDeploymentId: options.deployment, batchSize: options.batchSize })
        created.push(...batch.created)
        skipped.push(...batch.skipped)
        failed.push(...batch.failed)
        plan = await planOrgZoneBackfill(driver, { nexusDeploymentId: options.deployment })
        if (batch.failed.length || batch.created.length === 0 || plan.wouldCreate >= before) {
          stalled = true
          break
        }
      }
    }
    const unfinished = plan.items.filter((item) => item.status === 'would-create' || item.status === 'collision' || item.status === 'invalid')
    const report = { deployment: options.deployment, dryRun: !options.apply, plan, created, skipped, failed, unfinished }
    if (options.json) console.log(JSON.stringify(report))
    else {
      console.log(`deployment: ${options.deployment}`)
      console.log(`would-create=${plan.wouldCreate} already-bound=${plan.alreadyBound} collision=${plan.collisions} invalid=${plan.invalid} created=${created.length} failed=${failed.length}`)
      console.log(`unfinished: ${JSON.stringify(unfinished)}`)
    }
    if (!options.apply) return 0
    if (failed.length || stalled || plan.wouldCreate > 0) return 1
    if (plan.collisions || plan.invalid) return 3
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  } finally {
    await driver.close()
  }
}

process.exitCode = await run()
