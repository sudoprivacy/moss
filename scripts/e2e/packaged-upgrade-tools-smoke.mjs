#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [packageDirectory, reportPath] = process.argv.slice(2);
assert(packageDirectory && reportPath && isAbsolute(packageDirectory) && isAbsolute(reportPath),
  'Use absolute extracted-package and report paths');
const node = join(packageDirectory, 'node/bin/node');
const qualifier = join(packageDirectory, 'app/bin/moss-qualify-sqlite-upgrade.mjs');
const inspector = join(packageDirectory, 'app/bin/moss-inspect-existing-product.mjs');
for (const file of [node, qualifier, inspector]) assert(existsSync(file), `Missing packaged upgrade tool: ${file}`);

function run(entry, arguments_ = []) {
  const result = spawnSync(node, [entry, ...arguments_], { encoding: 'utf8', timeout: 60_000 });
  assert.ifError(result.error);
  return result;
}

const fixture = mkdtempSync(join(tmpdir(), 'moss-packaged-upgrade-'));
chmodSync(fixture, 0o700);
const databasePath = join(fixture, 'existing.db');
const source = new DatabaseSync(databasePath);
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
try {
  source.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE retained_data (value TEXT NOT NULL)');
  // An existing deployment already has its department-policy table before
  // the historical backfill runs. Keep that legacy schema in this fixture.
  source.exec(`CREATE TABLE department_secret_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    department_id TEXT NOT NULL,
    config_item_id INTEGER NOT NULL,
    org_id TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (config_item_id) REFERENCES config_items(id) ON DELETE CASCADE,
    UNIQUE(department_id, config_item_id)
  )`);
  source.prepare('INSERT INTO retained_data (value) VALUES (?)').run('committed-in-wal');
  const originalTables = source.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
  const databaseSha256 = digest(databasePath);
  const walSha256 = digest(databasePath + '-wal');
  const checked = run(qualifier, [databasePath]);
  assert.equal(checked.status, 0, checked.stderr);
  // Existing migration diagnostics can precede the final JSON receipt.
  const receiptStart = checked.stdout.indexOf('{\n  "schemaVersion"');
  assert(receiptStart >= 0, 'Missing upgrade qualification receipt');
  const qualification = JSON.parse(checked.stdout.slice(receiptStart));
  assert.equal(qualification.sourceOpenedReadOnly, true);
  assert.equal(qualification.sourceBackupApi, 'node:sqlite.backup');
  assert.equal(qualification.sourceTables.retained_data.rows, 1);
  assert.equal(qualification.existingRowsPreserved, true);
  assert.equal(qualification.idempotentReopen, true);
  assert.equal(qualification.runtimeStarted, false);
  assert.equal(qualification.authenticatedReady, false);
  assert.deepEqual(source.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all(), originalTables);
  assert.equal(source.prepare('SELECT value FROM retained_data').get().value, 'committed-in-wal');
  assert.equal(digest(databasePath), databaseSha256, 'Qualification modified the source database');
  assert.equal(digest(databasePath + '-wal'), walSha256, 'Qualification modified committed source WAL data');

  // Loading the second bundled tool must reach its own argument guard without
  // installing dependencies, authenticating or starting an existing session.
  const rejected = run(inspector);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Use absolute existing-config and new-evidence paths/);

  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({
    passed: true,
    node: resolve(node),
    qualifierSha256: digest(qualifier),
    inspectorSha256: digest(inspector),
    committedWalDataPreserved: true,
    sourceDatabaseUnchanged: true,
    idempotentCopyMigration: true,
    inspectorArgumentGuardReached: true,
    runtimeStarted: false,
    qualification,
  }, null, 2) + '\n');
  process.stdout.write('Packaged upgrade tools passed the offline WAL-preservation journey\n');
} finally {
  source.close();
  assert.equal(dirname(fixture), resolve(tmpdir()));
  assert(fixture.startsWith(join(tmpdir(), 'moss-packaged-upgrade-')));
  rmSync(fixture, { recursive: true, force: true });
}
