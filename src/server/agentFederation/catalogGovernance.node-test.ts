import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { AuthCenterDb } from '../authCenter/db.js'
import {
  SqliteDriver,
  PgDriver,
  type DbDriver,
  type PgPoolLike,
} from '../db/driver.js'
import pg from 'pg'
import { applyPgSchema } from '../db/pg_schema.js'
import { CatalogRepository } from '../catalog/catalogRepository.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import {
  createCatalogTestRepository,
  createIdentityTestRepository,
} from '../testing/compatibilityRepositories.js'
import { startProtocolReference } from '../testing/standardProtocolReference.js'
import { syntheticTaskSubmission, queryOnlyDefinition } from '../testing/externalProviderDefinitionFixture.js'
import { ExternalTaskStore } from '../externalProviders/store.js'
import { ExternalProviderService } from '../externalProviders/service.js'
import { dispatchExternalProvider } from '../externalProviders/routes.js'
import { discoverStandardManifest } from './standardHttpAdapter.js'
import { CatalogReadModel } from './catalogReadModel.js'
import type { ImportCandidate } from '../../../contracts/agent-catalog/v1alpha1/contract.js'
import type { StandardHttpProtocol } from '../../../contracts/agent-federation/v1alpha1/contract.js'

const key = 'catalog-synthetic-test-key'
const actor = { orgId: 'org', userId: 'admin' }
async function difyReference() {
  const control = { invocations: 0 }
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401).end(); return }
    if (req.url === '/v1/info' || req.url === '/v1/parameters') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url.endsWith('/info') ? { name: 'Dify synthetic reference' } : { user_input_form: [], file_upload: { enabled: false } })); return }
    if (req.url === '/v1/chat-messages' && req.method === 'POST') {
      control.invocations++
      res.setHeader('Content-Type', 'text/event-stream')
      res.end([{ event: 'workflow_started', workflow_run_id: 'dify-run-1', task_id: 'dify-task-1' }, { event: 'message', answer: '42', conversation_id: 'dify-conversation-1' }, { event: 'message_end' }, { event: 'workflow_finished', data: { status: 'succeeded' } }].map(e => `data: ${JSON.stringify(e)}\n\n`).join(''))
      return
    }
    res.writeHead(404).end()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Reference address missing')
  return { endpoint: `http://127.0.0.1:${address.port}/v1`, target: 'dify-reference', control,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())) } }
}

async function fixture(
  kind: 'http' | 'openai' | 'mcp' | 'a2a' = 'http',
  legacy = false,
) {
  const server = await startProtocolReference(kind, key)
  const protocol = {
    openai: 'openai-chat-completions/v1',
    mcp: 'mcp/2025-06-18',
    a2a: 'a2a/0.3.0',
  } as const
  const manifest =
    kind === 'http'
      ? server.legacyManifest()
      : await discoverStandardManifest(
          {
            endpoint: server.endpoint,
            key,
            protocol: protocol[kind] as StandardHttpProtocol,
            target: server.target,
            agentId: server.target,
            name: 'Catalog reference',
          },
          AbortSignal.timeout(5000),
        )
  let raw: DatabaseSync | undefined,
    db: DbDriver,
    drop = async () => {}
  if (process.env.MOSS_PG_TEST_URL) {
    pg.types.setTypeParser(20, Number)
    const schema = `catalog_${randomUUID().replaceAll('-', '')}`,
      admin = new pg.Pool({ connectionString: process.env.MOSS_PG_TEST_URL })
    await admin.query(`CREATE SCHEMA ${schema}`)
    const pool = new pg.Pool({
      connectionString: process.env.MOSS_PG_TEST_URL,
      options: `-c search_path=${schema}`,
      max: 8,
    })
    db = new PgDriver(pool as unknown as PgPoolLike)
    drop = async () => {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    }
    await applyPgSchema(db)
    await db.run(
      'INSERT INTO organizations(id, name, created_at) VALUES (?, ?, ?)',
      [actor.orgId, 'Catalog test', Date.now()],
    )
  } else {
    raw = new DatabaseSync(':memory:')
    db = new SqliteDriver(raw)
    await new AuthCenterDb(raw).createOrganization(
      actor.orgId,
      'Catalog test',
      Date.now(),
    )
  }
  const secrets = new Map<string, string>()
  const secretState = { version: 1 }
  const options = {
    catalog: raw
      ? createCatalogTestRepository(raw, db)
      : new CatalogRepository(db),
    identities: raw
      ? createIdentityTestRepository(raw, {}, db)
      : new IdentityRepository(db),
    policy: {
      orgIds: [actor.orgId],
      endpoints: [server.endpoint],
      timeoutMs: 2000,
    },
    isActorActive: async (a: typeof actor) => a.orgId === actor.orgId,
    isMemberActive: async () => true,
    secrets: {
      getSecret: async (n: string, k: string) => ({
        value: secrets.get(n + '/' + k) ?? null,
        status: 'enabled',
        version: secretState.version,
      }),
      putSecret: async (n: string, k: string, v: string) => {
        secrets.set(n + '/' + k, v)
      },
      deleteSecret: async (n: string, k: string) => {
        secrets.delete(n + '/' + k)
      },
    },
  }
  const store = new ExternalTaskStore(db),
    service = new ExternalProviderService(store, options)
  const agent = await service.onboard(actor, {
    request_id: randomUUID(),
    provider_kind: 'custom_http',
    endpoint: server.endpoint,
    api_key: key,
    app_id: server.target,
    workspace_id: 'reference',
    name: 'Catalog reference',
    source_definition: JSON.stringify(manifest),
    decoder: 'text',
    allowed_user_ids: [actor.userId, 'member'],
    review_days: 1,
    review_note: 'Synthetic conformance',
    catalog_governance: !legacy,
  })
  const g = service.governance
  const source = (await g.data.managed(actor, agent.id))?.view
  const close = async () => {
    await service.close()
    await db.close()
    await drop()
    await server.close()
  }
  const sync = async () => {
    const view = (await g.data.source(actor, source!.id)).view
    const result = await g.sync(actor, view.id, { revision: view.revision })
    assert.equal(result.status, 'succeeded', result.error ?? '')
    return (await g.data.candidate(actor, result.candidate_id!)).view
  }
  const approve = async (c: ImportCandidate) => {
    c = await g.decide(actor, c.id, {
      revision: c.revision,
      action: 'submit',
      note: 'Submit reviewed metadata',
    })
    return g.decide(actor, c.id, {
      revision: c.revision,
      action: 'approve',
      note: 'Approve synthetic test',
      review_days: 1,
    })
  }
  const publish = async (c: ImportCandidate) => {
    const approved = await approve(c)
    const result = await g.publish(actor, approved.id, {
      revision: approved.revision,
    })
    assert.equal(result.status, 'published', result.publication_error ?? '')
    return result
  }
  return {
    server,
    db,
    service,
    g,
    agent,
    source,
    sync,
    approve,
    publish,
    close,
    secretState,
    options,
  }
}

