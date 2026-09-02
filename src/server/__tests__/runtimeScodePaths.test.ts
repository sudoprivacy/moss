import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getDefaultServerConfig, readServerConfig } from '../config.js'
import { resolveRuntimeScodePath } from '../runtimeScodePath.js'
import type { ServerConfig } from '../types.js'

const config = {
  defaultRuntime: 'docker',
  engine: 'scode',
  scodePath: '/legacy/scode',
  hostScodePath: '/opt/moss/bin/scode',
  hostScodeEnabled: true,
  dockerScodePath: '/usr/local/bin/scode',
} as ServerConfig

describe('runtime scode paths', () => {
  it('selects the path for each runtime type', () => {
    expect(resolveRuntimeScodePath(config, 'host')).toBe('/opt/moss/bin/scode')
    expect(resolveRuntimeScodePath(config, 'docker')).toBe('/usr/local/bin/scode')
  })

  it('keeps explicit and legacy scode paths compatible', () => {
    expect(resolveRuntimeScodePath(config, 'host', '/custom/scode')).toBe('/custom/scode')
    expect(resolveRuntimeScodePath({ ...config, hostScodePath: undefined }, 'host'))
      .toBe('/legacy/scode')
    expect(resolveRuntimeScodePath({ ...config, dockerScodePath: undefined }, 'docker'))
      .toBe('/legacy/scode')
  })

  it('disables only host sessions when the bundled binary is incompatible', () => {
    const disabled = { ...config, hostScodeEnabled: false }
    expect(() => resolveRuntimeScodePath(disabled, 'host')).toThrow(
      'bundled scode requires glibc 2.39 or newer',
    )
    expect(resolveRuntimeScodePath(disabled, 'docker')).toBe('/usr/local/bin/scode')
  })

  it('only expands the host path on the host filesystem', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moss-scode-config-'))
    const configPath = join(dir, 'server.json')
    const raw = getDefaultServerConfig()
    raw.runtimeDefaults.hostScodePath = './bin/scode'
    raw.runtimeDefaults.hostScodeEnabled = false
    raw.runtimeDefaults.dockerScodePath = 'scode'
    writeFileSync(configPath, JSON.stringify(raw), 'utf8')

    try {
      const { config: loaded } = await readServerConfig(configPath)
      expect(loaded.hostScodePath).toBe(join(process.cwd(), 'bin', 'scode'))
      expect(loaded.hostScodeEnabled).toBe(false)
      expect(loaded.dockerScodePath).toBe('scode')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps host and Docker release scode versions aligned', () => {
    const root = join(import.meta.dir, '..', '..', '..')
    const workflow = readFileSync(join(root, '.github/workflows/build-release.yml'), 'utf8')
    const hostDockerfile = readFileSync(join(root, 'deploy/server.Dockerfile.local'), 'utf8')
    const runtimeDockerfile = readFileSync(join(root, 'deploy/runtime/Dockerfile'), 'utf8')
    const packageScript = readFileSync(join(root, 'deploy/package-server.sh'), 'utf8')
    const versions = JSON.parse(
      readFileSync(join(root, 'src/server/nexus/runtime-versions.json'), 'utf8'),
    ) as Record<string, string>

    expect(versions.scode).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(workflow).toContain("require('./src/server/nexus/runtime-versions.json').scode")
    expect(hostDockerfile).toContain('COPY src/server/nexus/runtime-versions.json /runtime-versions.json')
    expect(hostDockerfile).toContain("SCODE_VERSION=\"$(jq -er '.scode' /runtime-versions.json)\"")
    expect(hostDockerfile).toContain('EXPECTED_VERSION_PATTERN=')
    expect(runtimeDockerfile).toContain('COPY src/server/nexus/runtime-versions.json /tmp/moss-runtime-versions.json')
    expect(runtimeDockerfile).toContain('require("/tmp/moss-runtime-versions.json").scode')
    expect(packageScript).not.toContain('SCODE_VERSION')
    expect(hostDockerfile).toContain('COPY --from=host-scode-runtime /usr/local/bin/scode ./app/bin/scode')
  })
})
