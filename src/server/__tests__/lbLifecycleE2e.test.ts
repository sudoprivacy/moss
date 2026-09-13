// Real-process LB lifecycle E2E: bundle the fixture with `bun build
// --target=node`, spawn it under node (the production runtime shape), and
// drive it over real HTTP. Covers the extracted readiness.ts / httpRespond.ts
// production paths: /readyz red+green, sticky-route cookie on/off, graceful
// drain (beginDrain → /readyz 503 → POST /api/v1/sessions rejected 503 by
// writeError's ServerDrainingError mapping), and budget/stats reading a seeded
// transcript through utils/jsonl.ts + utils/transcriptGuard.ts.
//
// Drain is triggered over stdin, not SIGTERM: on Windows child.kill('SIGTERM')
// never runs the child's listener (verified by probe), so the signal path is
// covered by the docker E2E (Linux) instead.
import { afterEach, describe, expect, it } from 'bun:test'

// Every case passes 60_000 as bun:test's per-case timeout (third argument):
// each spawns a real server process (DB migrations + service init take 3-8s on
// Windows), far beyond the 5s default.
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { getDefaultServerConfig } from '../config.js'

const ADMIN_USERNAME = 'lb-lifecycle-admin'
const ADMIN_PASSWORD = 'lb-lifecycle-password'

type LbFixture = {
  baseUrl: string
  token: string
  rootDir: string
  stderrOutput: string[]
  process: ReturnType<typeof Bun.spawn>
}

const fixtures: LbFixture[] = []
const tcpListeners: ReturnType<typeof createServer>[] = []

// Bundle once for the whole file; every case spawns a fresh child from it so
// state (drain is one-way) never leaks between cases.
const bundleDir = await mkdtemp(join(tmpdir(), 'moss-lb-e2e-build-'))
const fixturePath = resolve(import.meta.dir, 'lbLifecycleE2e.fixture.ts')
const bundle = Bun.spawnSync(
  [
    'bun', 'build', fixturePath,
    '--target=node',
    '--format=esm',
    '--outdir', bundleDir,
    '--external=better-sqlite3',
    '--external=@xenova/transformers',
    '--external=onnxruntime-node',
    '--external=sharp',
  ],
  { cwd: resolve(import.meta.dir, '..', '..') },
)
if (bundle.exitCode !== 0) {
  throw new Error(`Fixture bundle failed: ${bundle.stderr.toString()}`)
}
const bundleEntry = join(bundleDir, 'lbLifecycleE2e.fixture.js')

