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
