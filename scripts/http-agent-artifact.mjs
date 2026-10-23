import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, renameSync, lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = 'https://github.com/sudoprivacy/moss'
const artifactName = 'http-agent-provider.mjs'
const manifestName = 'artifact-manifest.json'
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const sha = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()

/** Build input record, not a signed attestation or a claim of reproducibility. */
export function providerBuildSource(root) {
  if (git(root, 'status', '--porcelain', '--untracked-files=no')) throw new Error('Commit tracked changes before building a Provider candidate')
  const origin = git(root, 'remote', 'get-url', 'origin').replace(/^git@github.com:/, 'https://github.com/').replace(/\.git$/, '')
  if (origin !== repository) throw new Error('Unexpected Provider source repository')
  return { repository, revision: git(root, 'rev-parse', 'HEAD'), tree: git(root, 'rev-parse', 'HEAD^{tree}'), lock_digest: hash(readFileSync(join(root, 'bun.lock'))) }
}

export function writeProviderManifest(root, directory, source, builder) {
  if (JSON.stringify(providerBuildSource(root)) !== JSON.stringify(source)) throw new Error('Provider source changed during build')
  const bytes = readFileSync(join(directory, artifactName))
  const manifest = { schema_version: 1, kind: 'HttpAgentProviderBuild', source, builder,
    artifact: { name: artifactName, digest: hash(bytes), size: bytes.length } }
  const target = join(directory, manifestName)
  writeFileSync(`${target}.tmp`, JSON.stringify(manifest, null, 2) + '\n')
  renameSync(`${target}.tmp`, target)
  verifyProviderArtifact(directory, source.revision)
  return manifest
}

/** The revision must come from the caller's release lock, never from this manifest. */
export function verifyProviderArtifact(directory, expectedRevision) {
  if (!commit(expectedRevision)) throw new Error('Pass a full, independently selected source revision')
  const manifest = JSON.parse(readFileSync(join(directory, manifestName), 'utf8'))
  if (manifest.schema_version !== 1 || manifest.kind !== 'HttpAgentProviderBuild'
    || manifest.source?.repository !== repository || manifest.source.revision !== expectedRevision
    || !commit(manifest.source.tree) || !sha(manifest.source.lock_digest)
    || manifest.artifact?.name !== artifactName || !sha(manifest.artifact.digest)
    || !Number.isSafeInteger(manifest.artifact.size) || manifest.artifact.size < 1
    || typeof manifest.builder?.bun !== 'string' || !manifest.builder.bun
    || typeof manifest.builder.platform !== 'string' || typeof manifest.builder.arch !== 'string') throw new Error('Invalid or mismatched Provider build manifest')
  const path = join(directory, artifactName)
  if (!lstatSync(path).isFile()) throw new Error('Provider artifact must be a regular file')
  const bytes = readFileSync(path)
  if (bytes.length !== manifest.artifact.size || hash(bytes) !== manifest.artifact.digest) throw new Error('Provider artifact digest mismatch')
  return manifest
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 4 || args[0] !== '--directory' || args[2] !== '--revision') throw new Error('Usage: node scripts/http-agent-artifact.mjs --directory <build> --revision <full-source-sha>')
  const manifest = verifyProviderArtifact(args[1], args[3])
  console.log(JSON.stringify({ source_revision: manifest.source.revision, artifact_digest: manifest.artifact.digest }))
}
