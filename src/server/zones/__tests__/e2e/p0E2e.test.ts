// Runs under Node (`tsx --test`) — spawns REAL processes (nexus full-profile +
// moss server). Serial only (spec `-n 0` semantics; parallel spawns race on
// reserved port ranges, observed on Windows).
//
// ⚠ 必须整套运行（`node scripts/test-server.js` 或无过滤的 `npx tsx --test
// 本文件`）。场景间存在状态依赖（nexus 在场景 3 启动、moss 在场景 3 重启、
// orgAAdminToken/userA 在场景 4 设置）——用 `--test-name-pattern` 单跑后续
// 场景会拿到空 token/未初始化状态，产生误导性 401/404（曾误诊为回归）。
//
// SW-20260915-002-MOSS §11.3 real-process P0 E2E — moss 侧场景：
//   1  创建 Org，产生一个 pending default binding（Nexus 离线时也成立）
//   3  binding active（Nexus 上线后 reconciler 收敛，exactly-once）
//   4  普通用户以自身短期 delegation 写/读本 Org Zone；他 Org 用户不能
//   5  同一 Org 绑定第二个 Zone（管理面 addBinding）
//   6  同一 Zone grant 给第二个 Org
//   8  Membership suspend 后旧 delegation 的下一次访问拒绝
//   11 Org rename 不改变 Zone ID
//   12 detach 只撤销访问，不删除数据（Zone 在 Nexus 侧仍存在）
//   13 suspend 阻止新 mutation/runtime，resume 恢复
//   18 响应丢失后同幂等键 replay
import { before, after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  freePort, login, mintNexusUserKey, mossApi, nexusApi, sleep, startMoss, startNexus,
  zonesE2eEnvReady,
  type MossProcess, type NexusProcess,
} from './p0Harness.js'
import { startNexusFaultProxy, type NexusFaultProxy } from './nexusFaultProxy.js'

let moss: MossProcess
let nexus: NexusProcess | null = null
let nexusProxy: NexusFaultProxy | null = null
let adminToken = ''
const tmp = mkdtempSync(join(tmpdir(), 'moss-p0-e2e-'))
const internalApiToken = randomUUID()
let mossPort = 0

async function startMossForP0(
  directory: string,
  input: Parameters<typeof startMoss>[1],
): Promise<MossProcess> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await startMoss(directory, input) }
    catch (error) {
      if (attempt === 3 || !String(error).includes('nexusd-cluster 0.1.6 not found')) throw error
    }
  }
  throw new Error('unreachable')
}

// H-1：环境自检放在 describe 的 { skip } 选项上——钩子随用例一起跳过，
// CI / 无 nexus checkout 的机器整套 skip 而非 before() 里 spawn 失败。
const e2eEnv = zonesE2eEnvReady()

async function createOrg(name: string): Promise<string> {
  const { status, json } = await mossApi(moss, adminToken, 'POST', '/api/v1/organizations', { name })
  assert.equal(status, 200, `create org failed: ${JSON.stringify(json)}`)
  const org = (json as { id?: string }).id ?? ((json as { organization?: { id?: string } }).organization?.id)
  assert.ok(org, `org id missing: ${JSON.stringify(json)}`)
  return org
}

async function bindings(): Promise<Array<Record<string, unknown>>> {
  const { status, json } = await mossApi(moss, adminToken, 'GET', '/api/v1/zones/bindings')
  assert.equal(status, 200)
  return (json as { bindings: Array<Record<string, unknown>> }).bindings
}

async function waitBindingActive(orgId: string, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = (await bindings()).find((b) => b.org_id === orgId && b.is_default === true)
    if (row && row.sync_status === 'active') return row
    if (Date.now() > deadline) {
      throw new Error(`binding for ${orgId} not active within ${timeoutMs}ms (last: ${JSON.stringify(row)})`)
    }
    await sleep(3_000)
  }
}

/** nexus 铸 delegation 的 membership 回查要求 version 精确等于 moss 当前
 * revision（与 delegationService.ts 的 `r${revision}` 同构）——测试直读
 * moss.db 取真值，不假设场景执行顺序带来的具体数值。 */
function currentMembershipVersion(userId: string): string {
  const sqlite = new DatabaseSync(join(tmp, 'mosshome', 'server', 'moss.db'), { readOnly: true })
  try {
    const row = sqlite.prepare(
      `SELECT membership_revision FROM users WHERE id = ?`,
    ).get(userId) as { membership_revision: number }
    return `r${Number(row.membership_revision)}`
  } finally {
    sqlite.close()
  }
}

