/**
 * Child entrypoint for one 会话存档 pull. Kept deliberately tiny: it
 * exists so a native SDK crash kills this process instead of the server
 * (see worker.ts). Receives a PullConfig over IPC, reports one result.
 */

import { pullOnce, type PullConfig } from './puller.js'

process.on('message', async (cfg: PullConfig) => {
  try {
    const result = await pullOnce(cfg)
    process.send?.({ ok: true, result })
  } catch (err) {
    process.send?.({ ok: false, error: err instanceof Error ? err.message : String(err) })
  } finally {
    process.exit(0)
  }
})
