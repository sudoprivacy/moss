#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

const READINESS_TIMEOUT_MS = 180_000

function parseArgs(argv) {
  const options = { archive: '', databaseUrl: '', workDir: '', report: '' }
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!value || !['--archive', '--database-url', '--work-dir', '--report'].includes(key)) {
      throw new Error(`Unknown or incomplete argument: ${key ?? '(missing)'}`)
    }
    options[key.slice(2).replaceAll('-', '')] = value
  }
  if (!options.archive || !options.databaseurl || !options.workdir || !options.report) {
    throw new Error('--archive, --database-url, --work-dir, and --report are required')
  }
  return {
    archive: path.resolve(options.archive),
    databaseUrl: options.databaseurl,
    workDir: path.resolve(options.workdir),
    report: path.resolve(options.report),
  }
}

export async function reservePorts(count) {
  const reservations = []
  try {
    for (let index = 0; index < count; index += 1) {
      const server = net.createServer()
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      let closing
      reservations.push({
        port: address.port,
        release: () => closing ??= new Promise((resolve, reject) =>
          server.close(error => error ? reject(error) : resolve())),
      })
    }
    return reservations
  } catch (error) {
    await Promise.all(reservations.map(reservation => reservation.release()))
    throw error
  }
}

function databaseUrl(base, database) {
  const url = new URL(base)
  url.pathname = `/${database}`
  return url.toString()
}

async function request(baseUrl, pathname, init = {}, expected = 200) {
  const response = await fetch(`${baseUrl}${pathname}`, { ...init, signal: AbortSignal.timeout(30_000) })
  const text = await response.text()
  if (response.status !== expected) {
    throw new Error(`${init.method ?? 'GET'} ${pathname}: expected ${expected}, got ${response.status}: ${text.slice(0, 300)}`)
  }
  return text ? JSON.parse(text) : null
}

export async function waitReady(baseUrl, child, expectedInstanceId) {
  const deadline = Date.now() + READINESS_TIMEOUT_MS
  let lastError = null
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited before readiness with code ${child.exitCode}`)
    let ready
    try {
      ready = await request(baseUrl, '/readyz')
    } catch (error) {
      lastError = error
    }
    if (ready?.ready === true) {
      assert.equal(ready.instance_id, expectedInstanceId,
        `Expected instance ${expectedInstanceId} at ${baseUrl}, received ${ready.instance_id}`)
      return
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(
    `readiness timed out for ${baseUrl}` +
      (lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ''),
  )
}

async function stop(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = new Promise(resolve => child.once('exit', resolve))
  let timer
  try {
    const timeout = new Promise(resolve => {
      timer = setTimeout(resolve, 15_000, 'timeout')
    })
    if (await Promise.race([exited, timeout]) === 'timeout') {
      child.kill('SIGKILL')
      await exited
    }
  } finally {
    clearTimeout(timer)
  }
}

function startInstance({ node, entry, appDir, configPath, database, id, nexusPort, logPath }) {
  const log = createWriteStream(logPath, { flags: 'a' })
  const config = JSON.parse(requireText(configPath))
  const homeDir = path.join(config.storage.rootDir, 'home')
  const child = spawn(node, [entry, 'start'], {
    cwd: appDir,
    env: {
      ...process.env,
      MOSS_SERVER_CONFIG: configPath,
      MOSS_DATABASE_URL: database,
      MOSS_DB_BACKEND: 'postgres',
      MOSS_INSTANCE_ID: id,
      MOSS_PUBLIC_BASE_URL: `http://127.0.0.1:${config.server.port}`,
      MOSS_AUTH_PROXY_PORT: '0',
      MOSS_NEXUS_GRPC_PORT: String(nexusPort),
      HOME: homeDir,
      XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  child.once('exit', () => log.end())
  return child
}

