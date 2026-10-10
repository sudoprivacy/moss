import { z } from 'zod'
import { ALIVE_ATTEMPT_STATES } from '../attemptLiveness.js'
import type { DbDriver } from '../db/driver.js'

/** Native transcript and repository identity; process IDs belong to the live runner. */
export interface CohostSessionBinding {
  ownerId: string
  agentId: string
  durableSessionId: string
  repositoryPath: string
}

const bindingSchema = z.object({
  ownerId: z.string().min(1),
  agentId: z.string().min(1).max(256).regex(/^[^/\\\0]+$/),
  durableSessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  repositoryPath: z.string().startsWith('/').refine(path => !/[\\\0]/.test(path) &&
    !path.split('/').includes('..')),
})

/** Validate a durable binding at the database and authenticated runner boundaries. */
export function parseCohostSessionBinding(value: unknown): CohostSessionBinding {
  return bindingSchema.parse(value)
}

/** Native execution identity is separate from the WebUI transcript projection. */
export class CohostSessionRepository {
  constructor(private readonly driver: DbDriver) {}

  async get(sessionId: string): Promise<CohostSessionBinding | undefined> {
    const row = await this.driver.get<{ owner_user_id: string; native_agent_id: string; durable_session_id: string; repository_path: string }>(`
      SELECT owner_user_id, native_agent_id, durable_session_id, repository_path FROM cohost_sessions WHERE session_id = ?
    `, [sessionId])
    return row ? parseCohostSessionBinding({ ownerId: row.owner_user_id, agentId: row.native_agent_id, durableSessionId: row.durable_session_id, repositoryPath: row.repository_path }) : undefined
  }

  /** Publish once, before runner readiness, and refuse stale attempts or changed history. */
  async bind(sessionId: string, attemptId: string, input: CohostSessionBinding, ownerInstanceId?: string): Promise<boolean> {
    const binding = parseCohostSessionBinding(input)
    const changes = await this.driver.run(`
      INSERT INTO cohost_sessions (session_id, owner_user_id, native_agent_id, durable_session_id, repository_path)
      SELECT s.session_id, s.user_id, ?, ?, ? FROM sessions s
      JOIN session_attempts a ON a.attempt_id = s.current_attempt_id
      WHERE s.session_id = ? AND s.user_id = ? AND s.runtime_type = 'cohost' AND s.deleted_at IS NULL
        AND a.attempt_id = ?
        AND a.runtime_state IN (${ALIVE_ATTEMPT_STATES.map(state => `'${state}'`).join(', ')})
        ${ownerInstanceId ? 'AND a.server_instance_id = ?' : ''}
      ON CONFLICT (session_id) DO UPDATE
        SET durable_session_id = excluded.durable_session_id, repository_path = excluded.repository_path
        WHERE cohost_sessions.owner_user_id = excluded.owner_user_id
          AND cohost_sessions.native_agent_id = excluded.native_agent_id
          AND cohost_sessions.durable_session_id = excluded.durable_session_id
          AND cohost_sessions.repository_path = excluded.repository_path
    `, [binding.agentId, binding.durableSessionId, binding.repositoryPath, sessionId, binding.ownerId, attemptId,
      ...(ownerInstanceId ? [ownerInstanceId] : [])])
    return changes === 1
  }
}
