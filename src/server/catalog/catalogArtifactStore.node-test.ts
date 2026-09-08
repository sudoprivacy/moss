import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import JSZip from 'jszip'
import { CatalogArtifactError, CatalogArtifactStore } from './catalogArtifactStore.js'

async function zip(entries: Record<string, string>): Promise<Buffer> {
  const archive = new JSZip()
  for (const [name, value] of Object.entries(entries)) archive.file(name, value)
  return archive.generateAsync({ type: 'nodebuffer' })
}

describe('统一目录制品存储', () => {
  test('暂存、原子发布并按 checksum 读取 Skill 制品', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moss-catalog-artifacts-'))
    try {
      const store = new CatalogArtifactStore(root)
      const bytes = await zip({ 'SKILL.md': '# Test', 'scripts/run.sh': 'echo ok' })
      const staged = await store.stage({ kind: 'skill', orgId: 'org/a', resourceId: '../skill', version: '1.0.0', bytes })
      assert.match(staged.checksum, /^[0-9a-f]{64}$/)
      assert.equal(staged.finalPath.startsWith(root), true)
      assert.equal(staged.finalPath.includes('../skill'), false)

      await store.publish(staged)
      assert.deepEqual(await store.read(staged.finalPath, staged.checksum), bytes)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('拒绝缺少 SKILL.md 的 Skill、危险路径和篡改文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moss-catalog-artifacts-'))
    try {
      const store = new CatalogArtifactStore(root)
      await assert.rejects(
        store.stage({ kind: 'skill', orgId: 'org', resourceId: 'skill', version: '1', bytes: await zip({ 'README.md': 'x' }) }),
        (error: unknown) => error instanceof CatalogArtifactError && error.code === 'INVALID_ARCHIVE',
      )
      await assert.rejects(
        store.read(join(root, '..', 'outside.zip'), 'deadbeef'),
        (error: unknown) => error instanceof CatalogArtifactError && error.code === 'UNSAFE_PATH',
      )

      const staged = await store.stage({ kind: 'agent', orgId: 'org', resourceId: 'agent', version: '1', bytes: await zip({ 'system.md': 'ok' }) })
      await store.publish(staged)
      await writeFile(staged.finalPath, 'tampered')
      await assert.rejects(
        store.read(staged.finalPath, staged.checksum),
        (error: unknown) => error instanceof CatalogArtifactError && error.code === 'CHECKSUM_MISMATCH',
      )
      await store.remove(staged.finalPath)
      await assert.rejects(readFile(staged.finalPath))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
