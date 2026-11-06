import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ShareoneReviewAssets } from '@sudowork/sudograph-runtime'

// This bundled verifier travels with the host, so archive acceptance does not
// accidentally load a developer checkout or an unbundled workspace dependency.
const directory = process.argv[2]
assert(directory, 'Usage: node verify-model-review-assets.mjs <deployed-directory>')
const source = JSON.parse(await readFile(path.join(directory, 'installed-source.json'), 'utf8')) as {
  repository: string; revision: string; format: string
}
assert(source.repository === 'https://github.com/sudoprivacy/shareone.git'
  && source.format === 'shareone-review-shell/v1' && /^[a-f0-9]{40}$/.test(source.revision))
const assets = new ShareoneReviewAssets()
await assets.load(directory)
const bytes = await readFile(path.join(directory, 'review-assets.json'))
const manifest = JSON.parse(bytes.toString()) as { entry: string; files: Record<string, unknown> }
assert(assets.get(manifest.entry))
assert(assets.shell('/review/packaged-acceptance', { allow_comments: true }).includes(manifest.entry))
console.log(JSON.stringify({ format: 'moss-packaged-review-assets/v1', passed: true, source,
  files: Object.keys(manifest.files).length, manifest_sha256: createHash('sha256').update(bytes).digest('hex') }))
