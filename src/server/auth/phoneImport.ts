/**
 * Bulk import of phone identities from the previous server.
 *
 * This copies accounts; it does not move them. The previous server stays live
 * and keeps authenticating the same people, so the two deployments hold
 * overlapping rosters on purpose and the import is a repeatable sync rather
 * than a one-way cutover.
 *
 * That is only safe because of what is *not* copied. Each account's credit
 * balance lives in the upstream model gateway, keyed on a per-user token, and
 * this carries the token rather than the numbers. One person therefore keeps
 * one balance, spent from whichever deployment they sign in to. Copying the
 * numbers instead would have produced two ledgers for one person and let them
 * be spent twice.
 *
 * Two properties follow from being a sync:
 *
 * - **Re-runnable, add-only.** A phone already on file is left alone, so the
 *   sync can be repeated at any time to pick up whoever has signed up on the
 *   old server since. It deliberately does not update existing accounts: the
 *   old server is not authoritative over what moss already knows, so a name or
 *   status changed on one side does not overwrite the other. The cost is that
 *   the two rosters drift apart over time, which is inherent to running both.
 * - **Rehearsable.** `dryRun` executes the real path and rolls it back, so what
 *   the rehearsal reports is what the real run will do — not what a separate
 *   simulation believes it will do.
 */
import { z } from 'zod/v4'
import type { AuthService } from './service.js'
import { normalizePhone } from './phoneAuth.js'

/**
 * A sync runs over a known roster, so the cap is there to keep a malformed or
 * hostile request from turning into an unbounded transaction — not to page a
 * real import.
 */
const MAX_ROWS = 2000

const rowSchema = z.object({
  phone: z.string(),
  nickname: z.string().optional(),
  group: z.string().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  createdAt: z.number().int().nonnegative().optional(),
  sudorouterUserId: z.string().optional(),
  sudorouterKey: z.string().optional(),
})

const requestSchema = z.object({
  users: z.array(rowSchema).min(1).max(MAX_ROWS),
  groupNames: z.record(z.string(), z.string()).optional(),
  dryRun: z.boolean().optional(),
})

export function parsePhoneImportRequest(body: unknown): PhoneImportRequest {
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? ` at ${issue.path.join('.')}` : ''
    throw new Error(`Invalid import request${where}: ${issue?.message ?? 'unknown error'}`)
  }
  return parsed.data
}

export type PhoneImportRow = {
  phone: string
  nickname?: string
  /**
   * Opaque grouping key from the source system (its enterprise id). Rows sharing
   * a key land in one organization; a key held by a single row yields a
   * one-person organization, which needs no special case.
   */
  group?: string
  status?: 'active' | 'disabled'
  /** Original signup time in epoch milliseconds. */
  createdAt?: number
  sudorouterUserId?: string
  sudorouterKey?: string
}

export type PhoneImportRequest = {
  users: PhoneImportRow[]
  /** Grouping key -> organization name. Keys absent here fall back to a generated name. */
  groupNames?: Record<string, string>
  /** Execute and roll back, reporting exactly what a real run would do. */
  dryRun?: boolean
}

export type PhoneImportOutcome = 'created' | 'existing' | 'linked' | 'error'

export type PhoneImportRowResult = {
  /** Echoed in the caller's original form so a failing row is identifiable without the normalized value. */
  phone: string
  outcome: PhoneImportOutcome
  orgId?: string
  userId?: string
  error?: string
}

export type PhoneImportResult = {
  dryRun: boolean
  summary: Record<PhoneImportOutcome, number> & { total: number; organizationsCreated: number }
  rows: PhoneImportRowResult[]
}

/**
 * Organization names are user-visible, so a group with no supplied name gets a
 * marked placeholder rather than a bare id — it reads as unfinished imported
 * data, which is what it is, instead of looking like a deliberate name.
 */
function fallbackOrgName(group: string): string {
  return `Imported group ${group}`
}

export function importPhoneUsers(
  authService: AuthService,
  request: PhoneImportRequest,
): PhoneImportResult {
  const dryRun = request.dryRun === true
  const rows: PhoneImportRowResult[] = []
  const summary = {
    total: request.users.length,
    created: 0,
    existing: 0,
    linked: 0,
    error: 0,
    organizationsCreated: 0,
  }

  // Resolved once per run: many rows share a group, and resolving per row would
  // race itself into duplicate organizations within a single import.
  const orgIdByGroup = new Map<string, string>()

  const resolveOrgId = (group: string): string => {
    const cached = orgIdByGroup.get(group)
    if (cached) return cached
    const name = request.groupNames?.[group]?.trim() || fallbackOrgName(group)
    const existing = authService.findOrganizationByName(name)
    if (existing) {
      orgIdByGroup.set(group, existing.id)
      return existing.id
    }
    const created = authService.createOrganization({ name }).organization
    summary.organizationsCreated += 1
    orgIdByGroup.set(group, created.id)
    return created.id
  }

  authService.runInTransaction(() => {
    for (const row of request.users) {
      const phone = normalizePhone(row.phone)
      if (!phone) {
        rows.push({ phone: row.phone, outcome: 'error', error: 'Invalid phone number' })
        summary.error += 1
        continue
      }

      const credential = row.sudorouterKey
        ? { sudorouterUserId: row.sudorouterUserId ?? null, sudorouterKey: row.sudorouterKey }
        : undefined

      try {
        const { user, created } = authService.provisionPhoneUser({
          phone,
          nickname: row.nickname,
          autoCreateOrg: true,
          orgId: row.group ? resolveOrgId(row.group) : undefined,
          status: row.status,
          createdAt: row.createdAt,
          modelCredential: credential,
        })

        if (created) {
          rows.push({ phone: row.phone, outcome: 'created', orgId: user.orgId, userId: user.id })
          summary.created += 1
          continue
        }

        // Already present — from an earlier sync, or because they signed up
        // here directly while the old server was still serving them. Their
        // identity is left as it is, but a missing gateway token is still worth
        // attaching: without it the account would silently spend the shared
        // server key instead of their own balance.
        if (credential && !authService.getUserModelCredential(user.id)) {
          authService.setUserModelCredential(user.id, credential)
          rows.push({ phone: row.phone, outcome: 'linked', orgId: user.orgId, userId: user.id })
          summary.linked += 1
          continue
        }

        rows.push({ phone: row.phone, outcome: 'existing', orgId: user.orgId, userId: user.id })
        summary.existing += 1
      } catch (error) {
        rows.push({
          phone: row.phone,
          outcome: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
        summary.error += 1
      }
    }
  }, { rollback: dryRun })

  return { dryRun, summary, rows }
}
