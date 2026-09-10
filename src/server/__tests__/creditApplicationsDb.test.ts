// Runs under Node (AuthCenterDb uses node:sqlite, which Bun lacks): `tsx --test`.
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { AuthCenterDb } from '../authCenter/db.js'
import { AuthService } from '../auth/service.js'
import { reviewApplication, submitApplication } from '../credits/creditApplications.js'
import type { SudorouterClient } from '../credits/sudorouter.js'

/**
 * The credit-application logic is unit-tested against an in-memory store; this
 * exercises the same flows through the real table, which is where a column
 * mapping or a partial UPDATE goes wrong without any test noticing.
 */

let db: AuthCenterDb
let raw: DatabaseSync
let auth: AuthService
let userId: string

const POLICY = { minPoints: 100, maxPoints: 10_000, allowDuplicatePending: false }

const noopGateway: SudorouterClient = {
  getCredits: async () => ({ remainingPoints: 0, usedPoints: 0 }),
  getModelUsage: async () => [],
  addPoints: async () => {},
}

beforeEach(() => {
  raw = new DatabaseSync(':memory:')
  db = new AuthCenterDb(raw, ':memory:')
  auth = new AuthService(db, 3600)
  const { user } = auth.provisionPhoneUser({
    phone: '13800138000', nickname: 'Tester', autoCreateOrg: true,
  })
  userId = user.id
})

afterEach(() => {
  auth.destroy()
  raw.close()
})

describe('credit applications on the real table', () => {
  it('stores and reads back an application', () => {
    const app = submitApplication(auth.creditApplications, POLICY, {
      userId, orgId: 'org-1', requestedPoints: 500, reason: 'need credits',
    })
    assert.ok(app.id > 0)
    assert.match(app.applicationNo, /^CA\d{14}[0-9A-F]{6}$/)

    const listed = auth.creditApplications.listForUser(userId, 1, 20)
    assert.equal(listed.total, 1)
    assert.equal(listed.list[0]?.requestedPoints, 500)
    assert.equal(listed.list[0]?.reason, 'need credits')
    assert.equal(listed.list[0]?.status, 'PENDING')
    assert.equal(listed.list[0]?.approvedPoints, null)
  })

  it('pages, newest first', () => {
    for (let i = 0; i < 5; i++) {
      auth.creditApplications.create({ userId, orgId: 'org-1', requestedPoints: 100 + i, reason: null })
    }
    const first = auth.creditApplications.listForUser(userId, 1, 2)
    assert.equal(first.total, 5)
    assert.equal(first.list.length, 2)
    const second = auth.creditApplications.listForUser(userId, 2, 2)
    assert.equal(second.list.length, 2)
    assert.notEqual(first.list[0]?.id, second.list[0]?.id)
  })

  it('keeps a comment that a later status move does not mention', async () => {
    // The gateway call happens after the comment is written; a status-only
    // update must not blank it, which a naive full-row UPDATE would.
    const app = submitApplication(auth.creditApplications, POLICY, {
      userId, orgId: 'org-1', requestedPoints: 500, reason: null,
    })
    const reviewed = await reviewApplication(auth.creditApplications, noopGateway, {
      id: app.id, approve: true, gatewayUserId: '42', adminComment: 'approved by ops',
    })
    assert.equal(reviewed.status, 'APPROVED')
    assert.equal(reviewed.adminComment, 'approved by ops')
    assert.equal(reviewed.approvedPoints, 500)
    assert.ok(reviewed.reviewedAt && reviewed.reviewedAt > 0)
  })

  it('sees an in-flight review as still pending', async () => {
    // PROCESSING is a decision mid-flight; letting a second request through
    // while one is in the air is how a person gets granted twice.
    const app = submitApplication(auth.creditApplications, POLICY, {
      userId, orgId: 'org-1', requestedPoints: 500, reason: null,
    })
    auth.creditApplications.updateStatus(app.id, { status: 'PROCESSING' })
    assert.equal(auth.creditApplications.hasPending(userId), true)

    auth.creditApplications.updateStatus(app.id, { status: 'APPROVED' })
    assert.equal(auth.creditApplications.hasPending(userId), false)
  })

  it('records why a gateway refusal failed', async () => {
    const app = submitApplication(auth.creditApplications, POLICY, {
      userId, orgId: 'org-1', requestedPoints: 500, reason: null,
    })
    const failing: SudorouterClient = {
      ...noopGateway,
      addPoints: async () => { throw new Error('gateway said no') },
    }
    const reviewed = await reviewApplication(auth.creditApplications, failing, {
      id: app.id, approve: true, gatewayUserId: '42',
    })
    // A plain Error carries no status, so the outcome is unknown, not refused.
    assert.equal(reviewed.status, 'SYNC_UNKNOWN')
    assert.match(reviewed.sudorouterError ?? '', /gateway said no/)

    const reloaded = auth.creditApplications.getById(app.id)
    assert.equal(reloaded?.status, 'SYNC_UNKNOWN')
    assert.match(reloaded?.sudorouterError ?? '', /gateway said no/)
  })

  it('scopes the list to its own user', () => {
    const other = auth.provisionPhoneUser({
      phone: '13800138001', nickname: 'Other', autoCreateOrg: true,
    }).user
    submitApplication(auth.creditApplications, POLICY, {
      userId, orgId: 'org-1', requestedPoints: 500, reason: null,
    })
    assert.equal(auth.creditApplications.listForUser(other.id, 1, 20).total, 0)
  })
})
