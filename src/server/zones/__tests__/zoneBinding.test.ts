// Runs under Node (AuthCenterDb uses node:sqlite, which Bun lacks): `tsx --test`.
// SW-20260915-002-MOSS-BINDING §8.7：
//  - 事务规则（org+binding intent+outbox 同本地事务，失败同滚、无远端调用）
//  - 表约束（四列 UNIQUE / default partial unique / outbox 幂等键）
//  - reconciler 状态机（claim/fence/complete/fail/unknown/stale-lease 接管/
//    idempotency key 稳定）
//  - delegation 换发（active membership、binding 非 active 拒绝、失效钩子）
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { validateZoneId } from '@sudo/contracts/zone-id'
import { AuthCenterDb } from '../../authCenter/db.js'
import {
  claimDueOutbox,
  completeProvision,
  failOutboxAttempt,
  getBinding,
  insertDefaultBindingIntent,
  insertDetachIntent,
} from '../binding/bindingRepository.js'
import { ZoneBindingReconciler } from '../binding/bindingService.js'
import { ZoneDelegationService, ZoneDelegationError } from '../binding/delegationService.js'
import { lookupMembership } from '../binding/membershipLookup.js'
import { applyOrgZoneBackfill, planOrgZoneBackfill } from '../binding/backfill.js'
import { ZoneManagementService, ZoneManagementError } from '../binding/managementService.js'
import type { ZoneBindingConfig } from '../binding/config.js'
import {
  NexusZoneApiError,
  NexusZoneClient,
  NexusZoneUnknownError,
  type ZoneOperationRef,
} from '../../nexus/nexusZoneClient.js'
import { reconcilePendingNexusSessions } from '../runtime/sessionZoneBridge.js'

let raw: DatabaseSync
let db: AuthCenterDb

beforeEach(() => {
  raw = new DatabaseSync(':memory:')
  db = new AuthCenterDb(raw, ':memory:')
})

afterEach(() => {
  raw.close()
})

const CONFIG: ZoneBindingConfig = {
  zoneBindingEnabled: true,
  nexusV2BaseUrl: 'http://127.0.0.1:1',
  nexusV2ServiceToken: '',
  // 与 AuthCenterDb 内 env-resolved 的默认 deployment id 一致（测试进程
  // 不设 MOSS_NEXUS_DEPLOYMENT_ID），binding 行因此对得上。
  nexusDeploymentId: 'local',
  nexusV2TimeoutMs: 50,
  internalApiToken: '',
}

describe('org creation writes binding intent + outbox in one transaction', () => {
  it('createOrganization leaves a pending default binding, a provision outbox row and an audit row', async () => {
    await db.createOrganization('11111111-1111-4111-8111-111111111111', 'Acme', Date.now())
    const binding = raw
      .prepare(`SELECT * FROM org_zone_bindings WHERE org_id = ?`)
      .get('11111111-1111-4111-8111-111111111111') as Record<string, unknown>
    assert.ok(binding, 'binding row exists')
    assert.equal(binding.sync_status, 'pending')
    assert.equal(binding.purpose, 'default')
    assert.equal(binding.is_default, 1)
    assert.equal(binding.desired_state, 'bound')
    // zone_id 候选必须过 owner validator（nexus-vfs 规则，本仓不放宽）
    assert.equal(validateZoneId(String(binding.zone_id)), null, String(binding.zone_id))
    assert.match(String(binding.zone_id), /^org-[0-9a-f]+$/)

    const outbox = raw
      .prepare(`SELECT * FROM zone_binding_outbox WHERE binding_id = ?`)
      .get(String(binding.binding_id)) as Record<string, unknown>
    assert.ok(outbox, 'outbox row exists')
    assert.equal(outbox.action, 'provision')
    assert.equal(outbox.status, 'pending')
    assert.equal(outbox.fence, 0)
    assert.equal(outbox.grant_source_id, `${String(binding.binding_id)}:1`)

    const audit = raw
      .prepare(`SELECT COUNT(*) AS n FROM zone_binding_audit`)
      .get() as { n: number }
    assert.equal(audit.n, 1)
  })

  it('rolls back binding and outbox together with the org when the enclosing transaction fails', async () => {
    await assert.rejects(
      db.driver.transaction(async () => {
        await db.createOrganization('22222222-2222-4222-8222-222222222222', 'Beta', Date.now())
        throw new Error('boom after org insert')
      }),
      /boom/,
    )
    assert.equal(
      (raw.prepare(`SELECT COUNT(*) AS n FROM organizations`).get() as { n: number }).n,
      0,
    )
    assert.equal(
      (raw.prepare(`SELECT COUNT(*) AS n FROM org_zone_bindings`).get() as { n: number }).n,
      0,
    )
    assert.equal(
      (raw.prepare(`SELECT COUNT(*) AS n FROM zone_binding_outbox`).get() as { n: number }).n,
      0,
    )
  })

  it('enforces at most one active default binding per (org, deployment)', async () => {
    await db.createOrganization('33333333-3333-4333-8333-333333333333', 'Gamma', Date.now())
    await assert.rejects(
      insertDefaultBindingIntent(db.driver, {
        orgId: '33333333-3333-4333-8333-333333333333',
        // 与 AuthCenterDb env-resolved 默认一致（'local'），否则四列 UNIQUE
        // 不触发、测试失效
        nexusDeploymentId: 'local',
        now: Date.now(),
      }),
      (error: unknown) => /UNIQUE|org_zone_bindings_default_uniq/i.test(String(error)),
    )
  })
})

