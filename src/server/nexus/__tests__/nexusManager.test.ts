import { afterEach, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import {
  NexusManager,
  type ResolvedNexusConfig,
  assertVaultPluginAvailable,
  buildNexusArgs,
  formatNexusStartupFailure,
  parseNexusVersion,
  resolveNexusConfigFromEnv,
  resolveNexusZoneIdLockPath,
  resolveVaultDylibName,
} from '../nexusManager.js'
import runtimeVersions from '../runtime-versions.json' with { type: 'json' }

const tempDirs: string[] = []
const servers: Server[] = []

type SpawnCall = {
  command: string
  args: string[]
  options: SpawnOptions
}

function makeTempNexusDir(): string {
  const nexusDir = mkdtempSync(join(tmpdir(), 'moss-nexus-manager-'))
  tempDirs.push(nexusDir)
  return nexusDir
}

function makeFakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, {
    pid: 4242,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killed: false,
  })
  child.kill = ((signal: NodeJS.Signals | number = 'SIGTERM') => {
    const exitSignal = typeof signal === 'string' ? signal : 'SIGTERM'
    Object.assign(child, { killed: true, signalCode: exitSignal })
    queueMicrotask(() => child.emit('exit', null, exitSignal))
    return true
  }) as ChildProcess['kill']
  return child
}