for (const kind of ['http', 'openai', 'mcp', 'a2a'] as const)
  void test(`catalog ${kind}: import, idempotent sync, separate approval/publication/channel, invoke, new revision`, async (t) => {
    const f = await fixture(kind)
    t.after(f.close)
    const candidate = await f.sync(),
      again = await f.sync()
    assert.equal(again.id, candidate.id)
    assert.equal(f.server.control.invocations, 0)
    await assert.rejects(
      f.g.publish(actor, candidate.id, { revision: candidate.revision }),
      { code: 'CANDIDATE_APPROVAL_REQUIRED' },
    )
    const approved = await f.approve(candidate)
    assert.equal(
      (await f.service.releases.list(actor, f.agent.id)).items.length,
      0,
    )
    assert.equal(
      (await f.service.list({ ...actor, userId: 'member' })).length,
      0,
    )
    const published = await f.g.publish(actor, approved.id, {
      revision: approved.revision,
    })
    assert.equal(
      published.status,
      'published',
      published.publication_error ?? '',
    )
    assert.equal(
      (await f.service.releases.list(actor, f.agent.id)).channels.length,
      0,
    )
    assert.equal(
      (await f.sync()).id,
      candidate.id,
      'publication does not make identical source produce another candidate',
    )
    await f.service.releases.moveChannel(
      actor,
      f.agent.id,
      'stable',
      published.published_version!,
      0,
    )
    const task = await f.service.create(
      { ...actor, userId: 'member' },
      syntheticTaskSubmission({
        agent_id: f.agent.id,
        query: '6 * 7',
        idempotency_key: randomUUID(),
      }),
    )
    await f.service.waitForTask(task.id)
    assert.equal(
      (await f.service.store.task({ ...actor, userId: 'member' }, task.id))
        .answer,
      '42',
    )
    const old = await f.service.releases.list(actor, f.agent.id)
    f.server.control.revision++
    const next = await f.sync()
    assert.notEqual(next.id, candidate.id)
    assert.equal(next.status, 'draft')
    assert(next.changes.some((c) => c.field === 'source_digest'))
    assert.deepEqual(
      await f.service.releases.list(actor, f.agent.id),
      old,
      'sync cannot overwrite versions or channels',
    )
    await assert.rejects(f.service.review(actor, f.agent.id, true, 2), {
      code: 'CANDIDATE_WORKFLOW_REQUIRED',
    })
    await assert.rejects(
      f.service.administration.update(actor, f.agent.id, {
        revision: 2,
        name: 'bypass',
        review_days: 1,
      }),
      { code: 'CANDIDATE_WORKFLOW_REQUIRED' },
    )
    assert.equal(f.server.control.invocations, 1)
  })