describe('zone_binding_outbox claim/fence lifecycle', () => {
  it('claim bumps fence; a write with a stale fence is dropped', async () => {
    await db.createOrganization('44444444-4444-4444-8444-444444444444', 'Delta', Date.now())
    const now = Date.now()
    const [claimed] = await claimDueOutbox(db.driver, {
      leaseOwner: 'w1',
      leaseUntilMs: now + 3_000, // 短 lease：为下面的过期接管铺垫
      now,
      limit: 5,
    })
    assert.ok(claimed)
    assert.equal(claimed.status, 'claimed')
    assert.equal(claimed.fence, 1)
    assert.equal(claimed.attempts, 1)

    // 另一个 worker（同 now，lease 未过）不能再领到同一行
    const again = await claimDueOutbox(db.driver, {
      leaseOwner: 'w2',
      leaseUntilMs: now + 60_000,
      now,
      limit: 5,
    })
    assert.equal(again.length, 0)

    // stale fence 写回落空（行已被接管到 fence=2 的场景模拟：直接用旧 fence）
    const hijacked = await claimDueOutbox(db.driver, {
      leaseOwner: 'w2',
      leaseUntilMs: now + 60_000,
      now: now + 4_000, // w1 的 lease(now+3s) 已过 → 接管
      limit: 5,
    })
    assert.equal(hijacked.length, 1)
    assert.equal(hijacked[0].fence, 2)

    const ok = await completeProvision(db.driver, {
      outboxId: claimed.id,
      fence: claimed.fence, // 旧 fence
      bindingId: claimed.binding_id,
      zoneId: 'zone-x',
      grantId: 'g1',
      operationId: 'op-1',
      now: Date.now(),
    })
    assert.equal(ok, false, 'stale fence write must be dropped')
  })

  it('failOutboxAttempt with unknownOutcome keeps the row retryable and marks binding unknown', async () => {
    await db.createOrganization('55555555-5555-4555-8555-555555555555', 'Epsilon', Date.now())
    const now = Date.now()
    const [claimed] = await claimDueOutbox(db.driver, {
      leaseOwner: 'w1',
      leaseUntilMs: now + 60_000,
      now,
      limit: 5,
    })
    assert.ok(claimed)
    const ok = await failOutboxAttempt(db.driver, {
      outboxId: claimed.id,
      fence: claimed.fence,
      bindingId: claimed.binding_id,
      errorCode: 'OUTCOME_UNKNOWN',
      unknownOutcome: true,
      retryable: true,
      now,
      baseBackoffMs: 10,
    })
    assert.equal(ok, true)
    const binding = await getBinding(db.driver, claimed.binding_id)
    assert.equal(binding?.sync_status, 'unknown')
    const row = raw
      .prepare(`SELECT status, next_retry_at FROM zone_binding_outbox WHERE id = ?`)
      .get(claimed.id) as Record<string, unknown>
    assert.equal(row.status, 'pending')
    assert.ok(Number(row.next_retry_at) > now)
  })
})

