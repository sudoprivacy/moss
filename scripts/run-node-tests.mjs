import { existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, relative } from 'node:path'
import process from 'node:process'

const root = process.cwd()

function findNodeTests(directory) {
  const tests = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      tests.push(...findNodeTests(path))
    } else if (entry.isFile() && entry.name.endsWith('.node-test.ts')) {
      tests.push(relative(root, path))
    }
  }
  return tests
}

const testRoots = ['src', 'spikes']
  .map(directory => join(root, directory))
  .filter(existsSync)
const tests = testRoots.flatMap(findNodeTests).sort()
if (tests.length === 0) {
  console.error('No Node test files matched {src,spikes}/**/*.node-test.ts')
  process.exit(1)
}

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...tests],
  { cwd: root, stdio: 'inherit' },
)

if (result.error) {
  throw result.error
}
process.exit(result.status ?? 1)