void test('catalog authorization, connection changes, disable/enable and audit contain no credential values', async (t) => {
  const f = await fixture()
  t.after(f.close)
  const c = await f.sync()
  await assert.rejects(
    f.g.data.candidate({ orgId: 'other', userId: 'admin' }, c.id),
    { code: 'IMPORT_CANDIDATE_NOT_FOUND' },
  )
  const result = await dispatchExternalProvider(
    f.service,
    actor,
    'POST',
    new URL('http://localhost/api/v1/external-agents/admin/catalog/sources'),
    {},
    () => {
      throw new Error('no admin')
    },
  )
  assert.notEqual(result.status, 200)
  const managedUrl = new URL(`http://localhost/api/v1/external-agents/admin/catalog/managed?ids=${f.agent.id}`)
  const { dispatchCatalogGovernance } = await import('./catalogRoutes.js')
  const managed = await dispatchCatalogGovernance(f.g, actor, 'GET', managedUrl, undefined)
  assert.equal((managed as Array<{ id: string }>)[0].id, f.source!.id)
  assert.deepEqual(await dispatchCatalogGovernance(f.g, { ...actor, orgId: 'other' }, 'GET', managedUrl, undefined), [])
  const administrator = { ...actor, userId: 'another-admin' }
  assert.equal((await f.service.administration.listPage(administrator)).items.some(item => item.id === f.agent.id), true)
  assert.equal((await f.service.listPage(administrator)).items.some(item => item.id === f.agent.id), false)
  await assert.rejects(dispatchCatalogGovernance(f.g, actor, 'GET', new URL(managedUrl.href + ',invalid%27'), undefined), { code: 'INVALID_CATALOG_FILTER' })
  const detail = await dispatchCatalogGovernance(f.g, actor, 'GET', new URL(`http://localhost/api/v1/external-agents/admin/catalog/agents/${f.agent.id}`), undefined) as { agent: { id: string }; source: { id: string } }
  assert.equal(detail.agent.id, f.agent.id)
  assert.equal(detail.source.id, f.source!.id)
  const changed = await f.g.updateSource(actor, f.source!.id, {
    revision: 1,
    name: 'Changed',
  })
  await assert.rejects(f.approve(c), { code: 'CANDIDATE_VALIDATION_STALE' })
  const approved = await f.publish(await f.sync())
  await f.service.releases.moveChannel(
    actor,
    f.agent.id,
    'stable',
    approved.published_version!,
    0,
  )
  const disabled = await f.g.updateSource(actor, changed.id, {
    revision: changed.revision,
    enabled: false,
  })
  const stopped = await f.service.create(
    actor,
    syntheticTaskSubmission({
      agent_id: f.agent.id,
      query: '6 * 7',
      idempotency_key: randomUUID(),
    }),
  )
  assert.equal(stopped.status, 'rejected')
  assert.equal(f.server.control.invocations, 0)
  await f.g.updateSource(actor, changed.id, {
    revision: disabled.revision,
    enabled: true,
  })
  const audit = await f.g.data.page(actor, 'audit')
  assert(audit.items.length > 0)
  assert(!JSON.stringify(audit).includes(key))
  assert(!JSON.stringify(c).includes(key))
  await assert.rejects(
    f.g.updateSource(actor, changed.id, { revision: 1, enabled: false }),
    { code: 'CONFIGURATION_CHANGED' },
  )
})

void test('lost publication response reconciles exact version without another publish', async (t) => {
  const f = await fixture()
  t.after(f.close)
  const c = await f.approve(await f.sync())
  const publish = f.service.releases.publish.bind(f.service.releases)
  let count = 0
  f.service.releases.publish = async (...args) => {
    count++
    await publish(...args)
    throw new Error('lost response')
  }
  const unknown = await f.g.publish(actor, c.id, { revision: c.revision })
  assert.equal(unknown.status, 'publication_unknown')
  await assert.rejects(
    f.g.assertVersion(actor, f.agent.id, unknown.published_version!),
    { code: 'CATALOG_VERSION_NOT_ACTIVE' },
  )
  const confirmed = await f.g.reconcile(actor, c.id)
  assert.equal(confirmed.status, 'published')
  assert.equal(count, 1)
  assert.equal(
    (await f.service.releases.list(actor, f.agent.id)).channels.length,
    0,
  )
})

void test('adoption is explicit, GET stays read-only and preserves legacy versions', async (t) => {
  const f = await fixture('http', true)
  t.after(f.close)
  await f.service.review(actor, f.agent.id, true, f.agent.revision)
  const versions = await f.service.releases.list(actor, f.agent.id)
  const binding = await f.service.store.binding(actor, f.agent.id)
  const before = await f.db.all('SELECT * FROM agent_catalog_sources')
  assert.equal(before.length, 0)
  await f.service.releaseOptions(actor, f.agent.id)
  assert.equal(
    (await f.db.all('SELECT * FROM agent_catalog_sources')).length,
    0,
  )
  const source = await f.g.attach(actor, {
    catalog_id: f.agent.id,
    revision: binding.revision,
  })
  assert.deepEqual(await f.service.releases.list(actor, f.agent.id), versions)
  assert.equal(
    (await f.g.data.source(actor, source.id)).view.availability,
    'unknown',
  )
  await f.g.assertVersion(actor, f.agent.id, versions.items[0].version)
})

