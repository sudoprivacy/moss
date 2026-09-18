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

/**
 * Suites this gates, by directory. Adding a directory here is what makes its
 * tests run in CI at all — a test outside these is not protecting anything.
 */
const SUITES = ['src/server/__tests__', 'src/channels/__tests__', 'src/server/nexus/__tests__']

const BUN = [
  // src/server/nexus/__tests__
  'nexusClient.test.ts',
  'nexusManager.test.ts',
  // src/channels/__tests__
  'connectionScope.test.ts',
  'crashSeedRecovery.test.ts',
  'untrustedText.test.ts',
  // src/server/__tests__
  'applicationHelloReplay.test.ts',
  'contractsActivation.test.ts',
  'nexusZoneId.test.ts',
  'authProxyPort.test.ts',
  'credentialsEnvelope.test.ts',
  'credits.test.ts',
  'fuiou.test.ts',
  'lbHaConfig.test.ts',
  'lbLifecycleE2e.test.ts',
  'lbReadiness.test.ts',
  'modelListCache.test.ts',
  'podWorkspace.test.ts',
  'publicSystemConfig.test.ts',
  'recharge.test.ts',
  'runtimeScodePaths.test.ts',
  'smsTencent.test.ts',
  // LB/HA branch suites whose chains carry bun:-protocol transitives (Node
  // rejects the scheme) but never reach node:sqlite — verified green under bun.
  'reviewFixesDaemon.test.ts',
]

/** Need Node: either they reach `node:sqlite` (Bun lacks it), or they pin the
 * Node runtime path on purpose — jsonlParse exercises parseJSONL's non-Bun
 * fallback, the branch the production (node) bundle actually executes.
 * The lb-, ha-, and pg-prefixed block from the LB/HA branch constructs
 * RuntimeService / DirectConnectStore / server surfaces, all of which reach
 * node:sqlite or the driver seam — verified green under `npx tsx --test` on
 * that branch. */
const NODE = [
  'claimAttempt.test.ts',
  'creditApplicationsDb.test.ts',
  'enterpriseConfig.test.ts',
  'jsonlParse.test.ts',
  'lbDraining.test.ts',
  'lbServerInstance.test.ts',
  'phoneAuth.test.ts',
  'phoneImport.test.ts',
  'rechargeDb.test.ts',
  'tokenQuota.test.ts',
  'transcriptGuard.test.ts',
  // LB/HA branch suites (node:sqlite / driver seam reach-through)
  'attemptLiveness.test.ts',
  'channelPluginLease.test.ts',
  'configRefresh.test.ts',
  'haClaimReap.test.ts',
  'internalChannelToken.test.ts',
  'lbAuthProxyRulesPoll.test.ts',
  'lbCorpAppSeq.test.ts',
  'lbFencing.test.ts',
  'lbInternalChannel.test.ts',
  'lbLivenessLayering.test.ts',
  'mcpEventsCrossInstance.test.ts',
  'msgAuditLease.test.ts',
  'pgBackend.test.ts',
  'reviewFixes.test.ts',
  'runtimePaths.test.ts',
  'sessionManagerReload.test.ts',
  'sqlDialect.test.ts',
  'sqliteTransaction.test.ts',
  'syncWorkerInflight.test.ts',
  'userContainerName.test.ts',
]

/**
 * Currently unrunnable, excluded so the gate reflects a reachable bar.
 *
 * These are not skips to be forgotten: each one is a test that cannot execute,
 * which is a defect in its own right. Listing them keeps that visible.
 */
const EXCLUDED = {
  // Asserts on the contents of the packaged E2E script; fails on dev checkouts.
  'releaseE2eSmoke.test.ts': 'asserts packaged release artifacts absent from a dev tree',
  // Declared "runnable under Bun only" by its own header, but bun cannot load
  // runtimeService.ts (transitive node:sqlite), and under node its mock.timers
  // / #scheduleFencingWait private-access shape plus real-clock heartbeat
  // windows fail.
  'runtimeServiceFencing.test.ts': 'loads under neither runner: bun lacks node:sqlite transitively, node lacks the bun mock/timer semantics it relies on',
  // Imports server.ts for buildWsUrl/wsRouteHint, and that chain reaches both
  // bun:bundle (src/utils/log.ts — Node rejects the scheme) and node:sqlite
  // (src/server/db.ts — Bun lacks the module). Verified equally unrunnable on
  // the pre-rebase LB/HA branch tip, so this is not a rebase regression.
  'lbOwnerRoute.test.ts': 'server.ts import chain is unloadable under both runners (bun:bundle blocks Node, node:sqlite blocks Bun)',
}

const present = SUITES.flatMap(dir =>
  readdirSync(dir)
    .filter(name => name.endsWith('.test.ts'))
    .map(name => ({ name, dir })),
).reduce((acc, { name, dir }) => {
  if (acc.has(name)) throw new Error(`two suites both contain ${name}; names must be unique across ${SUITES.join(', ')}`)
  acc.set(name, dir)
  return acc
}, new Map())
const accounted = new Set([...BUN, ...NODE, ...Object.keys(EXCLUDED)])
const unlisted = [...present.keys()].filter(name => !accounted.has(name))
if (unlisted.length > 0) {
  console.error(
    `Unlisted test files in ${SUITES.join(' / ')}:\n  ${unlisted.join('\n  ')}\n` +
      'Add each to BUN or NODE in scripts/test-server.js so it actually runs.',
  )
  process.exit(1)
}

const missing = [...BUN, ...NODE].filter(name => !present.has(name))
if (missing.length > 0) {
  console.error(`Listed but absent from ${SUITES.join(' / ')}:\n  ${missing.join('\n  ')}`)
  process.exit(1)
}

function run(label, command, leadingArgs, names) {
  if (names.length === 0) return true
  console.log(`\n=== ${label} (${names.length} files) ===`)
  const paths = names.map(name => `${present.get(name)}/${name}`)
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
