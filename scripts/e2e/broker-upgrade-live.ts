/**
 * Real daemon upgrade and rollback with TLS, persisted VFS files and Vault.
 * Usage: node <bundled script> <old daemon> <new daemon> <plugin dir> <evidence dir>
 * Keep the generated data, identity and logs for diagnosis. No model key needed.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { NexusVfsClient } from '@nexus-ai-fs/vfs-client'
import { NexusSecretClient } from '../../src/server/nexus/nexusSecretClient.js'

const [oldBinary, newBinary, plugins, evidence] = process.argv.slice(2)
assert(oldBinary && newBinary && plugins && evidence, 'four arguments are required')
const oldVersion = execFileSync(oldBinary, ['--version'], { encoding: 'utf8' }).trim()
const newVersion = execFileSync(newBinary, ['--version'], { encoding: 'utf8' }).trim()
assert.match(oldVersion, /plugin-abi 7/)
assert.match(newVersion, /v0\.8\.0 .*plugin-abi 7/)
mkdirSync(evidence, { recursive: true })
const root = mkdtempSync(join(evidence, 'broker-upgrade-'))
const data = join(root, 'data')
const identity = join(root, 'identity')
const tls = join(data, 'tls')
const reserve = createServer()
await new Promise<void>((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve) })
const addr = reserve.address()
assert(addr && typeof addr !== 'string')
const endpoint = `127.0.0.1:${addr.port}`
await new Promise<void>((resolve, reject) => reserve.close(e => e ? reject(e) : resolve()))
let daemon: ChildProcess | undefined
let client: NexusVfsClient | undefined
let log: number | undefined
const stages: string[] = []

async function stop() {
  client?.close()
  client = undefined
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    const exited = once(daemon, 'exit')
    daemon.kill('SIGTERM')
    await Promise.race([exited, delay(10000).then(() => { throw new Error('daemon did not stop cleanly') })])
  }
  daemon = undefined
  if (log !== undefined) closeSync(log)
  log = undefined
}

async function start(binary: string, stage: string) {
  log = openSync(join(root, `${stage}.log`), 'a')
  daemon = spawn(binary, ['--cluster-init', 'upgrade-live', '--hostname', 'upgrade-live',
    '--advertise-addr', endpoint, '--data-dir', data, '--identity-dir', identity, '--plugin-dir', plugins],
  { env: { ...process.env, NEXUS_DATA_DIR: data, NEXUS_IDENTITY_DIR: identity }, stdio: ['ignore', log, log] })
  const limit = Date.now() + 30000
  while (!existsSync(join(tls, 'node-key.pem'))) {
    assert(daemon.exitCode === null && daemon.signalCode === null, `${stage} exited during TLS bootstrap`)
    assert(Date.now() < limit, `${stage} TLS bootstrap timed out`)
    await delay(100)
  }
  client = NexusVfsClient.withMtls(endpoint, {
    ca: join(tls, 'ca.pem'), cert: join(tls, 'node.pem'), key: join(tls, 'node-key.pem'), serverName: 'nexus-node',
  }, { connectTimeoutMs: 1000 })
  for (;;) {
    try { await client.serverInfo(''); break } catch (e) {
      assert(daemon.exitCode === null && daemon.signalCode === null, `${stage} exited before readiness`)
      if (Date.now() >= limit) throw e
      await delay(100)
    }
  }
  stages.push(stage)
  return { files: client, vault: new NexusSecretClient(client, '') }
}

const nonce = randomUUID()
const path = `/upgrade-live-${nonce}/order.json`
const namespace = `upgrade-live-${nonce}`
const initial = JSON.stringify({ code: nonce, subtotal: 791 })
const updated = JSON.stringify({ code: nonce, total: 804 })
try {
  const old = await start(oldBinary, 'old-write')
  await old.files.mkdir(`/upgrade-live-${nonce}`, '', { parents: true })
  await old.files.write(path, Buffer.from(initial), '')
  assert.equal((await old.files.read(path, '')).toString(), initial)
  await old.vault.putSecret(namespace, 'fixture', `first-${nonce}`)
  assert.equal((await old.vault.getSecret(namespace, 'fixture')).value, `first-${nonce}`)
  await stop()
  const caBefore = readFileSync(join(tls, 'ca.pem'))

  const next = await start(newBinary, 'new-read-update')
  assert.equal((await next.files.read(path, '')).toString(), initial)
  assert.deepEqual(await next.vault.getSecret(namespace, 'fixture'), { value: `first-${nonce}`, version: 1 })
  assert.deepEqual(readFileSync(join(tls, 'ca.pem')), caBefore, 'upgrade must keep cluster CA')
  await next.files.write(path, Buffer.from(updated), '')
  await next.vault.putSecret(namespace, 'fixture', `updated-${nonce}`)
  await stop()

  const rollback = await start(oldBinary, 'old-rollback-read')
  assert.equal((await rollback.files.read(path, '')).toString(), updated)
  assert.deepEqual(await rollback.vault.getSecret(namespace, 'fixture'), { value: `updated-${nonce}`, version: 2 })
  await stop()
  const final = await start(newBinary, 'new-final-read')
  assert.equal((await final.files.read(path, '')).toString(), updated)
  assert.deepEqual(await final.vault.getSecret(namespace, 'fixture'), { value: `updated-${nonce}`, version: 2 })
  writeFileSync(join(root, 'acceptance.json'), JSON.stringify({ oldVersion, newVersion, nonce, stages,
    checks: ['old-write', 'TLS-preserved', 'VFS-preserved', 'Vault-preserved', 'new-write', 'rollback-read', 'upgrade-again-read'] }, null, 2))
  console.log(`PASS real TLS/VFS/Vault upgrade and rollback: ${root}`)
} finally {
  await stop()
}
