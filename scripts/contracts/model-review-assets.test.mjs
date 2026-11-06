import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { prepareModelReviewAssets } from '../prepare-model-review-assets.mjs'

test('host packaging preserves checked assets, excludes unlisted files and refuses corrupt replacements', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'moss-review-package-'))
  t.after(async () => {
    assert(path.dirname(root) === tmpdir() && path.basename(root).startsWith('moss-review-package-'))
    await rm(root, { recursive: true, force: true })
  })
  const source = path.join(root, 'installed-sdk')
  await mkdir(source)
  const body = Buffer.from('// Packaging fixture; not production frontend acceptance.')
  const style = Buffer.from(':root{color-scheme:dark}')
  const manifest = { format: 'shareone-review-shell/v1', entry: 'review.js', styles: ['review.css'],
    files: {
      'review.js': { bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') },
      'review.css': { bytes: style.length, sha256: createHash('sha256').update(style).digest('hex') },
    } }
  await writeFile(path.join(source, 'review.js'), body)
  await writeFile(path.join(source, 'review.css'), style)
  await writeFile(path.join(source, 'review-assets.json'), JSON.stringify(manifest))
  const pin = {
    repository: 'https://github.com/sudoprivacy/shareone.git', revision: 'a'.repeat(40), format: 'shareone-review-shell/v1',
  }
  await writeFile(path.join(source, 'installed-source.json'), JSON.stringify(pin))
  await writeFile(path.join(source, 'unlisted-private-file'), 'Not a distributed frontend asset')
  const receipt = await prepareModelReviewAssets(root, source)
  assert.equal(receipt.files, 2)
  assert.deepEqual((await readdir(receipt.directory)).sort(), ['installed-source.json', 'review-assets.json', 'review.css', 'review.js'])
  assert.deepEqual(await readFile(path.join(receipt.directory, 'review.js')), body)
  await writeFile(path.join(source, 'review.js'), 'Corrupt replacement')
  await assert.rejects(prepareModelReviewAssets(root, source), /differs from its receipt/)
  assert.deepEqual(await readFile(path.join(receipt.directory, 'review.js')), body)
  await writeFile(path.join(source, 'installed-source.json'), '{}')
  await assert.rejects(prepareModelReviewAssets(root, source), /pinned ShareOne source receipt/)
  assert.deepEqual(await readFile(path.join(receipt.directory, 'review.js')), body)

  await writeFile(path.join(source, 'installed-source.json'), JSON.stringify(pin))
  await writeFile(path.join(source, 'review.js'), body)
  const linkedRoot = path.join(root, 'linked-checkout')
  const outside = path.join(root, 'operator-directory')
  await mkdir(linkedRoot)
  await mkdir(outside)
  await symlink(outside, path.join(linkedRoot, 'bin'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(prepareModelReviewAssets(linkedRoot, source), /Build resources must remain in this checkout/)
  assert.deepEqual(await readdir(outside), [], 'A linked output cannot write or remove operator files')
})
