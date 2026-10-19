import pg from 'pg'
import { PgDriver, type PgPoolLike } from '../db/driver.js'
import { CatalogRepository } from '../catalog/catalogRepository.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import { ExternalTaskStore } from '../externalProviders/store.js'
import { ExternalProviderService } from '../externalProviders/service.js'

// Synthetic-only subprocess for actual SIGKILL/failover tests. No shutdown hook releases its lease.
process.once('message', async (input: { connectionString: string; schema: string; endpoint: string; token: string; actor: { orgId: string; userId: string }; submission: unknown }) => {
  if (!/^moss_crash_[a-f0-9]+$/.test(input.schema)) throw new Error('Invalid test schema')
  const driver = new PgDriver(new pg.Pool({ connectionString: input.connectionString, options: `-c search_path=${input.schema}`, max: 4 }) as unknown as PgPoolLike)
  const service = new ExternalProviderService(new ExternalTaskStore(driver), {
    catalog: new CatalogRepository(driver), identities: new IdentityRepository(driver),
    secrets: { getSecret: async () => ({ value: input.token, status: 'enabled', version: 1 }) },
    isActorActive: async () => true,
    isMemberActive: async () => true,
    policy: { orgIds: [input.actor.orgId], endpoints: [input.endpoint], timeoutMs: 90_000 },
  })
  try {
    const task = await service.create(input.actor, input.submission)
    process.send!({ task, ownerId: service.ownership.ownerId })
  } catch { process.send!({ error: 'CHILD_EXECUTION_FAILED' }); process.exitCode = 1 }
})
