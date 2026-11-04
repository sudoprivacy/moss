import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  backupDataDir,
  compareFingerprints,
  fingerprintSecrets,
  readDataState,
  readUpgradeReport,
  restoreDataDir,
  writeUpgradeReport,
  writeVersionMarker,
} from '../nexusUpgrade.js'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'nexus-upgrade-'))
}

describe('nexus data state', () => {
  it('treats a missing or empty directory as fresh', () => {
    const d = tmp()
    expect(readDataState(join(d, 'nope'), '0.8.26').kind).toBe('empty')
    mkdirSync(join(d, 'data'))
    expect(readDataState(join(d, 'data'), '0.8.26').kind).toBe('empty')
  })

  it('treats unmarked data as written by another version (pre-marker moss)', () => {
    const d = join(tmp(), 'data')
    mkdirSync(join(d, 'vault'), { recursive: true })
    writeFileSync(join(d, 'metastore.redb'), 'x')
    expect(readDataState(d, '0.8.26')).toEqual({ kind: 'other', version: null })
    writeVersionMarker(d, '0.1.5')
    expect(readDataState(d, '0.8.26')).toEqual({ kind: 'other', version: '0.1.5' })
    writeVersionMarker(d, '0.8.26')
    expect(readDataState(d, '0.8.26')).toEqual({ kind: 'current', version: '0.8.26' })
  })
})

describe('backup and restore', () => {
  it('restores the exact original contents', () => {
    const root = tmp()
    const data = join(root, 'data')
    mkdirSync(join(data, 'vault'), { recursive: true })
    writeFileSync(join(data, 'vault', 'master.key'), 'KEY')
    writeFileSync(join(data, 'metastore.redb'), 'v1')
    const backup = backupDataDir(root, data, '0.1.5')
    writeFileSync(join(data, 'metastore.redb'), 'migrated-and-broken')
    mkdirSync(join(data, 'rootfs'))
    restoreDataDir(backup, data)
    expect(readFileSync(join(data, 'metastore.redb'), 'utf8')).toBe('v1')
    expect(readFileSync(join(data, 'vault', 'master.key'), 'utf8')).toBe('KEY')
    expect(readdirSync(data).includes('rootfs')).toBe(false)
    expect(readdirSync(root).some(e => e.startsWith('data.failed-'))).toBe(true)
  })
})

describe('secret fingerprints', () => {
  const rows = [
    { namespace: 'org:1:system:wms', key: 'password', status: 'enabled', version: 2, value: 's3cret' },
    { namespace: 'user:9:whoami', key: 'whoami', status: 'disabled', version: 1, value: null },
  ]

  it('never contains the values', () => {
    const fp = fingerprintSecrets(rows)
    expect(JSON.stringify(fp)).not.toContain('s3cret')
    expect(fp[0]!.valueHash).toHaveLength(64)
    expect(fp[1]!.valueHash).toBeNull()
  })

  it('accepts identical sets regardless of order and rejects any difference', () => {
    expect(compareFingerprints(fingerprintSecrets(rows), fingerprintSecrets([...rows].reverse())).ok).toBe(true)
    const changed = fingerprintSecrets([{ ...rows[0]!, value: 'other' }, rows[1]!])
    expect(compareFingerprints(fingerprintSecrets(rows), changed)).toEqual({ ok: false, reason: 'secret org:1:system:wms/password differs after upgrade' })
    expect(compareFingerprints(fingerprintSecrets(rows), fingerprintSecrets([rows[0]!])).ok).toBe(false)
  })
})

describe('upgrade report', () => {
  it('round-trips', () => {
    const d = tmp()
    expect(readUpgradeReport(d)).toBeNull()
    writeUpgradeReport(d, { status: 'upgraded', from: '0.1.5', to: '0.8.26', running: '0.8.26', at: 'now', backup: '/b', secrets: 31, verified: true })
    expect(readUpgradeReport(d)?.secrets).toBe(31)
  })
})
