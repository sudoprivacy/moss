// Runs under Node (`tsx --test`). Real nexus full-profile process + the real
// moss SQLite database (opened read/write from the test process against the
// same file moss uses — sqlite WAL allows one writer at a time; the moss
// process is idle during these assertions, so we ARE the writer).
//
// SW-20260915-002-MOSS-RUNTIME-ZONE P1a (§8.10) — bridge-level E2E:
//   R5.1  home zone 由 binding policy 解析；Nexus Session API 权威写入；本地投影
//   R5.2  runner generation 对账（execution zone 固化 + 回读）
//   R5.3  payload zone 提示不能覆盖 policy
//   R5.4  runner delegation 是短期用户 delegation（非 service credential）
//   R5.7  detach → 该 zone 的 run 打成 revocation_pending
//   R5.8  home zone 来自 binding 表，绝非 org_id 字符串
import { before, after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { SqliteDriver } from '../../../db/driver.js'
import { AuthCenterDb } from '../../../authCenter/db.js'
import {
  applyRunnerZoneContext, establishNexusSession, parkRunsForZone, reconcilePendingNexusSessions, reconcileRunnerGeneration,
  resolveHomeZoneWithHint, runnerPid, runnerZoneContext,
} from '../../runtime/sessionZoneBridge.js'
import { NexusZoneClient } from '../../../nexus/nexusZoneClient.js'
import { resolveZoneBindingConfig, type ZoneBindingConfig } from '../../binding/config.js'
import { startNexus, sleep, type NexusProcess } from './p0Harness.js'

const tmp = mkdtempSync(join(tmpdir(), 'moss-p1a-e2e-'))
mkdirSync(join(tmp, 'moss'), { recursive: true })
let nexus: NexusProcess
let client: NexusZoneClient
let driver: SqliteDriver
let raw: DatabaseSync
let authDb: AuthCenterDb
// deployment id 与 AuthCenterDb 的 env-resolved 默认一致（测试进程未设
// MOSS_NEXUS_DEPLOYMENT_ID → 'local'），binding 行与解析必须同源。
let config: ZoneBindingConfig

before(async () => {
  nexus = await startNexus(join(tmp, 'nexus'))
  config = {
    ...resolveZoneBindingConfig(),
    zoneBindingEnabled: true,
    nexusDeploymentId: 'local',
    nexusV2BaseUrl: nexus.baseUrl,
    nexusV2ServiceToken: nexus.apiKey,
  }
  client = new NexusZoneClient({ nexusV2BaseUrl: nexus.baseUrl, nexusV2ServiceToken: nexus.apiKey, nexusV2TimeoutMs: 15_000 })
  // moss 主库 + auth 库（同目录结构；直接建全新实例——桥只依赖表结构）
  raw = new DatabaseSync(join(tmp, 'moss', 'direct-connect.db'))
  driver = new SqliteDriver(raw)
  // 建表：借用 moss 的 schema 初始化——AuthCenterDb 自带；主库 sessions 等表
  // 通过 DirectConnectStore 构造太重，这里按需建最小表集（桥只读写这几张表，
  // 与 db.ts 的 DDL 逐列一致——expand-only 列含于其中）。
  raw.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      transcript_session_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      cwd TEXT NOT NULL,
      runtime_type TEXT NOT NULL,
      docker_image TEXT, docker_mode TEXT, config_dir TEXT, container_name TEXT,
      status TEXT NOT NULL,
      desired_state TEXT NOT NULL,
      current_attempt_id TEXT,
      transcript_path TEXT NOT NULL,
      title TEXT, summary TEXT, assistant_name TEXT, source TEXT, channel_chat_id TEXT, client_metadata TEXT,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      ended_at INTEGER,
      deleted_at INTEGER,
      home_zone_id TEXT,
      home_zone_observed_at TEXT,
      home_zone_observed_revision TEXT,
      home_zone_sync_error TEXT
    );
    CREATE TABLE IF NOT EXISTS session_attempts (
      attempt_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      generation INTEGER NOT NULL,
      backend_type TEXT NOT NULL,
      runtime_state TEXT NOT NULL,
      server_instance_id TEXT,
      runner_pid INTEGER,
      container_name TEXT, attach_path TEXT,
      resume_transcript_session_id TEXT NOT NULL,
      execution_zone_id TEXT,
      started_at INTEGER NOT NULL,
      last_heartbeat_at INTEGER,
      stopped_at INTEGER, exit_code INTEGER, exit_signal TEXT, stop_reason TEXT, error_text TEXT,
      UNIQUE (session_id, generation)
    );
  `)
  // 生产同构：AuthCenterDb 与主库共享同一 sqlite handle（shared-store 形态），
  // 桥函数跨 sessions/users/org_zone_bindings 的查询在同一个 driver 上成立。
  authDb = new AuthCenterDb(raw, join(tmp, 'moss', 'direct-connect.db'))
})

after(async () => {
  raw.close()
  await nexus.stop()
})

describe('P1a session zone bridge (real nexus)', () => {
  const orgId = 'p1aorg-0000-4000-8000-000000000001'
  const otherOrg = 'p1aorg-0000-4000-8000-000000000002'
  let homeZone = ''

  it('R5.8/R5.1: home zone comes from the active binding (never the org_id string) and lands authoritatively in nexus', async () => {
    // moss 侧先建 org（binding 的候选 zone id 由 policy 生成：org-<hex>）
    await authDb.createOrganization(orgId, 'P1a Org', Date.now())
    const bindingRow = await driver.get(
      `SELECT binding_id, zone_id FROM org_zone_bindings WHERE org_id = ? LIMIT 1`, [orgId],
    ) as { binding_id: string; zone_id: string } | undefined
    assert.ok(bindingRow)
    const zoneId = bindingRow.zone_id
    assert.match(zoneId, /^org-[a-z0-9]+$/)
    assert.notEqual(zoneId, orgId, 'R5.8: home zone is never the org_id string')

    // nexus 上建同一 zone + org grant（grant 是 delegation 的前提）
    const created = await client.createZone({ zoneId, displayName: zoneId }, `p1a-e2e-zone-${zoneId}`)
    for (let i = 0; i < 60; i++) {
      const op = await client.getOperation(created.operation_id)
      if (op.state === 'succeeded' || op.state === 'failed') break
      await sleep(1_000)
    }
    const grant = await client.createGrant({
      zoneId,
      grantee: { subject_type: 'organization', subject_id: orgId },
      capabilities: ['zone.data.read', 'zone.data.write', 'zone.runtime.execute'],
      source: { source_type: 'moss_org_binding', source_id: 'p1a-binding' },
      reason: 'p1a e2e',
      policyVersion: 'p1a-e2e',
    }, `p1a-e2e-grant-${zoneId}`)
    for (let i = 0; i < 60; i++) {
      const op = await client.getOperation(grant.operation_id)
      if (op.state === 'succeeded' || op.state === 'failed') break
      await sleep(1_000)
    }
    // binding active（本地 policy 源）
    await driver.run(
      `UPDATE org_zone_bindings SET sync_status = 'active' WHERE binding_id = ?`,
      [bindingRow.binding_id],
    )

    // 桥：binding policy 解析
    const resolution = await resolveHomeZoneWithHint(
      authDb.driver as SqliteDriver, orgId, undefined, config,
    )
    assert.ok(resolution.homeZoneId)
    assert.equal(resolution.homeZoneId, zoneId)
    homeZone = zoneId

    // 无 binding 的 org → null（不是 org_id 兜底）
    await authDb.createOrganization(otherOrg, 'No Binding', Date.now())
    const none = await resolveHomeZoneWithHint(authDb.driver as SqliteDriver, otherOrg, undefined, config)
    assert.equal(none.homeZoneId, null)

    // 权威写入 + 回读（R5.1）
    const sessionId = 'p1a-sess-0001'
    const observed = await establishNexusSession(client, { sessionId, homeZoneId: homeZone })
    assert.ok(observed, 'nexus authoritative write must succeed while nexus is up')
    const authoritative = await client.getSession(sessionId)
    assert.equal(authoritative.home_zone_id, homeZone)

    await driver.run(
      `INSERT INTO sessions (session_id, transcript_session_id, org_id, user_id, role, scopes_json, cwd, runtime_type, status, desired_state, transcript_path, created_at, last_active_at, home_zone_id)
       VALUES (?, ?, ?, 'p1a-projection-user', 'user', '[]', '/tmp', 'host', 'active', 'active', ?, ?, ?, ?)`,
      [sessionId, sessionId, orgId, `/t/${sessionId}.jsonl`, Date.now(), Date.now(), homeZone],
    )
    assert.equal(await reconcilePendingNexusSessions(driver, client), 1)
    const projection = await driver.get(
      `SELECT home_zone_observed_at, home_zone_observed_revision FROM sessions WHERE session_id = ?`,
      [sessionId],
    )
    assert.ok(String(projection?.home_zone_observed_at ?? ''))
    assert.equal(String(projection?.home_zone_observed_revision), authoritative.updated_at)
  })

  it('R5.3: a payload zone hint disagreeing with policy is ignored', async () => {
    const resolution = await resolveHomeZoneWithHint(
      authDb.driver as SqliteDriver, orgId, 'attacker-zone', config,
    )
    assert.equal(resolution.homeZoneId, homeZone)
    assert.equal(resolution.payloadZoneAccepted, false)
    assert.match(resolution.payloadZoneIgnoredReason ?? '', /hint ignored/)

    const matching = await resolveHomeZoneWithHint(
      authDb.driver as SqliteDriver, orgId, homeZone, config,
    )
    assert.equal(matching.homeZoneId, homeZone)
    assert.equal(matching.payloadZoneAccepted, true)
  })

  it('R5.2: runner generation reconciles with the nexus PID descriptor', async () => {
    const sessionId = 'p1a-sess-0002'
    const userId = 'p1a-user-0002'
    const now = Date.now()
    await driver.run(
      `INSERT INTO users (id, org_id, email, name, role, status, local_auth, created_at)
       VALUES (?, ?, ?, 'P1a User 2', 'user', 'active', 1, ?)`,
      [userId, orgId, 'p1a-user-0002@example.test', now],
    )
    await driver.run(
      `INSERT INTO sessions (session_id, transcript_session_id, org_id, user_id, role, scopes_json, cwd, runtime_type, status, desired_state, transcript_path, created_at, last_active_at, home_zone_id)
       VALUES (?, ?, ?, ?, 'user', '[]', '/tmp', 'host', 'active', 'active', ?, ?, ?, ?)`,
      [sessionId, sessionId, orgId, userId, `/t/${sessionId}.jsonl`, now, now, homeZone],
    )
    await establishNexusSession(client, { sessionId, homeZoneId: homeZone })
    const context = await runnerZoneContext(authDb.driver as SqliteDriver, client, { sessionId, config })
    assert.ok(context)
    assert.equal(context.NEXUS_ZONE_ID, homeZone)
    assert.equal(context.NEXUS_V2_BASE_URL, nexus.baseUrl)
    assert.ok(!('MOSS_NEXUS_V2_SERVICE_TOKEN' in context))
    assert.ok(!('NEXUS_API_KEY' in context))
    const sanitized = applyRunnerZoneContext({ MOSS_INTERNAL_API_TOKEN: 'must-not-leak' }, context)
    assert.ok(!('MOSS_INTERNAL_API_TOKEN' in sanitized))
    const attemptId = 'p1a-attempt-0002'
    const reconciled = await reconcileRunnerGeneration(client, {
      attemptId,
      sessionId,
      homeZoneId: homeZone,
      delegationRef: context.NEXUS_DELEGATION_REF,
    })
    assert.ok(reconciled)
    assert.equal(reconciled.executionZoneId, homeZone)
    const readBack = await client.getRuntimeRun(runnerPid(attemptId))
    assert.equal(readBack.execution_zone_id, homeZone)
    assert.equal(readBack.delegation_ref, context.NEXUS_DELEGATION_REF)
    assert.ok(readBack.grant_ref)
    assert.ok(Number.isSafeInteger(readBack.authorization_epoch))

    await assert.rejects(
      reconcileRunnerGeneration(client, {
        attemptId: 'p1a-cross-zone-without-decision',
        sessionId,
        homeZoneId: homeZone,
        executionZoneId: 'different-zone',
        delegationRef: context.NEXUS_DELEGATION_REF,
      }),
      /cross-Zone execution requires decision reason and policy version/,
    )
  })

  it('R5.4: runner zone context carries a short-lived USER delegation, never the service credential', async () => {
    const sessionId = 'p1a-sess-0003'
    const now = Date.now()
    // delegation 的 membership 前提：org 内的 active 用户
    await driver.run(
      `INSERT INTO users (id, org_id, email, name, role, status, local_auth, created_at)
       VALUES ('p1a-user-0003', ?, 'p1a3@x.local', 'p1a3', 'user', 'active', 1, ?)`,
      [orgId, now],
    )
    await driver.run(
      `INSERT INTO sessions (session_id, transcript_session_id, org_id, user_id, role, scopes_json, cwd, runtime_type, status, desired_state, transcript_path, created_at, last_active_at, home_zone_id)
       VALUES (?, ?, ?, ?, 'user', '[]', '/tmp', 'host', 'active', 'active', ?, ?, ?, ?)`,
      [sessionId, sessionId, orgId, 'p1a-user-0003', `/t/${sessionId}.jsonl`, now, now, homeZone],
    )
    const context = await runnerZoneContext(authDb.driver as SqliteDriver, client, {
      sessionId,
      config,
    })
    assert.ok(context, 'zone context must resolve for a homed session')
    assert.equal(context.NEXUS_ZONE_ID, homeZone)
    assert.ok(context.NEXUS_DELEGATION_REF.startsWith('dlg_'), 'runner carries a user delegation ref')
    // delegation ref 是用户 delegation（nexus 侧核对 org 绑定），绝不是 service key
    assert.notEqual(context.NEXUS_DELEGATION_REF, nexus.apiKey)
    assert.notEqual(context.NEXUS_DELEGATION_REF, nexus.adminApiKey)
    const runnerEnv = applyRunnerZoneContext({
      MOSS_NEXUS_V2_SERVICE_TOKEN: nexus.apiKey,
      NEXUS_API_KEY: nexus.adminApiKey,
      SAFE_VALUE: 'kept',
    }, context)
    assert.equal(runnerEnv.SAFE_VALUE, 'kept')
    assert.equal(runnerEnv.NEXUS_DELEGATION_REF, context.NEXUS_DELEGATION_REF)
    assert.equal(runnerEnv.MOSS_NEXUS_V2_SERVICE_TOKEN, undefined)
    assert.equal(runnerEnv.NEXUS_API_KEY, undefined)
  })

  it('R5.7: detaching parks the zone’s active runs in revocation_pending', async () => {
    const sessionId = 'p1a-sess-0004'
    const attemptId = 'p1a-attempt-0004'
    const now = Date.now()
    await driver.run(
      `INSERT INTO users (id, org_id, email, name, role, status, local_auth, created_at)
       VALUES ('u4', ?, 'p1a-u4@example.test', 'P1a User 4', 'user', 'active', 1, ?)`,
      [orgId, now],
    )
    await driver.run(
      `INSERT INTO sessions (session_id, transcript_session_id, org_id, user_id, role, scopes_json, cwd, runtime_type, status, desired_state, transcript_path, created_at, last_active_at, home_zone_id)
       VALUES (?, ?, ?, 'u4', 'user', '[]', '/tmp', 'host', 'active', 'active', ?, ?, ?, ?)`,
      [sessionId, sessionId, orgId, `/t/${sessionId}.jsonl`, now, now, homeZone],
    )
    await driver.run(
      `INSERT INTO session_attempts (attempt_id, session_id, generation, backend_type, runtime_state, resume_transcript_session_id, execution_zone_id, started_at, last_heartbeat_at)
       VALUES (?, ?, 1, 'host', 'running', ?, ?, ?, ?)`,
      [attemptId, sessionId, sessionId, homeZone, now, now],
    )
    await establishNexusSession(client, { sessionId, homeZoneId: homeZone })
    const context = await runnerZoneContext(authDb.driver as SqliteDriver, client, {
      sessionId,
      config,
    })
    assert.ok(context)
    await reconcileRunnerGeneration(client, {
      attemptId,
      sessionId,
      homeZoneId: homeZone,
      delegationRef: context.NEXUS_DELEGATION_REF,
    })

    const parked = await parkRunsForZone(authDb.driver as SqliteDriver, client, homeZone)
    assert.ok(parked >= 1, `expected at least one parked run, got ${parked}`)
    const run = await client.getRuntimeRun(runnerPid(attemptId))
    assert.equal(run.state, 'revocation_pending')
  })
})
