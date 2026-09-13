import type { AttemptRecord } from './types.js'

/**
 * A-9: single source of truth for the non-terminal runtime states. The
 * owner-predicates in db.ts (touchAttemptHeartbeat / markAttemptStopped)
 * must keep their SQL IN lists in lockstep with this whitelist — the
 * previous two hand-maintained copies had already drifted ('detached'
 * missing there), which would self-fence a daemon the moment anything
 * writes that state.
 */
export const ALIVE_ATTEMPT_STATES = ['starting', 'running', 'detached'] as const

/** Non-terminal runtime states: an attempt in one of these can still have a
 *  live runner. Terminal states (stopped/failed/lost) must NEVER count as
 *  heartbeat-fresh: markAttemptStopped stamps last_heartbeat_at with its own
 *  write time, so a timestamp-only check keeps a just-lost attempt "alive"
 *  and blocks its respawn (the fencing self-block this predicate fixes). */
export function isAttemptHeartbeatFresh(
  attempt: Pick<AttemptRecord, 'runtimeState' | 'lastHeartbeatAt'>,
  heartbeatTimeoutMs: number,
): boolean {
  return (
    (ALIVE_ATTEMPT_STATES as readonly string[]).includes(attempt.runtimeState)
    && attempt.lastHeartbeatAt !== null
    && Date.now() - attempt.lastHeartbeatAt < heartbeatTimeoutMs
  )
}
