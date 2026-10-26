/** Own a native TLS founder for acceptance journeys on every supported platform. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** Keep daemon files, inherited configuration and termination within one owned fixture. */
export async function startIsolatedNexus(binary: string) {
  const privateRoot = mkdtempSync(join(tmpdir(), 'moss-authenticated-runtime-'))
  const data = join(privateRoot, 'data')
  const plugins = join(privateRoot, 'plugins')
  mkdirSync(plugins)
  const reservation = createServer()
  await new Promise<void>((resolvePort, reject) => {
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', resolvePort)
  })
  const address = reservation.address()
  assert(address && typeof address !== 'string')
  const endpoint = `127.0.0.1:${address.port}`
  await new Promise<void>((resolvePort, reject) => reservation.close(error => error ? reject(error) : resolvePort()))
  const environment = { ...process.env }
  for (const key of Object.keys(environment))
    if (key.startsWith('NEXUS_') || key.startsWith('MOSS_')) delete environment[key]
  const log = openSync(join(privateRoot, 'daemon.log'), 'wx', 0o600)
  const daemon = spawn(binary, ['--cluster-init', `owner-ci-${randomUUID()}`, '--hostname', 'owner-e2e',
    '--advertise-addr', endpoint, '--bind-addr', endpoint, '--data-dir', data,
    '--identity-dir', join(privateRoot, 'identity'), '--plugin-dir', plugins], {
    env: environment, stdio: ['ignore', log, log], windowsHide: true,
  })
  closeSync(log)
  let spawnError: Error | undefined
  daemon.once('error', error => { spawnError = error })
  const stop = async (): Promise<void> => {
    if (daemon.pid === undefined || daemon.exitCode !== null || daemon.signalCode !== null) return
    const exited = once(daemon, 'exit')
    daemon.kill('SIGTERM')
    const timer = setTimeout(() => daemon.kill('SIGKILL'), 10_000)
    timer.unref()
    try { await exited } finally { clearTimeout(timer) }
  }
  try {
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError
      assert(daemon.exitCode === null && daemon.signalCode === null, 'the isolated issuer exited during startup')
      if (['ca.pem', 'node.pem', 'node-key.pem'].every(name => existsSync(join(data, 'tls', name)))) {
        const isListening = await new Promise<boolean>(resolveReady => {
          const socket = createConnection({ host: '127.0.0.1', port: address.port })
          const finish = (value: boolean) => { socket.destroy(); resolveReady(value) }
          socket.once('connect', () => finish(true))
          socket.once('error', () => finish(false))
          socket.setTimeout(500, () => finish(false))
        })
        if (isListening) return { privateRoot, data, endpoint, environment, stop }
      }
      await delay(250)
    }
    throw new Error('The isolated issuer must bootstrap its own identity and listener')
  } catch (error) {
    await stop()
    throw error
  }
}
