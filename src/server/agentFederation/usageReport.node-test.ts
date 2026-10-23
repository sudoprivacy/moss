import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { PgDriver, SqliteDriver, type DbDriver, type PgPoolLike } from '../db/driver.js'
import { AgentUsageReports, projectAgentUsage, usageWindow } from './usageReport.js'
import { ExecutionModelGateway, type ExecutionModelCall } from './executionModelGateway.js'
import { AgentInventoryService } from './inventoryService.js'
import { dispatchAgentInventory } from './inventoryRoutes.js'
import type { AuthContext } from '../auth/token.js'

const hash = `sha256:${'a'.repeat(64)}`, otherHash = `sha256:${'b'.repeat(64)}`
const window = { from: 100_000, to: 200_000, mode: 'run' as const }
function call(id = 'call-a', authority = hash): ExecutionModelCall {
  return { id, callId: id, orgId: 'org-a', assetId: 'asset-a', taskId: 'task-a', grantId: 'grant-a', specDigest: hash,
    ownerUserId: 'owner-a', departmentId: 'dept-a', resource: 'model-a', model: 'test-model', mode: 'run', status: 'completed',
    createdAt: 110_000, updatedAt: 111_000, grantExpiresAt: 120_000, tokenCleanupPending: false,
    routerAuthorityId: authority, attribution: { metadataDigest: hash, sourcePlatform: 'dify', assetName: 'Original name' },
    routerToken: { id: 1, accountId: 1, name: 'private-token-metadata', model: 'test-model', expiresAt: 120_000, quotaLimit: 100 },
    answer: 'private answer must not be exported', ledgerStatus: 'router_verified', consumption: [
      { id: 1, tokenId: 1, accountId: 1, createdAt: 111, model: 'test-model', quota: 7, promptTokens: 3, completionTokens: 1 }] }
}
void test('usage: exact ledger identity de-duplicates entries; authorities and accounts remain separate', () => {
  const a = call(), b = call('call-b', otherHash), c = call('call-c')
  a.consumption.push({ ...a.consumption[0] })
  c.routerToken!.accountId = 2; c.consumption[0].accountId = 2
  const report = projectAgentUsage('org-a', window, [a, b, c])
  assert.equal(report.status, 'verified'); assert.equal(report.calls.length, 3)
  assert.equal(report.authorities.length, 2); assert.equal(report.authorities[0].verified_quota, 14)
  assert.equal(report.authorities[1].verified_quota, 7); assert.equal(report.groups.length, 2)
  assert.equal(report.calls[0].entries.length, 1)
  assert.doesNotMatch(JSON.stringify(report), /private answer|private-token|quotaLimit|specDigest|grantId|Bearer/)
})
void test('usage: pending, unknown, missing historical attribution and no dispatch stay distinct', () => {
  const pending = call(); pending.status = 'unknown'; pending.ledgerStatus = 'pending'; pending.consumption = []
  const legacy = call('legacy'); delete legacy.routerAuthorityId; delete legacy.attribution
  const rejected = call('rejected'); delete rejected.routerToken; rejected.status = 'rejected'; rejected.consumption = []
  const report = projectAgentUsage('org-a', window, [pending, legacy, rejected])
  assert.equal(report.status, 'partial')
  assert.equal(report.calls[0].ledger_status, 'pending'); assert.equal(report.calls[1].platform, null)
  assert.equal(report.calls[1].entries.length, 0); assert.equal(report.calls[2].ledger_status, 'not_invoked')
  assert.equal(report.authorities.reduce((n, t) => n + t.pending_calls, 0), 2)
  assert.equal(report.authorities.reduce((n, t) => n + t.verified_quota, 0), 0)
  assert.equal(projectAgentUsage('org-a', window, []).status, 'no_records')
})
void test('usage: interval is half-open by Router timestamp; overlapping calls and evaluation are not silently lost', () => {
  const a = call(); a.createdAt = 99_000; a.consumption[0].createdAt = 100
  const b = call('b'); b.routerToken!.id = 2; b.consumption[0] = { ...b.consumption[0], id: 2, tokenId: 2, createdAt: 200 }
  const evaluation = call('eval'); evaluation.mode = 'evaluation'
  const report = projectAgentUsage('org-a', window, [a, b, evaluation])
  assert.equal(report.authorities[0].verified_quota, 7); assert.equal(report.calls.length, 2)
  assert.equal(report.calls[1].entries.length, 0)
  assert.equal(projectAgentUsage('org-a', { ...window, mode: 'evaluation' }, [a, evaluation]).calls[0].id, 'eval')
  const later = { from: 200_000, to: 210_000, mode: 'run' as const }
  assert.equal(projectAgentUsage('org-a', later, [b]).authorities[0].verified_quota, 7)
})
void test('usage: rejects organization, token, ledger, time, identity conflicts and numeric overflow', () => {
  for (const mutate of [
    (a: ExecutionModelCall) => { a.orgId = 'org-b' },
    (a: ExecutionModelCall) => { a.consumption[0].tokenId = 2 },
    (a: ExecutionModelCall) => { a.consumption[0].model = 'other' },
    (a: ExecutionModelCall) => { a.consumption[0].createdAt = 500 },
    (a: ExecutionModelCall) => { a.consumption[0].quota = -1 },
    (a: ExecutionModelCall) => { a.consumption.push({ ...a.consumption[0], quota: 88 }) },
  ]) { const a = call(); mutate(a); assert.throws(() => projectAgentUsage('org-a', window, [a]), { code: 'AGENT_USAGE_EVIDENCE_INVALID' }) }
  assert.throws(() => projectAgentUsage('org-a', window, [call(), call('different-call')]), { code: 'AGENT_USAGE_EVIDENCE_INVALID' })
  assert.throws(() => projectAgentUsage('org-a', window, [call(), call()]), { code: 'AGENT_USAGE_EVIDENCE_INVALID' })
  const a = call(); a.consumption[0].quota = Number.MAX_SAFE_INTEGER
  a.consumption.push({ ...a.consumption[0], id: 2, quota: 1 })
  assert.throws(() => projectAgentUsage('org-a', window, [a]), { code: 'AGENT_USAGE_EVIDENCE_INVALID' })
})
void test('usage: validates duration, mode and duplicate/unknown selectors', () => {
  assert.deepEqual(usageWindow(new URLSearchParams('from=100000&to=200000')), window)
  for (const value of ['from=1&to=200000', 'from=100000&to=100000', 'from=100000&to=999999999999', 'from=x&to=200000',
    'from=100000&to=200000&orgId=other', 'from=100000&to=200000&mode=other', 'from=100000&to=200000&from=100000'])
    assert.throws(() => usageWindow(new URLSearchParams(value)), { code: 'INVALID_USAGE_WINDOW' })
})

