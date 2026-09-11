#!/usr/bin/env node
/**
 * Runs the server test suite under both runners it needs.
 *
 * `src/server/__tests__` is split across two runners, not by preference but by
 * capability. Files reaching `AuthCenterDb` need `node:sqlite`, which Bun does
 * not implement, so they run under Node via `tsx --test`. The rest run under
 * `bun:test`, and several of those use `node:test`'s `describe`/`it` alongside
 * `bun:` imports, so the import list is not a reliable signal either way.
 * Handing the whole directory to either runner fails.
 *
 * The partition is therefore written out rather than inferred. Detecting it
 * from imports looked tidy and was wrong twice: `node:test` is implemented by
 * Bun, and `node:sqlite` arrives transitively through `../server.js` in files
 * that never name it. An explicit list is longer but it is checkable by reading
 * it, and `UNLISTED` below makes a new file fail loudly instead of being
 * silently skipped — a test that never runs is worse than one that fails.
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const DIR = 'src/server/__tests__'

const BUN = [
  'applicationHelloReplay.test.ts',
  'authProxyPort.test.ts',
  'credentialsEnvelope.test.ts',
  'credits.test.ts',
  'lbHaConfig.test.ts',
  'modelListCache.test.ts',
  'podWorkspace.test.ts',
  'publicSystemConfig.test.ts',
  'runtimeScodePaths.test.ts',
  'smsTencent.test.ts',
]

/** Reach `AuthCenterDb`, so they need `node:sqlite`. */
const NODE = [
  'claimAttempt.test.ts',
  'creditApplicationsDb.test.ts',
  'lbServerInstance.test.ts',
  'phoneAuth.test.ts',
  'phoneImport.test.ts',
]

/**
 * Currently unrunnable, excluded so the gate reflects a reachable bar.
 *
 * These are not skips to be forgotten: each one is a test that cannot execute,
 * which is a defect in its own right. Listing them keeps that visible.
 */
const EXCLUDED = {
  // Import `../server.js`, which pulls `node:sqlite` (so Bun cannot load it)
  // and a `bun:` module (so Node cannot). They run under neither runner.
  'lbDraining.test.ts': 'imports ../server.js: needs node:sqlite and bun: at once',
  'lbReadiness.test.ts': 'imports ../server.js: needs node:sqlite and bun: at once',
  // Asserts on the contents of the packaged E2E script; fails on dev checkouts.
  'releaseE2eSmoke.test.ts': 'asserts packaged release artifacts absent from a dev tree',
}

const present = readdirSync(DIR).filter(name => name.endsWith('.test.ts'))
const accounted = new Set([...BUN, ...NODE, ...Object.keys(EXCLUDED)])
const unlisted = present.filter(name => !accounted.has(name))
if (unlisted.length > 0) {
  console.error(
    `Unlisted test files in ${DIR}:\n  ${unlisted.join('\n  ')}\n` +
      'Add each to BUN or NODE in scripts/test-server.js so it actually runs.',
  )
  process.exit(1)
}

const missing = [...BUN, ...NODE].filter(name => !present.includes(name))
if (missing.length > 0) {
  console.error(`Listed but absent from ${DIR}:\n  ${missing.join('\n  ')}`)
  process.exit(1)
}

function run(label, command, leadingArgs, names) {
  if (names.length === 0) return true
  console.log(`\n=== ${label} (${names.length} files) ===`)
  const paths = names.map(name => `${DIR}/${name}`)
  const { status } = spawnSync(command, [...leadingArgs, ...paths], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  return status === 0
}

// Both run even when the first fails: one red runner should not hide the
// other's result, or fixing a failure means discovering the next one a commit
// later.
const bunOk = run('bun:test', 'bun', ['test'], BUN)
const nodeOk = run('node:test', 'npx', ['tsx', '--test'], NODE)

const skipped = Object.entries(EXCLUDED)
if (skipped.length > 0) {
  console.log('\nnot run:')
  for (const [name, reason] of skipped) console.log(`  ${name} — ${reason}`)
}

if (!bunOk || !nodeOk) process.exit(1)
console.log('\nserver suite: both runners passed')