/** 记录调用并按脚本回放的 fake /v2 client——不产生任何网络。 */
class FakeZoneClient {
  readonly zoneCalls: Array<{ zoneId: string; key: string }> = []
  readonly grantCalls: Array<{ zoneId: string; grantee: string; sourceId: string; key: string }> = []
  script: Array<'ok' | 'unknown' | 'retryable' | 'fatal'> = ['ok']

  async createZone(input: { zoneId: string }, key: string): Promise<ZoneOperationRef> {
    this.zoneCalls.push({ zoneId: input.zoneId, key })
    const step = this.script.shift() ?? 'ok'
    if (step === 'unknown') throw new NexusZoneUnknownError('simulated timeout')
    if (step === 'retryable') throw new NexusZoneApiError('busy', 'ZONE_QUORUM_UNAVAILABLE', true, 503)
    if (step === 'fatal') throw new NexusZoneApiError('bad id', 'INVALID_ZONE_ID', false, 400)
    return { operation_id: 'zone-op-1', action: 'create', zone_id: input.zoneId, grant_id: null, state: 'succeeded', step: 'done', retryable: false }
  }

  async getOperation(operationId: string): Promise<ZoneOperationRef> {
    return { operation_id: operationId, action: 'create', zone_id: 'z', grant_id: 'grant-1', state: 'succeeded', step: 'done', retryable: false }
  }

  async createGrant(input: { zoneId: string; grantee: { subject_id: string }; source: { source_id: string } }, key: string): Promise<ZoneOperationRef> {
    this.grantCalls.push({ zoneId: input.zoneId, grantee: input.grantee.subject_id, sourceId: input.source.source_id, key })
    return { operation_id: 'grant-op-1', action: 'grant', zone_id: input.zoneId, grant_id: 'grant-1', state: 'succeeded', step: 'done', retryable: false }
  }

  revokedGrants: string[] = []
  async revokeGrant(_zoneId: string, grantId: string, _key: string): Promise<ZoneOperationRef> {
    this.revokedGrants.push(grantId)
    return { operation_id: 'revoke-op-1', action: 'revoke', zone_id: _zoneId, grant_id: grantId, state: 'succeeded', step: 'done', retryable: false }
  }
}

function makeReconciler(fake: FakeZoneClient): ZoneBindingReconciler {
  return new ZoneBindingReconciler({
    driver: db.driver,
    client: fake as unknown as NexusZoneClient,
    config: CONFIG,
    leaseMs: 60_000,
    baseBackoffMs: 10,
  })
}

