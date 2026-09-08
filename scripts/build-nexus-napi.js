#!/usr/bin/env node

import { copyFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const defaultRoot = resolve(scriptDir, '..')

export function resolveNexusNapiBuild(root, platform, arch) {
  const sourceName = {
    darwin: 'libnexus_napi.dylib',
    linux: 'libnexus_napi.so',
    win32: 'nexus_napi.dll',
  }[platform]
  const supportedArch = arch === 'x64' || arch === 'arm64'
  if (!sourceName || !supportedArch) {
    throw new Error(`Unsupported nexus-napi build platform: ${platform}-${arch}`)
  }

  const crateDir = resolve(root, 'native/nexus-napi')
  return {
    manifestPath: resolve(crateDir, 'Cargo.toml'),
    sourcePath: resolve(crateDir, 'target/release', sourceName),
    destinationPath: resolve(crateDir, `nexus-napi.${platform}-${arch}.node`),
  }
}

export function buildNexusNapi({
  root = defaultRoot,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
} = {}) {
  const layout = resolveNexusNapiBuild(root, platform, arch)
  process.stdout.write(`\nBuilding ${layout.destinationPath}\n`)

  const build = spawnSync(
    'cargo',
    ['build', '--manifest-path', layout.manifestPath, '--release', '--locked'],
    { cwd: root, env, stdio: 'inherit' },
  )
  if (build.error) {
    throw new Error(`Failed to execute cargo for nexus-napi: ${build.error.message}`)
  }
  if (build.status !== 0) {
    throw new Error(`nexus-napi cargo build failed with exit code ${build.status ?? 'unknown'}`)
  }
  if (!existsSync(layout.sourcePath)) {
    throw new Error(`nexus-napi build output not found: ${layout.sourcePath}`)
  }

  copyFileSync(layout.sourcePath, layout.destinationPath)

  const nodeExecutable = env.MOSS_NODE_BINARY?.trim() || 'node'
  const probe = spawnSync(
    nodeExecutable,
    ['-e', `require(${JSON.stringify(layout.destinationPath)})`],
    { cwd: root, env, encoding: 'utf8' },
  )
  if (probe.error || probe.status !== 0) {
    const detail = `${probe.stderr ?? ''}${probe.stdout ?? ''}`.trim()
    throw new Error(
      `nexus-napi load probe failed for ${platform}-${arch}` +
        (detail ? `: ${detail}` : ''),
    )
  }

  process.stdout.write(`Built and loaded ${layout.destinationPath}\n`)
  return layout
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    buildNexusNapi()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
