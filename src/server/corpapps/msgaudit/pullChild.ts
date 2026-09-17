/**
 * Child entrypoint for one 会话存档 pull. Kept deliberately tiny: it
 * exists so a native SDK crash kills this process instead of the server
 * (see worker.ts). Receives a PullConfig over IPC, reports one result.
 *
 * Display names are deliberately NOT resolved here. Filling them in at
 * archive time cost one WeCom round trip (~500ms) per distinct id per
 * pull, which for a 20-person group meant ~11s of blocking per run and
 * thousands of redundant calls a day. Names are now looked up on demand
 * through the corpapp CLI / API instead, where a single call can name a
 * whole group at once.
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
