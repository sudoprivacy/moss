import type { SqlParam } from '../db/driver.js'

/** The attempt and server whose lease authorizes a session lifecycle write. */
export interface SessionAttemptFence {
  attemptId: string
  ownerInstanceId?: string
}

/** Keep the ownership check in the same SQL statement as the lifecycle update. */
export function sessionAttemptFenceSql(fence?: SessionAttemptFence): { clause: string; params: SqlParam[] } {
  if (!fence) return { clause: '', params: [] }
  const params: SqlParam[] = [fence.attemptId]
  let clause = 'AND sessions.current_attempt_id = ?'
  if (fence.ownerInstanceId !== undefined) {
    clause += ` AND EXISTS (
      SELECT 1 FROM session_attempts a
      WHERE a.attempt_id = sessions.current_attempt_id AND a.server_instance_id = ?
    )`
    params.push(fence.ownerInstanceId)
  }
  return { clause, params }
}
