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

  it('closes a rejection with no gateway at all', async () => {
    // A deployment without a metered gateway must still be able to decline a
    // request it never intended to grant; the gateway is only needed to pay one.
    const store = makeStore()
    const app = submitApplication(store, POLICY, {
      userId: 'u1', orgId: 'o1', requestedPoints: 500, reason: null,
    })
    const reviewed = await reviewApplication(store, null, {
      id: app.id, approve: false, gatewayUserId: null, adminComment: 'declined',
    })
    expect(reviewed.status).toBe('REJECTED')

    const second = submitApplication(store, POLICY, {
      userId: 'u2', orgId: 'o1', requestedPoints: 500, reason: null,
    })
    await expect(reviewApplication(store, null, {
      id: second.id, approve: true, gatewayUserId: '42',
    })).rejects.toThrow(/gateway is not configured/)
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

describe('provisioning a gateway account', () => {
  type Call = { path: string; method: string; body: unknown }

  function clientRecording(calls: Call[], responses: Record<string, unknown>): SudorouterClient {
    return createSudorouterClient({
      baseUrl: 'https://gateway.example',
      getAdminToken: async () => 'admin-token',
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const path = String(url).replace('https://gateway.example', '')
        calls.push({
          path,
          method: init?.method ?? 'GET',
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        })
        const key = Object.keys(responses).find(k => path.startsWith(k))
        return new Response(JSON.stringify({ success: true, data: key ? responses[key] : null }))
      }) as unknown as typeof fetch,
    })
  }

  it('reuses an account the gateway already knows', async () => {
    // Creating a second account for the same person would strand the balance
    // the first one holds.
    const calls: Call[] = []
    const client = clientRecording(calls, {
      '/api/user/search': [{ id: 77, username: '13800138000' }],
      '/api/token/': { key: 'sk-reused' },
    })
    const account = await client.provisionAccount({
      username: '13800138000', initialPoints: 1000,
    })
    expect(account).toEqual({ gatewayUserId: '77', gatewayKey: 'sk-reused', created: false })

    // No account created, and — crucially — no starting balance granted again.
    expect(calls.some(c => c.path === '/api/user/' && c.method === 'POST')).toBe(false)
    expect(calls.some(c => c.path === '/api/user/quota')).toBe(false)
  })

  it('creates an account and grants the starting balance once', async () => {
    const calls: Call[] = []
    const client = clientRecording(calls, {
      '/api/user/search': [],
      '/api/user/': { id: 91 },
      '/api/token/': { key: 'sk-new' },
    })
    const account = await client.provisionAccount({
      username: '13800138001', displayName: 'Newcomer', initialPoints: 1000,
    })
    expect(account).toEqual({ gatewayUserId: '91', gatewayKey: 'sk-new', created: true })

    const created = calls.find(c => c.path === '/api/user/' && c.method === 'POST')
    expect(created?.body).toMatchObject({ username: '13800138001', display_name: 'Newcomer', role: 1 })

    // Points in, quota out: the grant is sent in the gateway's own unit.
    const quota = calls.find(c => c.path === '/api/user/quota')
    expect(quota?.body).toMatchObject({ id: 91, quota: 500_000 })

    // The cap belongs to the account, not the key.
    const token = calls.find(c => c.path === '/api/token/')
    expect(token?.body).toMatchObject({ user_id: 91, unlimited_quota: true, expired_time: -1 })
  })

  it('pads a short username into a password the gateway will accept', async () => {
    const calls: Call[] = []
    const client = clientRecording(calls, {
      '/api/user/search': [], '/api/user/': { id: 5 }, '/api/token/': { key: 'k' },
    })
    await client.provisionAccount({ username: 'sudo', initialPoints: 0 })
    expect((calls.find(c => c.path === '/api/user/')?.body as { password: string }).password)
      .toBe('sudo1111')
  })

  it('ignores a search hit that is not an exact username match', async () => {
    // The gateway's search is a keyword scan, so a substring match is not this
    // person — provisioning onto it would hand them someone else's account.
    const calls: Call[] = []
    const client = clientRecording(calls, {
      '/api/user/search': [{ id: 3, username: '13800138000-old' }],
      '/api/user/': { id: 12 },
      '/api/token/': { key: 'k' },
    })
    const account = await client.provisionAccount({ username: '13800138000', initialPoints: 0 })
    expect(account.gatewayUserId).toBe('12')
    expect(account.created).toBe(true)
  })
})