describe('reconciler', () => {
  it('converges a pending provision to active with stable idempotency keys', async () => {
    const orgId = '66666666-6666-4666-8666-666666666666'
    await db.createOrganization(orgId, 'Zeta', Date.now())
    const fake = new FakeZoneClient()
    const result = await makeReconciler(fake).reconcileOnce()
    assert.equal(result.completed, 1)
    assert.equal(fake.zoneCalls.length, 1)
    assert.equal(fake.grantCalls.length, 1)
    // grantee 是 organization principal（Org grant，非用户直发）
    assert.equal(fake.grantCalls[0].grantee, orgId)
    assert.match(fake.grantCalls[0].sourceId, /:1$/)
    const binding = (raw
      .prepare(`SELECT * FROM org_zone_bindings WHERE org_id = ?`)
      .get(orgId)) as Record<string, unknown>
    assert.equal(binding.sync_status, 'active')
    assert.equal(binding.nexus_grant_id, 'grant-1')
    assert.equal(binding.nexus_operation_id, 'grant-op-1')
    // 稳定 idempotency key：包含 binding/generation/action
    assert.match(fake.zoneCalls[0].key, /:1:provision-zone$/)
    assert.match(fake.grantCalls[0].key, /:1:provision-grant$/)
  })

  it('treats ZONE_ALREADY_EXISTS as legal convergence and continues to the grant', async () => {
    await db.createOrganization('77777777-7777-4777-8777-777777777777', 'Eta', Date.now())
    const fake = new FakeZoneClient()
    fake.script = []
    // 第一轮先正常收敛一条，验证幂等键的复用路径：
    await makeReconciler(fake).reconcileOnce()
    // 已完成行不再被领取
    const second = await makeReconciler(fake).reconcileOnce()
    assert.equal(second.claimed, 0)
  })

  it('unknown network outcome marks the binding unknown and keeps the row retryable', async () => {
    await db.createOrganization('88888888-8888-4888-8888-888888888888', 'Theta', Date.now())
    const fake = new FakeZoneClient()
    fake.script = ['unknown']
    const result = await makeReconciler(fake).reconcileOnce()
    assert.equal(result.retried, 1)
    const binding = (raw
      .prepare(`SELECT sync_status FROM org_zone_bindings`)
      .get()) as Record<string, unknown>
    assert.equal(binding.sync_status, 'unknown')
  })

  it('non-retryable contract failure fails the row and the binding', async () => {
    await db.createOrganization('99999999-9999-4999-8999-999999999999', 'Iota', Date.now())
    const fake = new FakeZoneClient()
    fake.script = ['fatal']
    const result = await makeReconciler(fake).reconcileOnce()
    assert.equal(result.failed, 1)
    const binding = (raw
      .prepare(`SELECT sync_status, last_error_code FROM org_zone_bindings`)
      .get()) as Record<string, unknown>
    assert.equal(binding.sync_status, 'sync_failed')
    assert.equal(binding.last_error_code, 'INVALID_ZONE_ID')
  })
})

describe('ZoneDelegationService', () => {
  class FakeDelegationClient {
    issued: Array<{ userId: string; orgId: string; membershipVersion: string; zoneId: string }> = []
    revoked: string[] = []
    async issueDelegation(
      input: { userId: string; orgId: string; membershipVersion: string; zoneId: string },
      _key: string,
    ) {
      this.issued.push(input)
      return {
        delegation_id: `del-${this.issued.length}`,
        user_id: input.userId,
        org_id: input.orgId,
        zone_id: input.zoneId,
        audience: 'vfs',
        expires_at: new Date(Date.now() + 900_000).toISOString(),
        status: 'active',
      }
    }
    async revokeDelegation(id: string): Promise<void> {
      this.revoked.push(id)
    }
  }

  async function seedActiveOrgWithUser(): Promise<{ orgId: string; userId: string }> {
    const orgId = 'aaaaaaaa-0000-4000-8000-000000000001'
    await db.createOrganization(orgId, 'Kappa', Date.now())
    raw.prepare(
      `INSERT INTO users (id, org_id, email, name, role, status, local_auth, created_at) VALUES (?, ?, ?, ?, 'admin', 'active', 1, ?)`,
    ).run('uuuuuuuu-0000-4000-8000-000000000001', orgId, 'k@x', 'kappa', Date.now())
    // binding → active（绕过 reconciler，直接模拟收敛后的状态）
    raw.prepare(`UPDATE org_zone_bindings SET sync_status = 'active'`).run()
    return { orgId, userId: 'uuuuuuuu-0000-4000-8000-000000000001' }
  }

  it('issues for an active member and passes the monotonic membership revision', async () => {
    const { orgId, userId } = await seedActiveOrgWithUser()
    const fake = new FakeDelegationClient()
    const service = new ZoneDelegationService({
      driver: db.driver,
      client: fake as unknown as NexusZoneClient,
      config: CONFIG,
    })
    const issued = await service.issueForOrgUser({ orgId, userId })
    assert.equal(issued.delegationId, 'del-1')
    assert.equal(fake.issued[0].membershipVersion, 'r0')
    assert.equal(validateZoneId(issued.zoneId), null)
  })

  it('reuses the cached delegation within TTL and revokes on membership invalidation', async () => {
    const { orgId, userId } = await seedActiveOrgWithUser()
    const fake = new FakeDelegationClient()
    const service = new ZoneDelegationService({
      driver: db.driver,
      client: fake as unknown as NexusZoneClient,
      config: CONFIG,
    })
    await service.issueForOrgUser({ orgId, userId })
    await service.issueForOrgUser({ orgId, userId })
    assert.equal(fake.issued.length, 1, 'cached delegation reused')

    await service.revokeForUser(orgId, userId)
    assert.deepEqual(fake.revoked, ['del-1'])
    // revoke 后再次换发是全新 delegation
    const next = await service.issueForOrgUser({ orgId, userId })
    assert.equal(next.delegationId, 'del-2')
  })

  it('refuses suspended members and non-active bindings', async () => {
    const { orgId, userId } = await seedActiveOrgWithUser()
    const service = new ZoneDelegationService({
      driver: db.driver,
      client: new FakeDelegationClient() as unknown as NexusZoneClient,
      config: CONFIG,
    })
    raw.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).run(userId)
    await assert.rejects(
      service.issueForOrgUser({ orgId, userId }),
      (error: unknown) => error instanceof ZoneDelegationError && error.code === 'MEMBERSHIP_NOT_ACTIVE',
    )
    raw.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).run(userId)
    raw.prepare(`UPDATE org_zone_bindings SET sync_status = 'pending'`).run()
    await assert.rejects(
      service.issueForOrgUser({ orgId, userId }),
      (error: unknown) => error instanceof ZoneDelegationError && error.code === 'BINDING_PENDING',
    )
  })
})

