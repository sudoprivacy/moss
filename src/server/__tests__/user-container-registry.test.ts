import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, writeFile, chmod, rm, mkdir, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

import {
  _getRecordForTests,
  _resetForTests,
  acquireSession,
  buildUserContainerName,
  ensureUserContainer,
  releaseSession,
} from '../runtime/userContainerRegistry.js'
import type { ServerConfig } from '../types.js'

/**
 * Test strategy: replace the `docker` binary on PATH with a shell script that
 * logs calls and returns canned output. This lets us assert idle-timer
 * acquire/release transitions without a real Docker daemon.
 */
async function setupFakeDocker(): Promise<{
  dir: string
  logFile: string
  cleanup: () => Promise<void>
  previousPath: string | undefined
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'moss-fake-docker-'))
  const logFile = path.join(dir, 'docker.log')
  await writeFile(logFile, '')

  // Track invocation count so successive `docker run -d` calls produce
  // different container IDs.
  const counterFile = path.join(dir, 'counter')
  await writeFile(counterFile, '0')

  const script = `#!/bin/sh
echo "$@" >> "${logFile}"
case "$1" in
  run)
    n=$(cat "${counterFile}")
    echo $((n + 1)) > "${counterFile}"
    echo "fake-container-id-$n"
    ;;
  inspect)
    echo "true"
    ;;
  stop|rm|ps|exec)
    ;;
esac
exit 0
`
  const fakeDocker = path.join(dir, 'docker')
  await writeFile(fakeDocker, script)
  await chmod(fakeDocker, 0o755)
  const previousPath = process.env.PATH
  process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ''}`

  return {
    dir,
    logFile,
    previousPath,
    cleanup: async () => {
      process.env.PATH = previousPath
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: '0.0.0.0',
    port: 0,
    authMode: 'local',
    tokenTtlSec: 3600,
    bootstrapAdmin: { username: 'admin' },
    defaultRuntime: 'docker',
    engine: 'scode',
    dockerImage: 'fake:test',
    idleTimeoutMs: 1000,
    maxSessions: 32,
    rootDir: '/tmp',
    dbPath: '/tmp/db.sqlite',
    transcriptDir: '/tmp/t',
    runtimeDir: '/tmp/runtime',
    dockerStopTimeoutSec: 10,
    dockerLabels: {},
    startupPolicy: 'reattach-or-resume',
    heartbeatTimeoutMs: 30000,
    reattachProbeTimeoutMs: 1000,
    resumeOnMissingRuntime: true,
    logLevel: 'info',
    docker: {
      containerMode: 'user',
      maxSessionsPerUser: 5,
      userContainerIdleTimeoutMs: 60,
      execKillGraceMs: 1000,
      user: { pidsLimit: 256, memory: '1g', cpus: '1', nofile: 1024 },
    },
    ...overrides,
  }
}

describe('UserContainerRegistry', () => {
  let docker: Awaited<ReturnType<typeof setupFakeDocker>>

  beforeEach(async () => {
    _resetForTests()
    docker = await setupFakeDocker()
  })

  afterEach(async () => {
    _resetForTests()
    await docker.cleanup()
  })

  it('builds deterministic container names', () => {
    const a = buildUserContainerName('org1', 'userA')
    const b = buildUserContainerName('org1', 'userA')
    const c = buildUserContainerName('org2', 'userA')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith('moss-user-')).toBe(true)
    expect(a.length).toBeLessThan(64)
  })

  it('ensureUserContainer is idempotent under concurrency', async () => {
    const config = makeConfig()
    const ctx = { orgId: 'org', userId: 'u', role: 'user', scopes: [] as string[], image: 'fake:test' }
    const results = await Promise.all([
      ensureUserContainer(config, ctx),
      ensureUserContainer(config, ctx),
      ensureUserContainer(config, ctx),
    ])
    expect(results[0]).toBe(results[1])
    expect(results[1]).toBe(results[2])

    const log = await readFile(docker.logFile, 'utf8')
    const runs = log.split('\n').filter(line => line.startsWith('run '))
    expect(runs.length).toBe(1)
  })

  it('arms idle timer when count drops to 0; cancels when it goes back up', async () => {
    const config = makeConfig({
      docker: { ...makeConfig().docker!, userContainerIdleTimeoutMs: 60 },
    })
    const ctx = { orgId: 'org', userId: 'u', role: 'user', scopes: [] as string[], image: 'fake:test' }
    await ensureUserContainer(config, ctx)
    await acquireSession('org', 'u', 's1', config)
    const rec1 = _getRecordForTests('org', 'u')!
    expect(rec1.idleTimer).toBeNull()
    expect(rec1.activeSessionIds.size).toBe(1)

    await releaseSession('org', 'u', 's1', config)
    const rec2 = _getRecordForTests('org', 'u')!
    expect(rec2.activeSessionIds.size).toBe(0)
    expect(rec2.idleTimer).not.toBeNull()

    // Re-acquire cancels the timer.
    await acquireSession('org', 'u', 's2', config)
    const rec3 = _getRecordForTests('org', 'u')!
    expect(rec3.idleTimer).toBeNull()
  })

  it('enforces maxSessionsPerUser for concurrent sessions', async () => {
    const config = makeConfig({
      docker: { ...makeConfig().docker!, maxSessionsPerUser: 2 },
    })
    const ctx = { orgId: 'org', userId: 'u', role: 'user', scopes: [] as string[], image: 'fake:test' }
    await ensureUserContainer(config, ctx)
    await acquireSession('org', 'u', 's1', config)
    await acquireSession('org', 'u', 's2', config)

    await expect(acquireSession('org', 'u', 's3', config)).rejects.toThrow(
      'maxSessionsPerUser exceeded',
    )
    const rec = _getRecordForTests('org', 'u')!
    expect([...rec.activeSessionIds].sort()).toEqual(['s1', 's2'])

    // Re-acquiring the same session is idempotent and should not trip the cap.
    await acquireSession('org', 'u', 's2', config)
    expect(rec.activeSessionIds.size).toBe(2)
  })

  it('reclaims the container after idle timeout', async () => {
    const config = makeConfig({
      docker: { ...makeConfig().docker!, userContainerIdleTimeoutMs: 50 },
    })
    const ctx = { orgId: 'org', userId: 'u', role: 'user', scopes: [] as string[], image: 'fake:test' }
    await ensureUserContainer(config, ctx)
    await acquireSession('org', 'u', 's1', config)
    await releaseSession('org', 'u', 's1', config)

    expect(_getRecordForTests('org', 'u')).toBeDefined()
    await new Promise(r => setTimeout(r, 250))

    expect(_getRecordForTests('org', 'u')).toBeUndefined()
    const log = await readFile(docker.logFile, 'utf8')
    expect(log).toContain('stop')
    expect(log).toContain('rm')
  })

  it('acquire after timer fired but before drain executed does not race', async () => {
    const config = makeConfig({
      docker: { ...makeConfig().docker!, userContainerIdleTimeoutMs: 30 },
    })
    const ctx = { orgId: 'org', userId: 'u', role: 'user', scopes: [] as string[], image: 'fake:test' }
    await ensureUserContainer(config, ctx)
    await acquireSession('org', 'u', 's1', config)
    await releaseSession('org', 'u', 's1', config)
    // Re-acquire immediately to win the race. The acquire goes through the
    // mutex with the idle timer; the timer's onIdleFire double-checks count.
    await acquireSession('org', 'u', 's2', config)

    // Wait past the original timer.
    await new Promise(r => setTimeout(r, 150))

    // Still present because acquire grabbed it back.
    const rec = _getRecordForTests('org', 'u')
    expect(rec).toBeDefined()
    expect(rec?.activeSessionIds.has('s2')).toBe(true)
  })
})

// Use mkdir to silence unused import warning if Node strips it.
void mkdir
