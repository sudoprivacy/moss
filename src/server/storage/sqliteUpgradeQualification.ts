/** Qualify this source's migrations on a private SQLite backup, without starting Moss. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { DirectConnectStore } from '../db.js'
import { serverFileConfigSchema } from '../types.js'

const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"'
const MAX_ROWS_PER_TABLE = 100_000
type Inventory = Record<string, { columns: string[]; rows: number; sha256: string }>

/** Read the running controller's operational identity before a stop, never mint one.
 * The deployment caller must independently bind expectedPid to the owned service.
 * This row is a heartbeat observation, not authentication or process liveness proof.
 */
export function inspectSqliteController(source: string, expectedPid: number, heartbeatTimeoutMs: number) {
  assert(isAbsolute(source), 'Use an absolute source database path')
  assert(Number.isSafeInteger(expectedPid) && expectedPid > 0, 'Expected service PID is required')
  assert(Number.isSafeInteger(heartbeatTimeoutMs) && heartbeatTimeoutMs > 0, 'Use the controller heartbeat timeout')
  const db = new DatabaseSync(source, { readOnly: true })
  try {
    const observedAt = Date.now()
    const rows = db.prepare(`SELECT instance_id, host, pid, heartbeat_at FROM server_instances
      WHERE status = 'running' AND heartbeat_at >= ?`).all(observedAt - heartbeatTimeoutMs)
    assert.equal(rows.length, 1, 'Require exactly one fresh controller; do not bypass live-peer fencing')
    const row = rows[0]!
    assert.equal(row.pid, expectedPid, 'Controller row does not match the independently verified service PID')
    assert(typeof row.instance_id === 'string' && row.instance_id.length > 0, 'Missing registered instance identity')
    assert(typeof row.heartbeat_at === 'number' && row.heartbeat_at <= observedAt, 'Controller clock is ahead of this host')
    return { schemaVersion: 1, sourceOpenedReadOnly: true, instanceId: row.instance_id,
      pid: expectedPid, bindHost: row.host, observedAt, heartbeatTimeoutMs,
      heartbeatAgeMs: observedAt - row.heartbeat_at, authenticationClaimed: false,
      runtimeStarted: false, databaseChanged: false }
  } finally { db.close() }
}

/** Prepare, never install, the one native config change needed for stable restart. */
export function prepareControllerConfiguration(configPath: string, databasePath: string, expectedPid: number,
  expectedConfigSha256: string, output: string) {
  assert(isAbsolute(configPath) && isAbsolute(output) && resolve(configPath) !== resolve(output), 'Use distinct absolute configuration paths')
  const original = readFileSync(configPath)
  const configSha256 = createHash('sha256').update(original).digest('hex')
  assert.equal(configSha256, expectedConfigSha256, 'Existing configuration changed; inspect again')
  const raw = JSON.parse(original.toString('utf8'))
  const parsed = serverFileConfigSchema().parse(raw)
  assert(!parsed.storage.dbBackend || parsed.storage.dbBackend === 'sqlite', 'This adoption journey requires SQLite')
  if (parsed.storage.dbPath) assert.equal(resolve(parsed.storage.dbPath), resolve(databasePath), 'Wrong controller database')
  const observation = inspectSqliteController(databasePath, expectedPid, parsed.recovery.heartbeatTimeoutMs)
  assert(!parsed.server.instanceId || parsed.server.instanceId === observation.instanceId, 'Configured identity differs from the live controller')
  assert(!process.env.MOSS_INSTANCE_ID || process.env.MOSS_INSTANCE_ID.trim() === observation.instanceId, 'Environment overrides the observed identity')
  const next = { ...raw, server: { ...raw.server, instanceId: observation.instanceId } }
  serverFileConfigSchema().parse(next)
  const bytes = Buffer.from(JSON.stringify(next, null, 2) + '\n')
  const fd = openSync(output, 'wx', 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  return { ...observation, originalConfigSha256: configSha256,
    preparedConfigSha256: createHash('sha256').update(bytes).digest('hex'),
    preparedConfigPath: output, installed: false, exclusiveConfigurationOwnerRequired: true }
}

function valueHash(value: unknown): unknown {
  if (value instanceof Uint8Array) return ['bytes', Buffer.from(value).toString('base64')]
  if (typeof value === 'bigint') return ['bigint', value.toString()]
  return [value === null ? 'null' : typeof value, value]
}

/** Only hashes/counts leave the process; database values and prompts never do. */
function inventory(db: DatabaseSync, original?: Inventory): Inventory {
  const tables = original ? Object.keys(original) : db.prepare(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
  ).all().map(row => String(row.name))
  return Object.fromEntries(tables.map(table => {
    const available = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => String(row.name))
    const columns = original?.[table]?.columns ?? available
    assert(columns.length && columns.every(column => available.includes(column)), `Existing columns removed: ${table}`)
    const count = Number(db.prepare(`SELECT count(*) AS count FROM ${quote(table)}`).get()!.count)
    assert(count <= MAX_ROWS_PER_TABLE, `Qualification row bound exceeded: ${table}; use a reviewed larger-data journey`)
    const query = db.prepare(`SELECT ${columns.map(quote).join(',')} FROM ${quote(table)}`)
    query.setReadBigInts(true)
    const rows = query.all().map(row => createHash('sha256').update(JSON.stringify(
      columns.map(column => valueHash(row[column])),
    )).digest('hex')).sort()
    const sha256 = createHash('sha256').update(JSON.stringify(rows)).digest('hex')
    return [table, { columns, rows: count, sha256 }]
  }))
}