describe('P0 real-process E2E (moss-side scenarios)', { skip: e2eEnv.ok ? false : `zones E2E environment incomplete: ${e2eEnv.missing.join('; ')}` }, () => {
  let orgA = ''
  let orgB = ''
  let zoneA = ''
  let userA = { id: '', name: 'p0usera', password: 'p0-user-a-12345' }
  let userB = { id: '', name: 'p0userb', password: 'p0-user-b-12345' }
  let delegationA = ''
  let nexusKeyA = ''
  let orgAAdminToken = ''
  let zoneBDefault = ''

  before(async () => {
    // 阶段一：moss 单独起，/v2 未配置（Nexus 离线语义——binding 写入并保持
    // pending，无网络尝试）。阶段二（场景 3）以真实 nexus 地址重启 moss：
    // V2 endpoint 是进程 env，运行期不可变，重启是唯一正确的编排。
    moss = await startMossForP0(tmp, {
      nexusV2BaseUrl: '', nexusServiceToken: '', internalApiToken,
    })
    adminToken = await login(moss, moss.adminUsername, moss.adminPassword)
  })

  after(async () => {
    if (moss) await moss.stop()
    if (nexusProxy) await nexusProxy.stop()
    if (nexus) await nexus.stop()
  })

  it('scenario 1: creating an org leaves a pending default binding while nexus is offline', async () => {
    orgA = await createOrg('P0 E2E Org A')
    const row = (await bindings()).find((b) => b.org_id === orgA)
    assert.ok(row, 'default binding row exists')
    assert.equal(row.desired_state, 'bound')
    // 离线状态下保持 pending（reconciler 无法收敛，不谎报）
    assert.ok(['pending', 'syncing', 'unknown'].includes(String(row.sync_status)), `unexpected sync_status: ${row.sync_status}`)
    assert.match(String(row.zone_id), /^org-[0-9a-f]+$/)
    zoneA = String(row.zone_id)
  })

  it('scenario 3: binding converges to active after nexus comes online (exactly-once)', async () => {
    // moss 以真实 /v2 地址重启（同一 CLAUDE_CONFIG_DIR 数据库——离线期写入
    // 的 binding 行由新实例的 reconciler 收敛）。硬杀跳过了优雅清理，实例
    // 心跳（默认 30s 窗口）滞留会让新实例的 HA 保护拒绝启动——等窗口过期。
    await moss.stop()
    await sleep(35_000)
    mossPort = await freePort()
    nexus = await startNexus(join(tmp, 'nexus'), {
      membershipUrl: `http://127.0.0.1:${mossPort}`,
      internalApiToken,
    })
    nexusProxy = await startNexusFaultProxy(nexus.baseUrl)
    moss = await startMossForP0(tmp, {
      nexusV2BaseUrl: nexusProxy.baseUrl,
      nexusServiceToken: nexus.apiKey,
      port: mossPort,
      internalApiToken,
    })
    adminToken = await login(moss, moss.adminUsername, moss.adminPassword)
    const row = await waitBindingActive(orgA)
    // waitBindingActive 即 reconciler 已 completeProvision——其输入经 grant_id
    // 非空检查（bindingService），active 行的 nexus_grant_id 必为 string
    assert.equal(typeof row.nexus_grant_id, 'string')
    // Nexus 侧确实只有一个 zone（无重复创建）
    const { status, json } = await nexusApi(nexus!, 'GET', `/v2/zones/${encodeURIComponent(zoneA)}`)
    assert.equal(status, 200, `zone should exist on nexus: ${JSON.stringify(json)}`)
  })

  it('scenario 4: org member uses own delegation for zone access; foreign org member is denied', async () => {
    orgB = await createOrg('P0 E2E Org B')
    const orgBBinding = await waitBindingActive(orgB)

    // 两个 org 各建一个普通用户并登录。createUser/updateUser 的 org 均锁定
    // 调用者当前 org（server.ts 明示 never trust body.org_id）——super admin
    // 须先 switchOrg 到目标 org（返回重签的 admin token）。orgA 上下文的
    // token 保存供场景 8 的 suspend 使用。
    for (const [i, org] of [orgA, orgB].entries()) {
      const who = i === 0 ? userA : userB
      const switched = await mossApi(moss, adminToken, 'POST', '/api/v1/auth/switch-org', { org_id: org })
      assert.equal(switched.status, 200, `switch org failed: ${JSON.stringify(switched.json)}`)
      const orgAdminToken = (switched.json as { access_token: string }).access_token
      if (i === 0) orgAAdminToken = orgAdminToken
      const { status, json } = await mossApi(moss, orgAdminToken, 'POST', '/api/v1/users', {
        name: who.name, password: who.password, role: 'user', email: `${who.name}@p0.local`,
      })
      assert.equal(status, 200, `create user failed: ${JSON.stringify(json)}`)
      who.id = (json as { id?: string; user?: { id?: string } }).id ?? (json as { user?: { id?: string } }).user?.id ?? ''
      assert.ok(who.id)
    }

    // nexus 侧为两个 moss 用户各铸 API key（用户自身认证载体，subject 对齐
    // moss userId——delegation 验证要求 user 主体匹配；key 的 zone 绑定目标
    // zone——GET /v2/zones/{id} 的可见性跟随 key 的 zone）
    nexusKeyA = await mintNexusUserKey(nexus!, userA.id, zoneA)
    const nexusKeyB = await mintNexusUserKey(nexus!, userB.id, zoneA)
    const nexusKeyBOwnZone = await mintNexusUserKey(nexus!, userB.id, String(orgBBinding.zone_id))

    // Org A 用户换发自身 delegation（普通用户路径，无 admin credential）
    const tokenA = await login(moss, userA.name, userA.password)
    const forbiddenBindings = await mossApi(moss, tokenA, 'GET', '/api/v1/zones/bindings')
    assert.equal(forbiddenBindings.status, 403)
    const issuedA = await mossApi(moss, tokenA, 'POST', '/api/v1/zones/delegations', {})
    assert.equal(issuedA.status, 201, `delegation issue failed: ${JSON.stringify(issuedA.json)}`)
    delegationA = (issuedA.json as { delegation_id: string }).delegation_id
    assert.ok(delegationA)
    // nexus 侧核对 delegation 绑定（user/org/zone/audience 五要素）
    const detail = await nexusApi(nexus!, 'GET', `/v2/auth/zone-delegations/${delegationA}`)
    assert.equal(detail.status, 200, `delegation detail failed: ${JSON.stringify(detail.json)}`)
    const dv = detail.json as Record<string, unknown>
    assert.equal(dv.user_id, userA.id, `delegation user binding: ${JSON.stringify({ got: dv.user_id, want: userA.id })}`)
    assert.equal(dv.org_id, orgA, `delegation org binding: ${JSON.stringify({ got: dv.org_id, want: orgA, zone: dv.zone_id, wantZone: zoneA, aud: dv.audience })}`)
    assert.equal(dv.zone_id, zoneA, `delegation zone binding: ${JSON.stringify({ got: dv.zone_id })}`)
    assert.equal(dv.audience, 'nexus-api', `delegation audience: ${JSON.stringify({ got: dv.audience })}`)
    const bindingA = (await bindings()).find((row) => row.org_id === orgA && row.is_default === true)
    assert.equal(dv.grant_id, bindingA?.nexus_grant_id)
    const rawZone = await nexusApi(nexus!, 'GET', `/v2/zones/${zoneA}`)
    const rawGrant = await nexusApi(nexus!, 'GET', `/v2/zones/${zoneA}/grants/${bindingA?.nexus_grant_id}`)
    assert.equal(rawGrant.status, 200)
    assert.equal((rawGrant.json as { source?: { source_type?: string } }).source?.source_type, 'moss_org_binding')
    const refreshed = await mossApi(moss, adminToken, 'POST', `/api/v1/zones/bindings/${bindingA?.binding_id}/refresh`)
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.json))
    assert.equal((refreshed.json as { observed_grant_source?: string }).observed_grant_source, 'moss_org_binding', JSON.stringify({ refreshed: refreshed.json, rawZone: rawZone.json, rawGrant: rawGrant.json }))
    assert.equal(dv.purpose, 'data-access')
    assert.deepEqual(dv.scope_rules, [
      { capability: 'zone.data.read', resource_prefixes: ['/'] },
      { capability: 'zone.data.write', resource_prefixes: ['/'] },
    ])

    // 用户自身认证 + delegation 头（zone_security 双要素）访问本 Org Zone → 200
    const own = await fetch(`${nexus!.baseUrl}/v2/zones/${encodeURIComponent(zoneA)}`, {
      headers: { Authorization: `Bearer ${nexusKeyA}`, 'X-Nexus-Zone-Delegation': delegationA },
    })
    assert.equal(own.status, 200, `org A member must access own zone via delegation: ${await own.text()}`)

    // Org B 用户的（对 B 的）delegation 访问 Org A 的 Zone → 拒绝
    const tokenB = await login(moss, userB.name, userB.password)
    const issuedB = await mossApi(moss, tokenB, 'POST', '/api/v1/zones/delegations', {})
    assert.equal(issuedB.status, 201, `delegation issue B failed: ${JSON.stringify(issuedB.json)}`)
    const delegationB = (issuedB.json as { delegation_id: string }).delegation_id
    const foreign = await fetch(`${nexus!.baseUrl}/v2/zones/${encodeURIComponent(zoneA)}`, {
      headers: { Authorization: `Bearer ${nexusKeyB}`, 'X-Nexus-Zone-Delegation': delegationB },
    })
    assert.ok([403, 404].includes(foreign.status), `org B member must be denied on org A zone, got ${foreign.status}`)

    const sessionId = `moss-p0-user-record-${randomUUID()}`
    const session = await nexusApi(nexus!, 'POST', '/v2/sessions', { session_id: sessionId, home_zone_id: zoneA })
    assert.equal(session.status, 201, JSON.stringify(session.json))
    const recordBody = { record_kind: 'context', data: '{"moss":"zone-a-write-read"}' }
    const recordPath = `/v2/sessions/${sessionId}/records`
    const unauthenticatedWrite = await nexusApi(nexus!, 'POST', recordPath, recordBody, { Authorization: `Bearer ${nexusKeyA}` })
    // record write 的拒绝折叠为 404（与读面同形，反枚举 L-8③）——不再回显
    // GRANT_NOT_ACTIVE 原因码
    assert.equal(unauthenticatedWrite.status, 404)
    assert.equal((unauthenticatedWrite.json as { detail?: { code?: string } }).detail?.code, 'SESSION_NOT_FOUND')
    const write = await nexusApi(nexus!, 'POST', recordPath, recordBody, { Authorization: `Bearer ${nexusKeyA}`, 'X-Nexus-Zone-Delegation': delegationA })
    assert.equal(write.status, 201, JSON.stringify(write.json))
    const vfsPath = (write.json as { vfs_path?: string }).vfs_path
    assert.ok(vfsPath)
    const read = await nexusApi(nexus!, 'GET', `/api/v2/files/read?path=${encodeURIComponent(vfsPath)}&zone=${encodeURIComponent(zoneA)}`, undefined, { Authorization: `Bearer ${nexusKeyA}` })
    assert.equal(read.status, 200, JSON.stringify(read.json))
    assert.equal((read.json as { content?: string }).content, recordBody.data)
    const foreignWrite = await nexusApi(nexus!, 'POST', recordPath, recordBody, { Authorization: `Bearer ${nexusKeyB}`, 'X-Nexus-Zone-Delegation': delegationB })
    assert.ok([403, 404].includes(foreignWrite.status), JSON.stringify(foreignWrite.json))
    const foreignRead = await nexusApi(nexus!, 'GET', `/api/v2/files/read?path=${encodeURIComponent(vfsPath)}&zone=${encodeURIComponent(zoneA)}`, undefined, { Authorization: `Bearer ${nexusKeyBOwnZone}` })
    assert.ok([403, 404].includes(foreignRead.status), JSON.stringify(foreignRead.json))
  })

  it('scenario 8: membership lookup is fail-closed across outage and monotonic changes', async () => {
    const nexusDbPath = join(tmp, 'nexus', 'nexus.db')
    const mossDbPath = join(tmp, 'mosshome', 'server', 'moss.db')
    const delegationStatus = (): string => {
      const sqlite = new DatabaseSync(nexusDbPath, { readOnly: true })
      try {
        const row = sqlite.prepare(
          `SELECT status FROM zone_delegations WHERE delegation_id = ?`,
        ).get(delegationA) as { status: string }
        return row.status
      } finally {
        sqlite.close()
      }
    }

    // No membership mutation and no revoke hook: stopping Moss alone must
    // deny through MEMBERSHIP_UNAVAILABLE while the delegation row stays active.
    await moss.stop()
    const unavailable = await fetch(`${nexus!.baseUrl}/v2/zones/${encodeURIComponent(zoneA)}`, {
      headers: { Authorization: `Bearer ${nexusKeyA}`, 'X-Nexus-Zone-Delegation': delegationA },
    })
    assert.equal(unavailable.status, 503, await unavailable.text())
    assert.equal(delegationStatus(), 'active')

    await sleep(35_000)
    moss = await startMossForP0(tmp, {
      nexusV2BaseUrl: nexusProxy!.baseUrl,
      nexusServiceToken: nexus!.apiKey,
      port: mossPort,
      internalApiToken,
    })
    adminToken = await login(moss, moss.adminUsername, moss.adminPassword)
    const switched = await mossApi(moss, adminToken, 'POST', '/api/v1/auth/switch-org', { org_id: orgA })
    assert.equal(switched.status, 200)
    orgAAdminToken = (switched.json as { access_token: string }).access_token

    // Mutate the authoritative row directly so the in-process best-effort
    // revoke hook cannot race the assertion.
    const mossDb = new DatabaseSync(mossDbPath)
    mossDb.prepare(
      `UPDATE users SET status = 'disabled', membership_revision = membership_revision + 1 WHERE id = ?`,
    ).run(userA.id)
    mossDb.close()
    try {
      const inactive = await fetch(`${nexus!.baseUrl}/v2/zones/${encodeURIComponent(zoneA)}`, {
        headers: { Authorization: `Bearer ${nexusKeyA}`, 'X-Nexus-Zone-Delegation': delegationA },
      })
      // zone GET 的权限拒绝折叠为 404（反枚举，与 zone 不存在同形）——
      // fail-closed 语义本身由下方 delegationStatus 断言佐证
      assert.equal(inactive.status, 404, await inactive.text())
      assert.equal(delegationStatus(), 'active')

      const restoreDb = new DatabaseSync(mossDbPath)
      restoreDb.prepare(
        `UPDATE users SET status = 'active', membership_revision = membership_revision + 1 WHERE id = ?`,
      ).run(userA.id)
      restoreDb.close()
      const stale = await fetch(`${nexus!.baseUrl}/v2/zones/${encodeURIComponent(zoneA)}`, {
        headers: { Authorization: `Bearer ${nexusKeyA}`, 'X-Nexus-Zone-Delegation': delegationA },
      })
      assert.equal(stale.status, 404, await stale.text())
      assert.equal(delegationStatus(), 'active')

      const tokenA3 = await login(moss, userA.name, userA.password)
      const reissued = await mossApi(moss, tokenA3, 'POST', '/api/v1/zones/delegations', {})
      assert.equal(reissued.status, 201, `active member must re-issue after restore: ${JSON.stringify(reissued.json)}`)
      delegationA = (reissued.json as { delegation_id: string }).delegation_id
      const restored = await fetch(`${nexus!.baseUrl}/v2/zones/${encodeURIComponent(zoneA)}`, {
        headers: { Authorization: `Bearer ${nexusKeyA}`, 'X-Nexus-Zone-Delegation': delegationA },
      })
      assert.equal(restored.status, 200, await restored.text())
    } finally {
      // 断言中断时 userA 会泄漏为 disabled（后续场景 6/H-1 的 delegation
      // 铸造将全部撞上该泄漏态）；正常路径上方已恢复 active，此条件写
      // 不触发、零影响。
      const cleanup = new DatabaseSync(mossDbPath)
      try {
        cleanup.prepare(
          `UPDATE users SET status = 'active' WHERE id = ? AND status <> 'active'`,
        ).run(userA.id)
      } finally {
        cleanup.close()
      }
    }
  })

  it('scenario 11: renaming the org does not change the zone id', async () => {
    const renamed = await mossApi(moss, adminToken, 'PATCH', `/api/v1/organizations/${orgA}`, {
      name: 'P0 E2E Org A (renamed)',
    })
    assert.equal(renamed.status, 200, `rename failed: ${JSON.stringify(renamed.json)}`)
    const row = (await bindings()).find((b) => b.org_id === orgA && b.is_default === true)
    assert.ok(row)
    assert.equal(row.zone_id, zoneA, 'zone id must be immutable across org rename')
  })

  it('scenario 12: detaching a binding revokes access but keeps zone data', async () => {
    // Org B 的 default binding 解绑
    const row = (await bindings()).find((b) => b.org_id === orgB && b.is_default === true)
    assert.ok(row)
    zoneBDefault = String(row.zone_id)
    const detached = await mossApi(moss, adminToken, 'POST', `/api/v1/zones/bindings/${row.binding_id}/detach`)
    assert.equal(detached.status, 200, `detach failed: ${JSON.stringify(detached.json)}`)

    // 收敛 detached
    const deadline = Date.now() + 120_000
    for (;;) {
      const current = (await bindings()).find((b) => b.binding_id === row.binding_id)
      if (current?.sync_status === 'detached') break
      if (Date.now() > deadline) throw new Error(`binding not detached: ${JSON.stringify(current)}`)
      await sleep(3_000)
    }

    // Zone 数据仍在（Nexus 侧 zone 仍存在、可查询——detach 不删除）
    const zone = await nexusApi(nexus!, 'GET', `/v2/zones/${encodeURIComponent(zoneBDefault)}`)
    assert.equal(zone.status, 200, 'zone must still exist after detach')
  })

  it('scenario 5: a second zone can be bound to the same org (admin surface)', async () => {
    // 先在 Nexus 侧建第二个 Zone（管理动作，走 /v2——被测的是 moss 侧绑定语义）
    const zoneB = `org2nd-${orgA.replaceAll('-', '').slice(0, 16)}`
    const created = await nexusApi(nexus!, 'POST', '/v2/zones', { zone_id: zoneB, display_name: zoneB }, { 'Idempotency-Key': `p0-e2e-zone-${zoneB}` })
    assert.equal(created.status, 202, `zone create failed: ${JSON.stringify(created.json)}`)
    const opId = (created.json as { operation_id: string }).operation_id
    for (let i = 0; i < 60; i++) {
      const op = await nexusApi(nexus!, 'GET', `/v2/zone-operations/${opId}`)
      if ((op.json as { state?: string }).state === 'succeeded') break
      await sleep(1_000)
    }

    const added = await mossApi(moss, adminToken, 'POST', '/api/v1/zones/bindings', {
      org_id: orgA, zone_id: zoneB, purpose: 'shared',
    })
    assert.equal(added.status, 201, `add binding failed: ${JSON.stringify(added.json)}`)
    const bindingId = (added.json as { binding_id: string }).binding_id
    // 收敛 active
    const deadline = Date.now() + 120_000
    for (;;) {
      const row = (await bindings()).find((b) => b.binding_id === bindingId)
      if (row?.sync_status === 'active') break
      if (Date.now() > deadline) throw new Error(`second binding not active: ${JSON.stringify(row)}`)
      await sleep(3_000)
    }
    // 一个 Org 多 Zone：org A 现在有 ≥2 条 bound binding
    const orgABindings = (await bindings()).filter((b) => b.org_id === orgA && b.desired_state === 'bound')
    assert.ok(orgABindings.length >= 2)
  })

  it('scenario 6: one zone can grant a second org without disturbing the first', async () => {
    const added = await mossApi(moss, adminToken, 'POST', '/api/v1/zones/bindings', { org_id: orgB, zone_id: zoneA, purpose: 'shared' })
    assert.equal(added.status, 201, JSON.stringify(added.json))
    const bindingId = (added.json as { binding_id: string }).binding_id
    const deadline = Date.now() + 120_000
    let shared: Record<string, unknown> | undefined
    while (Date.now() < deadline) {
      shared = (await bindings()).find((row) => row.binding_id === bindingId)
      if (shared?.sync_status === 'active') break
      await sleep(3_000)
    }
    assert.equal(shared?.sync_status, 'active', JSON.stringify(shared))
    assert.ok(shared.nexus_grant_id)
    const grant = await nexusApi(nexus!, 'GET', `/v2/zones/${zoneA}/grants/${shared.nexus_grant_id}`)
    assert.equal(grant.status, 200, JSON.stringify(grant.json))
    assert.equal((grant.json as { grantee: { subject_id: string } }).grantee.subject_id, orgB)
    assert.equal((await bindings()).find((row) => row.org_id === orgA && row.is_default === true)?.sync_status, 'active')
    // A new grant advances the authorization epoch; Moss's TTL cache can
    // return a previously issued delegation. Issue a fresh one through the
    // public Nexus boundary to verify the original grant still authorizes A.
    const defaultBinding = (await bindings()).find((row) => row.org_id === orgA && row.is_default === true)
    assert.ok(defaultBinding?.nexus_grant_id)
    const issued = await nexusApi(nexus!, 'POST', '/v2/auth/zone-delegations', {
      user_id: userA.id, org_id: orgA, membership_version: currentMembershipVersion(userA.id), zone_id: zoneA,
      audience: 'nexus-api', ttl_s: 300, grant_id: defaultBinding.nexus_grant_id,
      purpose: 'data-access', scope_rules: [{ capability: 'zone.data.read', resource_prefixes: ['/'] }],
    }, { Authorization: `Bearer ${nexus!.apiKey}`, 'Idempotency-Key': `moss-s6-reissue-${randomUUID()}` })
    assert.equal(issued.status, 201, JSON.stringify(issued.json))
    delegationA = (issued.json as { delegation_id: string }).delegation_id
    const own = await nexusApi(nexus!, 'GET', `/v2/zones/${zoneA}`, undefined, { Authorization: `Bearer ${nexusKeyA}`, 'X-Nexus-Zone-Delegation': delegationA })
    assert.equal(own.status, 200, JSON.stringify(own.json))
    assert.equal((await nexusApi(nexus!, 'GET', `/v2/zones/${zoneA}`)).status, 200)
  })

  it('H-1: deprovision preserves errors and completes a real Nexus deletion', async () => {
    const mismatch = await mossApi(
      moss,
      adminToken,
      'POST',
      `/api/v1/zones/${encodeURIComponent(zoneBDefault)}/deprovision`,
      { confirm_zone_id: 'wrong-zone' },
    )
    assert.equal(mismatch.status, 400)
    assert.deepEqual(mismatch.json, {
      error: {
        code: 'CONFIRM_MISMATCH',
        message: 'confirmation zone id does not match the target zone id',
        retryable: false,
      },
    })

    const blockerSession = await nexusApi(
      nexus!, 'POST', '/v2/sessions', { session_id: 'moss-active-run-blocker', home_zone_id: zoneA },
    )
    assert.equal(blockerSession.status, 201, JSON.stringify(blockerSession.json))
    const bindingA = (await bindings()).find((row) => row.org_id === orgA && row.is_default === true)
    assert.ok(bindingA?.nexus_grant_id)
    const runtimeDelegationResponse = await nexusApi(
      nexus!,
      'POST',
      '/v2/auth/zone-delegations',
      {
        user_id: userA.id,
        org_id: orgA,
        membership_version: currentMembershipVersion(userA.id),
        zone_id: zoneA,
        audience: 'nexus-api',
        ttl_s: 300,
        grant_id: bindingA.nexus_grant_id,
        purpose: 'runtime',
        scope_rules: [{
          capability: 'zone.runtime.execute',
          resource_prefixes: ['/sessions/moss-active-run-blocker'],
        }],
      },
      {
        Authorization: `Bearer ${nexus!.apiKey}`,
        'Idempotency-Key': 'moss-active-run-blocker-delegation',
      },
    )
    assert.equal(runtimeDelegationResponse.status, 201, JSON.stringify(runtimeDelegationResponse.json))
    const runtimeDelegation = (runtimeDelegationResponse.json as { delegation_id: string }).delegation_id
    const blockerRun = await nexusApi(
      nexus!,
      'POST',
      '/v2/runtime/start',
      {
        pid: 'moss-active-run-blocker-pid',
        session_id: 'moss-active-run-blocker',
        delegation_ref: runtimeDelegation,
      },
      {
        Authorization: `Bearer ${nexusKeyA}`,
        'X-Nexus-Zone-Delegation': runtimeDelegation,
      },
    )
    assert.equal(blockerRun.status, 201, JSON.stringify(blockerRun.json))

    const blocked = await mossApi(
      moss,
      adminToken,
      'POST',
      `/api/v1/zones/${encodeURIComponent(zoneA)}/deprovision`,
      { confirm_zone_id: zoneA },
    )
    assert.equal(blocked.status, 409, `Nexus blocker must remain 409: ${JSON.stringify(blocked.json)}`)
    assert.equal((blocked.json as { error?: { code?: string } }).error?.code, 'ZONE_DELETE_BLOCKED')
    assert.equal((blocked.json as { error?: { retryable?: boolean } }).error?.retryable, false)
    assert.match(String((blocked.json as { error?: { message?: string } }).error?.message), /active runtime/)

    const unavailableZone = 'h1-structured-503'
    nexusProxy!.failNextDeprovision(unavailableZone)
    const unavailable = await mossApi(
      moss,
      adminToken,
      'POST',
      `/api/v1/zones/${unavailableZone}/deprovision`,
      { confirm_zone_id: unavailableZone },
    )
    assert.equal(unavailable.status, 503, `structured Nexus 503 must remain 503: ${JSON.stringify(unavailable.json)}`)
    assert.deepEqual(unavailable.json, {
      error: {
        code: 'ZONE_RUNTIME_UNAVAILABLE',
        message: 'injected Nexus runtime outage',
        retryable: true,
      },
    })

    const accepted = await mossApi(
      moss,
      adminToken,
      'POST',
      `/api/v1/zones/${encodeURIComponent(zoneBDefault)}/deprovision`,
      { confirm_zone_id: zoneBDefault },
    )
    assert.equal(accepted.status, 202, `deprovision failed: ${JSON.stringify(accepted.json)}`)
    const operationId = (accepted.json as { operation_id?: string }).operation_id
    assert.ok(operationId)
    const deadline = Date.now() + 120_000
    let operation: Record<string, unknown> | null = null
    while (Date.now() <= deadline) {
      const current = await nexusApi(nexus!, 'GET', `/v2/zone-operations/${operationId}`)
      assert.equal(current.status, 200, `operation lookup failed: ${JSON.stringify(current.json)}`)
      operation = current.json as Record<string, unknown>
      if (operation.state === 'succeeded') break
      if (operation.state === 'failed') throw new Error(`deprovision operation failed: ${JSON.stringify(operation)}`)
      await sleep(1_000)
    }
    assert.equal(operation?.state, 'succeeded', `deprovision did not finish: ${JSON.stringify(operation)}`)
    const deleted = await nexusApi(nexus!, 'GET', `/v2/zones/${encodeURIComponent(zoneBDefault)}`)
    assert.equal(deleted.status, 200, `deleted zone tombstone missing: ${JSON.stringify(deleted.json)}`)
    assert.equal((deleted.json as { status?: string }).status, 'deleted')
  })

  it('scenario 18: a lost create response replays the same operation under the same key', async () => {
    const priorAttempts = nexusProxy!.zoneCreateAttempts().length
    nexusProxy!.dropNextZoneCreate()
    const orgC = await createOrg('P0 E2E Org C lost response')
    const binding = (await bindings()).find((row) => row.org_id === orgC && row.is_default === true)
    assert.ok(binding)
    const zoneC = String(binding.zone_id)
    const deadline = Date.now() + 150_000
    let settled: Record<string, unknown> | undefined
    while (Date.now() < deadline) {
      settled = (await bindings()).find((row) => row.org_id === orgC && row.is_default === true)
      if (settled?.sync_status === 'active' && nexusProxy!.zoneCreateAttempts().length >= priorAttempts + 2) break
      await sleep(2_000)
    }
    assert.equal(settled?.sync_status, 'active', JSON.stringify(settled))
    const attempts = nexusProxy!.zoneCreateAttempts().slice(priorAttempts).filter((attempt) => attempt.key.includes(String(binding.binding_id)))
    assert.equal(attempts.length, 2, JSON.stringify(attempts))
    assert.ok(attempts[0].key)
    assert.equal(attempts[0].key, attempts[1].key)
    assert.equal(attempts[0].status, 202)
    assert.equal(attempts[1].status, 202)
    assert.ok(attempts[0].operationId)
    assert.equal(attempts[0].operationId, attempts[1].operationId)
    const sqlite = new DatabaseSync(join(tmp, 'nexus', 'nexus.db'), { readOnly: true })
    try {
      const row = sqlite.prepare("SELECT COUNT(*) AS n FROM zone_operations WHERE zone_id = ? AND action = 'create'").get(zoneC) as { n: number }
      assert.equal(row.n, 1)
    } finally { sqlite.close() }
  })

  it('scenario 13: suspend rejects runtime, writes and grants; resume restores them', async () => {
    const adminHeaders = { Authorization: `Bearer ${nexus!.apiKey}` }
    const cancelledBlocker = await nexusApi(nexus!, 'POST', '/v2/runtime/runs/moss-active-run-blocker-pid/cancel', {}, adminHeaders)
    assert.ok([200, 202, 204].includes(cancelledBlocker.status), JSON.stringify(cancelledBlocker.json))

    const sessionId = `moss-suspend-${randomUUID()}`
    const session = await nexusApi(nexus!, 'POST', '/v2/sessions', { session_id: sessionId, home_zone_id: zoneA })
    assert.equal(session.status, 201, JSON.stringify(session.json))
    const defaultBinding = (await bindings()).find((row) => row.org_id === orgA && row.is_default === true)
    assert.ok(defaultBinding?.nexus_grant_id)
    const runtimeDelegationResponse = await nexusApi(nexus!, 'POST', '/v2/auth/zone-delegations', {
      user_id: userA.id, org_id: orgA, membership_version: currentMembershipVersion(userA.id), zone_id: zoneA,
      audience: 'nexus-api', ttl_s: 300, grant_id: defaultBinding.nexus_grant_id,
      purpose: 'runtime', scope_rules: [{ capability: 'zone.runtime.execute', resource_prefixes: [`/sessions/${sessionId}`] }],
    }, { ...adminHeaders, 'Idempotency-Key': `moss-suspend-runtime-${sessionId}` })
    assert.equal(runtimeDelegationResponse.status, 201, JSON.stringify(runtimeDelegationResponse.json))
    const runtimeDelegation = (runtimeDelegationResponse.json as { delegation_id: string }).delegation_id
    const runtimeHeaders = { Authorization: `Bearer ${nexusKeyA}`, 'X-Nexus-Zone-Delegation': runtimeDelegation }
    const runBody = (pid: string) => ({ pid, session_id: sessionId, delegation_ref: runtimeDelegation })
    const firstPid = `moss-suspend-before-${randomUUID()}`
    const before = await nexusApi(nexus!, 'POST', '/v2/runtime/start', runBody(firstPid), runtimeHeaders)
    assert.equal(before.status, 201, JSON.stringify(before.json))
    const cancelled = await nexusApi(nexus!, 'POST', `/v2/runtime/runs/${firstPid}/cancel`, {}, adminHeaders)
    assert.ok([200, 202, 204].includes(cancelled.status), JSON.stringify(cancelled.json))

    const tokenA = await login(moss, userA.name, userA.password)
    const issuedData = await mossApi(moss, tokenA, 'POST', '/api/v1/zones/delegations', {})
    assert.equal(issuedData.status, 201, JSON.stringify(issuedData.json))
    const dataDelegation = (issuedData.json as { delegation_id: string }).delegation_id

    const waitOperation = async (operationId: string) => {
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        const op = await mossApi(moss, adminToken, 'GET', `/api/v1/zones/operations/${operationId}`)
        assert.equal(op.status, 200, JSON.stringify(op.json))
        const value = op.json as { state: string; error: unknown }
        assert.equal(value.error, null)
        if (value.state === 'succeeded') return
        if (value.state === 'failed') throw new Error(`operation failed: ${JSON.stringify(op.json)}`)
        await sleep(1_000)
      }
      throw new Error(`operation ${operationId} timed out`)
    }
    const suspended = await mossApi(moss, adminToken, 'POST', `/api/v1/zones/${zoneA}:suspend`)
    assert.equal(suspended.status, 202, JSON.stringify(suspended.json))
    const suspendOperationId = (suspended.json as { operation_id: string }).operation_id
    await waitOperation(suspendOperationId)
    const zoneSuspended = await nexusApi(nexus!, 'GET', `/v2/zones/${zoneA}`)
    assert.equal((zoneSuspended.json as { status?: string }).status, 'suspended')
    const refreshSuspended = await mossApi(moss, adminToken, 'POST', `/api/v1/zones/bindings/${defaultBinding.binding_id}/refresh`)
    assert.equal(refreshSuspended.status, 200, JSON.stringify(refreshSuspended.json))
    assert.equal((refreshSuspended.json as { observed_zone_status?: string }).observed_zone_status, 'suspended')

    const deniedRun = await nexusApi(nexus!, 'POST', '/v2/runtime/start', runBody(`moss-suspend-denied-${randomUUID()}`), runtimeHeaders)
    // suspended zone 的 runtime 拒绝来自 capability 层的 suspend gate
    // （authz.py 的 ZONE_NOT_ACTIVE Decision → 403），非业务层 409
    assert.equal(deniedRun.status, 403, JSON.stringify(deniedRun.json))
    assert.equal((deniedRun.json as { detail?: { code?: string } }).detail?.code, 'ZONE_NOT_ACTIVE')

    const recordBody = { record_kind: 'context', data: '{"suspended":true}' }
    const staleWrite = await nexusApi(nexus!, 'POST', `/v2/sessions/${sessionId}/records`, recordBody, { Authorization: `Bearer ${nexusKeyA}`, 'X-Nexus-Zone-Delegation': dataDelegation })
    // record write 的拒绝折叠为 404（与读面同形）——GRANT_REVOKED 原因码不再回显
    assert.equal(staleWrite.status, 404, JSON.stringify(staleWrite.json))
    assert.equal((staleWrite.json as { detail?: { code?: string } }).detail?.code, 'SESSION_NOT_FOUND')
    const deniedWrite = await nexusApi(nexus!, 'POST', `/v2/sessions/${sessionId}/records`, recordBody, adminHeaders)
    assert.equal(deniedWrite.status, 409, JSON.stringify(deniedWrite.json))
    assert.equal((deniedWrite.json as { detail?: { code?: string } }).detail?.code, 'ZONE_NOT_ACTIVE')

    const office = await mossApi(moss, adminToken, 'POST', '/api/v1/zones/bindings', { org_id: orgA, zone_id: zoneA, purpose: 'office' })
    assert.equal(office.status, 201, JSON.stringify(office.json))
    const officeId = (office.json as { binding_id: string }).binding_id
    const officeDeadline = Date.now() + 120_000
    let officeRow: Record<string, unknown> | undefined
    while (Date.now() < officeDeadline) {
      officeRow = (await bindings()).find((row) => row.binding_id === officeId)
      if (officeRow?.sync_status === 'sync_failed') break
      await sleep(3_000)
    }
    assert.equal(officeRow?.sync_status, 'sync_failed', JSON.stringify(officeRow))
    assert.ok(officeRow.last_error_code)

    nexusProxy!.failOperationLookup(suspendOperationId)
    const injected = await mossApi(moss, adminToken, 'GET', `/api/v1/zones/operations/${suspendOperationId}`)
    assert.equal(injected.status, 200, JSON.stringify(injected.json))
    assert.deepEqual((injected.json as { error: unknown }).error, {
      code: 'INJECTED_OPERATION_FAILURE', message: 'injected operation lookup failure', retryable: false,
    })

    const resumed = await mossApi(moss, adminToken, 'POST', `/api/v1/zones/${zoneA}:resume`)
    assert.equal(resumed.status, 202, JSON.stringify(resumed.json))
    await waitOperation((resumed.json as { operation_id: string }).operation_id)
    const zoneResumed = await nexusApi(nexus!, 'GET', `/v2/zones/${zoneA}`)
    assert.equal((zoneResumed.json as { status?: string }).status, 'active')
    const restoredWrite = await nexusApi(nexus!, 'POST', `/v2/sessions/${sessionId}/records`, { record_kind: 'context', data: '{"suspended":false}' }, adminHeaders)
    assert.equal(restoredWrite.status, 201, JSON.stringify(restoredWrite.json))
    const restoredRun = await nexusApi(nexus!, 'POST', '/v2/runtime/start', runBody(`moss-suspend-restored-${randomUUID()}`), runtimeHeaders)
    assert.equal(restoredRun.status, 201, JSON.stringify(restoredRun.json))
    const refreshedDefault = await mossApi(moss, adminToken, 'POST', `/api/v1/zones/bindings/${defaultBinding.binding_id}/refresh`)
    assert.equal((refreshedDefault.json as { sync_status?: string }).sync_status, 'active')
    assert.equal((await bindings()).find((row) => row.binding_id === officeId)?.sync_status, 'sync_failed')
    const core = await mossApi(moss, adminToken, 'POST', '/api/v1/zones/bindings', { org_id: orgA, zone_id: zoneA, purpose: 'core' })
    assert.equal(core.status, 201, JSON.stringify(core.json))
    const coreId = (core.json as { binding_id: string }).binding_id
    const coreDeadline = Date.now() + 120_000
    let coreRow: Record<string, unknown> | undefined
    while (Date.now() < coreDeadline) {
      coreRow = (await bindings()).find((row) => row.binding_id === coreId)
      if (coreRow?.sync_status === 'active') break
      await sleep(3_000)
    }
    assert.equal(coreRow?.sync_status, 'active', JSON.stringify(coreRow))
  })

  it('A-2: session creation surfaces home_zone_id; requireZone refuses unbound orgs', async () => {
    // 宽松模式（默认）：无 active binding 的 Org（binding pending）建会话
    // 成功，响应显式携带 home_zone_id:null，审计日志留痕。
    const orgUnbound = await createOrg('P0 E2E Org Unbound')
    const switched = await mossApi(moss, adminToken, 'POST', '/api/v1/auth/switch-org', { org_id: orgUnbound })
    assert.equal(switched.status, 200, JSON.stringify(switched.json))
    const unboundToken = (switched.json as { access_token: string }).access_token
    const created = await mossApi(moss, unboundToken, 'POST', '/api/v1/sessions', {})
    assert.equal(created.status, 200, JSON.stringify(created.json))
    assert.equal((created.json as { home_zone_id?: string | null }).home_zone_id, null)
    const createdSessionId = (created.json as { session_id: string }).session_id

    // 严格模式：MOSS_REQUIRE_ZONE=true 重启 moss，同一 Org 建会话 409
    // （ZONE_REQUIRED，会话行零残留）。
    await moss.stop()
    await sleep(35_000)
    mossPort = await freePort()
    moss = await startMossForP0(tmp, {
      nexusV2BaseUrl: nexusProxy!.baseUrl,
      nexusServiceToken: nexus!.apiKey,
      port: mossPort,
      internalApiToken,
      env: { MOSS_REQUIRE_ZONE: 'true' },
    })
    adminToken = await login(moss, moss.adminUsername, moss.adminPassword)
    const switchedStrict = await mossApi(moss, adminToken, 'POST', '/api/v1/auth/switch-org', { org_id: orgUnbound })
    assert.equal(switchedStrict.status, 200, JSON.stringify(switchedStrict.json))
    const strictToken = (switchedStrict.json as { access_token: string }).access_token
    const refused = await mossApi(moss, strictToken, 'POST', '/api/v1/sessions', {})
    assert.equal(refused.status, 409, JSON.stringify(refused.json))
    assert.match(String((refused.json as { error?: string }).error), /ZONE_REQUIRED/)

    // 会话列表无残留行（严格模式拒绝发生在任何会话行写入之前）。
    // 列表按调用者 Org 上下文过滤（附录边界 4），用切到目标 org 的 token 查。
    const list = await mossApi(moss, strictToken, 'GET', '/api/v1/sessions?active_only=false')
    assert.equal(list.status, 200, JSON.stringify(list.json))
    const sessionsOfOrg = ((list.json as { sessions: Array<{ sessionId: string; orgId: string }> }).sessions)
      .filter((s) => s.orgId === orgUnbound)
    assert.equal(sessionsOfOrg.length, 1, `expected only the lenient-mode session: ${JSON.stringify(sessionsOfOrg)}`)
    assert.equal(sessionsOfOrg[0].sessionId, createdSessionId)
  })
})
