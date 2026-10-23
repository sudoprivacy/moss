import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { providerBuildSource, writeProviderManifest, verifyProviderArtifact } from '../http-agent-artifact.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'provider-artifact-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.name', 'Artifact Test')
  git('config', 'user.email', 'artifact@example.test')
  git('remote', 'add', 'origin', 'https://github.com/sudoprivacy/moss.git')
  writeFileSync(join(root, 'bun.lock'), 'fixture lock\n')
  writeFileSync(join(root, '.gitignore'), 'dist/\n')
  git('add', '.')
  git('commit', '-qm', 'Fixture source')
  const directory = join(root, 'dist')
  mkdirSync(directory)
  const artifact = join(directory, 'http-agent-provider.mjs')
  writeFileSync(artifact, 'console.log("fixture, not a release");\n')
  const source = providerBuildSource(root)
  const build = () => writeProviderManifest(root, directory, source, { bun: 'test', platform: 'test', arch: 'test' })
  return { root, directory, artifact, source, git, build }
}

test('candidate verifies against independently pinned source and exact executable bytes', t => {
  const f = fixture(t)
  const manifest = f.build()
  assert.deepEqual(verifyProviderArtifact(f.directory, f.source.revision), manifest)
  assert.throws(() => verifyProviderArtifact(f.directory, 'main'), /full/)
  assert.throws(() => verifyProviderArtifact(f.directory, '0'.repeat(40)), /mismatched/)
  writeFileSync(f.artifact, 'changed executable')
  assert.throws(() => verifyProviderArtifact(f.directory, f.source.revision), /digest mismatch/)
})

test('tracked edits, staged edits and concurrent source changes cannot carry a clean source claim', t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'bun.lock'), 'changed dependency lock\n')
  assert.throws(() => providerBuildSource(f.root), /Commit tracked changes/)
  f.git('add', 'bun.lock')
  assert.throws(f.build, /Commit tracked changes/)
  f.git('commit', '-qm', 'Next source')
  assert.throws(f.build, /source changed during build/)
})

test('artifact manifest cannot select paths, substitute a symlink, or change repository', t => {
  const f = fixture(t)
  const manifest = f.build()
  const path = join(f.directory, 'artifact-manifest.json')
  writeFileSync(path, JSON.stringify({ ...manifest, artifact: { ...manifest.artifact, name: '../bun.lock' } }))
  assert.throws(() => verifyProviderArtifact(f.directory, f.source.revision), /Invalid/)
  writeFileSync(path, JSON.stringify(manifest))
  rmSync(f.artifact)
  symlinkSync(join(f.root, 'bun.lock'), f.artifact)
  assert.throws(() => verifyProviderArtifact(f.directory, f.source.revision), /regular file/)
  f.git('remote', 'set-url', 'origin', 'https://example.test/untrusted/moss.git')
  assert.throws(() => providerBuildSource(f.root), /repository/)
  assert.equal(readFileSync(join(f.root, 'bun.lock'), 'utf8'), 'fixture lock\n')
})
