import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  NexusManager,
  assertVaultPluginAvailable,
  buildNexusArgs,
  formatNexusStartupFailure,
  parseNexusVersion,
  resolveNexusConfigFromEnv,
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
    expect(runtimeVersions['nexus-vault']).toBe('0.5.44')
    expect(dockerfile).toContain('COPY src/server/nexus/runtime-versions.json /runtime-versions.json')
    expect(dockerfile).toContain("NEXUSD_CLUSTER_VERSION=\"$(jq -er '.\"nexusd-cluster\"' /runtime-versions.json)\"")
    expect(dockerfile).toContain('github.com/nexi-lab/nexus/releases/download/nexusd-cluster-v${NEXUSD_CLUSTER_VERSION}')
    expect(dockerfile).toContain("NEXUS_VAULT_VERSION=\"$(jq -er '.\"nexus-vault\"' /runtime-versions.json)\"")
    expect(dockerfile).toContain('github.com/nexi-lab/nexus/releases/download/vault-v${NEXUS_VAULT_VERSION}')
  })

  it('fail-fasts when the vault plugin dylib or its signature is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moss-nexus-plugins-'))
    tempDirs.push(dir)
    // 与实现相同的平台文件名选择
    const dylib = process.platform === 'win32' ? 'nexus_vault.dll' : 'libnexus_vault.so'
    expect(() => assertVaultPluginAvailable(dir)).toThrow('vault plugin not found')

    writeFileSync(join(dir, dylib), 'fake-dylib')
    // 缺 .sig 仍然失败（nexusd 拒绝加载无签名插件）
    expect(() => assertVaultPluginAvailable(dir)).toThrow('vault plugin not found')

    writeFileSync(join(dir, `${dylib}.sig`), 'fake-sig')
    expect(() => assertVaultPluginAvailable(dir)).not.toThrow()
  })

  it('builds the nexusd-cluster 0.1.x serve-local arguments used by the demo', () => {
    expect(buildNexusArgs(2126, '/tmp/nexus-data', '/app/bin/nexus/plugins')).toEqual([
      'serve-local',
      '--port', '2126',
      '--data-dir', '/tmp/nexus-data',
      '--no-tls',
      '--plugin-dir', '/app/bin/nexus/plugins',
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

  it('defaults to embedded serve-local mode when MOSS_NEXUS_MODE is unset', () => {
    expect(resolveNexusConfigFromEnv({})).toEqual({ mode: 'embedded', grpcPort: 2126 })
    expect(resolveNexusConfigFromEnv({ MOSS_NEXUS_GRPC_PORT: '2200' })).toEqual({
      mode: 'embedded',
      grpcPort: 2200,
    })
  })

  it('resolves external mTLS config from the environment', () => {
    expect(
      resolveNexusConfigFromEnv({
        MOSS_NEXUS_MODE: 'external',
        MOSS_NEXUS_ENDPOINT: 'https://100.64.0.1:8443',
        MOSS_NEXUS_TLS_CA: '/certs/ca.pem',
        MOSS_NEXUS_TLS_CERT: '/certs/moss.pem',
        MOSS_NEXUS_TLS_KEY: '/certs/moss-key.pem',
        MOSS_NEXUS_AUTH_TOKEN: 'tok',
      }),
    ).toEqual({
      mode: 'external',
      endpoint: 'https://100.64.0.1:8443',
      authToken: 'tok',
      tls: { caPath: '/certs/ca.pem', certPath: '/certs/moss.pem', keyPath: '/certs/moss-key.pem', serverName: undefined },
    })
  })

  it('rejects external mode without an endpoint', () => {
    expect(() => resolveNexusConfigFromEnv({ MOSS_NEXUS_MODE: 'external' })).toThrow(
      'requires MOSS_NEXUS_ENDPOINT',
    )
  })

  it('rejects partial mTLS material', () => {
    expect(() =>
      resolveNexusConfigFromEnv({
        MOSS_NEXUS_MODE: 'external',
        MOSS_NEXUS_ENDPOINT: 'https://127.0.0.1:8443',
        MOSS_NEXUS_TLS_CA: '/certs/ca.pem',
      }),
    ).toThrow('requires all of MOSS_NEXUS_TLS_CA, MOSS_NEXUS_TLS_CERT, MOSS_NEXUS_TLS_KEY')
  })

  it('rejects an https endpoint without client certs', () => {
    expect(() =>
      resolveNexusConfigFromEnv({
        MOSS_NEXUS_MODE: 'external',
        MOSS_NEXUS_ENDPOINT: 'https://127.0.0.1:8443',
      }),
    ).toThrow('no client certs were provided')
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