function makeStartHarness(options: {
  nexusDir?: string
  config?: ResolvedNexusConfig
  spawnError?: Error
  readinessProbe?: () => Promise<void>
  startupReleaseError?: Error
} = {}) {
  const nexusDir = options.nexusDir ?? makeTempNexusDir()
  const pluginDir = join(nexusDir, 'test-plugins')
  mkdirSync(pluginDir, { recursive: true })
  const dylib = join(pluginDir, resolveVaultDylibName(process.platform))
  writeFileSync(dylib, 'fake-dylib')
  writeFileSync(`${dylib}.sig`, 'fake-signature')

  const spawnCalls: SpawnCall[] = []
  const spawnedChildren: ChildProcess[] = []
  const spawnProcess = ((command: string, args: string[] = [], spawnOptions: SpawnOptions = {}) => {
    spawnCalls.push({ command, args: [...args], options: spawnOptions })
    if (options.spawnError) throw options.spawnError
    const child = makeFakeChild()
    spawnedChildren.push(child)
    return child
  }) as typeof spawn
  const manager = new NexusManager({
    nexusDir,
    grpcPort: 0,
    config: options.config ?? { mode: 'embedded', grpcPort: 0 },
    pluginDir,
    spawnProcess,
    readinessProbe: options.readinessProbe ?? (async () => {}),
    runtimeResolver: () => ({ path: '/test/nexusd', version: runtimeVersions['nexusd-cluster'] }),
    startupLock: options.startupReleaseError
      ? async () => async () => { throw options.startupReleaseError }
      : undefined,
  })

  return {
    manager,
    nexusDir,
    dataDir: join(nexusDir, 'data'),
    lockPath: resolveNexusZoneIdLockPath(join(nexusDir, 'data')),
    spawnCalls,
    spawnedChildren,
  }
}

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

    expect(runtimeVersions['nexusd-cluster']).toBe('0.1.5')
    expect(runtimeVersions['nexus-vault']).toBe('0.5.44')
    expect(dockerfile).toContain('COPY src/server/nexus/runtime-versions.json /runtime-versions.json')
    expect(dockerfile).toContain("NEXUSD_CLUSTER_VERSION=\"$(jq -er '.\"nexusd-cluster\"' /runtime-versions.json)\"")
    expect(dockerfile).toContain('github.com/nexi-lab/nexus/releases/download/nexusd-cluster-v${NEXUSD_CLUSTER_VERSION}')
    expect(dockerfile).toContain("NEXUS_VAULT_VERSION=\"$(jq -er '.\"nexus-vault\"' /runtime-versions.json)\"")
    expect(dockerfile).toContain('github.com/nexi-lab/nexus/releases/download/vault-v${NEXUS_VAULT_VERSION}')
  })

  it('resolves the vault dylib name per platform (covers darwin without a mac)', () => {
    expect(resolveVaultDylibName('win32')).toBe('nexus_vault.dll')
    expect(resolveVaultDylibName('darwin')).toBe('libnexus_vault.dylib')
    expect(resolveVaultDylibName('linux')).toBe('libnexus_vault.so')
  })

  it('fail-fasts when the vault plugin dylib or its signature is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moss-nexus-plugins-'))
    tempDirs.push(dir)
    // 与实现相同的平台文件名选择（复用实现的纯函数，保证各平台造/查一致）
    const dylib = resolveVaultDylibName(process.platform)
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

  it('keeps the real embedded start path byte-for-byte legacy when no ZoneId or lock exists', async () => {
    const harness = makeStartHarness()

    await harness.manager.start()

    expect(harness.spawnCalls).toHaveLength(1)
    expect(harness.spawnCalls[0].args).toEqual([
      'serve-local',
      '--port', '0',
      '--data-dir', harness.dataDir,
      '--no-tls',
      '--plugin-dir', join(harness.nexusDir, 'test-plugins'),
    ])
    expect(harness.spawnCalls[0].options.env).toEqual(
      expect.objectContaining({ NEXUS_DATA_DIR: harness.dataDir }),
    )
    expect(existsSync(harness.lockPath)).toBe(false)
    await harness.manager.stop()
  })

  it('serializes legacy startup against a concurrent first ZoneId declaration', async () => {
    let releaseReadiness!: () => void
    const readiness = new Promise<void>(resolve => { releaseReadiness = resolve })
    const first = makeStartHarness({ readinessProbe: () => readiness })
    const firstStart = first.manager.start()
    for (let attempt = 0; attempt < 100 && first.spawnCalls.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(first.spawnCalls).toHaveLength(1)

    const declared = makeStartHarness({
      nexusDir: first.nexusDir,
      config: { mode: 'embedded', grpcPort: 0, zoneId: 'concurrent-zone' },
    })
    await expect(declared.manager.start()).rejects.toThrow('another startup owns')
    expect(declared.spawnCalls).toHaveLength(0)
    expect(existsSync(declared.lockPath)).toBe(false)

    releaseReadiness()
    await firstStart
    await first.manager.stop()
  })

  it('atomically binds an exact first ZoneId and forwards it through the real start caller', async () => {
    const config = resolveNexusConfigFromEnv({ MOSS_NEXUS_ZONE_ID: 'cloud-user-1001' })
    const harness = makeStartHarness({ config })

    await harness.manager.start()

    expect(harness.spawnCalls).toHaveLength(1)
    const args = harness.spawnCalls[0].args
    expect(args.filter(arg => arg === '--cluster-init')).toHaveLength(1)
    expect(args.slice(args.indexOf('--cluster-init'))).toEqual(['--cluster-init', 'cloud-user-1001'])
    expect(readFileSync(harness.lockPath, 'utf8')).toBe(
      '{\n  "version": 1,\n  "zoneId": "cloud-user-1001"\n}\n',
    )
    expect(readdirSync(harness.nexusDir).filter(name => name.endsWith('.tmp'))).toEqual([])
    expect(existsSync(harness.dataDir)).toBe(false)
    await harness.manager.stop()
  })

  it('allows the first declaration when the Nexus data directory is literally empty', async () => {
    const harness = makeStartHarness({
      config: { mode: 'embedded', grpcPort: 0, zoneId: 'empty-data-zone' },
    })
    mkdirSync(harness.dataDir)

    await harness.manager.start()

    expect(harness.spawnCalls[0].args).toContain('empty-data-zone')
    await harness.manager.stop()
  })

  it('rejects invalid and whitespace-normalized declarations before spawn or data mutation', async () => {
    for (const zoneId of ['', 'aa', ' cloud-user-1001', 'cloud-user-1001 ', 'Has-Upper', 'abc\n']) {
      const harness = makeStartHarness({ config: { mode: 'embedded', grpcPort: 0, zoneId } })

      await expect(harness.manager.start()).rejects.toThrow('refusing to start nexusd')
      expect(harness.spawnCalls, JSON.stringify(zoneId)).toHaveLength(0)
      expect(existsSync(harness.lockPath), JSON.stringify(zoneId)).toBe(false)
      expect(existsSync(harness.dataDir), JSON.stringify(zoneId)).toBe(false)
    }
  })

  it('rejects a first declaration over initialized data without changing it', async () => {
    const harness = makeStartHarness({
      config: { mode: 'embedded', grpcPort: 0, zoneId: 'new-zone' },
    })
    mkdirSync(harness.dataDir)
    const existing = join(harness.dataDir, 'existing-state')
    writeFileSync(existing, 'legacy-data')

    await expect(harness.manager.start()).rejects.toThrow('already initialized or non-empty')

    expect(harness.spawnCalls).toHaveLength(0)
    expect(existsSync(harness.lockPath)).toBe(false)
    expect(readFileSync(existing, 'utf8')).toBe('legacy-data')
  })

  it('reuses a lock without env, accepts an exact match, and never overwrites a mismatch', async () => {
    const first = makeStartHarness({
      config: { mode: 'embedded', grpcPort: 0, zoneId: 'immutable-zone' },
    })
    await first.manager.start()
    await first.manager.stop()
    const originalLock = readFileSync(first.lockPath, 'utf8')

    const restart = makeStartHarness({ nexusDir: first.nexusDir })
    await restart.manager.start()
    expect(restart.spawnCalls[0].args.slice(-2)).toEqual(['--cluster-init', 'immutable-zone'])
    await restart.manager.stop()

    const matching = makeStartHarness({
      nexusDir: first.nexusDir,
      config: { mode: 'embedded', grpcPort: 0, zoneId: 'immutable-zone' },
    })
    await matching.manager.start()
    expect(matching.spawnCalls[0].args.slice(-2)).toEqual(['--cluster-init', 'immutable-zone'])
    await matching.manager.stop()

    const mismatch = makeStartHarness({
      nexusDir: first.nexusDir,
      config: { mode: 'embedded', grpcPort: 0, zoneId: 'different-zone' },
    })
    await expect(mismatch.manager.start()).rejects.toThrow('does not byte-match')
    expect(mismatch.spawnCalls).toHaveLength(0)
    expect(readFileSync(first.lockPath, 'utf8')).toBe(originalLock)
  })

  it('fails closed on malformed or noncanonical lock records before spawn', async () => {
    for (const contents of [
      '{not-json',
      '{"version":1,"zoneId":"canonical-zone"}\n',
      '{\n  "version": 2,\n  "zoneId": "canonical-zone"\n}\n',
      '{\n  "version": 1,\n  "zoneId": "Has-Upper"\n}\n',
    ]) {
      const harness = makeStartHarness()
      writeFileSync(harness.lockPath, contents)

      await expect(harness.manager.start()).rejects.toThrow('Invalid Nexus ZoneId lock')
      expect(harness.spawnCalls).toHaveLength(0)
      expect(existsSync(harness.dataDir)).toBe(false)
      expect(readFileSync(harness.lockPath, 'utf8')).toBe(contents)
    }
  })

  it('keeps a truthful lock after a failed first spawn and permits a same-ID retry', async () => {
    const first = makeStartHarness({
      config: { mode: 'embedded', grpcPort: 0, zoneId: 'retryable-zone' },
      spawnError: new Error('synthetic spawn failure'),
    })

    await expect(first.manager.start()).rejects.toThrow('synthetic spawn failure')
    expect(readFileSync(first.lockPath, 'utf8')).toContain('"zoneId": "retryable-zone"')
    expect(existsSync(first.dataDir)).toBe(false)

    const retry = makeStartHarness({ nexusDir: first.nexusDir })
    await retry.manager.start()
    expect(retry.spawnCalls[0].args.slice(-2)).toEqual(['--cluster-init', 'retryable-zone'])
    await retry.manager.stop()
  })

  it('stops and clears a ready child before surfacing startup-lock release failure', async () => {
    const harness = makeStartHarness({
      config: { mode: 'embedded', grpcPort: 0, zoneId: 'release-failure-zone' },
      startupReleaseError: new Error('synthetic release failure'),
    })

    await expect(harness.manager.start()).rejects.toThrow('spawned child was stopped')

    expect(harness.spawnedChildren).toHaveLength(1)
    expect(harness.spawnedChildren[0].killed).toBe(true)
    await harness.manager.stop()
    expect(harness.spawnedChildren[0].killed).toBe(true)
  })

  it('does not mask the primary startup error when lock release also fails', async () => {
    const harness = makeStartHarness({
      config: { mode: 'embedded', grpcPort: 0, zoneId: 'primary-error-zone' },
      spawnError: new Error('primary spawn failure'),
      startupReleaseError: new Error('secondary release failure'),
    })

    await expect(harness.manager.start()).rejects.toThrow('primary spawn failure')
    expect(harness.spawnedChildren).toHaveLength(0)
  })

  it('keeps external mode connect-only and rejects Moss-owned ZoneId input', async () => {
    const external: ResolvedNexusConfig = {
      mode: 'external',
      endpoint: 'http://nexus.example:2126',
      authToken: '',
      tls: null,
    }
    const harness = makeStartHarness({ config: external })

    await harness.manager.start()
    expect(harness.spawnCalls).toHaveLength(0)
    expect(existsSync(harness.dataDir)).toBe(false)

    for (const zoneId of ['', 'external-zone']) {
      expect(() => resolveNexusConfigFromEnv({
        MOSS_NEXUS_MODE: 'external',
        MOSS_NEXUS_ENDPOINT: 'http://nexus.example:2126',
        MOSS_NEXUS_ZONE_ID: zoneId,
      })).toThrow('only valid for Moss-managed embedded Nexus')
    }
  })

  it('blocks an external-mode transition while an embedded lock exists', async () => {
    const harness = makeStartHarness({
      config: {
        mode: 'external',
        endpoint: 'http://nexus.example:2126',
        authToken: '',
        tls: null,
      },
    })
    writeFileSync(
      harness.lockPath,
      '{\n  "version": 1,\n  "zoneId": "embedded-zone"\n}\n',
    )

    await expect(harness.manager.start()).rejects.toThrow('separately authorized topology migration')
    expect(harness.spawnCalls).toHaveLength(0)
    expect(existsSync(harness.dataDir)).toBe(false)
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
