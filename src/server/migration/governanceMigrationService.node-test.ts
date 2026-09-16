import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { migrationCommandContext, onlineCommandContext } from '../application/commandContext.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import { UnifiedIdentityService } from '../identity/unifiedIdentityService.js'
import {
  GovernanceMigrationBlockedError,
  GovernanceMigrationService,
} from './governanceMigrationService.js'
import { MigrationRunStore } from './migrationRunStore.js'
import type { SudoworkGovernanceSnapshot } from './sudoworkGovernanceSourceReader.js'

const snapshot: SudoworkGovernanceSnapshot = {
  invitations: [
    {
      id: 1, code: 'PENDING', enterpriseId: 7, status: 'pending',
      initialQuotaUsd: null, usedByUserId: null, createdAt: 100, usedAt: null,
    },
    {
      id: 2, code: 'USED', enterpriseId: 7, status: 'used',
      initialQuotaUsd: 12.5, usedByUserId: 17, createdAt: 200, usedAt: 300,
    },
  ],
  operationLogs: [{
    id: 9,
    userId: 17,
    userPhone: '13800000000',
    action: 'USER_UPDATE',
    resource: 'user',
    resourceId: 17,
    method: 'PATCH',
    path: '/api/v1/admin/users/17',
    paramsRaw: '{"page": 1}',
    requestDataRaw: '{"b":2, "a":1}',
    responseDataRaw: 'not-json',
    responseStatus: 200,
    ipAddress: '127.0.0.1',
    userAgent: 'Sudowork/1.0',
    durationMs: 23,
    errorMessage: null,
    createdAt: 400,
  }],
  checksum: 'governance-checksum',
}

function setup(source: SudoworkGovernanceSnapshot = snapshot) {
  const db = new DatabaseSync(':memory:')
  const auth = new AuthCenterDb(db)
  const identities = new IdentityRepository(db)
  const unified = new UnifiedIdentityService(db, auth, identities)
  const organization = unified.createOrganization({
    name: '企业 A', code: 'ENT-A', legacyEnterpriseId: 7,
  }, migrationCommandContext('identity-bootstrap', 'organization-7'))
  const user = unified.createUser({
    orgId: organization.organizationId,
    username: '13800000000',
    phone: '13800000000',
    passwordHash: '$2b$10$legacy',
    role: 'user',
    legacyUserId: 17,
  }, migrationCommandContext('identity-bootstrap', 'user-17'))
  const runs = new MigrationRunStore(db, { idFactory: () => 'run-governance' })
  runs.createRun({ sourceFingerprint: 'source-fingerprint', sourceMetadata: {} })
  const service = new GovernanceMigrationService({
    db,
    identities,
    runs,
    source: { readSnapshot: () => source },
    defaultInitialQuota: 500_000,
  })
  return { db, auth, identities, runs, service, organization, user }
}

describe('GovernanceMigrationService', () => {
  test('通过统一仓储幂等导入邀请码和完整审计且不产生外部副作用', () => {
    const context = setup()
    try {
      const plan = context.service.plan()
      assert.equal(plan.status, 'ready')
      const command = migrationCommandContext('run-governance', 'governance-phase')
      const first = context.service.execute(plan, command)
      const repeated = context.service.execute(plan, command)

      assert.deepEqual(repeated, first)
      assert.deepEqual(first, {
        migrationRunId: 'run-governance',
        sourceChecksum: 'governance-checksum',
        invitationsImported: 2,
        operationLogsImported: 1,
        deliverableExternalOutboxCount: 0,
      })
      const pendingId = context.identities.resolveNumericAliasGlobal('invitation', 1)!.resourceId
      const usedId = context.identities.resolveNumericAliasGlobal('invitation', 2)!.resourceId
      assert.deepEqual(context.identities.getInvitationById(pendingId), {
        id: pendingId,
        orgId: context.organization.organizationId,
        code: 'PENDING',
        status: 'pending',
        initialCreditUnits: 1_000,
        legacyInitialQuotaUsd: null,
        usedByUserId: null,
        createdAt: 100,
        usedAt: null,
      })
      assert.equal(context.identities.getInvitationById(usedId)?.initialCreditUnits, 12_500)
      assert.equal(context.identities.getInvitationById(usedId)?.usedByUserId, context.user.userId)
      assert.equal(context.identities.getInvitationById(usedId)?.usedAt, 300)
      const audit = context.identities.listOperationAudits({ limit: 10, offset: 0 }).items[0]!
      assert.equal(audit.legacyId, 9)
      assert.equal(audit.orgId, context.organization.organizationId)
      assert.equal(audit.actorUserId, context.user.userId)
      assert.equal(audit.legacyRequestDataRaw, '{"b":2, "a":1}')
      assert.equal(audit.legacyResponseDataRaw, 'not-json')
      assert.equal(context.runs.listMappings('run-governance').filter(item => item.namespace === 'invitation').length, 2)
    } finally {
      context.db.close()
    }
  })

  test('按唯一手机号归属 user_id=0 的历史日志', () => {
    const source: SudoworkGovernanceSnapshot = {
      invitations: [],
      operationLogs: [{ ...snapshot.operationLogs[0]!, id: 10, userId: 0 }],
      checksum: 'phone-log',
    }
    const context = setup(source)
    try {
      const plan = context.service.plan()
      assert.equal(plan.status, 'ready')
      context.service.execute(plan, migrationCommandContext('run-governance', 'governance-phone-log'))
      const audit = context.identities.listOperationAudits({ limit: 10, offset: 0 }).items[0]!
      assert.equal(audit.actorUserId, context.user.userId)
      assert.equal(audit.actorLegacyId, 0)
    } finally {
      context.db.close()
    }
  })

  test('无法推导组织的日志和孤立邀请会在预检阻断，显式旧企业归属可解除日志冲突', () => {
    const source: SudoworkGovernanceSnapshot = {
      invitations: [{ ...snapshot.invitations[0]!, enterpriseId: 99 }],
      operationLogs: [{ ...snapshot.operationLogs[0]!, id: 11, userId: null, userPhone: null }],
      checksum: 'blocked-governance',
    }
    const context = setup(source)
    try {
      const blocked = context.service.plan()
      assert.equal(blocked.status, 'blocked')
      assert.deepEqual(blocked.issues.map(item => item.code).sort(), [
        'IDENTITY_MAPPING_MISSING',
        'OPERATION_ORGANIZATION_REQUIRED',
      ])
      assert.throws(
        () => context.service.execute(blocked, migrationCommandContext('run-governance', 'blocked')),
        GovernanceMigrationBlockedError,
      )

      const onlyLog = { ...source, invitations: [], checksum: 'manual-log' }
      const manual = setup(onlyLog)
      try {
        const plan = manual.service.plan({ operationLogEnterpriseIds: { 11: 7 } })
        assert.equal(plan.status, 'ready')
      } finally {
        manual.db.close()
      }
    } finally {
      context.db.close()
    }
  })

  test('拒绝在线上下文和已被其他目标占用的邀请码代码', () => {
    const context = setup()
    try {
      context.identities.createInvitation({
        id: 'native-invitation',
        orgId: context.organization.organizationId,
        code: 'PENDING',
        initialCreditUnits: 1,
      })
      const plan = context.service.plan()
      assert.equal(plan.status, 'blocked')
      assert(plan.issues.some(item => item.code === 'TARGET_CONFLICT'))
      assert.throws(
        () => context.service.execute(plan, onlineCommandContext('not-migration')),
        /migration/,
      )
    } finally {
      context.db.close()
    }
  })
})
