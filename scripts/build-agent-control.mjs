#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destination = resolve(process.argv[2] ?? join(root, 'dist', 'agent-control'))
function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) throw new Error('Cannot establish control artifact source')
  return result.stdout.trim()
}
const source = git('rev-parse', 'HEAD')
if (git('status', '--porcelain')) throw new Error('Build the control artifact from a clean source tree')
mkdirSync(destination, { recursive: true })
const child = spawnSync('bun', ['build', 'src/server/agentControl/nativeMain.ts', '--target=node', '--format=esm',
  '--outfile', join(destination, 'moss-agent-control.mjs')], { cwd: root, stdio: 'inherit', windowsHide: true })
if (child.error) throw child.error
if (child.status !== 0) process.exit(child.status ?? 1)
const bytes = readFileSync(join(destination, 'moss-agent-control.mjs'))
writeFileSync(join(destination, 'manifest.json'), JSON.stringify({ format: 'moss-agent-control-artifact/v1', source,
  nodeMajorMinimum: 22, requiresNativeToolCallContext: true, file: 'moss-agent-control.mjs', bytes: bytes.byteLength,
  sha256: createHash('sha256').update(bytes).digest('hex') }, null, 2) + '\n')
