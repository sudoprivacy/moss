import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { AuthCenterDb } from '../authCenter/db.js'
import { BillingRepository } from '../billing/billingRepository.js'
import { ensureBillingSchema } from '../billing/billingSchema.js'
import { WalletService } from '../billing/walletService.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import { UnifiedIdentityService } from '../identity/unifiedIdentityService.js'
import { AccessMigrationPhase } from './accessMigrationPhase.js'
import { AutomationMigrationPhase } from './automationMigrationPhase.js'
import { GovernanceMigrationService } from './governanceMigrationService.js'
import { IdentityMergePlanner, type LegacyIdentitySnapshot } from './identityMergePlanner.js'
import { IdentityMigrationService } from './identityMigrationService.js'
import { MigrationPhaseRegistry, type MigrationPhase } from './migrationPhaseRegistry.js'
import { MigrationRunStore, type MigrationPhaseName } from './migrationRunStore.js'
import { P3BillingMigrationService } from './p3BillingMigrationService.js'
import { PlanningIdentityProjection } from './planningProjections.js'
import { readTargetIdentitySnapshot } from './targetIdentitySnapshot.js'
import { BillingMigrationPhase } from './domainMigrationPhases.js'
import { GovernanceMigrationPhase, OrganizationMigrationPhase, UserIdentityMigrationPhase } from './coreMigrationPhases.js'
import { SudoworkMigrationBlockedError, SudoworkMigrationCoordinator } from './sudoworkMigrationCoordinator.js'
import type { SudoworkSourceSnapshot } from './sudoworkSourceSnapshot.js'

const snapshot: SudoworkSourceSnapshot = {
  fingerprint: 'frozen-source', capturedAt: '2026-09-08T00:00:00.000Z',
  sqlite: { name: 'sqlite', checksum: 'sqlite', itemCount: 3, readOnly: true, metadata: {} },
  redis: { name: 'redis', checksum: 'redis', itemCount: 0, readOnly: true, metadata: {} },
  qms: { name: 'qms', checksum: 'qms', itemCount: 0, readOnly: true, metadata: {} },
  files: { name: 'files', checksum: 'files', itemCount: 0, readOnly: true, metadata: {} },
  includedDomains: ['organizations', 'identities', 'governance', 'catalog', 'configuration', 'dify', 'billing', 'automation', 'qms', 'access'],
  excludedLocalData: ['sessions', 'client_cron', 'client_channels'],
}

class NoopPhase implements MigrationPhase {
  constructor(readonly name: MigrationPhaseName) {}
  async plan() { return { status: 'ready' as const, issues: [] } }
  async execute() { return { migrated: 0 } }
  async verify() { return { status: 'matched' as const, issues: [] } }
}

class InterruptOncePhase extends NoopPhase {
  private interrupted = false

  override async execute() {
    if (!this.interrupted) {
      this.interrupted = true
      throw new Error('fixture interruption')
    }
    return { migrated: 0 }
  }
}