function integrity(db: DatabaseSync): void {
  assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check), ['ok'])
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'Foreign-key violations require review')
}

export async function qualifySqliteUpgrade(source: string) {
  assert(isAbsolute(source), 'Use an absolute source database path')
  const directory = mkdtempSync(join(tmpdir(), 'moss-db-upgrade-'))
  chmodSync(directory, 0o700)
  const copy = join(directory, 'moss.db')
  let sourceDb: DatabaseSync | undefined
  let store: DirectConnectStore | undefined
  try {
    // Read-only source plus the SQLite backup API includes WAL commits. A raw
    // filesystem copy of a running database is not an upgrade qualification.
    sourceDb = new DatabaseSync(source, { readOnly: true })
    await backup(sourceDb, copy)
    sourceDb.close(); sourceDb = undefined
    chmodSync(copy, 0o600)
    const snapshot = new DatabaseSync(copy, { readOnly: true })
    let before: Inventory
    try { integrity(snapshot); before = inventory(snapshot) }
    finally { snapshot.close() }

    const errors: unknown[][] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => { errors.push(args); originalError(...args) }
    try { store = new DirectConnectStore(copy) }
    finally { console.error = originalError }
    assert.equal(errors.length, 0, 'Migration emitted errors; retain the original diagnostic')
    integrity(store.db!)
    assert.deepEqual(inventory(store.db!, before), before, 'Migration changed existing rows or columns')
    const migrated = inventory(store.db!)
    await store.close(); store = undefined
    // An ordinary restart must not perform another logical data mutation.
    store = new DirectConnectStore(copy)
    integrity(store.db!)
    assert.deepEqual(inventory(store.db!), migrated, 'Migration is not idempotent on reopen')
    return { schemaVersion: 1, sourceOpenedReadOnly: true, sourceBackupApi: 'node:sqlite.backup',
      sourceTables: Object.fromEntries(Object.entries(before).map(([name, value]) =>
        [name, { rows: value.rows, sha256: value.sha256 }])),
      addedTables: Object.keys(migrated).filter(table => !(table in before)),
      existingRowsPreserved: true, idempotentReopen: true,
      runtimeStarted: false, nativeHistoryRecoveryAccepted: false, authenticatedReady: false }
  } finally {
    sourceDb?.close()
    await store?.close()
    // Remove only the exact private directory created above, on either outcome.
    assert.equal(dirname(directory), resolve(tmpdir()))
    assert(directory.startsWith(resolve(tmpdir()) + sep + 'moss-db-upgrade-'))
    rmSync(directory, { recursive: true, force: true })
  }
}

