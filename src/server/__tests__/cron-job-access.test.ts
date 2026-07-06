import { describe, it, expect } from 'bun:test'
import { canReadJob, canManageJob } from '../api/cron.js'
import type { CronJob } from '../services/cron/CronStore.js'

// Admin console manageability (#85): admins must be able to read AND manage
// (update/delete/trigger) any job in their org, while non-owners without admin
// capability stay blocked — including across org boundaries.
function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'cron_1',
    orgId: 'org-a',
    userId: 'user-owner',
    name: 'job',
    enabled: true,
    schedule: { kind: 'cron', value: '0 9 * * *' },
    payloadMessage: 'hi',
    conversationMode: 'new',
    boundSessionId: null,
    lastSessionId: null,
    assistantId: null,
    assistantName: null,
    workspace: null,
    runtimeJson: null,
    nextRunAt: null,
    leaseUntil: null,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    runCount: 0,
    retryCount: 0,
    maxRetries: 3,
    deletedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as CronJob
}

describe('cron job access predicates (#85)', () => {
  const owner = { orgId: 'org-a', userId: 'user-owner', scopes: [] as string[] }
  const otherUser = { orgId: 'org-a', userId: 'user-other', scopes: ['sessions:create'] }
  const orgAdmin = { orgId: 'org-a', userId: 'admin-1', scopes: ['admin:cron'] }
  const crossOrgAdmin = { orgId: 'org-b', userId: 'admin-2', scopes: ['admin:cron'] }

  it('owner can read and manage their own job', () => {
    expect(canReadJob(owner, job())).toBe(true)
    expect(canManageJob(owner, job())).toBe(true)
  })

  it('another non-admin user cannot read or manage someone else’s job', () => {
    expect(canReadJob(otherUser, job())).toBe(false)
    expect(canManageJob(otherUser, job())).toBe(false)
  })

  it('org admin can read and manage any job in their org', () => {
    expect(canReadJob(orgAdmin, job())).toBe(true)
    expect(canManageJob(orgAdmin, job())).toBe(true)
  })

  it('admin capability does not cross org boundaries', () => {
    expect(canReadJob(crossOrgAdmin, job())).toBe(false)
    expect(canManageJob(crossOrgAdmin, job())).toBe(false)
  })

  it('cron:list:any grants read but not manage; cron:disable:any grants manage', () => {
    const reader = { orgId: 'org-a', userId: 'u', scopes: ['cron:list:any'] }
    const manager = { orgId: 'org-a', userId: 'u', scopes: ['cron:disable:any'] }
    expect(canReadJob(reader, job())).toBe(true)
    expect(canManageJob(reader, job())).toBe(false)
    expect(canManageJob(manager, job())).toBe(true)
  })
})

// A dept_admin sees/manages jobs owned by members of their department subtree.
// The subtree user-id set is resolved on the fly (server-side) and passed in.
describe('cron dept_admin subtree access', () => {
  const deptAdmin = { orgId: 'org-a', userId: 'da', scopes: ['cron:self', 'cron:list:subtree', 'cron:manage:subtree'] }
  const subtree = new Set(['da', 'member-1', 'member-2'])

  it('reads and manages a job owned by a subtree member', () => {
    const j = job({ userId: 'member-1' })
    expect(canReadJob(deptAdmin, j, subtree)).toBe(true)
    expect(canManageJob(deptAdmin, j, subtree)).toBe(true)
  })

  it('cannot touch a job owned by someone outside the subtree', () => {
    const j = job({ userId: 'outsider' })
    expect(canReadJob(deptAdmin, j, subtree)).toBe(false)
    expect(canManageJob(deptAdmin, j, subtree)).toBe(false)
  })

  it('subtree scopes without a subtree set (undefined) grant nothing beyond ownership', () => {
    const j = job({ userId: 'member-1' })
    expect(canReadJob(deptAdmin, j)).toBe(false)
    expect(canManageJob(deptAdmin, j)).toBe(false)
  })

  it('a plain user with cron:self never gets subtree access even if a set leaks in', () => {
    const user = { orgId: 'org-a', userId: 'u1', scopes: ['cron:self'] }
    const j = job({ userId: 'member-1' })
    expect(canReadJob(user, j, subtree)).toBe(false)
    expect(canManageJob(user, j, subtree)).toBe(false)
  })
})
