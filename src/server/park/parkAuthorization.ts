import type { DbDriver, SqlParam, SqlRow } from '../db/driver.js'

/**
 * Park domain authorization — the single entry point for park role checks,
 * enterprise binding checks and cross-org assistant-assignment checks.
 *
 * Resource references (assistant / skill) may arrive as either the tenant
 * table UUID or the display name: createSession receives the raw client
 * reference while spawnAttempt/resume receive the already-resolved
 * resource.id (runtimeService.ts replaces it after requireOrganizationResource).
 * Every resolver here must accept both forms.
 */

export class ParkApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ParkApiError'
  }
}

export type ParkRole = 'park_leader' | 'park_ops' | 'park_system_operator'

export type GrantedParkResources = {
  parkOrgId: string
  /** tenant_assistants ids (approved + tenant/custom only) granted cross-org. */
  agentIds: string[]
  /** tenant_skills ids (approved + tenant/custom only) enabled by the granted assistant. */
  skillIds: string[]
}

type MinimalAuth = { userId: string; orgId: string }

const RESOURCE_PRECONDITION = `status = 'approved' AND source_type IN ('tenant', 'custom')`

/** Candidate tenant_assistants ids for a reference (UUID id or display name). */
async function resolveAssistantIds(driver: DbDriver, assistantRef: string): Promise<Array<{ id: string; orgId: string }>> {
  const rows = await driver.all<SqlRow>(
    `SELECT id, org_id FROM tenant_assistants WHERE (${RESOURCE_PRECONDITION}) AND (id = ? OR name = ?)`,
    [assistantRef, assistantRef],
  )
  return rows.map(row => ({ id: String(row.id), orgId: String(row.org_id) }))
}

/**
 * Resolve the park cross-org grant for a caller org (enterprise) and an
 * assistant reference. Returns null when the assistant is not part of any
 * park assignment for this org (the caller keeps its default behavior).
 *
 * grantedIds generation rule (plan 2.6 #4): only approved + tenant/custom
 * resources may enter the grant, mirroring the main catalog SQL conditions.
 */
export async function resolveParkScopedResources(
  driver: DbDriver,
  callerOrgId: string,
  assistantRef: string | null | undefined,
): Promise<GrantedParkResources | null> {
  if (!assistantRef) return null
  const candidates = await resolveAssistantIds(driver, assistantRef)
  if (candidates.length === 0) return null
  const assignment = await findAssignment(driver, callerOrgId, candidates.map(c => c.id))
  if (!assignment) return null

  const granted = candidates.find(c => c.id === assignment.assistantId)!
  const skillIds = await resolveEnabledSkillIds(driver, granted.orgId, assignment.assistantId)
  return { parkOrgId: assignment.parkOrgId, agentIds: [assignment.assistantId], skillIds }
}

async function findAssignment(
  driver: DbDriver,
  enterpriseOrgId: string,
  assistantIds: string[],
): Promise<{ parkOrgId: string; assistantId: string } | null> {
  if (assistantIds.length === 0) return null
  const placeholders = assistantIds.map(() => '?').join(', ')
  const row = await driver.get<SqlRow>(
    `SELECT park_org_id, assistant_id FROM park_assistant_assignments
     WHERE assistant_id IN (${placeholders}) AND enterprise_org_id = ? LIMIT 1`,
    [...assistantIds, enterpriseOrgId] as SqlParam[],
  )
  return row ? { parkOrgId: String(row.park_org_id), assistantId: String(row.assistant_id) } : null
}

/** tenant_skills ids (park org scope, approved+tenant/custom) enabled by the assistant. */
async function resolveEnabledSkillIds(driver: DbDriver, parkOrgId: string, assistantId: string): Promise<string[]> {
  const row = await driver.get<SqlRow>(
    `SELECT enabled_skills FROM tenant_assistants WHERE id = ?`, [assistantId],
  )
  const refs = parseStringArray(row?.enabled_skills)
  if (refs.length === 0) return []
  const placeholders = refs.map(() => '?').join(', ')
  const rows = await driver.all<SqlRow>(
    `SELECT id FROM tenant_skills WHERE org_id = ? AND (${RESOURCE_PRECONDITION})
     AND (id IN (${placeholders}) OR name IN (${placeholders}))`,
    [parkOrgId, ...refs, ...refs] as SqlParam[],
  )
  return rows.map(r => String(r.id))
}

