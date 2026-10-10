/** Verify an existing TLS broker using only fresh operator-owned fixtures. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NexusVfsClient } from '@nexus-ai-fs/vfs-client'
import { NexusSecretClient } from '../../src/server/nexus/nexusSecretClient.js'

const [endpoint, tls, mode, stateFile] = process.argv.slice(2)
assert(endpoint && tls && stateFile && (mode === 'write' || mode === 'verify'), 'endpoint, TLS dir, write/verify and state file required')
const client = NexusVfsClient.withMtls(endpoint, {
  ca: join(tls, 'ca.pem'), cert: join(tls, 'node.pem'), key: join(tls, 'node-key.pem'), serverName: 'nexus-node',
}, { connectTimeoutMs: 10000 })
const secrets = new NexusSecretClient(client, '')
try {
  const info = await client.serverInfo('')
  const state = mode === 'write'
    ? { nonce: randomUUID(), subtotal: 791, total: 804 }
    : JSON.parse(readFileSync(stateFile, 'utf8')) as { nonce: string; subtotal: number; total: number }
  assert.match(state.nonce, /^[0-9a-f-]{36}$/)
  const dir = `/runtime-upgrade-pc3/${state.nonce}`
  const file = `${dir}/order.json`
  const namespace = `runtime-upgrade-pc3-${state.nonce}`
  if (mode === 'write') {
    await client.mkdir(dir, '', { parents: true })
    await client.write(file, Buffer.from(JSON.stringify(state)), '')
    await secrets.putSecret(namespace, 'fixture', `first-${state.nonce}`)
    await secrets.putSecret(namespace, 'fixture', `updated-${state.nonce}`)
    writeFileSync(stateFile, JSON.stringify(state, null, 2))
  }
  assert.deepEqual(JSON.parse((await client.read(file, '')).toString()), state)
  assert.deepEqual(await secrets.getSecret(namespace, 'fixture'), { value: `updated-${state.nonce}`, version: 2 })
  console.log(JSON.stringify({ passed: true, mode, nonce: state.nonce, file, vaultVersion: 2,
    zone: info.zone_id, kernelVersion: info.version }))
} finally {
  client.close()
}
