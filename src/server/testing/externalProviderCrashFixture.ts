import { queryOnlyDefinition } from './externalProviderDefinitionFixture.js'
import { DatabaseSync } from 'node:sqlite'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { SqliteDriver } from '../db/driver.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { createCatalogTestRepository, createIdentityTestRepository } from './compatibilityRepositories.js'
import { ExternalTaskStore } from '../externalProviders/store.js'
import { ExternalProviderService } from '../externalProviders/service.js'
import { DifyPilotTransport } from '../externalProviders/difyTransport.js'

export async function crashFixture(directory: string) {
  const db = new DatabaseSync(join(directory, 'state.sqlite')), driver = new SqliteDriver(db)
  const actor = { orgId: 'crash-org', userId: 'reviewer' }
  const auth = new AuthCenterDb(db)
  if (!await auth.getOrganization(actor.orgId)) await auth.createOrganization(actor.orgId, 'Crash test', Date.now())
  const file = (namespace: string, key: string) => join(directory, `${encodeURIComponent(namespace)}-${key}.json`)
  const control = { crash: '' }
  const secrets = {
    async getSecret(namespace: string, key: string) {
      try { return JSON.parse(await readFile(file(namespace, key), 'utf8')) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    },
    async putSecret(namespace: string, key: string, value: string) {
      if (control.crash === 'before-write') {
        await writeFile(join(directory, 'crash-marker'), control.crash)
        process.kill(process.pid, 'SIGKILL')
      }
      await writeFile(file(namespace, key), JSON.stringify({ value, status: 'enabled', version: 1 }))
      if (control.crash === 'after-write') {
        await writeFile(join(directory, 'crash-marker'), control.crash)
        process.kill(process.pid, 'SIGKILL')
      }
    },
    async deleteSecret(namespace: string, key: string) { await rm(file(namespace, key), { force: true }) },
  }
  const store = new ExternalTaskStore(driver)
  const service = new ExternalProviderService(store, {
    catalog: createCatalogTestRepository(db, driver), identities: createIdentityTestRepository(db, {}, driver), secrets,
    isActive: async () => true, policy: { orgIds: [actor.orgId], endpoints: ['http://127.0.0.1:8089/v1'], timeoutMs: 1000 },
    transport: new DifyPilotTransport((async (url: string | URL | Request) => Response.json(String(url).endsWith('/info') ? { name: 'Synthetic' } : { user_input_form: [], file_upload: { enabled: false } })) as typeof fetch),
  })
  const body = { request_id: randomUUID(), name: 'Crash fixture', endpoint: 'http://127.0.0.1:8089/v1', api_key: 'synthetic-secret', app_id: 'app', workspace_id: 'workspace', source_definition: JSON.stringify(queryOnlyDefinition()), decoder: 'text', allowed_user_ids: [actor.userId], review_days: 1, review_note: 'Synthetic crash fixture' }
  return { actor, driver, store, service, control, body }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = await crashFixture(process.argv[2]!)
  const kind = process.argv[3]!, stage = process.argv[4]!
  if (kind === 'rotate') {
    const agent = await fixture.service.administration.onboard(fixture.actor, fixture.body)
    fixture.control.crash = stage
    await fixture.service.administration.rotate(fixture.actor, agent.id, { revision: agent.revision, api_key: 'synthetic-replacement' })
  } else {
    fixture.control.crash = stage
    await fixture.service.administration.onboard(fixture.actor, fixture.body)
  }
  throw new Error('Expected crash did not occur')
}
