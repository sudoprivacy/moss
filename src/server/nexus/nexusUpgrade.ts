/**
 * Upgrading the embedded Nexus in place.
 *
 * A new moss image ships a newer nexusd (0.8.x) and also keeps the previous
 * one (0.1.5) under bin/nexus/legacy. On first start against a data directory
 * the old daemon wrote, NexusManager:
 *
 *   1. copies the data directory to backups/ (it is small: the secrets vault);
 *   2. starts the old daemon once and records every secret's namespace, key,
 *      version and value hash (never the value);
 *   3. starts the new daemon on the same directory — it migrates its stores on
 *      first open — and records the same manifest;
 *   4. keeps the new daemon only if both manifests match, writing a version
 *      marker; otherwise restores the backup and runs the old daemon.
 *
 * MOSS_NEXUS_UPGRADE=hold keeps running the old daemon on old data, so an
 * operator can choose when the upgrade happens (set it back to auto, restart).
 * Rehearsed on a copy of ruigu's production vault: 0.1.5 → 0.8.26 → 0.1.5 →
 * 0.8.26 all read back the same 31 secrets.
 */
import { createHash } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

export const VERSION_MARKER = '.moss-nexus-version'
export const UPGRADE_REPORT = 'upgrade-report.json'

export type DataState =
  | { kind: 'empty' }
  | { kind: 'current'; version: string }
  /** Written by another version; `version` is null when no marker existed (pre-marker moss). */
  | { kind: 'other'; version: string | null }

export function readDataState(dataDir: string, targetVersion: string): DataState {
  if (!existsSync(dataDir)) return { kind: 'empty' }
  let entries: string[]
  try {
    entries = readdirSync(dataDir).filter(e => e !== VERSION_MARKER && !e.startsWith('.'))
  } catch {
    return { kind: 'empty' }
  }
  const markerPath = join(dataDir, VERSION_MARKER)
  const marker = existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() || null : null
  if (entries.length === 0) return { kind: 'empty' }
  if (marker === targetVersion) return { kind: 'current', version: marker }
  return { kind: 'other', version: marker }
}

export function writeVersionMarker(dataDir: string, version: string): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, VERSION_MARKER), `${version}\n`, 'utf8')
}

/**
 * Recursive copy with plain mkdir + copyFile. Node's recursive copy fails with
 * EACCES on Docker Desktop bind mounts, while these two calls work everywhere.
 */
export function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    if (entry.isDirectory()) copyTree(from, to)
    else if (entry.isFile()) copyFileSync(from, to)
    else if (entry.isSymbolicLink() && statSync(from).isFile()) copyFileSync(from, to)
  }
}

/** Copy the whole data directory; returns the backup path. */
export function backupDataDir(nexusDir: string, dataDir: string, label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = join(nexusDir, 'backups', `data-${stamp}-${label.replace(/[^\w.-]/g, '_')}`)
  mkdirSync(join(nexusDir, 'backups'), { recursive: true })
  copyTree(dataDir, dest)
  return dest
}

/** Put a backup back in place of the data directory. */
export function restoreDataDir(backupDir: string, dataDir: string): void {
  const failed = `${dataDir}.failed-${Date.now()}`
  if (existsSync(dataDir)) renameSync(dataDir, failed)
  copyTree(backupDir, dataDir)
  // Keep the failed attempt for diagnosis only when it differs in name; it is
  // small, but do not let repeated failures pile up forever.
  const parent = join(dataDir, '..')
  const failures = readdirSync(parent).filter(e => e.startsWith(`${dataDir.split('/').pop()}.failed-`)).sort()
  for (const old of failures.slice(0, Math.max(0, failures.length - 3))) rmSync(join(parent, old), { recursive: true, force: true })
}

export interface SecretFingerprint {
  namespace: string
  key: string
  status: string
  version: number
  /** sha256 of the value; null when the record has no readable value (disabled). */
  valueHash: string | null
}

export function fingerprintSecrets(rows: Array<{ namespace: string; key: string; status: string; version: number; value: string | null }>): SecretFingerprint[] {
  return rows
    .map(r => ({
      namespace: r.namespace,
      key: r.key,
      status: r.status,
      version: r.version,
      valueHash: r.value === null ? null : createHash('sha256').update(r.value).digest('hex'),
    }))
    .sort((a, b) => `${a.namespace}\u0000${a.key}`.localeCompare(`${b.namespace}\u0000${b.key}`))
}

export function compareFingerprints(before: SecretFingerprint[], after: SecretFingerprint[]): { ok: true } | { ok: false; reason: string } {
  if (before.length !== after.length) return { ok: false, reason: `secret count changed: ${before.length} → ${after.length}` }
  for (let i = 0; i < before.length; i++) {
    const a = before[i]!
    const b = after[i]!
    if (a.namespace !== b.namespace || a.key !== b.key) return { ok: false, reason: `secret ${a.namespace}/${a.key} missing after upgrade` }
    if (a.status !== b.status || a.version !== b.version || a.valueHash !== b.valueHash) {
      return { ok: false, reason: `secret ${a.namespace}/${a.key} differs after upgrade` }
    }
  }
  return { ok: true }
}

export interface UpgradeReport {
  status: 'upgraded' | 'rolled_back' | 'held' | 'fresh'
  from: string | null
  to: string
  running: string
  at: string
  backup: string | null
  secrets: number | null
  /** True when the old daemon's manifest was compared with the new one. */
  verified: boolean
  error?: string
}

export function writeUpgradeReport(nexusDir: string, report: UpgradeReport): void {
  mkdirSync(nexusDir, { recursive: true })
  writeFileSync(join(nexusDir, UPGRADE_REPORT), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

export function readUpgradeReport(nexusDir: string): UpgradeReport | null {
  try {
    return JSON.parse(readFileSync(join(nexusDir, UPGRADE_REPORT), 'utf8')) as UpgradeReport
  } catch {
    return null
  }
}
