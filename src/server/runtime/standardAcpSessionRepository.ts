import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { DbDriver } from '../db/driver.js'
import { ALIVE_ATTEMPT_STATES } from '../attemptLiveness.js'

const identifier = z.string().min(1).max(256).regex(/^[^\s\0]+$/)
const profileSchema = z.object({
  ownerId: identifier, orgId: identifier, profileId: identifier, agentId: identifier,
  authorityId: identifier,
  workspacePath: z.string().refine(value => (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) &&
    !value.includes('\0') && !value.split(/[\\/]/).includes('..'), 'Expected an absolute native workspace path without traversal'),
}).strict()
export type StandardAcpProfileBinding = z.infer<typeof profileSchema>
export type StandardAcpSessionClaim = StandardAcpProfileBinding & {
  sessionId: string; attemptId: string; writerNonce: string; nativeSessionId?: string
}
type Row = {
  owner_user_id: string; org_id: string; profile_id: string; native_agent_id: string;
  workspace_path: string; authority_id: string; native_session_id: string | null;
  writer_attempt_id: string; writer_nonce: string; writer_released: number | string
}
const sameProfile = (row: Row, profile: StandardAcpProfileBinding) => row.owner_user_id === profile.ownerId && row.org_id === profile.orgId &&
  row.profile_id === profile.profileId && row.native_agent_id === profile.agentId &&
  row.workspace_path === profile.workspacePath && row.authority_id === profile.authorityId

/** One native history/writer binding; all task lifecycle stays in Session/Attempt. */
export class StandardAcpSessionRepository {
  constructor(private readonly db: DbDriver) {}