function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/**
 * Session-creation gate for park-assigned assistants (plan 2.6 #2).
 * Returns null to allow; throws ParkApiError(403) to deny:
 *  - caller org == the assistant's owning park org → allow (same-org users go
 *    through the regular visible_to path; park staff can self-test);
 *  - the assistant is in the assignment table but the caller org is not an
 *    assigned enterprise → deny;
 *  - assistant not in the assignment table at all → allow (non-park flow).
 */
export async function assertParkAssistantAllowed(
  driver: DbDriver,
  auth: MinimalAuth,
  assistantName: string | null | undefined,
): Promise<void> {
  if (!assistantName) return
  const candidates = await resolveAssistantIds(driver, assistantName)
  if (candidates.length === 0) return
  if (candidates.some(c => c.orgId === auth.orgId)) return
  const rows = await driver.all<SqlRow>(
    `SELECT enterprise_org_id FROM park_assistant_assignments WHERE assistant_id IN (${candidates.map(() => '?').join(', ')})`,
    candidates.map(c => c.id) as SqlParam[],
  )
  if (rows.length === 0) return
  const assigned = rows.some(row => String(row.enterprise_org_id) === auth.orgId)
  if (!assigned) {
    throw new ParkApiError(403, 'park_assistant_not_assigned', '该智能体未分配给当前组织')
  }
}

// ---- park role checks ----

export async function getParkRole(driver: DbDriver, parkOrgId: string, userId: string): Promise<ParkRole | null> {
  const row = await driver.get<SqlRow>(
    `SELECT park_role FROM park_members WHERE park_org_id = ? AND user_id = ?`, [parkOrgId, userId],
  )
  return row ? row.park_role as ParkRole : null
}

export async function requireParkMember(
  driver: DbDriver,
  auth: MinimalAuth,
  parkOrgId: string,
  allowedRoles?: ParkRole[],
): Promise<ParkRole> {
  if (auth.orgId !== parkOrgId) {
    // Distinguish cross-park access (another park's staff) from a non-park
    // caller (e.g. an enterprise user) — both 403, different codes.
    const caller = await driver.get<SqlRow>(
      `SELECT org_type FROM park_org_profiles WHERE moss_org_id = ?`, [auth.orgId],
    )
    if (caller?.org_type === 'park') {
      throw new ParkApiError(403, 'park_cross_org', '无权访问其他园区的数据')
    }
    throw new ParkApiError(403, 'park_member_required', '需要园区成员身份')
  }
  const role = await getParkRole(driver, parkOrgId, auth.userId)
  if (!role) {
    throw new ParkApiError(403, 'park_member_required', '需要园区成员身份')
  }
  if (allowedRoles && !allowedRoles.includes(role)) {
    throw new ParkApiError(403, 'park_role_denied', '当前园区角色无权执行此操作')
  }
  return role
}

// ---- enterprise context ----

/**
 * Resolve the park context of an enterprise-org caller: their binding (which
 * park they belong to). Returns null when the org is not a bound enterprise.
 */
export async function resolveEnterpriseParkOrg(
  driver: DbDriver,
  enterpriseOrgId: string,
): Promise<string | null> {
  const row = await driver.get<SqlRow>(
    `SELECT park_org_id FROM park_enterprise_bindings WHERE enterprise_org_id = ? ORDER BY created_at DESC LIMIT 1`,
    [enterpriseOrgId],
  )
  return row ? String(row.park_org_id) : null
}

/** Require the caller org to be an enterprise bound to a park; returns parkOrgId. */
export async function requireEnterpriseOfPark(driver: DbDriver, auth: MinimalAuth): Promise<string> {
  const parkOrgId = await resolveEnterpriseParkOrg(driver, auth.orgId)
  if (!parkOrgId) {
    throw new ParkApiError(403, 'enterprise_not_bound', '当前组织未绑定园区')
  }
  return parkOrgId
}