describe('usage log reading', () => {
  function clientReturning(rows: unknown[], seen: { url?: string } = {}): SudorouterClient {
    return createSudorouterClient({
      baseUrl: 'https://gateway.example',
      getAdminToken: async () => 't',
      fetchImpl: (async (url: string | URL | Request) => {
        seen.url = String(url)
        return new Response(JSON.stringify({ success: true, data: rows }))
      }) as unknown as typeof fetch,
    })
  }

  it('queries the window the gateway actually honours', async () => {
    // Verified against the live gateway: start_date/end_date are accepted and
    // then ignored, which returns an unfiltered page and looks like it worked.
    const seen: { url?: string } = {}
    await clientReturning([], seen).getModelUsage('42', 1_757_000_000, 1_757_086_400)
    expect(seen.url).toContain('time_from=1757000000')
    expect(seen.url).toContain('time_to=1757086400')
    expect(seen.url).not.toContain('start_date')
  })

  it('drops administrative rows, which are top-ups and not spending', async () => {
    const rows = [
      { type: 'manage', model_name: '', cost: 0, created_at: 1_757_000_000 },
      { type: 'consumption', model_name: 'gpt-5.5', prompt_tokens: 10, completion_tokens: 5, cost: 21667, created_at: 1_757_000_000 },
    ]
    const usage = await clientReturning(rows).getModelUsage('42', 0, 1)
    expect(usage).toHaveLength(1)
    expect(usage[0]?.model).toBe('gpt-5.5')
  })

  it('reads cost from the field the gateway uses, and reports it in points', async () => {
    const rows = [{ type: 'consumption', model_name: 'm', prompt_tokens: 1, completion_tokens: 1, cost: 500, created_at: 1_757_000_000 }]
    const [row] = await clientReturning(rows).getModelUsage('42', 0, 1)
    expect(row?.cost).toBe(1)
    // Kept raw as well, so a caller summing many rows converts once instead of
    // rounding each one to zero first.
    expect(row?.costQuota).toBe(500)
  })

  it('sums small rows without rounding each to nothing', async () => {
    // Ten rows of 50 quota are 500 quota = 1 point. Converted per row they are
    // ten zeroes.
    const rows = Array.from({ length: 10 }, () => ({
      type: 'consumption', model_name: 'm', prompt_tokens: 1, completion_tokens: 0, cost: 50, created_at: 1_757_000_000,
    }))
    const usage = await clientReturning(rows).getModelUsage('42', 0, 1)
    expect(usage.every(r => r.cost === 0)).toBe(true)
    expect(quotaToPoints(usage.reduce((n, r) => n + r.costQuota, 0))).toBe(1)
  })
})

describe('gateway field limits', () => {
  it('trims a display name the gateway would reject', async () => {
    // The gateway validates username, password and display_name at 20 characters
    // and answers with a field-validation blob. A user is free to type a longer
    // nickname, and it must not cost them their account.
    const calls: Array<{ path: string; body: unknown }> = []
    const client = createSudorouterClient({
      baseUrl: 'https://gateway.example',
      getAdminToken: async () => 't',
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const path = String(url).replace('https://gateway.example', '')
        calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
        const data = path.startsWith('/api/user/search') ? []
          : path.startsWith('/api/token/') ? { key: 'k' }
          : { id: 1 }
        return new Response(JSON.stringify({ success: true, data }))
      }) as unknown as typeof fetch,
    })
    await client.provisionAccount({
      username: '13800138000',
      displayName: 'a display name far longer than twenty characters',
      initialPoints: 0,
    })
    const body = calls.find(c => c.path === '/api/user/')?.body as { display_name: string }
    expect(body.display_name).toHaveLength(20)
  })

  it('refuses a username the gateway cannot store, with a reason', async () => {
    const client = createSudorouterClient({
      baseUrl: 'https://gateway.example',
      getAdminToken: async () => 't',
      fetchImpl: (async () => new Response(JSON.stringify({ success: true, data: [] }))) as unknown as typeof fetch,
    })
    await expect(client.provisionAccount({
      username: 'x'.repeat(21), initialPoints: 0,
    })).rejects.toThrow(/too long for the gateway/)
  })
})
