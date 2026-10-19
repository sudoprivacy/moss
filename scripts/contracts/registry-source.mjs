import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = fileURLToPath(new URL('../../contracts/agent-registry/v1alpha1/', import.meta.url))
const files = ['contract.gen.ts', 'schema.json', 'signed-version.fixture.json']
const ownerRoot = 'src/nexus/contracts/schemas/agent-registry/v1alpha1/'
const stackRoot = 'contracts/experimental/agent-registry/'
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const requireSha = value => { if (!/^[a-f0-9]{40}$/.test(value ?? '')) throw new Error('Full source commit required') }
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const keys = value => Object.keys(value ?? {}).sort()
export function validateLocks(stack, owner) {
  requireSha(stack.revision); requireSha(owner.revision)
  if (stack.repository !== 'https://github.com/sudoprivacy/sudostack'
    || !equal(keys(stack.files), [...files, 'source.lock.json'].sort())
    || owner.repository !== 'https://github.com/nexi-lab/nexus' || owner.semanticOwner !== 'nexus'
    || owner.maturity !== 'experimental-registration-authority' || owner.apiVersion !== 'agent-registry.sudo.dev/v1alpha1'
    || !equal(keys(owner.files), files.map(file => ownerRoot + file).sort())) throw new Error('Invalid Registry source identity')
  for (const file of [...files, 'source.lock.json']) {
    const entry = stack.files[file]
    if (entry.path !== stackRoot + file || entry.output !== (file === 'source.lock.json' ? 'owner.source.lock.json' : file)
      || !/^sha256:[a-f0-9]{64}$/.test(entry.digest ?? '')) throw new Error('Invalid Registry source path or digest')
  }
  for (const file of files) {
    const entry = owner.files[ownerRoot + file]
    if (entry.output !== file || entry.digest !== stack.files[file].digest) throw new Error('Registry owner/assembly mismatch')
  }
}
function normalize(url) { return url.trim().replace(/^git@github.com:/, 'https://github.com/').replace(/\.git$/, '') }
function blob(checkout, lock, path) {
  if (normalize(execFileSync('git', ['-C', checkout, 'remote', 'get-url', 'origin'], { encoding: 'utf8' })) !== lock.repository) throw new Error('Source repository mismatch')
  execFileSync('git', ['-C', checkout, 'cat-file', '-e', `${lock.revision}^{commit}`])
  return execFileSync('git', ['-C', checkout, 'show', `${lock.revision}:${path}`], { maxBuffer: 8 * 1024 * 1024 })
}
export function checkSnapshot(root = directory) {
  const stack = JSON.parse(readFileSync(resolve(root, 'source.lock.json'), 'utf8'))
  const ownerBytes = readFileSync(resolve(root, 'owner.source.lock.json'))
  const owner = JSON.parse(ownerBytes)
  validateLocks(stack, owner)
  for (const file of [...files, 'source.lock.json']) {
    const entry = stack.files[file], bytes = readFileSync(resolve(root, entry.output))
    if (digest(bytes) !== entry.digest) throw new Error(`Registry artifact digest mismatch: ${file}`)
  }
  return { stack, owner }
}
export function verifySources(stackPath, ownerPath, check = true) {
  const { stack, owner } = checkSnapshot()
  // Verify BOTH source hops from exact Git objects, not checkout working-tree contents.
  for (const file of [...files, 'source.lock.json']) {
    const entry = stack.files[file], bytes = blob(stackPath, stack, entry.path)
    if (digest(bytes) !== entry.digest) throw new Error('Pinned Stack bytes differ')
    if (file !== 'source.lock.json' && !blob(ownerPath, owner, ownerRoot + file).equals(bytes)) throw new Error('Pinned Nexus bytes differ')
    if (check && !readFileSync(resolve(directory, entry.output)).equals(bytes)) throw new Error('Stale Registry artifact')
    if (!check) writeFileSync(resolve(directory, entry.output), bytes)
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (!args.length) checkSnapshot()
  else {
    const stack = args.indexOf('--stack'), owner = args.indexOf('--owner')
    if (stack < 0 || owner < 0 || !args[stack + 1] || !args[owner + 1]) throw new Error('Pass --stack <checkout> --owner <checkout>')
    verifySources(args[stack + 1], args[owner + 1], !args.includes('--write'))
  }
  console.log('Registry source closure verified')
}
