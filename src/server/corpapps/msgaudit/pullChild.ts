/**
 * Child entrypoint for one 会话存档 pull. Kept deliberately tiny: it
 * exists so a native SDK crash kills this process instead of the server
 * (see worker.ts). Receives a PullConfig over IPC, reports one result.
 *
 * ROSTER LOOKUP CROSSES BACK OVER IPC
 * -----------------------------------
 * PullConfig.rosterLookup is a function, and child_process IPC serialises
 * with JSON — a function is silently dropped and arrives as undefined, so
 * the child cannot be handed it directly. It asks the parent instead,
 * which owns the corp-app connector and its credentials, and awaits the
 * answer as plain data.
 *
 * Display names are deliberately NOT resolved here: filling them in at
 * archive time cost a WeCom round trip per id per pull. They are looked
 * up on demand through the corpapp CLI instead.
 */

import { pullOnce, type PullConfig } from './puller.js'

type RosterRequest = { kind: 'roster'; id: number; roomId: string }
type RosterReply = { kind: 'rosterResult'; id: number; members: string[] | null }

/** Pending roster lookups, keyed by the request id we sent. */
const pending = new Map<number, (members: string[] | null) => void>()
let nextRequestId = 1

/** Give up rather than stall the pull behind a wedged parent. */
const ROSTER_TIMEOUT_MS = 30_000

function askParentForRoster(roomId: string): Promise<string[] | null> {
  if (!process.send) return Promise.resolve(null)
  return new Promise((resolve) => {
    const id = nextRequestId++
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve(null)
    }, ROSTER_TIMEOUT_MS)
    timer.unref()
    pending.set(id, (members) => {
      clearTimeout(timer)
      resolve(members)
    })
    const req: RosterRequest = { kind: 'roster', id, roomId }
    process.send?.(req)
  })
}

process.on('message', async (msg: PullConfig | RosterReply) => {
  // Replies to our own lookups share the channel with the initial config.
  if (msg && typeof msg === 'object' && (msg as RosterReply).kind === 'rosterResult') {
    const reply = msg as RosterReply
    const resolver = pending.get(reply.id)
    if (resolver) {
      pending.delete(reply.id)
      resolver(reply.members)
    }
    return
  }

  const cfg = msg as PullConfig
  try {
    const result = await pullOnce({
      ...cfg,
      // Rebuild the lookup on this side, backed by the parent.
      rosterLookup: cfg.snapshotRosters ? askParentForRoster : undefined,
    })
    process.send?.({ ok: true, result })
  } catch (err) {
    process.send?.({ ok: false, error: err instanceof Error ? err.message : String(err) })
  } finally {
    process.exit(0)
  }
})
