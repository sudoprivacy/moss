import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { createServer, type Server } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  NexusManager,
  buildNexusArgs,
  formatNexusStartupFailure,
  parseNexusVersion,
} from '../nexusManager.js'

const tempDirs: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('NexusManager', () => {
  it('uses the repository runtime version config for the Docker assembly', () => {
    const runtimeVersions = JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'runtime-versions.json'), 'utf8'),
    ) as Record<string, string>
    const dockerfile = readFileSync(
      join(import.meta.dir, '..', '..', '..', '..', 'deploy', 'server.Dockerfile.local'),
      'utf8',
    )

    expect(runtimeVersions['nexusd-cluster']).toBe('0.1.1')
    expect(dockerfile).toContain('COPY src/server/nexus/runtime-versions.json /runtime-versions.json')
    expect(dockerfile).toContain("NEXUSD_CLUSTER_VERSION=\"$(jq -er '.\"nexusd-cluster\"' /runtime-versions.json)\"")
    expect(dockerfile).toContain('github.com/nexi-lab/nexus/releases/download/nexusd-cluster-v${NEXUSD_CLUSTER_VERSION}')
  })

  it('builds the nexusd-cluster 0.1.x serve-local arguments used by the demo', () => {
    expect(buildNexusArgs(2126, '/tmp/nexus-data')).toEqual([
      'serve-local',
      '--port', '2126',
      '--data-dir', '/tmp/nexus-data',
      '--no-tls',
    ])
  })

  it('parses only nexusd-cluster semantic versions', () => {
    expect(parseNexusVersion('nexusd-cluster 0.1.1')).toBe('0.1.1')
    expect(parseNexusVersion('nexusd-cluster v0.1.1')).toBe('0.1.1')
    expect(parseNexusVersion('nexus-vfs 0.6.0')).toBeNull()
  })

  it('rejects an occupied gRPC port before reporting startup success', async () => {
    const server = createServer()
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP test address')

    const nexusDir = mkdtempSync(join(tmpdir(), 'moss-nexus-manager-'))
    tempDirs.push(nexusDir)
    const manager = new NexusManager({ nexusDir, grpcPort: address.port })

    await expect(manager.start()).rejects.toThrow('already in use or unavailable')
  })

  it('includes exit code, signal, pid, and stderr in startup failures', () => {
    expect(formatNexusStartupFailure({
      message: 'nexusd-cluster exited before gRPC readiness',
      pid: 1234,
      exit: { code: 1, signal: null },
      stderr: 'Address already in use',
    })).toBe(
      'nexusd-cluster exited before gRPC readiness; pid=1234; code=1; signal=null; stderr=Address already in use',
    )
  })
})
