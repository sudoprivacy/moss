/**
 * Exercise the installed daemon and signed vault through Moss's real manager
 * and published SDK. Run from the repo root after fetching the runtime:
 *   bun scripts/fetch-nexus-runtime.js
 *   bun build --target=node scripts/e2e/embedded-nexus-live.ts --outfile bin/embedded-nexus-live.mjs
 *   node bin/embedded-nexus-live.mjs
 * The fresh data directory is retained for diagnosis; no account is required.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NexusVfsClient } from '@nexus-ai-fs/vfs-client'

import { NexusManager } from '../../src/server/nexus/nexusManager.js'
import { NexusSecretClient } from '../../src/server/nexus/nexusSecretClient.js'
import versions from '../../src/server/nexus/runtime-versions.json' with { type: 'json' }

const artifacts = process.env.MOSS_NEXUS_LIVE_ARTIFACTS ?? tmpdir()
mkdirSync(artifacts, { recursive: true })
const nexusDir = mkdtempSync(join(artifacts, 'moss-runtime-live-'))
// The daemon's identity has a separate default location from its data dir.
// Keep both isolated, including on hosts with an existing Nexus installation.
const previousIdentityDir = process.env.NEXUS_IDENTITY_DIR
process.env.NEXUS_IDENTITY_DIR = join(nexusDir, 'identity')
console.log(`Runtime evidence: ${nexusDir}`)
const reservation = createServer()
await new Promise<void>((resolve, reject) => {
  reservation.once('error', reject)
  reservation.listen(0, '127.0.0.1', resolve)
})
const address = reservation.address()
assert(address && typeof address !== 'string')
const grpcPort = address.port
await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))

const manager = new NexusManager({ nexusDir, config: { mode: 'embedded', grpcPort } })
const nonce = randomUUID()
let client: NexusVfsClient | undefined
try {
  await manager.start()
  client = new NexusVfsClient(manager.grpcUrl)
  await client.serverInfo('')
  let secrets = new NexusSecretClient(client, '')
  const namespace = `runtime-live-${nonce}`
  const first = await secrets.putSecret(namespace, 'fixture', `first-${nonce}`)
  assert.equal(first.currentVersion, 1)
  assert.equal((await secrets.getSecret(namespace, 'fixture')).value, `first-${nonce}`)
  const updated = await secrets.putSecret(namespace, 'fixture', `updated-${nonce}`)
  assert.equal(updated.currentVersion, 2)
  client.close()
  client = undefined
  await manager.stop()

  // Reopen the same real data directory, verifying persistence and plugin
  // compatibility beyond merely accepting a TCP connection.
  await manager.start()
  client = new NexusVfsClient(manager.grpcUrl)
  secrets = new NexusSecretClient(client, '')
  const restored = await secrets.getSecret(namespace, 'fixture')
  assert.deepEqual(restored, { value: `updated-${nonce}`, version: 2 })
  assert.equal(await secrets.deleteSecret(namespace, 'fixture'), true)
  assert.deepEqual(await secrets.batchGet([{ namespace, key: 'fixture' }]), {})
  assert.equal(await secrets.restoreSecret(namespace, 'fixture'), true)
  assert.equal((await secrets.getSecret(namespace, 'fixture')).value, `updated-${nonce}`)
  writeFileSync(join(nexusDir, 'acceptance.json'), JSON.stringify({
    daemon: versions['nexusd-cluster'], vault: versions['nexus-vault'], nonce,
    checks: ['start', 'write', 'read', 'update', 'restart', 'persist', 'delete', 'restore'],
  }, null, 2))
  console.log('PASS: installed runtime, signed vault and SDK preserve values across restart')
} finally {
  client?.close()
  await manager.stop()
  if (previousIdentityDir === undefined) delete process.env.NEXUS_IDENTITY_DIR
  else process.env.NEXUS_IDENTITY_DIR = previousIdentityDir
}
