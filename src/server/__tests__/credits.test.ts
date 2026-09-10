import { describe, expect, it } from 'bun:test'
import {
  createSudorouterClient,
  pointsToQuota,
  quotaToPoints,
  SudorouterError,
  type SudorouterClient,
} from '../credits/sudorouter.js'
import {
  CreditApplicationError,
  reviewApplication,
  submitApplication,
  type CreditApplication,
  type CreditApplicationStore,
} from '../credits/creditApplications.js'

/**
 * The credit ledger lives at the model gateway, not in moss. These cover the
 * two places where that split can silently cost money: the points/quota
 * conversion, and what happens when the gateway call does not cleanly succeed.
 */

describe('points and gateway quota', () => {
  it('converts at 500, the factor the previous server actually used', () => {
    // Measured from that server's own export: every account's `quota` is 500x
    // its `balance`. SudoRouter's own QuotaPerUnit is 500000 and denominates
    // dollars — using it here would show every user a thousandth of what they
    // hold, and nothing would error.
    expect(quotaToPoints(500)).toBe(1)
    expect(quotaToPoints(1_008_181_272)).toBe(2_016_363)
    expect(pointsToQuota(2_016_363)).toBe(1_008_181_500)
  })

  it('round-trips whole points', () => {
    for (const points of [1, 100, 12_345, 2_016_363]) {
      expect(quotaToPoints(pointsToQuota(points))).toBe(points)
    }
  })
})

describe('sudorouter client', () => {
  function clientWith(handler: (url: string, init?: RequestInit) => Response): SudorouterClient {
    return createSudorouterClient({
      baseUrl: 'https://gateway.example/',
      getAdminToken: async () => 'admin-token',
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) =>
        handler(String(url), init)) as unknown as typeof fetch,
    })
  }

  it('reads a balance as points', async () => {
    const client = clientWith(() =>
      new Response(JSON.stringify({ success: true, data: { quota: 50_000, used_quota: 2_500 } })))
    expect(await client.getCredits('42')).toEqual({ remainingPoints: 100, usedPoints: 5 })
  })

  it('sends quota, not points, when crediting', async () => {
    let sent: unknown = null
    const client = clientWith((_url, init) => {
      sent = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ success: true }))
    })
    await client.addPoints('42', 100, 'credit application CA1')
    expect(sent).toEqual({ id: 42, quota: 50_000, comment: 'credit application CA1' })
  })

  it('treats a 200 carrying success:false as a refusal', async () => {
    // The gateway answers 200 for application-level refusals, so status alone
    // never tells you whether a credit was applied.
    const client = clientWith(() =>
      new Response(JSON.stringify({ success: false, message: 'quota limit' })))
    await expect(client.addPoints('42', 10, 'x')).rejects.toThrow(/quota limit/)
  })

  it('refuses a non-numeric gateway id instead of posting it', async () => {
    const client = clientWith(() => new Response(JSON.stringify({ success: true })))
    await expect(client.addPoints('not-a-number', 10, 'x')).rejects.toThrow(/not numeric/)
  })
})

function makeStore(): CreditApplicationStore & { rows: CreditApplication[] } {
  const rows: CreditApplication[] = []
  let nextId = 1
  return {
    rows,
    create(input) {
      const app: CreditApplication = {
        id: nextId++,
        applicationNo: `CA${nextId}`,
        userId: input.userId,
        orgId: input.orgId,
        requestedPoints: input.requestedPoints,
        approvedPoints: null,
        reason: input.reason,
        status: 'PENDING',
        adminComment: null,
        createdAt: Date.now(),
        reviewedAt: null,
        sudorouterError: null,
      }
      rows.push(app)
      return app
    },
    listForUser(userId, page, pageSize) {
      const mine = rows.filter(r => r.userId === userId)
      return { list: mine.slice((page - 1) * pageSize, page * pageSize), total: mine.length }
    },
    getById: id => rows.find(r => r.id === id) ?? null,
    hasPending: userId =>
      rows.some(r => r.userId === userId && (r.status === 'PENDING' || r.status === 'PROCESSING')),
    updateStatus(id, patch) {
      const row = rows.find(r => r.id === id)
      if (!row) return
      Object.assign(row, patch)
    },
  }
}

const POLICY = { minPoints: 100, maxPoints: 10_000, allowDuplicatePending: false }

describe('submitting an application', () => {
  it('accepts a request inside the configured range', () => {
    const store = makeStore()
    const app = submitApplication(store, POLICY, {
      userId: 'u1', orgId: 'o1', requestedPoints: 500, reason: '  need credits  ',
    })
    expect(app.status).toBe('PENDING')
    expect(app.requestedPoints).toBe(500)
    expect(app.reason).toBe('need credits')
  })

  it('rejects amounts outside the range and non-integers', () => {
    const store = makeStore()
    const bad = [50, 20_000, 0, -1, 1.5, 'many']
    for (const requestedPoints of bad) {
      expect(() => submitApplication(store, POLICY, {
        userId: 'u1', orgId: 'o1', requestedPoints, reason: null,
      })).toThrow(CreditApplicationError)
    }
    expect(store.rows).toHaveLength(0)
  })

  it('refuses a second open request from the same person', () => {
    // Two open asks give the reviewer no way to tell a correction from a
    // duplicate, and approving both would grant twice.
    const store = makeStore()
    submitApplication(store, POLICY, { userId: 'u1', orgId: 'o1', requestedPoints: 500, reason: null })
    expect(() => submitApplication(store, POLICY, {
      userId: 'u1', orgId: 'o1', requestedPoints: 500, reason: null,
    })).toThrow(/still awaiting review/)

    // Someone else is unaffected.
    expect(submitApplication(store, POLICY, {
      userId: 'u2', orgId: 'o1', requestedPoints: 500, reason: null,
    }).status).toBe('PENDING')
  })
})