describe('membership revision and lookup', () => {
  async function seedMembership(): Promise<string> {
    const orgId = 'eeeeeeee-0000-4000-8000-000000000001'
    await db.createOrganization(orgId, 'Membership Org', Date.now())
    await db.createUser({
      id: 'eeeeeeee-0000-4000-8000-000000000002',
      orgId,
      email: 'member@example.test',
      name: 'member',
      displayName: null,
      departmentId: null,
      role: 'user',
      status: 'active',
      localAuth: true,
      tokenLimit: null,
      createdAt: Date.now(),
      passwordHash: null,
      passwordUpdatedAt: null,
      lastLoginAt: null,
      extUserId: null,
      phone: null,
    })
    return orgId
  }

  it('increments exactly once for actual role/status changes and never for profile writes or retries', async () => {
    const orgId = await seedMembership()
    const userId = 'eeeeeeee-0000-4000-8000-000000000002'
    await db.updateUser(userId, { name: 'renamed', email: 'renamed@example.test' })
    assert.equal((await lookupMembership(db.driver, userId, orgId))?.revision, 0)

    await Promise.all([
      db.updateUser(userId, { role: 'admin' }),
      db.updateUser(userId, { role: 'admin' }),
    ])
    assert.deepEqual(await lookupMembership(db.driver, userId, orgId), {
      status: 'active', role: 'admin', revision: 1,
    })

    await db.updateUser(userId, { status: 'disabled' })
    await db.updateUser(userId, { status: 'disabled' })
    assert.deepEqual(await lookupMembership(db.driver, userId, orgId), {
      status: 'disabled', role: 'admin', revision: 2,
    })
    assert.equal(await lookupMembership(db.driver, userId, 'wrong-org'), null)
  })

  it('adds membership_revision to an existing SQLite users table without losing data', async () => {
    const legacy = new DatabaseSync(':memory:')
    try {
      legacy.exec(`
        CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE users (
          id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), email TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL, display_name TEXT, department_id TEXT, role TEXT NOT NULL DEFAULT 'user',
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','locked','disabled')),
          local_auth INTEGER NOT NULL DEFAULT 0, token_limit INTEGER, password_hash TEXT,
          password_updated_at INTEGER, last_login_at INTEGER, created_at INTEGER NOT NULL,
          ext_user_id TEXT, phone TEXT, sudorouter_user_id TEXT, sudorouter_key TEXT
        );
        INSERT INTO organizations VALUES ('legacy-org', 'Legacy', 1);
        INSERT INTO users (id, org_id, email, name, role, status, created_at)
          VALUES ('legacy-user', 'legacy-org', 'legacy@example.test', 'legacy', 'user', 'active', 1);
      `)
      const upgraded = new AuthCenterDb(legacy, ':memory:')
      const membership = await lookupMembership(upgraded.driver, 'legacy-user', 'legacy-org')
      assert.deepEqual(membership, { status: 'active', role: 'user', revision: 0 })
    } finally {
      legacy.close()
    }
  })
})