void test('legacy adoption maps revoked, expired and disabled-channel authority state', async (t) => {
  const revoked = await fixture('http', true)
  t.after(revoked.close)
  await revoked.service.review(actor, revoked.agent.id, true, revoked.agent.revision)
  const revokedVersion = (await revoked.service.releases.list(actor, revoked.agent.id)).items[0]
  await revoked.service.releases.revoke(actor, revoked.agent.id, revokedVersion.version, 'Legacy revoked before catalog adoption')
  const revokedBinding = await revoked.service.store.binding(actor, revoked.agent.id)
  await revoked.g.attach(actor, { catalog_id: revoked.agent.id, revision: revokedBinding.revision })
  assert.equal((await revoked.g.data.version(actor, revoked.agent.id, revokedVersion.version))?.lifecycle, 'deprecated')
  assert.equal((await new CatalogReadModel(revoked.g).entry(actor, revoked.agent.id)).versions[0].status, 'revoked')

  const expired = await fixture('http', true)
  t.after(expired.close)
  await expired.service.review(actor, expired.agent.id, true, expired.agent.revision)
  const expiredVersion = (await expired.service.releases.list(actor, expired.agent.id)).items[0]
  await expired.db.run("UPDATE agent_version_decisions SET expires_at = 1 WHERE catalog_id = ? AND version = ? AND decision = 'approved'", [expired.agent.id, expiredVersion.version])
  const expiredBinding = await expired.service.store.binding(actor, expired.agent.id)
  await expired.g.attach(actor, { catalog_id: expired.agent.id, revision: expiredBinding.revision })
  assert.equal((await expired.g.data.version(actor, expired.agent.id, expiredVersion.version))?.lifecycle, 'deprecated')

  const disabled = await fixture('http', true)
  t.after(disabled.close)
  await disabled.service.review(actor, disabled.agent.id, true, disabled.agent.revision)
  const disabledVersion = (await disabled.service.releases.list(actor, disabled.agent.id)).items[0]
  const stable = (await disabled.service.releases.list(actor, disabled.agent.id)).channels.find(channel => channel.name === 'stable')
  await disabled.service.releases.moveChannel(actor, disabled.agent.id, 'stable', disabledVersion.version, stable?.revision ?? 0)
  await disabled.db.run('UPDATE agent_channels SET enabled = 0 WHERE catalog_id = ? AND name = ?', [disabled.agent.id, 'stable'])
  const disabledBinding = await disabled.service.store.binding(actor, disabled.agent.id)
  await disabled.g.attach(actor, { catalog_id: disabled.agent.id, revision: disabledBinding.revision })
  const disabledView = await new CatalogReadModel(disabled.g).entry(actor, disabled.agent.id)
  assert.equal((await disabled.g.data.version(actor, disabled.agent.id, disabledVersion.version))?.lifecycle, 'published')
  assert.equal(disabledView.entry.status, 'published')
  assert.equal(disabledView.entry.is_selectable, false)
  assert.equal(disabledView.versions[0].channels[0].enabled, false)
})

void test('source execution changes freeze published versions until a fresh candidate is approved', async (t) => {
  const f = await fixture('a2a')
  t.after(f.close)
  const published = await f.publish(await f.sync())
  await f.service.releases.moveChannel(actor, f.agent.id, 'stable', published.published_version!, 0)
  const before = await f.g.data.version(actor, f.agent.id, published.published_version!)
  assert.equal(before?.lifecycle, 'published')
  const changed = await f.g.updateSource(actor, f.source!.id, {
    revision: f.source!.revision,
    allowed_user_ids: ['member'],
  })
  assert.equal(changed.last_error, 'SOURCE_REVALIDATION_REQUIRED')
  assert.equal(changed.revision, f.source!.revision + 1)
  assert.equal((await f.g.data.version(actor, f.agent.id, published.published_version!))?.lifecycle, 'deprecated')
  await assert.rejects(f.g.assertVersion(actor, f.agent.id, published.published_version!), { code: 'CATALOG_VERSION_NOT_ACTIVE' })
  const read = new CatalogReadModel(f.g)
  const entry = await read.entry(actor, f.agent.id)
  assert.equal(entry.entry.status, 'deprecated')
  assert.equal(entry.entry.has_drift, true)
  const fresh = await f.g.sync(actor, changed.id, { revision: changed.revision })
  assert.equal(fresh.status, 'succeeded')
  assert.equal((await f.g.data.candidate(actor, fresh.candidate_id!)).view.status, 'draft')
})

void test('partial publication can be quarantined without retry; review renewal creates a separate candidate', async (t) => {
  const f = await fixture()
  t.after(f.close)
  const c = await f.approve(await f.sync())
  const publish = f.service.releases.publish.bind(f.service.releases)
  let calls = 0
  f.service.releases.publish = async (...args) => {
    calls++
    await publish(...args)
    throw new Error('ambiguous')
  }
  const unknown = await f.g.publish(actor, c.id, { revision: c.revision })
  const archived = await f.g.decide(actor, c.id, {
    revision: unknown.revision,
    action: 'abandon',
    note: 'Quarantine unresolved publication',
  })
  assert.equal(archived.status, 'archived')
  await assert.rejects(f.g.reconcile(actor, c.id), {
    code: 'CANDIDATE_STATE_CONFLICT',
  })
  await assert.rejects(
    f.g.assertVersion(actor, f.agent.id, archived.published_version!),
    { code: 'CATALOG_VERSION_NOT_ACTIVE' },
  )
  const fresh = await f.g.sync(actor, f.source!.id, {
    revision: 1,
    renew: true,
    note: 'Start an explicit independent approval',
  })
  assert.notEqual(fresh.candidate_id, c.id)
  assert.equal(fresh.status, 'succeeded')
  assert.equal(
    (await f.g.data.candidate(actor, fresh.candidate_id!)).view.status,
    'draft',
  )
  assert.equal(calls, 1)
  assert.equal(
    (await f.service.releases.list(actor, f.agent.id)).channels.length,
    0,
  )
})