const configCache = new Map()
function requireText(file) {
  const value = configCache.get(file)
  if (!value) throw new Error(`Configuration was not cached: ${file}`)
  return value
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  await rm(options.workDir, { recursive: true, force: true })
  await mkdir(options.workDir, { recursive: true })
  await mkdir(path.dirname(options.report), { recursive: true })
  const extractDir = path.join(options.workDir, 'unpacked')
  await mkdir(extractDir, { recursive: true })
  const extracted = spawnSync('tar', ['-xzf', options.archive, '-C', extractDir], { encoding: 'utf8' })
  if (extracted.status !== 0) throw new Error(`archive extraction failed: ${extracted.stderr}`)

  const packageRoot = path.join(extractDir, 'moss-server')
  const appDir = path.join(packageRoot, 'app')
  const node = path.join(packageRoot, 'node', 'bin', 'node')
  const entry = path.join(appDir, 'bin', 'moss-server.mjs')
  const bundleSha256 = createHash('sha256').update(await readFile(entry)).digest('hex')
  const admin = new Pool({ connectionString: options.databaseUrl, max: 2 })
  const databaseName = `moss_packaged_pg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const database = databaseUrl(options.databaseUrl, databaseName)
  // Hold all four ports simultaneously; releasing each allocation immediately
  // can let the OS return the same port for two supposedly independent servers.
  const reservations = await reservePorts(4)
  const ports = reservations.slice(0, 2).map(reservation => reservation.port)
  const nexusPorts = reservations.slice(2).map(reservation => reservation.port)
  const instanceIds = ['packaged-pg-a', 'packaged-pg-b']
  const username = 'packaged-root'
  const password = 'PackagedStrongPass123'
  const keyRequests = []
  const processes = []
  const report = {
    status: 'failed', backend: 'postgres', instanceIds, ports, nexusPorts, bundleSha256,
    firstStart: false, restart: false, keyRequests, controllerIdentities: [],
  }
  let shared
  async function checkControllerIdentities(label, indexes) {
    const rows = (await shared.query("SELECT instance_id, pid FROM server_instances WHERE status = 'running' ORDER BY instance_id")).rows.map(row => ({ instance_id: row.instance_id, pid: Number(row.pid) }))
    const expected = indexes.map(index => ({ instance_id: instanceIds[index], pid: processes[index].pid }))
    assert.deepEqual(rows, expected, 'Each server process must register exactly one controller identity')
    for (const row of rows) {
      const peers = await shared.query("SELECT COUNT(*) AS total FROM server_instances WHERE instance_id != $1 AND status = 'running' AND heartbeat_at >= $2", [row.instance_id, Date.now() - 30_000])
      assert.equal(Number(peers.rows[0].total), indexes.length - 1, 'Exclude self while retaining genuine peers')
    }
    report.controllerIdentities.push({ label, instances: rows })
  }

  try {
    await admin.query(`CREATE DATABASE ${databaseName}`)
    shared = new Pool({ connectionString: database, max: 2 })
    const configs = []
    for (let index = 0; index < 2; index += 1) {
      const runtimeRoot = path.join(options.workDir, `instance-${index + 1}`)
      const configPath = path.join(runtimeRoot, 'server.json')
      const config = {
        server: { host: '127.0.0.1', port: ports[index], publicBaseUrl: `http://127.0.0.1:${ports[index]}` },
        bootstrapAdmin: { username, password, email: 'packaged-root@example.test' },
        storage: {
          rootDir: runtimeRoot,
          dbPath: path.join(runtimeRoot, 'unused.sqlite'),
          transcriptDir: path.join(runtimeRoot, 'transcripts'),
          runtimeDir: path.join(runtimeRoot, 'runtime'),
          dbBackend: 'postgres',
        },
        wikiIndex: { enabled: false },
      }
      await mkdir(runtimeRoot, { recursive: true })
      const json = JSON.stringify(config)
      configCache.set(configPath, json)
      await writeFile(configPath, `${json}\n`)
      configs.push(configPath)
    }

    const launch = async index => {
      await Promise.all([reservations[index].release(), reservations[index + 2].release()])
      const child = startInstance({
        node, entry, appDir, configPath: configs[index], database,
        id: instanceIds[index], nexusPort: nexusPorts[index],
        logPath: path.join(options.workDir, `instance-${index + 1}.log`),
      })
      processes[index] = child
      return child
    }

    await launch(0)
    await waitReady(`http://127.0.0.1:${ports[0]}`, processes[0], instanceIds[0])
    await checkControllerIdentities('single-start', [0])
    await launch(1)
    await Promise.all(ports.map((port, index) => waitReady(`http://127.0.0.1:${port}`, processes[index], instanceIds[index])))
    await checkControllerIdentities('dual-start', [0, 1])
    report.firstStart = true
    keyRequests.push('dual-readyz:first-start')

    const login = await request(`http://127.0.0.1:${ports[0]}`, '/api/v1/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', username, password }),
    })
    if (typeof login?.access_token !== 'string') throw new Error('login returned no access token')
    const headers = { authorization: `Bearer ${login.access_token}`, 'content-type': 'application/json' }
    keyRequests.push('login:instance-a')
    const marker = `packaged-${Date.now()}`
    await request(`http://127.0.0.1:${ports[0]}`, '/api/v1/config-items', {
      method: 'POST', headers,
      body: JSON.stringify({ name: marker, pinyin: marker, scope: 'system', entries: [] }),
    }, 201)
    keyRequests.push('write:instance-a')
    const crossRead = await request(
      `http://127.0.0.1:${ports[1]}`,
      `/api/v1/config-items?name=${encodeURIComponent(marker)}`,
      { headers },
    )
    if (!crossRead?.data?.some?.(item => item.name === marker)) throw new Error('instance B did not observe instance A write')
    keyRequests.push('read:instance-b')

    await Promise.all(processes.map(stop))
    await checkControllerIdentities('stopped', [])
    processes.length = 0
    await Promise.all([launch(0), launch(1)])
    await Promise.all(ports.map((port, index) => waitReady(`http://127.0.0.1:${port}`, processes[index], instanceIds[index])))
    await checkControllerIdentities('dual-restart', [0, 1])
    const afterRestart = await request(
      `http://127.0.0.1:${ports[1]}`,
      `/api/v1/config-items?name=${encodeURIComponent(marker)}`,
      { headers },
    )
    if (!afterRestart?.data?.some?.(item => item.name === marker)) throw new Error('restart lost shared PostgreSQL data')
    report.restart = true
    report.status = 'passed'
    keyRequests.push('dual-readyz:restart', 'read-after-restart:instance-b')
  } finally {
    await Promise.all(processes.map(stop))
    await Promise.all(reservations.map(reservation => reservation.release()))
    await shared?.end()
    try {
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [databaseName],
      )
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`)
    } finally {
      await admin.end()
      await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`)
    }
  }

  if (report.status !== 'passed' || !report.firstStart || !report.restart || keyRequests.length < 5) {
    throw new Error('packaged PostgreSQL HA smoke evidence is incomplete')
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exit(1)
  })
}
