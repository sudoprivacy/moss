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
  name?: string
  displayName?: string | null
}

export interface PersonalMossAgent {
  ref: string
  agentName: string
  displayName: string
  ownerId: string
  orgId: string
  ownerName: string
}

export interface MossMemberAccess {
  orgId: string
  userId: string
  isEnabled: boolean
  isGranted: boolean
  source: 'role' | 'explicit'
  memberStatus: string
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

  private async authorizedMember(orgId: string, userId: string): Promise<MossMember | null> {
    const user = await this.member(userId)
    if (!user || user.orgId !== orgId || user.status !== 'active') return null
    return (await this.memberAccess(user)).isEnabled ? user : null
  }

  private async memberAccess(user: MossMember): Promise<MossMemberAccess> {
    const grant = await this.driver.get<{ enabled: number }>(
      'SELECT enabled FROM moss_member_access WHERE org_id = ? AND user_id = ?', [user.orgId, user.id],
    )
    // Explicit revocation also applies to admins. Roles are read from the
    // authoritative member record, never from a cached JWT or caller payload.
    const isAllowed = grant ? Number(grant.enabled) === 1 : user.role === 'admin' || user.role === 'super_admin'
    return { orgId: user.orgId, userId: user.id, isGranted: isAllowed,
      isEnabled: user.status === 'active' && isAllowed, source: grant ? 'explicit' : 'role', memberStatus: user.status }
  }

  async canUse(orgId: string, userId: string): Promise<boolean> {
    return Boolean(await this.authorizedMember(orgId, userId))
  }

  async requireUser(orgId: string, userId: string): Promise<MossMember> {
    const user = await this.authorizedMember(orgId, userId)
    if (!user) throw new ResourceAccessError(403, 'Moss access is not available')
    return user
  }

  async getAgent(orgId: string, userId: string): Promise<PersonalMossAgent> {
    const member = await this.requireUser(orgId, userId)
    const ref = mossAgentName(orgId, userId)
    return { ref, agentName: sessionAgentName(userId, ref), displayName: 'Moss', ownerId: userId, orgId,
      ownerName: member.displayName?.trim() || member.name?.trim() || 'Moss' }
  }

  private async managedMember(auth: AuthContext, userId: string): Promise<MossMember> {
    const actor = await this.member(auth.userId)
    if (!actor || actor.status !== 'active' || (actor.orgId !== auth.orgId && actor.role !== 'super_admin') ||
      !['admin', 'super_admin'].includes(actor.role) || !hasScope(auth.scopes, 'admin:users')) {
      throw new ResourceAccessError(403, 'Organization administrator required')
    }
    const target = await this.member(userId)
    if (!target || target.orgId !== auth.orgId) throw new ResourceAccessError(404, 'Member not available')
    return target
  }

  async getAccess(auth: AuthContext, userId: string): Promise<MossMemberAccess> {
    return this.memberAccess(await this.managedMember(auth, userId))
  }

  async setAccess(auth: AuthContext, userId: string, isEnabled: boolean): Promise<MossMemberAccess> {
    await this.managedMember(auth, userId)
    await this.driver.run(`
      INSERT INTO moss_member_access (org_id, user_id, enabled, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (org_id, user_id) DO UPDATE SET
        enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `, [auth.orgId, userId, isEnabled ? 1 : 0, auth.userId, Date.now()])
    return this.getAccess(auth, userId)
  }
}
