import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  FileTreeSnapshotReader,
  SudoworkSourceSnapshotError,
  SudoworkSourceSnapshotReader,
  type SourceComponentSnapshot,
} from './sudoworkSourceSnapshot.js'

function component(name: SourceComponentSnapshot['name'], checksum: string, metadata: Record<string, unknown> = {}): SourceComponentSnapshot {
  return { name, checksum, itemCount: 1, readOnly: true, metadata }
}

describe('SudoworkSourceSnapshotReader', () => {
  test('produces one deterministic fingerprint independent of metadata key order', async () => {
    const first = new SudoworkSourceSnapshotReader({
      sqlite: { capture: async () => component('sqlite', 'sqlite-a', { z: 1, a: { y: 2, x: 1 } }) },
      redis: { capture: async () => component('redis', 'redis-a') },
      qms: { capture: async () => component('qms', 'qms-a') },
      files: { capture: async () => component('files', 'files-a') },
    }, { clock: () => '2026-09-08T01:00:00.000Z' })
    const second = new SudoworkSourceSnapshotReader({
      sqlite: { capture: async () => component('sqlite', 'sqlite-a', { a: { x: 1, y: 2 }, z: 1 }) },
      redis: { capture: async () => component('redis', 'redis-a') },
      qms: { capture: async () => component('qms', 'qms-a') },
      files: { capture: async () => component('files', 'files-a') },
    }, { clock: () => '2026-09-08T02:00:00.000Z' })

    const left = await first.capture()
    const right = await second.capture()
    assert.equal(left.fingerprint, right.fingerprint)
    assert.notEqual(left.capturedAt, right.capturedAt)
    assert.deepEqual(left.excludedLocalData, ['sessions', 'client_cron', 'client_channels'])
    assert.equal(left.includedDomains.length, 10)
  })

  test('changes the aggregate fingerprint when any source component changes', async () => {
    let redisChecksum = 'redis-a'
    const reader = new SudoworkSourceSnapshotReader({
      sqlite: { capture: async () => component('sqlite', 'sqlite-a') },
      redis: { capture: async () => component('redis', redisChecksum) },
      qms: { capture: async () => component('qms', 'qms-a') },
      files: { capture: async () => component('files', 'files-a') },
    })
    const before = await reader.capture()
    redisChecksum = 'redis-b'
    const after = await reader.capture()
    assert.notEqual(after.fingerprint, before.fingerprint)
    await assert.rejects(
      reader.assertUnchanged(before.fingerprint),
      (error: unknown) => error instanceof SudoworkSourceSnapshotError && error.code === 'SOURCE_CHANGED',
    )
  })

  test('rejects a missing or writable source component', async () => {
    const missing = new SudoworkSourceSnapshotReader({
      sqlite: { capture: async () => component('sqlite', '') },
      redis: { capture: async () => component('redis', 'redis') },
      qms: { capture: async () => component('qms', 'qms') },
      files: { capture: async () => component('files', 'files') },
    })
    await assert.rejects(
      missing.capture(),
      (error: unknown) => error instanceof SudoworkSourceSnapshotError && error.code === 'MISSING_COMPONENT',
    )

    const writable = new SudoworkSourceSnapshotReader({
      sqlite: { capture: async () => ({ ...component('sqlite', 'sqlite'), readOnly: false }) },
      redis: { capture: async () => component('redis', 'redis') },
      qms: { capture: async () => component('qms', 'qms') },
      files: { capture: async () => component('files', 'files') },
    })
    await assert.rejects(
      writable.capture(),
      (error: unknown) => error instanceof SudoworkSourceSnapshotError && error.code === 'SOURCE_NOT_READ_ONLY',
    )
  })
})

describe('FileTreeSnapshotReader', () => {
  test('hashes only allowlisted regular files in stable relative-path order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moss-source-files-'))
    try {
      await mkdir(join(root, 'uploads', 'agents'), { recursive: true })
      await writeFile(join(root, 'uploads', 'agents', 'b.txt'), 'beta')
      await writeFile(join(root, 'uploads', 'agents', 'a.txt'), 'alpha')
      await writeFile(join(root, 'ignored.txt'), 'ignored')
      const reader = new FileTreeSnapshotReader(root, ['uploads'])

      const first = await reader.capture()
      await writeFile(join(root, 'ignored.txt'), 'changed but ignored')
      const second = await reader.capture()
      assert.equal(first.checksum, second.checksum)
      assert.equal(first.itemCount, 2)
      assert.deepEqual(first.metadata.paths, ['uploads/agents/a.txt', 'uploads/agents/b.txt'])

      await writeFile(join(root, 'uploads', 'agents', 'a.txt'), 'changed')
      assert.notEqual((await reader.capture()).checksum, first.checksum)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects traversal, missing roots and symbolic links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moss-source-files-'))
    try {
      await mkdir(join(root, 'uploads'), { recursive: true })
      await writeFile(join(root, 'outside.txt'), 'outside')
      await symlink(join(root, 'outside.txt'), join(root, 'uploads', 'link.txt'))

      assert.throws(
        () => new FileTreeSnapshotReader(root, ['../outside']),
        (error: unknown) => error instanceof SudoworkSourceSnapshotError && error.code === 'UNSAFE_PATH',
      )
      await assert.rejects(
        new FileTreeSnapshotReader(root, ['missing']).capture(),
        (error: unknown) => error instanceof SudoworkSourceSnapshotError && error.code === 'MISSING_COMPONENT',
      )
      await assert.rejects(
        new FileTreeSnapshotReader(root, ['uploads']).capture(),
        (error: unknown) => error instanceof SudoworkSourceSnapshotError && error.code === 'UNSAFE_PATH',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
