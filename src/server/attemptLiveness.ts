import type { AttemptRecord } from './types.js'

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
    (attempt.runtimeState === 'starting'
      || attempt.runtimeState === 'running'
      || attempt.runtimeState === 'detached')
    && attempt.lastHeartbeatAt !== null
    && Date.now() - attempt.lastHeartbeatAt < heartbeatTimeoutMs
  )
}
