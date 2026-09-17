/**
 * Child entrypoint for one 会话存档 pull. Kept deliberately tiny: it
 * exists so a native SDK crash kills this process instead of the server
 * (see worker.ts). Receives a PullConfig over IPC, reports one result.
 *
 * NAME RESOLUTION CROSSES BACK OVER IPC
 * -------------------------------------
 * PullConfig.nameLookup is a function, and child_process IPC serialises
 * with JSON — a function is silently dropped, arriving as undefined.
 * (Verified: the child receives every other key and `nameLookup:
 * undefined`.) So the child cannot be handed the lookup directly; it
 * asks the parent, which owns the corp-app connector and its
 * credentials, and awaits the answer as plain data.
 */

import { pullOnce, type PullConfig } from './puller.js'

type LookupRequest = { kind: 'lookup'; id: number; userId: string; external: boolean }
type RoomLookupRequest = { kind: 'roomLookup'; id: number; roomId: string }
type LookupReply = { kind: 'lookupResult'; id: number; name: string | null }
type ResultMessage = { ok: boolean; result?: unknown; error?: string }

/** Pending name lookups, keyed by the request id we sent. */
const pending = new Map<number, (name: string | null) => void>()
let nextLookupId = 1

/** Give up on a lookup rather than stall the pull behind a wedged parent. */
const LOOKUP_TIMEOUT_MS = 15_000

function askParentForName(userId: string, external: boolean): Promise<string | null> {
  if (!process.send) return Promise.resolve(null)
  return new Promise((resolve) => {
    const id = nextLookupId++
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve(null)
    }, LOOKUP_TIMEOUT_MS)
    timer.unref()
    pending.set(id, (name) => {
      clearTimeout(timer)
      resolve(name)
    })
    const req: LookupRequest = { kind: 'lookup', id, userId, external }
    process.send?.(req)
  })
}

/** Same round-trip as askParentForName, for group display names. */
function askParentForRoomName(roomId: string): Promise<string | null> {
  if (!process.send) return Promise.resolve(null)
  return new Promise((resolve) => {
    const id = nextLookupId++
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve(null)
    }, LOOKUP_TIMEOUT_MS)
    timer.unref()
    pending.set(id, (name) => {
      clearTimeout(timer)
      resolve(name)
    })
    const req: RoomLookupRequest = { kind: 'roomLookup', id, roomId }
    process.send?.(req)
  })
}

process.on('message', async (msg: PullConfig | LookupReply) => {
  // Replies to our own lookups arrive on the same channel as the initial
  // config; route them before treating a message as a new pull request.
  if (msg && typeof msg === 'object' && (msg as LookupReply).kind === 'lookupResult') {
    const reply = msg as LookupReply
    const resolver = pending.get(reply.id)
    if (resolver) {
      pending.delete(reply.id)
      resolver(reply.name)
    }
    return
  }

  const cfg = msg as PullConfig
  try {
    const result = await pullOnce({
      ...cfg,
      // Rebuild the lookup on this side, backed by the parent.
      nameLookup: cfg.resolveNames ? askParentForName : undefined,
      roomNameLookup: cfg.resolveNames ? askParentForRoomName : undefined,
    })
    process.send?.({ ok: true, result } satisfies ResultMessage)
  } catch (err) {
    process.send?.({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies ResultMessage)
  } finally {
    process.exit(0)
  }
})
