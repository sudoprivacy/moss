import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'

import { readFileSync } from 'node:fs'

import { resolveNexusNapiBuild } from './build-nexus-napi.js'

const root = '/workspace/moss'

describe('nexus-napi build layout', () => {
  it('uses the committed Cargo lockfile', () => {
    const script = readFileSync(resolve(import.meta.dir, 'build-nexus-napi.js'), 'utf8')
    expect(script).toContain("'--release', '--locked'")
    expect(script).toContain("env.MOSS_NODE_BINARY?.trim() || 'node'")
  })

  it('uses a platform-specific addon name on macOS arm64', () => {
    expect(resolveNexusNapiBuild(root, 'darwin', 'arm64')).toEqual({
      manifestPath: resolve(root, 'native/nexus-napi/Cargo.toml'),
      sourcePath: resolve(root, 'native/nexus-napi/target/release/libnexus_napi.dylib'),
      destinationPath: resolve(root, 'native/nexus-napi/nexus-napi.darwin-arm64.node'),
    })
  })

  it('uses a platform-specific addon name on Linux x64', () => {
    expect(resolveNexusNapiBuild(root, 'linux', 'x64')).toEqual({
      manifestPath: resolve(root, 'native/nexus-napi/Cargo.toml'),
      sourcePath: resolve(root, 'native/nexus-napi/target/release/libnexus_napi.so'),
      destinationPath: resolve(root, 'native/nexus-napi/nexus-napi.linux-x64.node'),
    })
  })

  it('rejects unsupported platforms before invoking Cargo', () => {
    expect(() => resolveNexusNapiBuild(root, 'aix', 'ppc64')).toThrow(
      'Unsupported nexus-napi build platform: aix-ppc64',
    )
  })
})
