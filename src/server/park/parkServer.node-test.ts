import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test } from 'node:test'

void test('real Moss server mounts public and authorized park HTTP routes', { timeout: 90_000 }, async () => {
  const bundleDir = await mkdtemp(join(tmpdir(), 'moss-park-server-bundle-'))
  try {
    const fixture = resolve(import.meta.dirname, 'testing/parkServerFixture.ts')
    const bundle = spawnSync('bun', [
      'build', fixture, '--target=node', '--format=esm', '--outdir', bundleDir,
      '--external=better-sqlite3',
      '--external=@sudo/contracts/common/v1/resource-ref',
      '--external=@xenova/transformers',
      '--external=onnxruntime-node',
      '--external=sharp',
    ], { cwd: resolve(import.meta.dirname, '../../..'), encoding: 'utf8' })
    assert.equal(bundle.status, 0, bundle.stderr || String(bundle.error))
    await symlink(resolve(import.meta.dirname, '../../../node_modules'), join(bundleDir, 'node_modules'), 'junction')
    const run = spawnSync(process.execPath, [join(bundleDir, 'parkServerFixture.js')], {
      cwd: resolve(import.meta.dirname, '../../..'),
      encoding: 'utf8',
      timeout: 75_000,
    })
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    assert.match(run.stdout, /PARK_SERVER_TEST_OK/)
  } finally {
    const tempRoot = resolve(tmpdir())
    const target = resolve(bundleDir)
    if (!target.startsWith(`${tempRoot}${sep}`)) throw new Error('Unsafe test cleanup path')
    await rm(target, { recursive: true, force: true })
  }
})
