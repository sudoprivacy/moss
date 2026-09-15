#!/usr/bin/env node
/**
 * Type-checks the repo and fails when `src/server` gains type errors.
 *
 * Why a ratchet and not a wall: the tree carries ~1500 type errors today, so a
 * plain `tsc --noEmit` gate would block every PR on debt nobody in this change
 * caused. But the production server is what ships, and nothing in this repo has
 * ever type-checked it — `bun` executes TypeScript without checking it, and the
 * release artifact is produced by `bun build`, a bundler. A wrong-arity call
 * (TS2554) therefore reaches dev under a fully green test suite; 83 such errors
 * exist right now, and one of them was introduced and caught only by an
 * out-of-band compile in September.
 *
 * So: count the errors under src/server, compare against a committed baseline,
 * and fail only if the count rose. Lower the baseline whenever you fix some —
 * the script prints the new number when you do.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const BASELINE_FILE = join(here, 'typecheck-baseline.json')
/** Only this subtree is ratcheted; the rest of the tree is not gated yet. */
const SCOPE = 'src/server/'

// Run TypeScript's own entrypoint through node rather than the `.bin` shim. The
// shim is a shell script, and invoking it with `shell: true` made Windows cmd
// reject the forward-slash path: tsc never started, the parse found zero error
// lines, and this gate reported success. A gate that passes when the compiler
// cannot run is worse than no gate at all — hence the guard below.
const repoRoot = join(here, '..')
const compiler = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
const run = spawnSync(process.execPath, [compiler, '--noEmit', '-p', 'tsconfig.json'], {
  cwd: repoRoot,
  encoding: 'utf8',
})

const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
const errorLines = output.split('\n').filter(line => /error TS\d+/.test(line))

// tsc exits 0 and silent when clean, and non-zero *with* error lines when it
// found problems. Non-zero with nothing parsed means it never ran — report that
// as a failure of the check itself rather than as "no errors found".
if (run.error || (run.status !== 0 && errorLines.length === 0)) {
  console.error('typecheck could not run — refusing to report a result.')
  console.error(`  status: ${run.status}  error: ${run.error ? run.error.code : '-'}`)
  console.error(`  output: ${output.trim().slice(0, 400) || '(none)'}`)
  process.exit(2)
}
const scoped = errorLines.filter(line => line.includes(SCOPE))

const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
const allowed = baseline.serverErrors

console.log(`type errors under ${SCOPE}: ${scoped.length} (baseline ${allowed})`)
console.log(`type errors elsewhere:      ${errorLines.length - scoped.length} (not gated)`)

if (process.argv.includes('--update-baseline')) {
  writeFileSync(BASELINE_FILE, `${JSON.stringify({ ...baseline, serverErrors: scoped.length }, null, 2)}\n`)
  console.log(`baseline updated to ${scoped.length}`)
  process.exit(0)
}

if (scoped.length > allowed) {
  console.error(`\n${SCOPE} gained ${scoped.length - allowed} type error(s). New or changed:`)
  for (const line of scoped.slice(0, 40)) console.error(`  ${line}`)
  console.error(
    '\nFix them, or if you deliberately accepted them, run:\n' +
      '  node scripts/typecheck-ratchet.js --update-baseline\n',
  )
  process.exit(1)
}

if (scoped.length < allowed) {
  console.log(`\n${allowed - scoped.length} fewer than the baseline — lower it with:`)
  console.log('  node scripts/typecheck-ratchet.js --update-baseline')
}
