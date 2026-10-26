/** Bootstrap an isolated real issuer and run the existing session ownership journey. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const [binaryInput, probeInput] = process.argv.slice(2)
assert(binaryInput && probeInput, 'Installed daemon and bundled ownership probe are required')
const binary = resolve(binaryInput)
const probe = resolve(probeInput)
const privateRoot = mkdtempSync(join(tmpdir(), 'moss-authenticated-runtime-'))
const data = join(privateRoot, 'data')
const identity = join(privateRoot, 'identity')
const plugins = join(privateRoot, 'plugins')
mkdirSync(plugins)
const artifacts = process.env.MOSS_NEXUS_LIVE_ARTIFACTS ?? tmpdir()
mkdirSync(artifacts, { recursive: true })
const results = mkdtempSync(join(artifacts, 'moss-session-owner-'))
const reservation = createServer()
await new Promise<void>((resolvePort, reject) => {
  reservation.once('error', reject)
  reservation.listen(0, '127.0.0.1', resolvePort)
})
const address = reservation.address()
assert(address && typeof address !== 'string')
const port = address.port
await new Promise<void>((resolvePort, reject) => reservation.close(error => error ? reject(error) : resolvePort()))
const endpoint = `127.0.0.1:${port}`
const environment = { ...process.env }
for (const key of Object.keys(environment)) {
  if (key.startsWith('NEXUS_') || key.startsWith('MOSS_')) delete environment[key]
}
const log = openSync(join(privateRoot, 'daemon.log'), 'wx', 0o600)
const daemon = spawn(binary, ['--cluster-init', `owner-ci-${randomUUID()}`, '--hostname', 'owner-e2e',
  '--advertise-addr', endpoint, '--bind-addr', endpoint, '--data-dir', data, '--identity-dir', identity,
  '--plugin-dir', plugins], { env: environment, stdio: ['ignore', log, log], windowsHide: true })
closeSync(log)
let spawnError: Error | undefined
daemon.once('error', error => { spawnError = error })
let isPassed = false
try {
  const deadline = Date.now() + 90_000
  let isReady = false
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError
    assert(daemon.exitCode === null && daemon.signalCode === null, 'the isolated issuer exited during startup')
    if (['ca.pem', 'node.pem', 'node-key.pem'].every(name => existsSync(join(data, 'tls', name)))) {
      isReady = await new Promise<boolean>(resolveReady => {
        const socket = createConnection({ host: '127.0.0.1', port })
        const finish = (value: boolean) => { socket.destroy(); resolveReady(value) }
        socket.once('connect', () => finish(true))
        socket.once('error', () => finish(false))
        socket.setTimeout(500, () => finish(false))
      })
      if (isReady) break
    }
    await delay(250)
  }
  assert(isReady, 'the isolated issuer must bootstrap its own identity and listener')
  const child = spawn(process.execPath, [probe, join(data, 'tls'), endpoint], {
    env: { ...environment, TMPDIR: privateRoot, TMP: privateRoot, TEMP: privateRoot },
    stdio: 'inherit', windowsHide: true, timeout: 60_000,
  })
  const [exitCode, signal] = await once(child, 'exit')
  assert.equal(signal, null, 'the ownership journey must finish before its deadline')
  assert.equal(exitCode, 0, 'the real mTLS ownership journey must pass')
  isPassed = true
} finally {
  if (daemon.exitCode === null && daemon.signalCode === null) {
    const exited = once(daemon, 'exit')
    daemon.kill('SIGTERM')
    const timer = setTimeout(() => daemon.kill('SIGKILL'), 10_000)
    timer.unref()
    await exited
    clearTimeout(timer)
  }
  writeFileSync(join(results, 'acceptance.json'), JSON.stringify({
    success: isPassed, daemonSha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
    checks: ['real isolated issuer', 'Node-authorized session minter', 'user-bound mTLS credential',
      'certificate-derived session owner', 'foreign body owner refused', 'foreign certificate refused',
      'bare issuer refused', 'owned child cleanup'],
  }, null, 2))
  console.log(`Ownership acceptance: ${results}`)
}
