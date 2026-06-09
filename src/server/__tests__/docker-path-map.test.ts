import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  _resetForTests as resetPathMap,
  toHostPath,
} from '../runtime/dockerPathMap.js'
import {
  _resetForTests as resetRegistry,
  ensureUserContainer,
} from '../runtime/userContainerRegistry.js'
import type { ServerConfig } from '../types.js'

/** Same fake-docker pattern as user-container-registry.test.ts but the
 *  script logs every argv line so we can assert the -v mounts. */
async function setupFakeDocker(): Promise<{
  dir: string
  logFile: string
  cleanup: () => Promise<void>
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'moss-fake-docker-path-'))
  const logFile = path.join(dir, 'docker.log')
  await writeFile(logFile, '')
  const script = `#!/bin/sh
# log full argv on its own line so the test can match mount entries
printf '%s\\n' "$*" >> "${logFile}"
case "$1" in
  run) echo "fake-id" ;;
  inspect) echo "true" ;;
esac
exit 0
`
  const fakeDocker = path.join(dir, 'docker')
  await writeFile(fakeDocker, script)
  await chmod(fakeDocker, 0o755)
  const prev = process.env.PATH
  process.env.PATH = `${dir}${path.delimiter}${prev ?? ''}`
  return {
    dir,
    logFile,
    cleanup: async () => {
      process.env.PATH = prev
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function baseConfig(): ServerConfig {
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
    dbPath: '/tmp/db',
    transcriptDir: '/tmp/t',
    runtimeDir: '/app/data/runtime',
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
      userContainerIdleTimeoutMs: 60000,
      execKillGraceMs: 5000,
      user: { pidsLimit: 256, memory: '1g', cpus: '1', nofile: 1024 },
    },
  }
}

describe('dockerPathMap.toHostPath', () => {
  beforeEach(() => {
    delete process.env.MOSS_HOST_PATH_MAP
    resetPathMap()
  })
  afterEach(() => {
    delete process.env.MOSS_HOST_PATH_MAP
    resetPathMap()
  })

  it('returns input unchanged when MOSS_HOST_PATH_MAP is unset', () => {
    expect(toHostPath('/app/data/runtime/sessions/x')).toBe('/app/data/runtime/sessions/x')
  })

  it('translates by longest container-prefix match', () => {
    process.env.MOSS_HOST_PATH_MAP = JSON.stringify({
      '/host/data': '/app/data',
      '/host/data/runtime': '/app/data/runtime',
    })
    resetPathMap()
    expect(toHostPath('/app/data/runtime/sessions/x')).toBe(
      '/host/data/runtime/sessions/x',
    )
    expect(toHostPath('/app/data/other')).toBe('/host/data/other')
  })

  it('returns input unchanged on invalid JSON', () => {
    process.env.MOSS_HOST_PATH_MAP = 'not-json'
    resetPathMap()
    expect(toHostPath('/app/data/foo')).toBe('/app/data/foo')
  })
})

describe('UserContainerRegistry uses toHostPath for -v mounts', () => {
  let docker: Awaited<ReturnType<typeof setupFakeDocker>>

  beforeEach(async () => {
    resetRegistry()
    resetPathMap()
    docker = await setupFakeDocker()
  })

  afterEach(async () => {
    resetRegistry()
    delete process.env.MOSS_HOST_PATH_MAP
    resetPathMap()
    await docker.cleanup()
  })

  it('rewrites runtimeDir mount when moss-server is itself in a container', async () => {
    process.env.MOSS_HOST_PATH_MAP = JSON.stringify({
      '/data/moss-server/runtime': '/app/data/runtime',
    })
    resetPathMap()
    const config = baseConfig()

    await ensureUserContainer(config, {
      orgId: 'orgX',
      userId: 'userX',
      role: 'user',
      scopes: [],
      image: 'fake:test',
    })
    const log = await readFile(docker.logFile, 'utf8')
    // Container path on the right side of `:` stays the same; host path on
    // the left should be remapped to /data/moss-server/runtime.
    expect(log).toContain('-v /data/moss-server/runtime:/app/data/runtime')
    expect(log).not.toContain('-v /app/data/runtime:/app/data/runtime')
  })

  it('passes path through unchanged when no mapping is configured', async () => {
    const config = baseConfig()
    await ensureUserContainer(config, {
      orgId: 'orgY',
      userId: 'userY',
      role: 'user',
      scopes: [],
      image: 'fake:test',
    })
    const log = await readFile(docker.logFile, 'utf8')
    expect(log).toContain('-v /app/data/runtime:/app/data/runtime')
  })
})