  async #current(sessionId: string, attemptId: string, profile: StandardAcpProfileBinding, ownerInstanceId?: string): Promise<boolean> {
    const row = await this.db.get(`SELECT s.session_id FROM sessions s
      JOIN session_attempts a ON a.attempt_id = s.current_attempt_id
      WHERE s.session_id = ? AND s.user_id = ? AND s.org_id = ? AND s.deleted_at IS NULL
        AND s.desired_state = 'active' AND s.execution_engine = 'standard_acp' AND s.execution_profile_id = ?
        AND a.attempt_id = ? AND a.runtime_state IN (${ALIVE_ATTEMPT_STATES.map(state => `'${state}'`).join(',')})
        ${ownerInstanceId ? 'AND a.server_instance_id = ?' : ''}
        ${this.db.kind === 'postgres' ? 'FOR UPDATE OF s' : ''}`,
    [sessionId, profile.ownerId, profile.orgId, profile.profileId, attemptId, ...(ownerInstanceId ? [ownerInstanceId] : [])])
    return Boolean(row)
  }

  /** Reserve before any launch/open side effect. Unknown first opens never replay. */
  async claim(sessionId: string, attemptId: string, input: StandardAcpProfileBinding, ownerInstanceId?: string): Promise<StandardAcpSessionClaim> {
    const profile = profileSchema.parse(input)
    return this.db.transaction(async () => {
      if (!await this.#current(sessionId, attemptId, profile, ownerInstanceId)) throw new Error('ACP execution is not owned by this current attempt')
      const old = await this.db.get<Row>('SELECT * FROM standard_acp_sessions WHERE session_id = ?', [sessionId])
      if (old && !sameProfile(old, profile)) throw new Error('ACP history/profile binding cannot be replaced')
      if (old && !old.native_session_id) throw new Error('ACP first-open outcome is unknown; inspect it before recovery')
      if (old && Number(old.writer_released) !== 1) throw new Error('ACP prior writer cleanup is not confirmed')
      const nonce = randomUUID()
      if (old) {
        const changed = await this.db.run(`UPDATE standard_acp_sessions SET writer_attempt_id=?,writer_nonce=?,writer_released=0
          WHERE session_id=? AND writer_released=1 AND writer_nonce=?`, [attemptId, nonce, sessionId, old.writer_nonce])
        if (changed !== 1) throw new Error('ACP writer was concurrently claimed')
      } else {
        const changed = await this.db.run(`INSERT INTO standard_acp_sessions
          (session_id,owner_user_id,org_id,profile_id,native_agent_id,workspace_path,authority_id,native_session_id,writer_attempt_id,writer_nonce,writer_released)
          VALUES (?,?,?,?,?,?,?,NULL,?,?,0) ON CONFLICT(session_id) DO NOTHING`,
        [sessionId, profile.ownerId, profile.orgId, profile.profileId, profile.agentId, profile.workspacePath, profile.authorityId, attemptId, nonce])
        if (changed !== 1) throw new Error('ACP writer was concurrently claimed')
      }
      return { ...profile, sessionId, attemptId, writerNonce: nonce, ...(old?.native_session_id ? { nativeSessionId: old.native_session_id } : {}) }
    })
  }

  /** Publish the actual producer ID before accepting model input or runner readiness. */
  async bind(claim: StandardAcpSessionClaim, nativeSessionId: string, ownerInstanceId?: string): Promise<boolean> {
    identifier.parse(nativeSessionId)
    return this.db.transaction(async () => {
      if (!await this.#current(claim.sessionId, claim.attemptId, claim, ownerInstanceId)) return false
      const changed = await this.db.run(`UPDATE standard_acp_sessions SET native_session_id=?
        WHERE session_id=? AND writer_attempt_id=? AND writer_nonce=? AND writer_released=0
          AND (native_session_id IS NULL OR native_session_id=?)`,
      [nativeSessionId, claim.sessionId, claim.attemptId, claim.writerNonce, nativeSessionId])
      return changed === 1
    })
  }

  async assertCurrent(claim: StandardAcpSessionClaim, ownerInstanceId?: string): Promise<void> {
    if (!await this.#current(claim.sessionId, claim.attemptId, claim, ownerInstanceId)) throw new Error('ACP attempt lost ownership')
    const row = await this.db.get<Row>('SELECT * FROM standard_acp_sessions WHERE session_id=?', [claim.sessionId])
    if (!row || !sameProfile(row, claim) || row.writer_nonce !== claim.writerNonce || Number(row.writer_released) !== 0) {
      throw new Error('ACP writer is no longer held by this execution')
    }
  }

  /** Canonical event journal is the input deduplication authority, not a second Task store. */
  async recordInput(claim: StandardAcpSessionClaim, inputId: string, text: string, ownerInstanceId?: string): Promise<void> {
    identifier.parse(inputId)
    await this.db.transaction(async () => {
      await this.assertCurrent(claim, ownerInstanceId)
      const eventId = `acp-input:${createHash('sha256').update(JSON.stringify([claim.sessionId, inputId])).digest('hex')}`
      const changed = await this.db.run(`INSERT INTO session_events(event_id,session_id,attempt_id,event_type,payload_json,created_at)
        VALUES (?,?,?,'standard_acp_input',?,?) ON CONFLICT(event_id) DO NOTHING`,
      [eventId, claim.sessionId, claim.attemptId, JSON.stringify({ inputId, text, nativeSessionId: claim.nativeSessionId }), Date.now()])
      if (changed !== 1) throw new Error('ACP input already recorded; inspect its prior outcome instead of replaying')
    })
  }

  /** Only call after the launcher confirms its writer is gone; never on a signal alone. */
  async release(claim: StandardAcpSessionClaim): Promise<boolean> {
    return await this.db.run(`UPDATE standard_acp_sessions SET writer_released=1
      WHERE session_id=? AND owner_user_id=? AND org_id=? AND writer_attempt_id=? AND writer_nonce=?`,
    [claim.sessionId, claim.ownerId, claim.orgId, claim.attemptId, claim.writerNonce]) === 1
  }

  async read(sessionId: string, ownerId: string, orgId: string): Promise<{ profile: StandardAcpProfileBinding; nativeSessionId?: string; writerReleased: boolean } | undefined> {
    const row = await this.db.get<Row>('SELECT * FROM standard_acp_sessions WHERE session_id=? AND owner_user_id=? AND org_id=?', [sessionId, ownerId, orgId])
    return row ? { profile: profileSchema.parse({ ownerId, orgId, profileId: row.profile_id, agentId: row.native_agent_id,
      authorityId: row.authority_id, workspacePath: row.workspace_path }),
    ...(row.native_session_id ? { nativeSessionId: row.native_session_id } : {}), writerReleased: Number(row.writer_released) === 1 } : undefined
  }
}
