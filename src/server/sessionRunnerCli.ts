import { readFile } from 'fs/promises'
import { SessionRunnerDaemon } from './sessionRunnerDaemon.js'
import { openStoreAsync } from './db.js'
import type { RunnerManifest } from './types.js'

async function main(): Promise<void> {
  const manifestPath = process.argv[2]
  if (!manifestPath) {
    throw new Error('Missing runner manifest path')
  }
  const raw = await readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(raw) as RunnerManifest
  // Store built here (async) so the postgres backend can pool a connection;
  // sqlite resolves synchronously under the hood (unchanged single-host path).
  const store = await openStoreAsync(manifest.config)
  const daemon = new SessionRunnerDaemon(manifest, store)
  await daemon.start()
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  )
  process.exit(1)
})

// A-3: the daemon has several fire-and-forget DB writes (void'd in event
// handlers) whose rejections would otherwise crash the whole runner via
// Node's default unhandledRejection=throw — turning a one-second DB blip
// into a full-portfolio session restart. Known paths carry their own
// catch; this handler is the backstop for the rest: log and count, never
// exit (the heartbeat interval surfaces persistent DB loss as a fenced
// exit through the proper chain).
let unhandledRejectionCount = 0
process.on('unhandledRejection', (reason: unknown) => {
  unhandledRejectionCount++
  process.stderr.write(
    `[SessionRunnerDaemon] Unhandled rejection #${unhandledRejectionCount}: ` +
      `${reason instanceof Error ? reason.stack || reason.message : String(reason)}\n`,
  )
})