void test('credential rotation, connection mutation and private snapshot corruption invalidate approval', async (t) => {
  const f = await fixture()
  t.after(f.close)
  const approved = await f.approve(await f.sync())
  f.secretState.version++
  await assert.rejects(
    f.g.publish(actor, approved.id, { revision: approved.revision }),
    { code: 'CANDIDATE_VALIDATION_STALE' },
  )
  f.secretState.version--
  const binding = await f.service.store.binding(actor, f.agent.id),
    connection = await f.options.identities.getIntegrationConnection(
      binding.connectionId,
    )
  await f.options.identities.putIntegrationConnection({
    ...connection!,
    config: { ...connection!.config, tenantId: 'changed' },
  })
  await assert.rejects(
    f.g.publish(actor, approved.id, { revision: approved.revision }),
    { code: 'CONNECTION_DISABLED_OR_CHANGED' },
  )
  await f.options.identities.putIntegrationConnection(connection!)
  const record = await f.g.data.candidate(actor, approved.id)
  record.binding.allowed_user_ids = ['someone-else']
  await f.g.data.saveCandidate(record)
  await assert.rejects(
    f.g.publish(actor, approved.id, { revision: approved.revision }),
    { code: 'CANDIDATE_VALIDATION_STALE' },
  )
  assert.equal(
    (await f.service.releases.list(actor, f.agent.id)).items.length,
    0,
  )
})

void test('historical dispatch provenance survives source edits; old evidence profile stays compatible', async (t) => {
  const f = await fixture('a2a')
  t.after(f.close)
  const c = await f.publish(await f.sync())
  await f.service.releases.moveChannel(
    actor,
    f.agent.id,
    'stable',
    c.published_version!,
    0,
  )
  const member = { ...actor, userId: 'member' }
  const task = await f.service.create(
    member,
    syntheticTaskSubmission({
      agent_id: f.agent.id,
      query: '6 * 7',
      idempotency_key: randomUUID(),
    }),
  )
  await f.service.waitForTask(task.id)
  const before = await f.service.evidence(member, task.id)
  assert.equal(before.provenance?.candidate_id, c.id)
  assert.equal(before.provenance?.protocol, 'a2a/0.3.0')
  const route = `/api/v1/tasks/${task.id}/evidence`
  const old = await dispatchExternalProvider(
    f.service,
    member,
    'GET',
    new URL('http://localhost' + route),
    undefined,
    () => {},
  )
  assert(!JSON.stringify(old).includes('adapter_version'))
  assert(!JSON.stringify(old).includes('provenance'))
  const full = await dispatchExternalProvider(
    f.service,
    member,
    'GET',
    new URL('http://localhost' + route + '?profile=catalog-v1'),
    undefined,
    () => {},
  )
  assert(JSON.stringify(full).includes('provenance'))
  await f.g.updateSource(actor, f.source!.id, {
    revision: 1,
    name: 'New source name',
  })
  assert.deepEqual(await f.service.evidence(member, task.id), before)
  const runs = await f.g.runs(actor, f.agent.id)
  assert.equal(runs.items[0].provider_run_id, before.execution?.provider_run_id)
  assert(!JSON.stringify(runs).includes('6 * 7'))
  assert(!JSON.stringify(runs).includes(key))
  await assert.rejects(f.g.runs({ ...actor, orgId: 'foreign' }, f.agent.id), {
    code: 'AGENT_NOT_FOUND',
  })
  await f.g.lifecycle(actor, f.agent.id, {
    version: c.published_version,
    lifecycle: 'deprecated',
    note: 'Retire version',
  })
  const rejected = await f.service.create(
    member,
    syntheticTaskSubmission({
      agent_id: f.agent.id,
      query: '6 * 7',
      idempotency_key: randomUUID(),
    }),
  )
  assert.equal(rejected.status, 'rejected')
  assert.equal(f.server.control.invocations, 1)
})

