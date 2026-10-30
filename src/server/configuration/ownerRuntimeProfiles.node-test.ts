import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { UserPodService } from '@sudo/user-runtime'
import type { RuntimeRelease } from '@sudo/user-runtime/release'
import { serverFileConfigSchema } from '../types.js'
import { readOwnerRuntimeOverrides } from './ownerRuntimeProfiles.js'

void test('deployment profiles select the verified owner release while default owners retain their image', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'moss-owner-profiles-'))
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert(directory.startsWith(join(resolve(tmpdir()), 'moss-owner-profiles-')))
    await rm(directory, { recursive: true, force: true })
  })
  const owner = randomUUID(), other = randomUUID()
  const digest = `sha256:${'a'.repeat(64)}`
  const release: RuntimeRelease = { schemaVersion: 1, releaseId: 'owner-profile-test',
    engine: { version: '0.2.37', commit: 'abcdef0' },
    cohost: { version: '0.2.37', nexusVersion: '0.8.26', pluginAbi: 7, binaryDigest: digest },
    issuerVersion: '0.8.26', image: { reference: 'runtime:profile-test', digest, digestKind: 'oci-config' },
    archive: { name: 'runtime-test.tar.gz', digest } }
  const manifest = join(directory, 'runtime-release.json'), configPath = join(directory, 'server.json')
  await writeFile(manifest, JSON.stringify(release))
  const analyzerRelay = { image: 'relay:verified', secretName: 'classifier' }
  await writeFile(configPath, JSON.stringify({ k8s: { ownerRuntimeOverrides: {
    [owner]: { runtimeManifestPath: manifest, analyzerRelay },
  } } }))
  const config = serverFileConfigSchema().parse(JSON.parse(await readFile(configPath, 'utf8')))
  const overrides = readOwnerRuntimeOverrides(config.k8s!.ownerRuntimeOverrides)
  assert.deepEqual(overrides![owner], { release, egressAnalyzerRelay: analyzerRelay })
  const runtime = new UserPodService({ image: 'runtime:retained', namespace: 'test', nodeHost: 'compute.internal',
    storageClass: 'retained', issuer: { endpoint: 'https://issuer.internal', tls: { ca: '/ca', cert: '/cert', key: '/key' } },
    ownerRuntimeOverrides: overrides }, { read: async () => undefined, write: async () => { throw new Error('Inspection must not provision') } },
  async () => { throw new Error('Inspection must not start a runtime') })
  t.after(() => runtime.close())
  assert.equal((await runtime.inspect(owner)).expectedImage, release.image.reference)
  assert.equal((await runtime.inspect(other)).expectedImage, 'runtime:retained')
  assert.equal(await runtime.find(owner), undefined)
  assert.equal(readOwnerRuntimeOverrides(undefined), undefined)
  assert.throws(() => readOwnerRuntimeOverrides({ [owner]: { runtimeManifestPath: 'relative.json' } }), /absolute/)
  await writeFile(manifest, JSON.stringify({ ...release, image: { ...release.image, reference: 'runtime:latest' } }))
  assert.throws(() => readOwnerRuntimeOverrides(config.k8s!.ownerRuntimeOverrides))
})

void test('deployment profiles reject foreign configuration fields and conflicting analyzer placements', () => {
  const owner = randomUUID(), base = { runtimeManifestPath: '/private/release.json' }
  assert.throws(() => serverFileConfigSchema().parse({ k8s: { ownerRuntimeOverrides: {
    [owner]: { ...base, issuer: { endpoint: 'https://other-issuer' } },
  } } }))
  assert.throws(() => serverFileConfigSchema().parse({ k8s: { ownerRuntimeOverrides: {
    [owner]: { ...base, analyzerImage: 'analyzer:verified', analyzerRelay: { image: 'relay:verified', secretName: 'classifier' } },
  } } }))
  assert.throws(() => serverFileConfigSchema().parse({ k8s: { ownerRuntimeOverrides: { 'not-a-user-id': base } } }))
})
