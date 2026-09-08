import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { migrationCommandContext } from '../application/commandContext.js'
import {
  BillingMigrationPhase,
  CatalogMigrationPhase,
  ConfigurationMigrationPhase,
  DifyMigrationPhase,
  QmsMigrationPhase,
} from './domainMigrationPhases.js'

const snapshot = { fingerprint: 'source' } as never
const execution = {
  runId: 'run-1', snapshot,
  commandContext: (key: string) => migrationCommandContext('run-1', key),
}
const verification = { runId: 'run-1', snapshot }

describe('domain migration phases', () => {
  test('Catalog 和配置阶段执行已有统一 Import Service 并用重规划校验', async () => {
    let catalogImported = false
    const catalog = {
      async plan() {
        return {
          status: 'ready' as const,
          counts: { agents: 1, skills: 0, imports: catalogImported ? 0 : 1, reuses: catalogImported ? 1 : 0 },
          conflicts: [], orphans: [],
        }
      },
      async execute(runId: string) { catalogImported = true; return { runId, imported: 1 } },
    }
    const states = { image: false, config: false, system: false }
    const configuration = new ConfigurationMigrationPhase({
      managedImages: {
        async plan() { return { status: 'ready' as const, counts: { source: 1, imports: states.image ? 0 : 1, reuses: states.image ? 1 : 0 }, conflicts: [] } },
        async execute() { states.image = true; return { imported: 1 } },
      },
      configuration: {
        plan() { return { status: 'ready' as const, counts: { source: 1, imports: states.config ? 0 : 1, reuses: states.config ? 1 : 0 }, conflicts: [], orphans: [] } },
        execute(runId: string) { states.config = true; return { runId, imported: 1 } },
      },
      systemConfiguration: {
        async plan() { return { status: 'ready' as const, migratedKeys: ['login_method'], deferredKeys: [], conflicts: [] } },
        async execute(runId: string) { states.system = true; return { runId, imported: true } },
      },
    } as never)
    const catalogPhase = new CatalogMigrationPhase(catalog as never)

    const catalogPlan = await catalogPhase.plan({ snapshot })
    assert.equal(catalogPlan.status, 'ready')
    assert.deepEqual(await catalogPhase.execute(execution, catalogPlan), { runId: 'run-1', imported: 1 })
    assert.equal((await catalogPhase.verify(verification)).status, 'matched')

    const configurationPlan = await configuration.plan({ snapshot })
    assert.equal(configurationPlan.status, 'ready')
    await configuration.execute(execution, configurationPlan)
    assert.deepEqual(states, { image: true, config: true, system: true })
    assert.equal((await configuration.verify(verification)).status, 'matched')
  })

  test('Dify、Billing 和 QMS 阶段使用稳定 migration context 并透传领域校验', async () => {
    const contexts: string[] = []
    const dify = {
      plan: () => ({ status: 'ready' as const, sourceChecksum: 'dify-sum', issues: [] }),
      async execute(_plan: unknown, context: ReturnType<typeof migrationCommandContext>) {
        contexts.push(context.idempotencyKey); return { imported: 1 }
      },
      async verify() { return { status: 'matched' as const, issues: [] } },
    }
    const billingSource = { readSnapshot: () => ({ checksum: 'billing-sum' }) }
    const billing = {
      plan: (source: unknown) => ({ status: 'ready' as const, sourceChecksum: 'billing-sum', source, issues: [] }),
      execute(_plan: unknown, context: ReturnType<typeof migrationCommandContext>) {
        contexts.push(context.idempotencyKey); return { imported: 1 }
      },
      verify: () => ({ status: 'matched' as const, issues: [] }),
    }
    const qms = {
      async plan() { return { status: 'ready' as const, sourceChecksum: 'qms-sum', issues: [] } },
      async execute(_plan: unknown, context: ReturnType<typeof migrationCommandContext>) {
        contexts.push(context.idempotencyKey); return { imported: 1 }
      },
      async verify() { return { status: 'matched' as const, issues: [] } },
    }
    const phases = [
      new DifyMigrationPhase(dify as never),
      new BillingMigrationPhase(billing as never, billingSource as never),
      new QmsMigrationPhase(qms as never),
    ]
    for (const phase of phases) {
      const plan = await phase.plan({ snapshot })
      assert.equal(plan.status, 'ready')
      await phase.execute(execution, plan)
      assert.equal((await phase.verify(verification)).status, 'matched')
    }
    assert.deepEqual(contexts, [
      'migration:phase:dify:dify-sum',
      'migration:phase:billing:billing-sum',
      'migration:phase:qms:qms-sum',
    ])
  })
})
