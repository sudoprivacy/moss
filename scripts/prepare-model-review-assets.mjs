import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ShareoneReviewAssets } from '@sudowork/sudograph-runtime'

/** Stage only the verified frontend shipped by the locked SDK, never a local UI checkout. */
export async function prepareModelReviewAssets(root, source) {
  root = await realpath(root)
  const pin = JSON.parse(await readFile(path.join(source, 'installed-source.json'), 'utf8'))
  assert(pin.format === 'shareone-review-shell/v1'
    && pin.repository === 'https://github.com/sudoprivacy/shareone.git'
    && /^[a-f0-9]{40}$/.test(pin.revision), 'The installed SDK must include its pinned ShareOne source receipt')
  const assets = new ShareoneReviewAssets()
  await assets.load(source)
  const manifestBody = await readFile(path.join(source, 'review-assets.json'))
  const manifest = JSON.parse(manifestBody)
  const bin = path.join(root, 'bin')
  await mkdir(bin, { recursive: true })
  assert.equal(await realpath(bin), bin, 'Build resources must remain in this checkout')
  const destination = path.join(bin, 'model-review-assets')
  if (existsSync(destination)) {
    assert(!(await lstat(destination)).isSymbolicLink() && await realpath(destination) === destination,
      'Refuse a linked review resource output')
  }
  const staging = await mkdtemp(path.join(bin, '.model-review-assets-'))
  try {
    for (const name of Object.keys(manifest.files)) {
      const file = assets.get(name)
      assert(file, 'Only checked manifest entries can be staged')
      const target = path.join(staging, name)
      const relative = path.relative(staging, target)
      assert(!relative.startsWith('..') && !path.isAbsolute(relative))
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, file.body)
    }
    await writeFile(path.join(staging, 'review-assets.json'), manifestBody)
    await writeFile(path.join(staging, 'installed-source.json'), JSON.stringify(pin))
    await new ShareoneReviewAssets().load(staging)
    // Destination and its parent were resolved above; no caller-selected output
    // can be removed, and invalid source bytes leave the last build intact.
    await rm(destination, { recursive: true, force: true })
    await rename(staging, destination)
    return { directory: destination, source: pin, files: Object.keys(manifest.files).length,
      manifest_sha256: createHash('sha256').update(manifestBody).digest('hex') }
  } finally {
    assert(path.dirname(staging) === bin && path.basename(staging).startsWith('.model-review-assets-'))
    await rm(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const require = createRequire(import.meta.url)
  const source = path.resolve(path.dirname(require.resolve('@sudowork/sudograph-runtime')), '../review-assets')
  console.log(JSON.stringify(await prepareModelReviewAssets(root, source)))
}
