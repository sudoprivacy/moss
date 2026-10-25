import { hasScope, type AuthContext } from './auth/token.js'
import { mossAgentName, sessionAgentName } from './agentIdentity.js'
import { ResourceAccessError } from './catalog/resourceError.js'
import type { DbDriver } from './db/driver.js'

/** Shared DDL for SQLite initialization and the versioned PostgreSQL migration. */
export const MOSS_MEMBER_ACCESS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS moss_member_access (
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    enabled BIGINT NOT NULL CHECK (enabled IN (0, 1)),
    updated_by TEXT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (org_id, user_id)
  );
`

export interface MossMember {
  id: string
  orgId: string
  role: string
  status: string
}

export interface PersonalMossAgent {
  ref: string
  agentName: string
  displayName: string
  ownerId: string
  orgId: string
}

/** Moss use is distinct from SudoWork login, IM pairing and data-source grants. */
export class MossAgentAccess {
  constructor(
    private readonly driver: DbDriver,
    private readonly member: (userId: string) => Promise<MossMember | null>,
  ) {}

  async initialize(): Promise<void> {
    await this.driver.exec(MOSS_MEMBER_ACCESS_SCHEMA)
  }

  async canUse(orgId: string, userId: string): Promise<boolean> {
    const user = await this.member(userId)
    if (!user || user.orgId !== orgId || user.status !== 'active') return false
    const grant = await this.driver.get<{ enabled: number }>(
      'SELECT enabled FROM moss_member_access WHERE org_id = ? AND user_id = ?', [orgId, userId],
    )
    // Explicit revocation also applies to admins. Roles are read from the
    // authoritative member record, never from a cached JWT or caller payload.
    return grant ? Number(grant.enabled) === 1 : user.role === 'admin' || user.role === 'super_admin'
  }

  async requireUser(orgId: string, userId: string): Promise<void> {
    if (!await this.canUse(orgId, userId)) throw new ResourceAccessError(403, 'Moss access is not available')
  }

  async getAgent(orgId: string, userId: string): Promise<PersonalMossAgent> {
    await this.requireUser(orgId, userId)
    const ref = mossAgentName(orgId, userId)
    return { ref, agentName: sessionAgentName(userId, ref), displayName: 'Moss', ownerId: userId, orgId }
  }

  async setAccess(auth: AuthContext, userId: string, isEnabled: boolean): Promise<void> {
    const actor = await this.member(auth.userId)
    if (!actor || actor.status !== 'active' || actor.orgId !== auth.orgId ||
      !['admin', 'super_admin'].includes(actor.role) || !hasScope(auth.scopes, 'admin:users')) {
      throw new ResourceAccessError(403, 'Organization administrator required')
    }
    const target = await this.member(userId)
    if (!target || target.orgId !== auth.orgId) throw new ResourceAccessError(404, 'Member not available')
    await this.driver.run(`
      INSERT INTO moss_member_access (org_id, user_id, enabled, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (org_id, user_id) DO UPDATE SET
        enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `, [auth.orgId, userId, isEnabled ? 1 : 0, auth.userId, Date.now()])
  }
}