describe('reviewing an application', () => {
  function gateway(behaviour: () => void): SudorouterClient {
    return {
      getCredits: async () => ({ remainingPoints: 0, usedPoints: 0 }),
      getModelUsage: async () => [],
      addPoints: async () => behaviour(),
    }
  }

  it('credits the gateway on approval', async () => {
    const store = makeStore()
    const app = submitApplication(store, POLICY, {
      userId: 'u1', orgId: 'o1', requestedPoints: 500, reason: null,
    })
    let credited = 0
    const client: SudorouterClient = {
      getCredits: async () => ({ remainingPoints: 0, usedPoints: 0 }),
      getModelUsage: async () => [],
      addPoints: async (_id, points) => { credited = points },
    }
    const reviewed = await reviewApplication(store, client, {
      id: app.id, approve: true, gatewayUserId: '42', adminComment: 'ok',
    })
    expect(reviewed.status).toBe('APPROVED')
    expect(reviewed.approvedPoints).toBe(500)
    expect(credited).toBe(500)
  })

  it('grants a different amount when the reviewer sets one', async () => {
    const store = makeStore()
    const app = submitApplication(store, POLICY, {
      userId: 'u1', orgId: 'o1', requestedPoints: 5000, reason: null,
    })
    let credited = 0
    const reviewed = await reviewApplication(store, {
      getCredits: async () => ({ remainingPoints: 0, usedPoints: 0 }),
      getModelUsage: async () => [],
      addPoints: async (_id, points) => { credited = points },
    }, { id: app.id, approve: true, approvedPoints: 1000, gatewayUserId: '42' })
    expect(reviewed.approvedPoints).toBe(1000)
    expect(credited).toBe(1000)
  })

  it('never touches the gateway on rejection', async () => {
    const store = makeStore()
    const app = submitApplication(store, POLICY, {
      userId: 'u1', orgId: 'o1', requestedPoints: 500, reason: null,
    })
    const reviewed = await reviewApplication(store, gateway(() => {
      throw new Error('the gateway must not be called for a rejection')
    }), { id: app.id, approve: false, gatewayUserId: '42', adminComment: 'no budget' })
    expect(reviewed.status).toBe('REJECTED')
    expect(reviewed.approvedPoints).toBe(0)
    expect(reviewed.adminComment).toBe('no budget')
  })

  it('separates a refusal from a lost answer', async () => {
    // This is the distinction that decides whether a retry is safe. A refusal
    // carries a status: the gateway decided and applied nothing, so retrying
    // is fine. No status means the answer never arrived and the credit may or
    // may not have landed — retrying could grant it twice.
    const refused = makeStore()
    const a = submitApplication(refused, POLICY, {
      userId: 'u1', orgId: 'o1', requestedPoints: 500, reason: null,
    })
    const afterRefusal = await reviewApplication(refused, gateway(() => {
      throw new SudorouterError('quota limit reached', 400)
    }), { id: a.id, approve: true, gatewayUserId: '42' })
    expect(afterRefusal.status).toBe('SYNC_FAILED')
    expect(afterRefusal.sudorouterError).toMatch(/quota limit/)

    const lost = makeStore()
    const b = submitApplication(lost, POLICY, {
      userId: 'u1', orgId: 'o1', requestedPoints: 500, reason: null,
    })
    const afterTimeout = await reviewApplication(lost, gateway(() => {
      throw new SudorouterError('SudoRouter unreachable: timeout')
    }), { id: b.id, approve: true, gatewayUserId: '42' })
    expect(afterTimeout.status).toBe('SYNC_UNKNOWN')
  })

  it('lets a refused approval be retried, but not a settled one', async () => {
    const store = makeStore()
    const app = submitApplication(store, POLICY, {
      userId: 'u1', orgId: 'o1', requestedPoints: 500, reason: null,
    })
    await reviewApplication(store, gateway(() => {
      throw new SudorouterError('temporary', 500)
    }), { id: app.id, approve: true, gatewayUserId: '42' })
    expect(store.getById(app.id)!.status).toBe('SYNC_FAILED')

    const retried = await reviewApplication(store, gateway(() => {}), {
      id: app.id, approve: true, gatewayUserId: '42',
    })
    expect(retried.status).toBe('APPROVED')

    // Already granted — reviewing again would credit a second time.
    await expect(reviewApplication(store, gateway(() => {}), {
      id: app.id, approve: true, gatewayUserId: '42',
    })).rejects.toThrow(/cannot be reviewed/)
  })

  it('refuses to approve someone with no gateway account', async () => {
    // Otherwise the application reads APPROVED while no credits ever moved.
    const store = makeStore()
    const app = submitApplication(store, POLICY, {
      userId: 'u1', orgId: 'o1', requestedPoints: 500, reason: null,
    })
    await expect(reviewApplication(store, gateway(() => {}), {
      id: app.id, approve: true, gatewayUserId: null,
    })).rejects.toThrow(/no model gateway account/)
    expect(store.getById(app.id)!.status).toBe('PENDING')
  })
})
