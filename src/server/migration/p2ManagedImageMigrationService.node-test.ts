import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import sharp from 'sharp'
import { ManagedImageStore } from '../configuration/managedImageStore.js'
import {
  P2ManagedImageMigrationBlockedError,
  P2ManagedImageMigrationService,
} from './p2ManagedImageMigrationService.js'

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 40, g: 120, b: 200, alpha: 1 } },
  }).png().toBuffer()
}

describe('P2 配置图片迁移', () => {
  test('预检零写入并原名幂等迁移配置图标和企业 Logo', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moss-p2-images-'))
    try {
      const target = new ManagedImageStore(root)
      const images = [
        {
          kind: 'config-item' as const,
          filename: '123e4567-e89b-42d3-a456-426614174000.png',
          mimeType: 'image/png',
          bytes: await png(32, 32),
        },
        {
          kind: 'enterprise' as const,
          filename: '123e4567-e89b-42d3-a456-426614174001.png',
          mimeType: 'image/png',
          bytes: await png(80, 24),
        },
      ]
      const migration = new P2ManagedImageMigrationService({
        source: { readManagedImages: async () => images },
        target,
      })
      assert.deepEqual(await migration.plan(), {
        status: 'ready', counts: { source: 2, imports: 2, reuses: 0 }, conflicts: [],
      })
      await assert.rejects(target.read('config-item', images[0]!.filename))
      assert.deepEqual(await migration.execute(), { imported: 2, reused: 0, source: 2 })
      assert.deepEqual(await migration.execute(), { imported: 0, reused: 2, source: 2 })
      assert.deepEqual((await target.read('enterprise', images[1]!.filename)).bytes, images[1]!.bytes)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('任一图片不安全时阻断整批且不复制其他文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moss-p2-images-'))
    try {
      const target = new ManagedImageStore(root)
      const safeName = '123e4567-e89b-42d3-a456-426614174000.png'
      const migration = new P2ManagedImageMigrationService({
        source: { readManagedImages: async () => [
          { kind: 'config-item', filename: safeName, mimeType: 'image/png', bytes: await png(32, 32) },
          {
            kind: 'enterprise', filename: '123e4567-e89b-42d3-a456-426614174001.svg', mimeType: 'image/svg+xml',
            bytes: Buffer.from('<svg width="20" height="20"><script>alert(1)</script></svg>'),
          },
        ] },
        target,
      })
      assert.equal((await migration.plan()).status, 'blocked')
      await assert.rejects(migration.execute(), P2ManagedImageMigrationBlockedError)
      await assert.rejects(target.read('config-item', safeName))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
