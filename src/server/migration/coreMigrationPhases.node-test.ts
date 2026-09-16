import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { migrationCommandContext } from '../application/commandContext.js'
import {
  GovernanceMigrationPhase,
  OrganizationMigrationPhase,
  UserIdentityMigrationPhase,
} from './coreMigrationPhases.js'

const snapshot = { fingerprint: 'source-fingerprint' } as never

describe('core migration phases', () => {
  test('组织和用户阶段共享身份计划但调用独立执行边界', async () => {
    const calls: string[] = []
    const domainPlan = { status: 'ready' as const, issues: [], sourceChecksum: 'identity-checksum' }
    const service = {
      plan(resolutions: unknown[]) {
        assert.deepEqual(resolutions, [{ kind: 'organization', sourceId: '7', targetId: 'org-a' }])
        return domainPlan
      },
      executeOrganizations(plan: unknown, context: ReturnType<typeof migrationCommandContext>) {
        assert.equal(plan, domainPlan)
        assert.equal(context.source, 'migration')
        calls.push(`organizations:${context.idempotencyKey}`)
        return { organizationsCreated: 1 }
      },
      executeUsers(plan: unknown, context: ReturnType<typeof migrationCommandContext>) {
        assert.equal(plan, domainPlan)
        assert.equal(context.externalEffects, 'suppress_external')
        calls.push(`identities:${context.idempotencyKey}`)
        return { usersCreated: 1 }
      },
      verify() { return { status: 'matched' as const, issues: [] } },
    }
    const resolutions = [{ kind: 'organization', sourceId: '7', targetId: 'org-a' }] as never[]
    const organizations = new OrganizationMigrationPhase(service as never, resolutions)
    const identities = new UserIdentityMigrationPhase(service as never, resolutions)
    const context = {
      runId: 'run-1',
      snapshot,
      commandContext: (key: string) => migrationCommandContext('run-1', key),
    }

    const organizationPlan = await organizations.plan({ snapshot })
    const identityPlan = await identities.plan({ snapshot })
    assert.equal(JSON.stringify(organizationPlan).includes('domainPlan'), false)
    assert.deepEqual(await organizations.execute(context, organizationPlan), { organizationsCreated: 1 })
    assert.deepEqual(await identities.execute(context, identityPlan), { usersCreated: 1 })
    assert.deepEqual(calls, [
      'organizations:migration:phase:organizations:identity-checksum',
      'identities:migration:phase:identities:identity-checksum',
    ])
    assert.equal((await organizations.verify({ runId: 'run-1', snapshot })).status, 'matched')
    assert.equal((await identities.verify({ runId: 'run-1', snapshot })).status, 'matched')
  })

  test('治理阶段透传阻断项、人工归属和校验结果', async () => {
    const domainPlan = {
      status: 'blocked' as const,
      sourceChecksum: 'governance-checksum',
      issues: [{
        code: 'OPERATION_ORGANIZATION_REQUIRED',
        sourceType: 'operation_log',
        sourceId: '9',
        message: '需要企业归属',
      }],
    }
    const service = {
      plan(resolutions: unknown) {
        assert.deepEqual(resolutions, { operationLogEnterpriseIds: { 9: 7 } })
        return domainPlan
      },
      execute() { throw new Error('blocked plan must not execute') },
      verify() {
        return { status: 'mismatch' as const, issues: ['未导入'], sourceChecksum: 'governance-checksum' }
      },
    }
    const phase = new GovernanceMigrationPhase(
      service as never,
      { operationLogEnterpriseIds: { 9: 7 } },
    )
    const plan = await phase.plan({ snapshot })
    assert.equal(phase.name, 'governance')
    assert.equal(plan.status, 'blocked')
    assert.deepEqual(plan.issues, [{
      code: 'OPERATION_ORGANIZATION_REQUIRED',
      resourceType: 'operation_log',
      resourceId: '9',
      message: '需要企业归属',
    }])
    assert.deepEqual(await phase.verify({ runId: 'run-1', snapshot }), {
      status: 'mismatch', issues: ['未导入'], sourceChecksum: 'governance-checksum',
    })
  })
})