void test('server filtering spans all pages; audit pagination is newest-first and organization-scoped', async (t) => {
  const f = await fixture()
  t.after(f.close)
  for (let i = 0; i < 65; i++) {
    const event = await f.g.data.audit(
      actor,
      i === 0 ? 'needle.operation' : 'ordinary.operation',
      f.agent.id,
    )
    event.at = 1000 + i
    await f.db.run('UPDATE agent_catalog_audit SET document = ? WHERE id = ?', [
      JSON.stringify(event),
      event.id,
    ])
  }
  const first = await f.g.data.page<{ at: number; id: string }>(actor, 'audit')
  assert.equal(first.items.length, 50)
  assert(first.next_cursor)
  const second = await f.g.data.page<{ at: number; id: string }>(
    actor,
    'audit',
    first.next_cursor!,
  )
  assert(second.items.length > 0)
  assert(first.items.at(-1)!.at >= second.items[0].at)
  assert.equal(
    new Set([...first.items, ...second.items].map((e) => e.id)).size,
    first.items.length + second.items.length,
  )
  const filtered = await f.g.data.page(actor, 'audit', '', '', {
    search: 'needle',
  })
  assert.equal(filtered.items.length, 1)
  assert.equal(
    (await f.g.data.page({ ...actor, orgId: 'other' }, 'audit')).items.length,
    0,
  )
  assert.equal(
    (
      await f.g.data.page(actor, 'sources', '', '', {
        protocol: 'agent-http.sudo.dev/v1alpha1',
        status: 'enabled',
        owner: actor.userId,
      })
    ).items.length,
    1,
  )
  await f.sync()
  assert.equal(
    (
      await f.g.data.page(actor, 'sources', '', '', {
        warning: 'true',
        observability: 'partial',
      })
    ).items.length,
    1,
  )
  assert.equal(
    (await f.g.data.page(actor, 'candidates', '', '', { capability: 'resume' }))
      .items.length,
    0,
  )
  assert.equal(
    (await f.g.data.page(actor, 'audit', '', '', { search: '%' })).items.length,
    0,
  )
})

void test('reusing a provider revision for different content is a conflict and cannot alter the active version', async (t) => {
  const f = await fixture()
  t.after(f.close)
  const published = await f.publish(await f.sync())
  const prior = await f.service.releases.list(actor, f.agent.id)
  f.service.administration.options.httpRequest = async (input, init) => {
    const response = await fetch(input, init)
    if (!String(input).endsWith('/manifest')) return response
    return Response.json({
      ...((await response.json()) as Record<string, unknown>),
      name: 'Changed content under the same revision',
    })
  }
  const result = await f.g.sync(actor, f.source!.id, { revision: 1 })
  assert.equal(result.error, 'SOURCE_REVISION_CONFLICT')
  assert.deepEqual(await f.service.releases.list(actor, f.agent.id), prior)
  assert.equal(
    (await f.g.data.candidate(actor, published.id)).view.status,
    'published',
  )
})

