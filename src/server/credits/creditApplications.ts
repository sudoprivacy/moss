/**
 * Credit applications — the `approve` recharge mode.
 *
 * A user asks for points and an administrator grants them; there is no payment
 * involved. moss owns the *request*, SudoRouter owns the *balance*, and the two
 * are joined by one fallible step: after an approval is recorded, the points
 * have to be credited at the gateway.
 *
 * That step is why the status set is larger than approve/reject. A gateway call
 * can fail in two distinguishable ways, and conflating them would be a way to
 * lose money in either direction:
 *
 * - `SYNC_FAILED` — the gateway refused. Nothing was credited; retrying is safe.
 * - `SYNC_UNKNOWN` — the gateway never answered. It may or may not have applied
 *   the credit, so retrying could double it. A human reconciles this one.
 *
 * The client already renders both, so this is the contract it expects, not a
 * shape invented here.
 */
import { randomUUID } from 'node:crypto'
import type { SudorouterClient } from './sudorouter.js'
import { SudorouterError } from './sudorouter.js'

export type CreditApplicationStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'APPROVED'
  | 'REJECTED'
  | 'SYNC_FAILED'
  | 'SYNC_UNKNOWN'

export type CreditApplication = {
  id: number
  applicationNo: string
  userId: string
  orgId: string
  requestedPoints: number
  approvedPoints: number | null
  reason: string | null
  status: CreditApplicationStatus
  adminComment: string | null
  createdAt: number
  reviewedAt: number | null
  sudorouterError: string | null
}

/** The wire shape the sudowork client reads. Snake case, points not quota. */
export type CreditApplicationPayload = {
  id: number
  application_no: string
  requested_points: number
  approved_points: number | null
  quota_amount: number | null
  reason: string | null
  status: CreditApplicationStatus
  admin_comment: string | null
  created_at: string
  reviewed_at: string | null
  sudorouter_error: string | null
}

export type CreditApplicationStore = {
  create(input: Omit<CreditApplication, 'id' | 'applicationNo' | 'createdAt' | 'status'
    | 'approvedPoints' | 'adminComment' | 'reviewedAt' | 'sudorouterError'>): Promise<CreditApplication>
  listForUser(userId: string, page: number, pageSize: number): Promise<{ list: CreditApplication[]; total: number }>
  getById(id: number): Promise<CreditApplication | null>
  hasPending(userId: string): Promise<boolean>
  updateStatus(id: number, patch: {
    status: CreditApplicationStatus
    approvedPoints?: number | null
    adminComment?: string | null
    reviewedAt?: number | null
    sudorouterError?: string | null
  }): Promise<void>
}

export class CreditApplicationError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
    this.name = 'CreditApplicationError'
  }
}

export type CreditApplicationPolicy = {
  minPoints: number
  maxPoints: number
  allowDuplicatePending: boolean
}

export function toPayload(app: CreditApplication, quotaPerPoint: (points: number) => number): CreditApplicationPayload {
  return {
    id: app.id,
    application_no: app.applicationNo,
    requested_points: app.requestedPoints,
    approved_points: app.approvedPoints,
    quota_amount: app.approvedPoints == null ? null : quotaPerPoint(app.approvedPoints),
    reason: app.reason,
    status: app.status,
    admin_comment: app.adminComment,
    created_at: new Date(app.createdAt).toISOString(),
    reviewed_at: app.reviewedAt == null ? null : new Date(app.reviewedAt).toISOString(),
    sudorouter_error: app.sudorouterError,
  }
}

export function newApplicationNo(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:T.]/g, '').slice(0, 14)
  return `CA${stamp}${randomUUID().slice(0, 6).toUpperCase()}`
}

export async function submitApplication(
  store: CreditApplicationStore,
  policy: CreditApplicationPolicy,
  input: { userId: string; orgId: string; requestedPoints: unknown; reason: unknown },
): Promise<CreditApplication> {
  const points = Number(input.requestedPoints)
  if (!Number.isInteger(points) || points <= 0) {
    throw new CreditApplicationError(400, 'requested_points must be a positive integer')
  }
  if (points < policy.minPoints || points > policy.maxPoints) {
    throw new CreditApplicationError(
      400,
      `requested_points must be between ${policy.minPoints} and ${policy.maxPoints}`,
    )
  }
  // A second pending request is refused rather than queued: two open asks from
  // one person give the reviewer no way to tell a correction from a duplicate.
  if (!policy.allowDuplicatePending && await store.hasPending(input.userId)) {
    throw new CreditApplicationError(409, 'A previous application is still awaiting review')
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 2000) : null
  return store.create({
    userId: input.userId,
    orgId: input.orgId,
    requestedPoints: points,
    reason: reason || null,
  })
}

/**
 * Record a decision and, when it is an approval, credit the gateway.
 *
 * The status is written *before* the gateway call and moved afterwards, so an
 * approval that dies mid-flight leaves `PROCESSING` behind rather than
 * vanishing. Nothing here retries on its own — see `SYNC_UNKNOWN`.
 */
export async function reviewApplication(
  store: CreditApplicationStore,
  /** Null is allowed: a rejection never reaches the gateway. */
  sudorouter: SudorouterClient | null,
  input: {
    id: number
    approve: boolean
    approvedPoints?: number
    adminComment?: string
    gatewayUserId: string | null
  },
): Promise<CreditApplication> {
  const app = await store.getById(input.id)
  if (!app) throw new CreditApplicationError(404, 'Application not found')
  if (app.status !== 'PENDING' && app.status !== 'SYNC_FAILED') {
    throw new CreditApplicationError(409, `Application is ${app.status} and cannot be reviewed`)
  }

  const now = Date.now()
  const comment = input.adminComment?.trim() || null

  if (!input.approve) {
    await store.updateStatus(app.id, {
      status: 'REJECTED',
      approvedPoints: 0,
      adminComment: comment,
      reviewedAt: now,
      sudorouterError: null,
    })
    return (await store.getById(app.id))!
  }

  const points = input.approvedPoints ?? app.requestedPoints
  if (!Number.isInteger(points) || points <= 0) {
    throw new CreditApplicationError(400, 'approved_points must be a positive integer')
  }
  if (!input.gatewayUserId) {
    // Approving with nowhere to credit would report success and move no money.
    throw new CreditApplicationError(
      409,
      'User has no model gateway account; credits cannot be applied',
    )
  }
  if (!sudorouter) {
    throw new CreditApplicationError(503, 'Model gateway is not configured')
  }

  await store.updateStatus(app.id, {
    status: 'PROCESSING',
    approvedPoints: points,
    adminComment: comment,
    reviewedAt: now,
    sudorouterError: null,
  })

  try {
    await sudorouter.addPoints(input.gatewayUserId, points, `credit application ${app.applicationNo}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // A refusal carries a status: the gateway decided, so nothing was applied.
    // No status means the answer never arrived and the outcome is unknown.
    const refused = error instanceof SudorouterError && error.status !== undefined
    await store.updateStatus(app.id, {
      status: refused ? 'SYNC_FAILED' : 'SYNC_UNKNOWN',
      sudorouterError: message.slice(0, 500),
    })
    return (await store.getById(app.id))!
  }

  await store.updateStatus(app.id, { status: 'APPROVED', sudorouterError: null })
  return (await store.getById(app.id))!
}