describe('Sudowork migration end to end', () => {
  test('空 Moss 可完成跨阶段预检、迁移、校验并安全重复执行', async () => {
    const db = new DatabaseSync(':memory:')
    const auth = new AuthCenterDb(db)
    ensureBillingSchema(db)
    const baseIdentities = new IdentityRepository(db)
    const projection = new PlanningIdentityProjection(baseIdentities)
    const identities = projection.repository
    const unified = new UnifiedIdentityService(db, auth, identities)
    let runSequence = 0
    const runs = new MigrationRunStore(db, { idFactory: () => `run-${++runSequence}` })
    const identitySource: LegacyIdentitySnapshot = {
      organizations: [
        { legacyId: 7, name: '企业 A', code: 'ENT-A', codeVerified: true },
        { legacyId: 8, name: '企业 B', code: 'ENT-B', codeVerified: true },
      ],
      users: [
        {
          legacyId: 17, enterpriseId: 7, username: '13800000000', displayName: '用户 A',
          phone: '13800000000', phoneVerified: true, email: null, emailVerified: false,
          passwordHash: 'legacy-hash', role: 'USER', status: 'ACTIVE', providerIdentity: null,
        },
        {
          legacyId: 18, enterpriseId: 8, username: 'user-b', displayName: '用户 B',
          phone: null, phoneVerified: false, email: 'user-b@example.test', emailVerified: true,
          passwordHash: 'legacy-hash-b', role: 'ADMIN', status: 'ACTIVE', providerIdentity: null,
        },
      ],
    }
    const identity = new IdentityMigrationService({
      db, auth, identities, unified, runs,
      source: { readSnapshot: () => identitySource },
      planner: new IdentityMergePlanner({ organizations: [], users: [] }),
      createPlanner: () => new IdentityMergePlanner(readTargetIdentitySnapshot(auth, baseIdentities)),
    })
    const governance = new GovernanceMigrationService({
      db, identities, runs, defaultInitialQuota: 100000,
      source: { readSnapshot: () => ({
        checksum: 'governance',
        invitations: [
          {
            id: 3, code: 'INVITE-A', enterpriseId: 7, status: 'pending' as const,
            initialQuotaUsd: null, usedByUserId: null, createdAt: 1, usedAt: null,
          },
          {
            id: 4, code: 'INVITE-B', enterpriseId: 8, status: 'used' as const,
            initialQuotaUsd: 1, usedByUserId: 18, createdAt: 2, usedAt: 3,
          },
        ],
        operationLogs: [],
      }) },
    })
    const billingRepository = new BillingRepository(db)
    const billingSource = {
      checksum: 'abcdef0123456789',
      users: [
        { id: 17, phone: '13800000000', enterpriseId: 7, balanceUnits: 0, quotaUnits: 0, usedQuotaUnits: 0, externalUserId: null },
        { id: 18, phone: '', enterpriseId: 8, balanceUnits: 0, quotaUnits: 0, usedQuotaUnits: 0, externalUserId: null },
      ],
      ledger: [], orders: [], rechargeRecords: [], adminRechargeRecords: [], creditApplications: [], refunds: [],
    }
    const billing = new P3BillingMigrationService(
      db, identities, billingRepository, new WalletService(db, billingRepository), Date.now, projection,
    )
    const emptyAccessStore = {
      async keys() { return [] as string[] }, async get() { return null }, async ttl() { return -2 },
      async setex() {},
    }
    const access = new AccessMigrationPhase({
      source: { async readSnapshot() { return { checksum: 'access', redisEntries: [], handoffs: [] } } },
      target: emptyAccessStore, identities,
      sourceLegacyJwtSecret: 'production-secret', targetLegacyJwtSecret: 'production-secret',
    })
    const automation = new AutomationMigrationPhase({
      readSnapshot: () => ({ checksum: 'automation', detectedTables: [] }),
    })
    const onIdentityPlanned = (plan: ReturnType<IdentityMigrationService['plan']>) => projection.install(plan, plan.source)
    const phases = new MigrationPhaseRegistry([
      new OrganizationMigrationPhase(identity, [], onIdentityPlanned, () => projection.deactivate()),
      new UserIdentityMigrationPhase(identity, [], onIdentityPlanned, () => projection.deactivate()),
      new GovernanceMigrationPhase(governance),
      new NoopPhase('catalog'), new NoopPhase('configuration'), new NoopPhase('dify'),
      new BillingMigrationPhase(billing, { readSnapshot: () => billingSource }),
      automation, new InterruptOncePhase('qms'), access,
    ])
    const source = { async capture() { return snapshot }, async assertUnchanged(value: string) { assert.equal(value, snapshot.fingerprint) } }
    const coordinator = new SudoworkMigrationCoordinator({ runs, source, phases })

    const dryRun = await coordinator.dryRun()
    assert.equal(dryRun.status, 'ready')
    assert.equal(auth.listOrganizations().length, 0)

    await assert.rejects(coordinator.execute(), /fixture interruption/)
    let first
    try {
      first = await coordinator.resume('run-1')
    } catch (error) {
      if (error instanceof SudoworkMigrationBlockedError) {
        assert.fail(JSON.stringify(error.report.phases.filter(item => item.plan.status === 'blocked')))
      }
      throw error
    }
    assert.equal(first.resumed, true)
    assert.equal(first.phases.length, 10)
    assert.equal((await coordinator.verify(first.runId)).status, 'matched')
    const org = baseIdentities.resolveNumericAliasGlobal('enterprise', 7)
    const user = baseIdentities.resolveNumericAliasGlobal('user', 17)
    const orgB = baseIdentities.resolveNumericAliasGlobal('enterprise', 8)
    const userB = baseIdentities.resolveNumericAliasGlobal('user', 18)
    assert(org)
    assert(user)
    assert(orgB)
    assert(userB)
    assert.equal(user.orgId, org.resourceId)
    assert.equal(userB.orgId, orgB.resourceId)
    assert.notEqual(user.orgId, userB.orgId)
    assert.equal(baseIdentities.getInvitationByCode('INVITE-A')?.orgId, org.resourceId)
    assert.equal(baseIdentities.getInvitationByCode('INVITE-B')?.usedByUserId, userB.resourceId)
    assert.deepEqual(billingRepository.getWallet('user', user.resourceId), { balanceUnits: 0, version: 0 })
    assert.deepEqual(billingRepository.getWallet('user', userB.resourceId), { balanceUnits: 0, version: 0 })
    assert.equal(Number((db.prepare(`
      SELECT COUNT(*) AS count FROM outbox_events
      WHERE context_source = 'migration' AND status = 'pending'
    `).get() as { count: number }).count), 0)
    assert.equal(Number((db.prepare(`
      SELECT COUNT(*) AS count FROM outbox_events
      WHERE context_source = 'migration' AND status = 'suppressed'
    `).get() as { count: number }).count), 2)

    const second = await coordinator.execute()
    assert.equal(second.phases.length, 10)
    assert.equal(auth.listOrganizations().length, 2)
    assert.equal(auth.listUsersByOrg(org.resourceId).length, 1)
    assert.equal(auth.listUsersByOrg(orgB.resourceId).length, 1)
    db.close()
  })
})