void test('concurrent decisions, publication and channel changes serialize with revision checks', async (t) => {
  const f = await fixture()
  t.after(f.close)
  const draft = await f.sync()
  const pending = await f.g.decide(actor, draft.id, {
    revision: draft.revision,
    action: 'submit',
    note: 'Submit',
  })
  const decisions = await Promise.allSettled(
    [1, 2].map(() =>
      f.g.decide(actor, pending.id, {
        revision: pending.revision,
        action: 'approve',
        note: 'Approve',
        review_days: 1,
      }),
    ),
  )
  assert.equal(decisions.filter((r) => r.status === 'fulfilled').length, 1)
  const approved = (await f.g.data.candidate(actor, pending.id)).view
  const calls = await Promise.allSettled(
    [1, 2].map(() =>
      f.g.publish(actor, approved.id, { revision: approved.revision }),
    ),
  )
  assert(calls.some((r) => r.status === 'fulfilled'))
  const versions = await f.service.releases.list(actor, f.agent.id)
  assert.equal(versions.items.length, 1)
  assert.equal(versions.channels.length, 0)
  const channels = await Promise.allSettled(
    [1, 2].map(() =>
      f.service.releases.moveChannel(
        actor,
        f.agent.id,
        'stable',
        versions.items[0].version,
        0,
      ),
    ),
  )
  assert.equal(channels.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(
    (await f.service.releases.list(actor, f.agent.id)).channels[0].revision,
    1,
  )
})

void test('policy revision invalidates previously validated and approved candidates', async (t) => {
  const f = await fixture()
  t.after(f.close)
  const c = await f.approve(await f.sync()),
    policy = await f.service.administration.policy(actor)
  await f.service.administration.setPolicy(actor, {
    revision: policy.revision,
    enabled: true,
    endpoints: [f.server.endpoint],
  })
  await assert.rejects(f.g.publish(actor, c.id, { revision: c.revision }), {
    code: 'CANDIDATE_VALIDATION_STALE',
  })
  assert.equal(
    (await f.service.releases.list(actor, f.agent.id)).items.length,
    0,
  )
})

void test('provenance retention drains successive batches and preserves non-retired execution facts', async (t) => {
  const f = await fixture()
  t.after(f.close)
  const { maintainRetention, PILOT_RETENTION } = await import('../externalProviders/retention.js')
  const now = Date.now() + 86400_000
  const expired = now - (PILOT_RETENTION.auditDays + 1) * 86400_000
  for (let i = 0; i <= PILOT_RETENTION.batchSize; i++) {
    const id = `retired-${String(i).padStart(4, '0')}`
    await f.g.db.run('INSERT INTO external_pilot_retention(task_id, compacted_at, retired_at) VALUES (?, ?, ?)', [id, expired, expired])
    await f.g.db.run('INSERT INTO agent_task_provenance(task_id, document) VALUES (?, ?)', [id, '{}'])
  }
  await f.g.db.run('INSERT INTO agent_task_provenance(task_id, document) VALUES (?, ?)', ['not-retired', '{}'])
  await maintainRetention(f.service.store, now)
  assert.equal(Number((await f.g.db.get('SELECT COUNT(*) AS count FROM agent_task_provenance'))!.count), 2)
  await maintainRetention(f.service.store, now + 60_001)
  assert.deepEqual((await f.g.db.all('SELECT task_id FROM agent_task_provenance')).map(row => row.task_id), ['not-retired'])
})


void test('Dify catalog governance preserves uploaded definition limitations through actual HTTP execution', async t => {
  const f = await fixture(), dify = await difyReference(); t.after(f.close); t.after(dify.close)
  const policy = await f.service.administration.policy(actor)
  await f.service.administration.setPolicy(actor, { revision: policy.revision, enabled: true, endpoints: [f.server.endpoint, dify.endpoint] })
  const agent = await f.service.onboard(actor, { request_id: randomUUID(), provider_kind: 'dify', endpoint: dify.endpoint, api_key: key,
    app_id: dify.target, workspace_id: 'synthetic', name: 'Dify catalog', source_definition: JSON.stringify(queryOnlyDefinition()), decoder: 'text',
    allowed_user_ids: [actor.userId, 'member'], review_days: 1, review_note: 'Synthetic Dify schema only', catalog_governance: true })
  const source = (await f.g.data.managed(actor, agent.id))!.view
  const synced = await f.g.sync(actor, source.id, { revision: source.revision })
  assert.equal(synced.status, 'succeeded', synced.error ?? '')
  const candidate = (await f.g.data.candidate(actor, synced.candidate_id!)).view
  assert(candidate.validation.warnings.includes('DIFY_REMOTE_PROMPT_NOT_OBSERVABLE'))
  assert.equal(candidate.snapshot.source_revision, null)
  assert.equal(candidate.snapshot.capabilities.version_pin, 'unsupported')
  const published = await f.publish(candidate)
  await f.service.releases.moveChannel(actor, agent.id, 'stable', published.published_version!, 0)
  const member = { ...actor, userId: 'member' }
  const task = await f.service.create(member, syntheticTaskSubmission({ agent_id: agent.id, query: '6 * 7', idempotency_key: randomUUID() }))
  await f.service.waitForTask(task.id)
  assert.equal((await f.service.store.task(member, task.id)).answer, '42')
  assert.equal((await f.service.evidence(member, task.id)).provenance?.protocol, 'dify/chat-messages')
  assert.equal(dify.control.invocations, 1)
})

void test('catalog read model distinguishes approval/publication/stable and is read-only across revocation', async t => {
  const { CatalogReadModel } = await import('./catalogReadModel.js')
  const f = await fixture('a2a'); t.after(f.close)
  const read = new CatalogReadModel(f.g), current = () => read.entry(actor, f.agent.id)
  assert.equal((await current()).entry.status, 'draft')
  let c = await f.sync()
  c = await f.g.decide(actor, c.id, { revision:c.revision, action:'submit', note:'Review' })
  assert.equal((await current()).entry.status,'pending_approval')
  c = await f.g.decide(actor, c.id, { revision:c.revision, action:'approve', note:'Review', review_days:1 })
  assert.equal((await current()).entry.status,'approved')
  assert.equal((await f.service.releases.list(actor,f.agent.id)).items.length,0)
  c = await f.g.publish(actor,c.id,{revision:c.revision})
  const version = c.published_version!
  assert.equal((await current()).entry.status,'published')
  await f.service.releases.moveChannel(actor,f.agent.id,'canary',version,0)
  assert.equal((await current()).entry.is_selectable,false,'canary is not the default member selection')
  await f.service.releases.moveChannel(actor,f.agent.id,'stable',version,0)
  const active = await current()
  assert.equal(active.entry.status,'active'); assert.equal(active.entry.is_selectable,true)
  assert.equal(active.entry.provider,'a2a')
  assert.equal(active.versions[0].source_revision,c.snapshot.source_revision)
  assert.equal(active.versions[0].adapter_version,c.snapshot.adapter_version)
  assert.equal(active.versions[0].source_identity,'unverified')
  // Administrator need not be personally in the conversation grant list.
  assert.equal((await read.entry({...actor,userId:'another-admin'},f.agent.id)).entry.is_selectable,true)
  await assert.rejects(read.entry({...actor,orgId:'foreign'},f.agent.id),{code:'AGENT_NOT_FOUND'})
  await f.service.releases.revoke(actor,f.agent.id,version,'Synthetic revocation')
  const revoked = await current()
  assert.equal(revoked.entry.status,'revoked');assert.equal(revoked.entry.is_selectable,false)
  assert.equal(revoked.versions[0].revoke_reason,'Synthetic revocation');assert.equal(revoked.versions[0].can_promote,false)
  assert.equal((await f.service.releases.list(actor,f.agent.id)).items.length,1)
  assert.equal((await f.service.releases.list(actor,f.agent.id)).channels.every(c=>!c.enabled),true)
})

void test('catalog availability and filters follow source/authority gates, preserving immutable provenance', async t => {
  const { CatalogReadModel } = await import('./catalogReadModel.js')
  const f=await fixture('openai');t.after(f.close)
  const c=await f.publish(await f.sync()),version=c.published_version!,read=new CatalogReadModel(f.g)
  await f.service.releases.moveChannel(actor,f.agent.id,'stable',version,0)
  const task=await f.service.create({...actor,userId:'member'},syntheticTaskSubmission({agent_id:f.agent.id,query:'6 * 7',idempotency_key:randomUUID()}))
  await f.service.waitForTask(task.id)
  assert.ok((await read.entry(actor,f.agent.id)).entry.last_run_at)
  assert.equal((await read.page(actor,'',{provider:'openai_compatible',status:'active',approval_status:'approved',zone:'unassigned',execution_mode:'external_hosted'})).items.length,1)
  assert.equal((await read.page(actor,'',{provider:'a2a'})).items.length,0)
  assert.equal((await read.page(actor,'',{approval_status:'revoked'})).items.length,0)
  const s=(await f.g.data.source(actor,f.source!.id)).view
  await f.g.updateSource(actor,s.id,{revision:s.revision,enabled:false})
  const disabled=await read.entry(actor,f.agent.id)
  assert.equal(disabled.entry.status,'unavailable');assert.equal(disabled.entry.is_selectable,false)
  assert.equal(disabled.versions[0].adapter_version,c.snapshot.adapter_version)
  assert.equal((await read.page(actor,'',{source_state:'disabled',status:'unavailable'})).items.length,1)
  const original=f.service.releases.list.bind(f.service.releases)
  f.service.releases.list=async()=>{throw new Error('authority offline')}
  const failed=await read.entry(actor,f.agent.id)
  assert.equal(failed.entry.is_selectable,false);assert.equal(failed.entry.admission_error,'CATALOG_READ_UNAVAILABLE')
  f.service.releases.list=original
})

void test('admin normalized events are paginated, organization/agent scoped and omit business payloads', async t => {
  const { dispatchCatalogGovernance }=await import('./catalogRoutes.js')
  const f=await fixture('a2a');t.after(f.close)
  const c=await f.publish(await f.sync())
  await f.service.releases.moveChannel(actor,f.agent.id,'stable',c.published_version!,0)
  const task=await f.service.create({...actor,userId:'member'},syntheticTaskSubmission({agent_id:f.agent.id,query:'private input marker',idempotency_key:randomUUID()}))
  await f.service.waitForTask(task.id)
  const url=new URL(`http://test/api/v1/external-agents/admin/catalog/agents/${f.agent.id}/runs/${task.id}/events`)
  const page=await dispatchCatalogGovernance(f.g,actor,'GET',url,null) as {events:{sequence:number;at:number;status:string}[];next_cursor:number;has_more:boolean}
  assert.ok(page.events.length>0)
  assert.ok(page.events.every(e=>Number.isSafeInteger(e.at)&&e.at>0))
  assert.equal(page.events.at(-1)?.status,'succeeded')
  assert.ok(!JSON.stringify(page).includes('private input marker'))
  assert.ok(page.events.every(e => !Object.hasOwn(e, 'answer') && !Object.hasOwn(e, 'delta') && !Object.hasOwn(e, 'state')))
  assert.ok(!JSON.stringify(page).includes(key))
  assert.deepEqual(Object.keys(page.events[0]).sort(),['at','error_code','sequence','status','type'])
  url.searchParams.set('cursor',String(page.next_cursor))
  assert.equal((await dispatchCatalogGovernance(f.g,actor,'GET',url,null) as typeof page).events.length,0)
  url.searchParams.set('cursor','-1')
  await assert.rejects(dispatchCatalogGovernance(f.g,actor,'GET',url,null),{code:'INVALID_CURSOR'})
  await assert.rejects(dispatchCatalogGovernance(f.g,{...actor,orgId:'foreign'},'GET',url,null),{code:'AGENT_NOT_FOUND'})
  url.pathname=url.pathname.replace(task.id,randomUUID());url.searchParams.delete('cursor')
  await assert.rejects(dispatchCatalogGovernance(f.g,actor,'GET',url,null),{code:'TASK_NOT_FOUND'})
})

void test('catalog scan cursor survives an empty filtered page',async t=>{
  const { CatalogReadModel }=await import('./catalogReadModel.js')
  const f=await fixture();t.after(f.close)
  const read=new CatalogReadModel(f.g),source=f.source!
  const entry=(await read.entry(actor,f.agent.id)).entry
  // Test cursor semantics independently of release I/O for a page beyond 50 sources.
  f.g.data.page=async(_actor,_kind,after)=>({api_version:'agent-catalog.sudo.dev/v1alpha1',items:[source] as never[],next_cursor:after?null:'next-source-page'})
  let calls=0
  read.entry=async()=>({entry:{...entry,provider:++calls===1?'dify':'a2a'},versions:[]})
  const first=await read.page(actor,'',{provider:'a2a'})
  assert.equal(first.items.length,0);assert.equal(first.next_cursor,'next-source-page')
  const next=await read.page(actor,first.next_cursor!,{provider:'a2a'})
  assert.equal(next.items.length,1);assert.equal(next.next_cursor,null)
})