async function persistence(db: DbDriver) {
  const gateway = new ExecutionModelGateway(db, { scope: () => ({ zoneId: 'zone-a', trustDomain: 'agents.example' }), executionAuthorize: async () => { throw new Error('GET must not call IAM') } }, [])
  await gateway.ready
  const values = [call(), { ...call('foreign'), orgId: 'org-b' }, { ...call('outside'), createdAt: 999_000, grantExpiresAt: 999_999 },
    { ...call('evaluation'), mode: 'evaluation' as const }]
  for (const c of values) await db.run('INSERT INTO agent_model_calls(id,org_id,call_id,grant_id,request_digest,document) VALUES (?,?,?,?,?,?)', [c.id, c.orgId, c.callId, c.grantId, hash, JSON.stringify(c)])
  let writes = 0
  const readOnly = new Proxy(db, { get(target, key) {
    if (['run', 'exec', 'transaction'].includes(String(key))) return () => { writes++; throw new Error('report mutated state') }
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
  } })
  const report = await new AgentUsageReports(readOnly, Promise.resolve()).read('org-a', window)
  assert.equal(report.calls.length, 1); assert.equal(report.authorities[0].verified_quota, 7); assert.equal(writes, 0)
  assert.equal((await new AgentUsageReports(db, Promise.resolve()).read('org-b', window)).calls[0].id, 'foreign')
  await db.run("DELETE FROM agent_model_calls WHERE id = 'call-a'")
  for (let i = 0; i <= 2000; i++) {
    const c = call(`large-${i}`)
    await db.run('INSERT INTO agent_model_calls(id,org_id,call_id,grant_id,request_digest,document) VALUES (?,?,?,?,?,?)', [c.id, c.orgId, c.callId, c.grantId, hash, JSON.stringify(c)])
  }
  await assert.rejects(new AgentUsageReports(db, Promise.resolve()).read('org-a', window), { code: 'AGENT_USAGE_REPORT_LIMIT' })
}
void test('usage: real SQLite read is tenant-scoped, bounded and has no side effects', async t => {
  const db = new SqliteDriver(new DatabaseSync(':memory:')); t.after(() => db.close()); await persistence(db)
})
void test('usage: real PostgreSQL has the same reporting semantics', { skip: !process.env.MOSS_PG_TEST_URL }, async () => {
  const schema = `usage_${randomUUID().replaceAll('-', '')}`, root = new pg.Pool({ connectionString: process.env.MOSS_PG_TEST_URL })
  await root.query(`CREATE SCHEMA ${schema}`)
  const pool = new pg.Pool({ connectionString: process.env.MOSS_PG_TEST_URL, options: `-c search_path=${schema}` })
  try { await persistence(new PgDriver(pool as unknown as PgPoolLike)) }
  finally { await pool.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end() }
})
void test('usage route: ordinary users are rejected before data lookup; admin scope selects current organization', async () => {
  let managed = false, org = '', reads = 0
  const service = new AgentInventoryService({ authorize: async () => ({ canManage: managed }),
    registry: { scope: () => ({ zoneId: 'zone-a' }) } as never,
    usage: { read: async (id: string) => { org = id; reads++; return projectAgentUsage(id, window, []) } } as never,
    labels: async () => ({ users: new Map(), departments: new Map() }), catalog: {} as never, member: async () => null, members: async () => [] })
  const actor = { orgId: 'org-a', userId: 'user-a' } as AuthContext
  const url = new URL('http://localhost/api/v1/agent-inventory/usage?from=100000&to=200000')
  assert.equal((await dispatchAgentInventory(service, actor, 'GET', url, null)).status, 403); assert.equal(reads, 0)
  managed = true
  assert.equal((await dispatchAgentInventory(service, actor, 'GET', url, null)).status, 200); assert.equal(org, actor.orgId)
  assert.equal((await dispatchAgentInventory(service, actor, 'POST', url, {})).status, 404)
  url.searchParams.set('org_id', 'org-b')
  assert.equal((await dispatchAgentInventory(service, actor, 'GET', url, null)).status, 400); assert.equal(reads, 1)
})
