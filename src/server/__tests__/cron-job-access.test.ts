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