async function startFixture(extraEnv: Record<string, string> = {}): Promise<LbFixture> {
  const rootDir = await mkdtemp(join(tmpdir(), 'moss-lb-e2e-'))
  const config = getDefaultServerConfig()
  config.server.host = '127.0.0.1'
  config.server.port = 0
  config.bootstrapAdmin.username = ADMIN_USERNAME
  config.bootstrapAdmin.password = ADMIN_PASSWORD
  config.storage = {
    rootDir,
    dbPath: join(rootDir, 'moss.db'),
    transcriptDir: join(rootDir, 'transcripts'),
    runtimeDir: join(rootDir, 'runtime'),
  }
  config.wikiIndex.enabled = false

  const configPath = join(rootDir, 'server.json')
  await writeFile(configPath, JSON.stringify(config), 'utf8')

  const fixtureProcess = Bun.spawn(['node', bundleEntry], {
    cwd: resolve(import.meta.dir, '..', '..'),
    env: {
      ...globalThis.process.env,
      MOSS_HOME: join(rootDir, 'moss-home'),
      MOSS_SERVER_CONFIG: configPath,
      ...extraEnv,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stderrOutput: string[] = []
  const stderrReader = fixtureProcess.stderr.getReader()
  void (async () => {
    const decoder = new TextDecoder()
    while (true) {
      const result = await stderrReader.read()
      if (result.done) return
      stderrOutput.push(decoder.decode(result.value, { stream: true }))
    }
  })()

  const stdoutReader = fixtureProcess.stdout.getReader()
  const output: string[] = []
  let combinedOutput = ''
  const readReady = async (): Promise<number> => {
    const decoder = new TextDecoder()
    while (true) {
      const result = await stdoutReader.read()
      if (result.done) throw new Error(`Fixture did not become ready: ${combinedOutput}`)
      const chunk = decoder.decode(result.value, { stream: true })
      output.push(chunk)
      combinedOutput += chunk
      const errorMatch = combinedOutput.match(/LB_E2E_ERROR:([^\r\n]+)/)
      if (errorMatch) throw new Error(`Fixture request error: ${errorMatch[1]}`)
      const match = combinedOutput.match(/LB_E2E_READY:(\d+)/)
      if (match) return Number(match[1])
    }
  }
  const port = await Promise.race([
    readReady(),
    fixtureProcess.exited.then(async () => {
      const stderr = await new Response(fixtureProcess.stderr).text()
      throw new Error(`Fixture exited before readiness: ${stderr}`)
    }),
  ])

  const baseUrl = `http://127.0.0.1:${port}`
  const response = await fetch(`${baseUrl}/api/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  })
  const tokenResult = (await response.json()) as { access_token?: string }
  if (!response.ok || !tokenResult.access_token) {
    fixtureProcess.kill()
    throw new Error(`Fixture authentication failed: ${JSON.stringify(tokenResult)}`)
  }

  const fixture = {
    baseUrl,
    token: tokenResult.access_token,
    rootDir,
    stderrOutput,
    process: fixtureProcess,
  }
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async fixture => {
    fixture.process.kill()
    await fixture.process.exited
    await rm(fixture.rootDir, { recursive: true, force: true })
  }))
  await Promise.all(tcpListeners.splice(0).map(
    listener => new Promise<void>(resolveClose => listener.close(() => resolveClose())),
  ))
})

describe('LB lifecycle E2E (real server process, node runtime)', () => {
  it('no nexus → /readyz is 503 with db:true, nexus:false, draining:false; instance id carries into the body and the moss_route cookie', async () => {
    const fixture = await startFixture({ MOSS_INSTANCE_ID: 'e2e-inst-1' })
    const response = await fetch(`${fixture.baseUrl}/readyz`)

    expect(response.status, fixture.stderrOutput.join('')).toBe(503)
    const body = await response.json() as {
      ok: boolean
      instance_id: string
      checks: { db: boolean; nexus: boolean; runtime: boolean | null; k8s: boolean | null; draining: boolean }
    }
    expect(body.ok).toBe(false)
    expect(body.checks.db).toBe(true)
    expect(body.checks.nexus).toBe(false)
    expect(body.checks.draining).toBe(false)
    expect(body.instance_id).toBe('e2e-inst-1')
    expect(response.headers.get('set-cookie')).toBe('moss_route=e2e-inst-1; Path=/; HttpOnly; SameSite=Lax')
  }, 60_000)

  it('MOSS_NEXUS_MODE=external with a reachable TCP endpoint → /readyz is 200 with nexus:true', async () => {
    const listener = createServer(socket => socket.destroy())
    tcpListeners.push(listener)
    const endpointPort = await new Promise<number>(resolvePort => {
      listener.listen(0, '127.0.0.1', () => {
        const address = listener.address()
        resolvePort(typeof address === 'object' && address ? address.port : 0)
      })
    })

    const fixture = await startFixture({
      MOSS_NEXUS_MODE: 'external',
      MOSS_NEXUS_ENDPOINT: `http://127.0.0.1:${endpointPort}`,
    })
    const response = await fetch(`${fixture.baseUrl}/readyz`)

    expect(response.status, fixture.stderrOutput.join('')).toBe(200)
    const body = await response.json() as { ok: boolean; checks: { nexus: boolean } }
    expect(body.ok).toBe(true)
    expect(body.checks.nexus).toBe(true)
  }, 60_000)

  it('drain via stdin DRAIN → /readyz 503 with draining:true and POST /api/v1/sessions rejected 503 with the draining message', async () => {
    const fixture = await startFixture()
    fixture.process.stdin?.write('DRAIN\n')
    fixture.process.stdin?.flush()

    let drained = false
    let lastBody = ''
    for (let attempt = 0; attempt < 50 && !drained; attempt++) {
      const response = await fetch(`${fixture.baseUrl}/readyz`)
      lastBody = await response.text()
      if (response.status === 503 && (JSON.parse(lastBody) as { checks: { draining: boolean } }).checks.draining) {
        drained = true
      } else {
        await new Promise(resolveWait => setTimeout(resolveWait, 100))
      }
    }
    expect(drained, `readyz never reported draining: ${lastBody}`).toBe(true)

    const createResponse = await fetch(`${fixture.baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fixture.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ cwd: fixture.rootDir }),
    })
    expect(createResponse.status, fixture.stderrOutput.join('')).toBe(503)
    expect(await createResponse.json()).toEqual({
      error: 'server is draining, not accepting new sessions',
    })

    // beginDrain enters the grace window; the server itself must stay alive.
    expect(fixture.process.exitCode).toBe(null)
  }, 60_000)

  it('budget/stats reads the seeded transcript through jsonl+transcriptGuard: exactly the assistant usage, filtered entries excluded', async () => {
    const fixture = await startFixture()
    const response = await fetch(`${fixture.baseUrl}/api/v1/budget/stats`, {
      headers: { Authorization: `Bearer ${fixture.token}` },
    })

    expect(response.status, fixture.stderrOutput.join('')).toBe(200)
    const stats = await response.json() as {
      users: Array<{ userName?: string; inputTokens: number; outputTokens: number; totalTokens: number }>
    }
    const adminRow = stats.users.find(u => u.userName === ADMIN_USERNAME)
    expect(adminRow).toBeDefined()
    // Seeded assistant entry: input 100 + output 50 = 150 total. The summary
    // entry is filtered by isTranscriptMessage; the user entry has no usage.
    expect(adminRow!.inputTokens).toBe(100)
    expect(adminRow!.outputTokens).toBe(50)
    expect(adminRow!.totalTokens).toBe(150)
  }, 60_000)

  it('without MOSS_INSTANCE_ID no Set-Cookie is emitted (single-instance behavior preserved)', async () => {
    const fixture = await startFixture()
    const response = await fetch(`${fixture.baseUrl}/healthz`)

    expect(response.status, fixture.stderrOutput.join('')).toBe(200)
    expect(response.headers.get('set-cookie')).toBe(null)
  }, 60_000)
})
