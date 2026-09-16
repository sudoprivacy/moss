import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import sharp from 'sharp'
import { ManagedImageError, ManagedImageStore } from './managedImageStore.js'

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 20, g: 100, b: 180, alpha: 1 } },
  }).png().toBuffer()
}

describe('统一配置图片存储', () => {
  test('配置图标要求正方形并以不可预测文件名原子保存', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moss-managed-images-'))
    try {
      const store = new ManagedImageStore(root)
      const bytes = await png(32, 32)
      const saved = await store.put({
        kind: 'config-item', originalName: 'icon.png', mimeType: 'image/png', bytes,
      })
      assert.match(saved.filename, /^[0-9a-f-]{36}\.png$/)
      assert.equal(saved.publicPath, `/uploads/config-items/${saved.filename}`)
      assert.deepEqual(await store.read('config-item', saved.filename), {
        bytes,
        mimeType: 'image/png',
      })

      await assert.rejects(
        store.put({
          kind: 'config-item', originalName: 'wide.png', mimeType: 'image/png', bytes: await png(40, 20),
        }),
        (error: unknown) => error instanceof ManagedImageError
          && error.statusCode === 400
          && error.message === '图标必须是正方形图片（宽高比为 1:1）',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('企业 Logo 保持旧格式并拒绝伪造类型、超限文件和主动 SVG', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moss-managed-images-'))
    try {
      const store = new ManagedImageStore(root)
      const bytes = await png(80, 24)
      const saved = await store.put({
        kind: 'enterprise', originalName: 'logo.png', mimeType: 'image/png', bytes,
      })
      assert.equal(saved.publicPath, `/uploads/enterprises/${saved.filename}`)

      await assert.rejects(
        store.put({ kind: 'enterprise', originalName: 'logo.jpg', mimeType: 'image/jpeg', bytes }),
        (error: unknown) => error instanceof ManagedImageError && error.message === '无法解析图片尺寸，请确保上传有效的图片文件',
      )
      await assert.rejects(
        store.put({
          kind: 'enterprise', originalName: 'large.png', mimeType: 'image/png', bytes: Buffer.alloc(500 * 1024 + 1),
        }),
        (error: unknown) => error instanceof ManagedImageError && error.message === '文件大小不能超过 500KB',
      )
      await assert.rejects(
        store.put({
          kind: 'enterprise',
          originalName: 'active.svg',
          mimeType: 'image/svg+xml',
          bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><script>alert(1)</script></svg>'),
        }),
        (error: unknown) => error instanceof ManagedImageError && error.message === 'SVG 图片包含不安全内容',
      )
      await assert.rejects(
        store.read('enterprise', '../secret.png'),
        (error: unknown) => error instanceof ManagedImageError && error.statusCode === 404,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('迁移保留旧 UUID 文件名且只允许同字节幂等重放', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moss-managed-images-'))
    try {
      const store = new ManagedImageStore(root)
      const filename = '123e4567-e89b-42d3-a456-426614174000.png'
      const bytes = await png(32, 32)
      assert.deepEqual(await store.importExisting({
        kind: 'config-item', filename, mimeType: 'image/png', bytes,
      }), { filename, publicPath: `/uploads/config-items/${filename}`, reused: false })
      assert.deepEqual(await store.importExisting({
        kind: 'config-item', filename, mimeType: 'image/png', bytes,
      }), { filename, publicPath: `/uploads/config-items/${filename}`, reused: true })
      await assert.rejects(
        store.importExisting({
          kind: 'config-item', filename, mimeType: 'image/png', bytes: await png(48, 48),
        }),
        (error: unknown) => error instanceof ManagedImageError && error.statusCode === 409,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
