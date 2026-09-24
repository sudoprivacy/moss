import type { DbDriver } from '../../db/driver.js'

export interface MembershipSnapshot {
  status: string
  role: string
  revision: number
}

/** Read the membership fact used by both delegation issuance and Nexus revalidation. */
export async function lookupMembership(
  driver: DbDriver,
  userId: string,
  orgId: string,
): Promise<MembershipSnapshot | null> {
  const row = await driver.get(
    `SELECT status, role, membership_revision
     FROM users
     WHERE id = ? AND org_id = ?
     LIMIT 1`,
    [userId, orgId],
  )
  if (!row) return null
  return {
    status: String(row.status),
    role: String(row.role),
    revision: Number(row.membership_revision),
  }
}