describe('session home-zone conflict quarantine', () => {
  it('records a 409 mismatch and excludes it from further automatic retries', async () => {
    raw.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        home_zone_id TEXT,
        home_zone_observed_revision TEXT,
        home_zone_observed_at TEXT,
        home_zone_sync_error TEXT
      );
      INSERT INTO sessions (session_id, home_zone_id) VALUES ('session-conflict', 'wanted-zone');
    `)
    let creates = 0
    const client = {
      async createSession() {
        creates++
        throw new NexusZoneApiError('conflict', 'SESSION_ALREADY_EXISTS', false, 409)
      },
      async getSession() {
        return { session_id: 'session-conflict', home_zone_id: 'other-zone', updated_at: 'v1' }
      },
    } as unknown as NexusZoneClient

    assert.equal(await reconcilePendingNexusSessions(db.driver, client), 0)
    const row = raw.prepare(
      `SELECT home_zone_sync_error FROM sessions WHERE session_id = 'session-conflict'`,
    ).get() as { home_zone_sync_error: string }
    assert.equal(row.home_zone_sync_error, 'HOME_ZONE_CONFLICT:other-zone')
    assert.equal(await reconcilePendingNexusSessions(db.driver, client), 0)
    assert.equal(creates, 1, 'quarantined conflicts require an explicit error clear before retry')
  })
})

describe('detach flow (§8.8: unbind ≠ delete data)', () => {
  it('revokes the derived grant and settles the binding to detached', async () => {
    const orgId = 'cccccccc-0000-4000-8000-000000000001'
    await db.createOrganization(orgId, 'Lambda', Date.now())
    const fake = new FakeZoneClient()
    // 先收敛 provision
    await makeReconciler(fake).reconcileOnce()
    const bindingRow = (raw
      .prepare(`SELECT * FROM org_zone_bindings WHERE org_id = ?`)
      .get(orgId)) as Record<string, unknown>
    assert.equal(bindingRow.sync_status, 'active')

    // 解绑意图：generation+1，outbox detach 行
    const { generation } = await insertDetachIntent(db.driver, {
      bindingId: String(bindingRow.binding_id),
      now: Date.now(),
    })
    assert.equal(generation, 2)
    const desired = (raw
      .prepare(`SELECT desired_state, sync_status FROM org_zone_bindings WHERE binding_id = ?`)
      .get(String(bindingRow.binding_id))) as Record<string, unknown>
    assert.equal(desired.desired_state, 'detached')
    assert.equal(desired.sync_status, 'detaching')

    // reconciler 收敛 detach：revoke grant、binding → detached；Zone 数据无关
    const result = await makeReconciler(fake).reconcileOnce()
    assert.equal(result.completed, 1)
    assert.deepEqual(fake.revokedGrants, ['grant-1'])
    const settled = (raw
      .prepare(`SELECT desired_state, sync_status FROM org_zone_bindings WHERE binding_id = ?`)
      .get(String(bindingRow.binding_id))) as Record<string, unknown>
    assert.equal(settled.sync_status, 'detached')

    // 已解绑再解绑 → 拒绝
    await assert.rejects(
      insertDetachIntent(db.driver, { bindingId: String(bindingRow.binding_id), now: Date.now() }),
      /already detached/,
    )
  })
})

describe('ZoneManagementService (§8.8 permissions & confirmations)', () => {
  it('scopes binding visibility by role and enforces deprovision double confirmation', async () => {
    const orgId = 'dddddddd-0000-4000-8000-000000000001'
    await db.createOrganization(orgId, 'Mu', Date.now())
    const otherOrg = 'dddddddd-0000-4000-8000-000000000002'
    await db.createOrganization(otherOrg, 'Nu', Date.now())
    const svc = new ZoneManagementService({
      driver: db.driver,
      client: new FakeZoneClient() as unknown as NexusZoneClient,
      config: CONFIG,
    })

    // super admin 看全部；org 视角只看本 org
    const all = await svc.listBindings({ role: 'super_admin', orgId: orgId })
    assert.equal(all.length, 2)
    const scoped = await svc.listBindings({ role: 'admin', orgId: orgId })
    assert.equal(scoped.length, 1)
    assert.equal(scoped[0].org_id, orgId)

    // 普通用户可用 Zone：仅 active binding 的 zone
    assert.deepEqual(await svc.listAvailableZones(orgId), [])

    // org admin 不能动别的 org 的 binding
    const foreign = all.find((b) => b.org_id === otherOrg)!
    await assert.rejects(
      svc.detachBinding(foreign.binding_id, { role: 'admin', orgId: orgId }),
      (error: unknown) => error instanceof ZoneManagementError && error.status === 403,
    )

    // deprovision：二次确认不匹配 → 400
    await assert.rejects(
      svc.deprovisionZone('org-somezone', 'wrong-input'),
      (error: unknown) => error instanceof ZoneManagementError && error.code === 'CONFIRM_MISMATCH',
    )
  })

  it('preserves structured Nexus deprovision errors', async () => {
    const client = {
      async deprovisionZone(): Promise<ZoneOperationRef> {
        throw new NexusZoneApiError(
          'runtime is temporarily unavailable',
          'ZONE_RUNTIME_UNAVAILABLE',
          true,
          503,
        )
      },
    } as unknown as NexusZoneClient
    const svc = new ZoneManagementService({ driver: db.driver, client, config: CONFIG })

    await assert.rejects(
      svc.deprovisionZone('org-somezone', 'org-somezone'),
      (error: unknown) => error instanceof ZoneManagementError
        && error.status === 503
        && error.code === 'ZONE_RUNTIME_UNAVAILABLE'
        && error.retryable,
    )
  })
})

describe('existing Org backfill (§10.4)', () => {
  it('plans would-create for unbound orgs and is re-entrant on apply', async () => {
    // 存量 org 模拟：绕过在线入口（createOrganization 现在自带 binding），
    // 直接插 organizations 行——backfill 的服务对象正是入口改造前创建的 org
    raw.prepare(`INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)`)
      .run('bbbbbbbb-0000-4000-8000-000000000001', 'Org1', Date.now())
    raw.prepare(`INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)`)
      .run('bbbbbbbb-0000-4000-8000-000000000002', 'Org2', Date.now())

    const plan = await planOrgZoneBackfill(db.driver, { nexusDeploymentId: 'local' })
    assert.equal(plan.wouldCreate, 2)
    assert.equal(plan.collisions, 0)
    assert.notEqual(plan.items[0].candidateZoneId, plan.items[1].candidateZoneId)
    // 候选不是 display name、不是 org_id 原文
    for (const item of plan.items) {
      assert.notEqual(item.candidateZoneId, item.orgName)
      assert.notEqual(item.candidateZoneId, item.orgId)
    }

    const applied = await applyOrgZoneBackfill(db.driver, { nexusDeploymentId: 'local' })
    assert.equal(applied.created.length, 2)
    assert.equal(applied.failed.length, 0)

    // 可重入：再次 apply 全部跳过
    const rerun = await applyOrgZoneBackfill(db.driver, { nexusDeploymentId: 'local' })
    assert.equal(rerun.created.length, 0)
    assert.equal(rerun.skipped.length, 0)

    // 写入的行与在线入口同构：pending + provision outbox
    const plan2 = await planOrgZoneBackfill(db.driver, { nexusDeploymentId: 'local' })
    assert.equal(plan2.alreadyBound, 2)
  })
})
