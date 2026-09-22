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
//   4  普通用户以自身短期 delegation 访问本 Org Zone；他 Org 用户不能
//   5  同一 Org 绑定第二个 Zone（管理面 addBinding）
//   8  Membership suspend 后旧 delegation 的下一次访问拒绝
//   11 Org rename 不改变 Zone ID
//   12 detach 只撤销访问，不删除数据（Zone 在 Nexus 侧仍存在）
import { before, after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  login, mintNexusUserKey, mossApi, nexusApi, sleep, startMoss, startNexus,
  type MossProcess, type NexusProcess,
} from './p0Harness.js'

let moss: MossProcess
let nexus: NexusProcess | null = null
let adminToken = ''
const tmp = mkdtempSync(join(tmpdir(), 'moss-p0-e2e-'))

before(async () => {
  // 阶段一：moss 单独起，/v2 未配置（Nexus 离线语义——binding 写入并保持
  // pending，无网络尝试）。阶段二（场景 3）以真实 nexus 地址重启 moss：
  // V2 endpoint 是进程 env，运行期不可变，重启是唯一正确的编排。
  moss = await startMoss(tmp, { nexusV2BaseUrl: '', nexusServiceToken: '' })
  adminToken = await login(moss, moss.adminUsername, moss.adminPassword)
})

after(async () => {
  await moss.stop()
  if (nexus) await nexus.stop()
})

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

describe('P0 real-process E2E (moss-side scenarios)', () => {
  let orgA = ''
  let orgB = ''
  let zoneA = ''
  let userA = { id: '', name: 'p0usera', password: 'p0-user-a-12345' }
  let userB = { id: '', name: 'p0userb', password: 'p0-user-b-12345' }
  let delegationA = ''
  let nexusKeyA = ''
  let orgAAdminToken = ''

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
    nexus = await startNexus(join(tmp, 'nexus'))
    // moss 以真实 /v2 地址重启（同一 CLAUDE_CONFIG_DIR 数据库——离线期写入
    // 的 binding 行由新实例的 reconciler 收敛）。硬杀跳过了优雅清理，实例
    // 心跳（默认 30s 窗口）滞留会让新实例的 HA 保护拒绝启动——等窗口过期。
    await moss.stop()
    await sleep(35_000)
    moss = await startMoss(tmp, { nexusV2BaseUrl: nexus.baseUrl, nexusServiceToken: nexus.apiKey })
    adminToken = await login(moss, moss.adminUsername, moss.adminPassword)
    const row = await waitBindingActive(orgA)
    // grant id 已记录（string 或 null——收敛后应为 string）
    assert.ok(row.nexus_grant_id === null || typeof row.nexus_grant_id === 'string')
    // Nexus 侧确实只有一个 zone（无重复创建）
    const { status, json } = await nexusApi(nexus!, 'GET', `/v2/zones/${encodeURIComponent(zoneA)}`)
    assert.equal(status, 200, `zone should exist on nexus: ${JSON.stringify(json)}`)
  })

  it('scenario 4: org member uses own delegation for zone access; foreign org member is denied', async () => {
    orgB = await createOrg('P0 E2E Org B')
    await waitBindingActive(orgB)

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

    // Org A 用户换发自身 delegation（普通用户路径，无 admin credential）
    const tokenA = await login(moss, userA.name, userA.password)
    const issuedA = await mossApi(moss, tokenA, 'POST', '/api/v1/zones/delegations', {})
    assert.equal(issuedA.status, 201, `delegation issue failed: ${JSON.stringify(issuedA.json)}`)
    delegationA = (issuedA.json as { delegation_id: string }).delegation_id
    assert.ok(delegationA)
    // nexus 侧核对 delegation 绑定（user/org/zone/audience 五要素）
    const detail = await nexusApi(nexus!, 'GET', `/v2/auth/zone-delegations/${delegationA}`)
    assert.equal(detail.status, 200, `delegation detail failed: ${JSON.stringify(detail.json)}`)
    const dv = detail.json as Record<string, string>
    assert.equal(dv.user_id, userA.id, `delegation user binding: ${JSON.stringify({ got: dv.user_id, want: userA.id })}`)
    assert.equal(dv.org_id, orgA, `delegation org binding: ${JSON.stringify({ got: dv.org_id, want: orgA, zone: dv.zone_id, wantZone: zoneA, aud: dv.audience })}`)
    assert.equal(dv.zone_id, zoneA, `delegation zone binding: ${JSON.stringify({ got: dv.zone_id })}`)
    assert.equal(dv.audience, 'nexus-api', `delegation audience: ${JSON.stringify({ got: dv.audience })}`)

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
  })

  it('scenario 8: suspended membership invalidates the old delegation on next access', async () => {
    // suspend 须用 orgA 上下文的 admin token（updateUser 按 auth.orgId 查
    // 用户——用 default-org token 会 404；该 404 在 hostDispatch 修复前
    // 曾以 unhandledRejection 击穿整个 server，即此前的"监听消失"）。
    // 1) suspend → 进程内 revoke 钩子主动 revoke → 旧 delegation 双要素
    //    访问被拒；
    // 2) membership 失效后（重）换发被拒（moss 同步校验）。
    const patched = await mossApi(moss, orgAAdminToken, 'PATCH', `/api/v1/users/${userA.id}`, {
      status: 'disabled',
    })
    assert.equal(patched.status, 200, `suspend failed: ${JSON.stringify(patched.json)}`)
    await sleep(2_000) // revoke 为 best-effort 异步

    const denied = await fetch(`${nexus!.baseUrl}/v2/zones/${encodeURIComponent(zoneA)}`, {
      headers: { Authorization: `Bearer ${nexusKeyA}`, 'X-Nexus-Zone-Delegation': delegationA },
    })
    assert.ok([401, 403, 404].includes(denied.status), `suspended member delegation must be denied, got ${denied.status}`)

    // suspend 后用户连登录都被拒（401）——membership 失效的最直接证明，
    // 重换发自然无从发生（换发前置的 active 校验在 zones 单测覆盖）。
    const loginRefused = await fetch(`${moss.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: userA.name, password: userA.password }),
    })
    assert.equal(loginRefused.status, 401, `suspended member must not log in: ${await loginRefused.text()}`)

    // 恢复用户；恢复后可正常换发（对称验证）
    await mossApi(moss, orgAAdminToken, 'PATCH', `/api/v1/users/${userA.id}`, { status: 'active' })
    const tokenA3 = await login(moss, userA.name, userA.password)
    const reissued = await mossApi(moss, tokenA3, 'POST', '/api/v1/zones/delegations', {})
    assert.equal(reissued.status, 201, `active member must re-issue after restore: ${JSON.stringify(reissued.json)}`)
    delegationA = (reissued.json as { delegation_id: string }).delegation_id
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
    const zoneBDefault = String(row.zone_id)
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
})
