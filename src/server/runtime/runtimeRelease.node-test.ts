import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RuntimeReleaseSchema, requirePairedEngine, parseCohostBuild } from './runtimeRelease.js'

const cohost = 'nexusd-cohost v0.2.28 (sudocode c28a06b, nexus-vfs v0.8.10) (nexus-cluster 0.8.10, plugin-abi 7)'
void test('shared release records the actual engine commit and the compiled Nexus pairing', () => {
  assert.deepEqual(requirePairedEngine('Sudo Code\n  Version 0.2.28\n  Git SHA c28a06b\n', cohost), {
    engine: { version: '0.2.28', commit: 'c28a06b' },
    cohost: { version: '0.2.28', commit: 'c28a06b', nexusVersion: '0.8.10', pluginAbi: 7 },
  })
  assert.throws(() => requirePairedEngine('Version 0.2.28\nGit SHA bbbbbbb', cohost), /same verified engine/)
  assert.throws(() => parseCohostBuild('nexusd-cluster 0.8.10'), /provenance/)
})
void test('an image config digest is labeled honestly and mutable latest references are refused', () => {
  const digest = `sha256:${'a'.repeat(64)}`
  const manifest = { schemaVersion: 1, releaseId: 'server-v0.1.51', engine: { version: '0.2.28', commit: 'c28a06b' },
    cohost: { version: '0.2.28', nexusVersion: '0.8.10', pluginAbi: 7, binaryDigest: digest },
    issuerVersion: '0.8.11', image: { reference: 'docker.io/library/my-moss-runtime:0.1.51-amd64', digest, digestKind: 'oci-config' },
    archive: { name: 'moss-runtime-0.1.51-linux-amd64.tar.gz', digest } }
  assert.equal(RuntimeReleaseSchema.parse(manifest).image.digestKind, 'oci-config')
  assert.equal(RuntimeReleaseSchema.safeParse({ ...manifest, image: { ...manifest.image, reference: 'runtime:latest' } }).success, false)
  assert.equal(RuntimeReleaseSchema.safeParse({ ...manifest, archive: { ...manifest.archive, name: '../image.tar.gz' } }).success, false)
})
