/** Exercise the production operator bootstrap and signed runtime identity on a native daemon. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NexusZoneApiClient, createUserRuntimeCredentialBundle } from '@nexus-ai-fs/vfs-client'
import { provisionMossIssuer } from '../../deploy/nexus/mossIssuer.js'
import { startIsolatedNexus } from './fixtures/isolated-nexus.js'

assert(process.argv[2], 'Installed native daemon is required')
const artifacts = process.env.MOSS_NEXUS_LIVE_ARTIFACTS ?? tmpdir()
mkdirSync(artifacts, { recursive: true })
const results = mkdtempSync(join(artifacts, 'moss-node-issuer-'))
const node = await startIsolatedNexus(resolve(process.argv[2]))
let isPassed = false
try {
  const first = await provisionMossIssuer(node.data, node.endpoint)
  const files = [first.tls.ca, first.tls.cert, first.tls.key]
  const before = files.map(path => createHash('sha256').update(readFileSync(path)).digest('hex'))
  const repeated = await provisionMossIssuer(node.data, node.endpoint)
  assert.deepEqual(repeated, first)
  assert.deepEqual(files.map(path => createHash('sha256').update(readFileSync(path)).digest('hex')), before,
    'repeated operator bootstrap must preserve the existing private identity')
  const issuer = NexusZoneApiClient.withMtls(first.endpoint, first.tls)
  try {
    const owner = `owner-e2e-${randomUUID()}`
    const credential = await issuer.mintUserRuntime(owner, { validitySecs: 120 })
    const bundle = createUserRuntimeCredentialBundle(owner, credential)
    assert(bundle.manifest.length > 0 && Object.keys(bundle.files).length > 0)
    assert.throws(() => createUserRuntimeCredentialBundle('foreign-owner', credential), /owner/)
  } finally { issuer.close() }
  isPassed = true
} finally {
  await node.stop()
  writeFileSync(join(results, 'acceptance.json'), JSON.stringify({ success: isPassed,
    checks: ['read-only issuer readiness', 'production operator provisioning', 'idempotent private credentials',
      'signed owner runtime credential', 'foreign owner bundle refused'] }, null, 2))
}
