import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { IncomingMessage } from 'node:http'
import { AuthCenterDb } from '../authCenter/db.js'
import { createCatalogTestRepository } from '../testing/compatibilityRepositories.js'
import { ensureIdentitySchema } from '../identity/identityRepository.js'
import { SqliteDriver } from '../db/driver.js'
import type { DocumentStore } from '../documentStore.js'
import type { AuthContext } from '../auth/token.js'
import type { AuthService } from '../auth/service.js'
import { ensureParkSchema } from './parkSchema.js'
import { ParkRepository } from './parkRepository.js'
import { dispatchParkApi, handleParkEnterpriseRegister } from './parkRoutes.js'
import { dispatchParkAgentApi } from './parkAgentRoutes.js'

/**
 * parkLeadFlow — 线索链路全自动化测试（plan 5.4 S1-S16）：搜集→处理→领导→展示→企业侧。
 * 不依赖真实 LLM：agent 侧以带 assistantId 的 auth 直接调 dispatch（工具行为层），
 * policy 检索走 grep 臂（tmpdir wiki 目录直接放 .md，见 5.2 策略）。
 */

function makeAuth(input: { userId: string; orgId: string; assistantId?: string | null; sessionId?: string | null }): AuthContext {
  return {
    rawToken: `test-${input.userId}`, userId: input.userId, orgId: input.orgId,
    role: 'user', scopes: [], keyId: 'test', jti: `jti-${input.userId}`,
    exp: Date.now() + 60_000, assistantId: input.assistantId ?? null, sessionId: input.sessionId ?? null,
  }
}

function fakeReq(body: Record<string, unknown>): IncomingMessage {
  return { [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)) } } as unknown as IncomingMessage
}

function stubDocumentStore(wikis: Array<{ id: string; name: string; storagePath: string; orgId: string }>): DocumentStore {
  return {
    getWiki: async (id: string, orgId: string) =>
      wikis.find(w => w.id === id && w.orgId === orgId) ?? null,
    listWikis: async (orgId: string) => wikis.filter(w => w.orgId === orgId),
  } as unknown as DocumentStore
}

async function callPark(deps: Parameters<typeof dispatchParkApi>[0], auth: AuthContext, method: string, path: string, body: Record<string, unknown>, store: DocumentStore): Promise<{ status: number; body: any }> {
  const result = await dispatchParkApi(deps, auth, method, new URL(`http://localhost${path}`), body, store)
  return { status: result!.status, body: result!.body }
}

async function callAgent(deps: Parameters<typeof dispatchParkAgentApi>[0], auth: AuthContext, method: string, path: string, store: DocumentStore, query = '', body: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
  const result = await dispatchParkAgentApi(deps, auth, method, path, new URL(`http://localhost${path}${query}`), fakeReq(body), store)
  return { status: result!.status, body: result!.body }
}

void describe('parkLeadFlow 线索链路（S1-S16）', () => {
  void test('搜集→处理→领导→展示→企业侧 全链路', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=OFF')
    new AuthCenterDb(db)
    ensureIdentitySchema(db)
    createCatalogTestRepository(db)
    try { db.exec('ALTER TABLE tenant_assistants ADD COLUMN enabled_wikis TEXT') } catch { /* present */ }
    ensureParkSchema(db)
    const root = await mkdtemp(join(tmpdir(), 'moss-park-flow-'))
    const driver = new SqliteDriver(db)
    const repo = new ParkRepository(driver)
    const deps = { driver }

    try {
      // ---- [准备] 园区/角色/注册企业/assistant/政策 wiki ----
      for (const [orgId, name] of [['park-org', '园区'], ['park-org-2', '园区二']] as const) {
        db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, 1)').run(orgId, name)
      }
      for (const [userId, orgId] of [['leader', 'park-org'], ['ops', 'park-org'], ['ops-b', 'park-org'], ['sysop', 'park-org'], ['ops2', 'park-org-2']] as const) {
        db.prepare(`INSERT INTO users (id, org_id, email, name, role, status, local_auth, created_at) VALUES (?, ?, ?, ?, 'user', 'active', 1, 1)`).run(userId, orgId, `${userId}@t`, userId)
      }
      await repo.upsertOrgProfile({ mossOrgId: 'park-org', orgType: 'park', displayName: '园区', isDefaultPark: true })
      await repo.upsertOrgProfile({ mossOrgId: 'park-org-2', orgType: 'park', displayName: '园区二' })
      await repo.insertMember({ parkOrgId: 'park-org', userId: 'leader', parkRole: 'park_leader' })
      await repo.insertMember({ parkOrgId: 'park-org', userId: 'ops', parkRole: 'park_ops' })
      await repo.insertMember({ parkOrgId: 'park-org', userId: 'ops-b', parkRole: 'park_ops' })
      await repo.insertMember({ parkOrgId: 'park-org', userId: 'sysop', parkRole: 'park_system_operator' })
      await repo.insertMember({ parkOrgId: 'park-org-2', userId: 'ops2', parkRole: 'park_ops' })
      let registered = 0
      const authService = {
        phoneAuth: { verifyCode: async () => true },
        findUserByPhone: async () => null,
        createOrganization: async ({ name }: { name: string }) => {
          registered += 1
          const id = registered === 1 ? 'ent-org' : 'ent-org-b'
          db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, 1)').run(id, name)
          return { organization: { id, name } }
        },
        createUser: async ({ orgId, displayName }: { orgId: string; displayName: string }) => {
          const id = orgId === 'ent-org' ? 'ent-user' : 'ent-user-b'
          db.prepare(`INSERT INTO users (id, org_id, email, name, role, status, local_auth, created_at) VALUES (?, ?, ?, ?, 'user', 'active', 1, 1)`).run(id, orgId, `${id}@t`, displayName)
          return { user: { id, orgId } }
        },
        putOrganizationClientPolicy: async (_orgId: string, patch: Record<string, unknown>) => patch,
      } as unknown as AuthService
      for (const [phone, enterpriseName, contactName, expectedOrg, expectedUser] of [
        ['13800000001', '星澜智能', '张三', 'ent-org', 'ent-user'],
        ['13800000002', '沐芯科技', '李四', 'ent-org-b', 'ent-user-b'],
      ] as const) {
        const result = await handleParkEnterpriseRegister({ driver, authService }, {
          phone, sms_code: '123456', enterprise_name: enterpriseName, contact_name: contactName,
        })
        assert.ok(result)
        assert.equal(result.status, 200, '企业经注册端点创建')
        assert.equal((result.body as { enterprise_org_id: string }).enterprise_org_id, expectedOrg)
        assert.equal((result.body as { user_id: string }).user_id, expectedUser)
        assert.equal((await repo.getBinding('park-org', expectedOrg))?.lifecycle, 'prospect')
      }

      // 政策 wiki（grep 臂：直接放 .md）
      const wikiDir = join(root, 'wiki-policy')
      await mkdir(wikiDir, { recursive: true })
      await writeFile(join(wikiDir, '租金减免政策.md'), '园区租金减免政策：入驻满一年的科技企业可享受三个月租金减免。\n申请截止 2026 年 12 月 31 日。\n', 'utf8')
      const store = stubDocumentStore([{ id: 'wiki-1', name: '园区政策库', storagePath: wikiDir, orgId: 'park-org' }])

      // tenant assistant（enabled_wikis + enabled_skills）
      const agentDir = join(root, 'agent-as-1')
      await mkdir(agentDir, { recursive: true })
      await writeFile(join(agentDir, '_moss_meta.json'), JSON.stringify({ id: 'as-1', name: 'park-consultation' }))
      db.prepare(`
        INSERT INTO tenant_assistants (id, name, display_name, org_id, author_id, status, source_type, file_path, enabled_wikis, created_at, updated_at)
        VALUES ('as-1', 'park-consultation', '园区咨询', 'park-org', 't', 'approved', 'tenant', ?, ?, 1, 1)
      `).run(agentDir, JSON.stringify(['wiki-1']))
      await repo.insertAssignment({ parkOrgId: 'park-org', assistantId: 'as-1', enterpriseOrgId: 'ent-org' })

      const entAuth = makeAuth({ userId: 'ent-user', orgId: 'ent-org', assistantId: 'as-1', sessionId: 'sess-1' })
      const opsAuth = makeAuth({ userId: 'ops', orgId: 'park-org' })
      const leaderAuth = makeAuth({ userId: 'leader', orgId: 'park-org' })
      const sysopAuth = makeAuth({ userId: 'sysop', orgId: 'park-org' })

      const badBinding = await callPark(deps, sysopAuth, 'POST', '/api/v1/parks/park-org/enterprise-bindings', { enterprise_org_id: 'park-org-2' }, store)
      assert.equal(badBinding.status, 400, '园区组织不能作为企业绑定')
      const badAssistant = await callPark(deps, sysopAuth, 'POST', '/api/v1/parks/park-org/assistant-assignments', { assistant_id: 'not-in-this-park', enterprise_org_id: 'ent-org' }, store)
      assert.equal(badAssistant.status, 400, '非本园区 Assistant 不能分配')
      const badEnterprise = await callPark(deps, sysopAuth, 'POST', '/api/v1/parks/park-org/assistant-assignments', { assistant_id: 'as-1', enterprise_org_id: 'park-org-2' }, store)
      assert.equal(badEnterprise.status, 400, '未绑定企业不能获分配')
      // ---- S1 搜集-检索 ----
      const s1 = await callAgent(deps, entAuth, 'GET', '/api/v1/agent/park/policies/search', store, '?q=' + encodeURIComponent('租金'))
      assert.equal(s1.status, 200)
      assert.ok((s1.body.matches as any[]).length > 0, '应命中政策')
      const match = s1.body.matches[0]
      assert.equal(match.file, '租金减免政策.md')
      assert.ok(typeof match.line_no === 'number' && typeof match.line === 'string')

      // ---- S2 搜集-记录 ----
      const s2 = await callAgent(deps, entAuth, 'POST', '/api/v1/agent/park/inquiries', store, '', {
        question: '我们想了解租金减免政策，联系我 13812345678',
        answer: '入驻满一年可申请三个月减免', intent: 'rent_consultation',
        industry_tags: ['AI'], policy_matches: [match],
      })
      assert.equal(s2.status, 200)
      assert.ok(s2.body.inquiry_id)
      const { InquiryService } = await import('./inquiryService.js')
      const inquiryService = new InquiryService(driver)
      const inquiry = await repo.getInquiry(s2.body.inquiry_id)
      assert.ok(inquiry)
      assert.equal(inquiry.parkOrgId, 'park-org')
      assert.equal(inquiry.enterpriseOrgId, 'ent-org')
      assert.equal(inquiry.userId, 'ent-user')
      assert.equal(inquiry.assistantSessionId, 'sess-1')
      assert.equal(inquiry.intent, 'rent_consultation')
      assert.ok(inquiry.redactedQuestion!.includes('***') && !inquiry.redactedQuestion!.includes('13812345678'), '手机号应被抹除')
      assert.ok((s2.body.confidence ?? 0) > 0, 'confidence 服务端有值')

      // ---- S3 搜集-提案 ----
      const s3 = await callAgent(deps, entAuth, 'POST', '/api/v1/agent/park/leads/propose', store, '', {
        source_inquiry_id: inquiry.inquiryId, industry_tags: ['AI'],
      })
      assert.equal(s3.status, 200)
      const lead = await repo.getLead(s3.body.lead_id)
      assert.ok(lead)
      assert.equal(lead.status, 'proposed')
      assert.equal(lead.source, 'inquiry')
      assert.equal(lead.sourceInquiryId, inquiry.inquiryId)
      assert.ok(lead.score !== null && lead.score >= 0 && lead.score <= 100)
      assert.ok(lead.scoreExplanation && lead.scoreExplanation.length > 0, '评分依据非空')
      const storedMatches = JSON.parse(lead.policyMatchesJson ?? '[]') as Array<{ file: string; line_no: number }>
      assert.ok(storedMatches.some(policy => policy.file === match.file && policy.line_no === match.line_no))
      const { LeadService } = await import('./leadService.js')
      const leadService = new LeadService(driver)

      // ---- S4 幂等 ----
      const leadAgain = await callAgent(deps, entAuth, 'POST', '/api/v1/agent/park/leads/propose', store, '', {
        source_inquiry_id: inquiry.inquiryId,
      })
      assert.equal(leadAgain.status, 200)
      assert.equal(leadAgain.body.lead_id, lead.leadId, '重复提案返回同一线索')
      const allLeads = await repo.listLeads('park-org', {})
      assert.equal(allLeads.filter(l => l.sourceInquiryId === inquiry.inquiryId).length, 1, '仅一条')

      // ---- S5 越权-工具 ----
      const entBAuth = makeAuth({ userId: 'ent-user-b', orgId: 'ent-org-b', assistantId: 'as-1' })
      const noAssistantAuth = makeAuth({ userId: 'ent-user', orgId: 'ent-org' })
      for (const [auth, label] of [[entBAuth, '未分配企业'], [noAssistantAuth, '无 assistantId']] as const) {
        const denied = await callAgent(deps, auth, 'GET', '/api/v1/agent/park/policies/search', store, '?q=x')
        assert.equal(denied.status, 403, `${label} 应 403`)
        const writeDenied = await callAgent(deps, auth, 'POST', '/api/v1/agent/park/inquiries', store, '', { question: '越权请求' })
        assert.equal(writeDenied.status, 403, `${label} 写入应 403`)
        const proposalDenied = await callAgent(deps, auth, 'POST', '/api/v1/agent/park/leads/propose', store, '', { source_inquiry_id: inquiry.inquiryId })
        assert.equal(proposalDenied.status, 403, `${label} 提案应 403`)
      }
      const missingSession = await callAgent(deps, makeAuth({ userId: 'ent-user', orgId: 'ent-org', assistantId: 'as-1' }), 'POST', '/api/v1/agent/park/inquiries', store, '', { question: '无会话' })
      assert.equal(missingSession.status, 403, '无会话标识不能写入')
      const wrongSession = await callAgent(deps, makeAuth({ userId: 'ent-user', orgId: 'ent-org', assistantId: 'as-1', sessionId: 'other-session' }), 'POST', '/api/v1/agent/park/leads/propose', store, '', { source_inquiry_id: inquiry.inquiryId })
      assert.equal(wrongSession.status, 404, '其他会话不能对本会话咨询提案')

      // ---- S6 处理-列表 ----
      const s6 = await callPark(deps, opsAuth, 'GET', '/api/v1/parks/park-org/leads', {}, store)
      assert.equal(s6.status, 200)
      assert.ok((s6.body.items as any[]).some(l => l.lead_id === lead.leadId), '运营线索池含 S3 线索')
      const s6cross = await callPark(deps, makeAuth({ userId: 'ops2', orgId: 'park-org-2' }), 'GET', '/api/v1/parks/park-org/leads', {}, store)
      assert.equal(s6cross.status, 403, '另一园区运营 403')

      // ---- S7 处理-详情（脱敏，无原文 ref） ----
      const s7 = await callPark(deps, opsAuth, 'GET', `/api/v1/parks/park-org/leads/${lead.leadId}`, {}, store)
      assert.equal(s7.status, 200)
      assert.ok(s7.body.inquiry_summary && s7.body.inquiry_summary.redacted_question.includes('***'))
      const serialized = JSON.stringify(s7.body)
      assert.ok(!serialized.includes('question_ref') && !serialized.includes('answer_ref'), '响应不含原文 ref 字段')

      for (const [auth, role] of [[leaderAuth, '领导'], [sysopAuth, '系统运营']] as const) {
        const claimDenied = await callPark(deps, auth, 'POST', `/api/v1/parks/park-org/leads/${lead.leadId}/claim`, {}, store)
        assert.equal(claimDenied.status, 403, `${role}不能认领`)
        for (const status of ['confirmed', 'rejected', 'following_up'] as const) {
          const denied = await callPark(deps, auth, 'PATCH', `/api/v1/parks/park-org/leads/${lead.leadId}`, { status, reason: '无权限' }, store)
          assert.equal(denied.status, 403, `${role}不能将线索设为 ${status}`)
        }
      }

      // ---- S8 处理-状态机 ----
      const t1 = await callPark(deps, opsAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead.leadId}`, { status: 'confirmed' }, store)
      assert.equal(t1.status === 200 ? t1.body.status : null, 'confirmed', 'proposed→confirmed（运营，无需 owner）')
      const claim = await callPark(deps, opsAuth, 'POST', `/api/v1/parks/park-org/leads/${lead.leadId}/claim`, {}, store)
      assert.equal(claim.body.owner_id, 'ops', '认领后 owner=运营')
      // 已有负责人的线索不可被其他运营认领（认领越权修复：计划 2.3 口径②）
      const opsBAuth = makeAuth({ userId: 'ops-b', orgId: 'park-org' })
      const steal = await callPark(deps, opsBAuth, 'POST', `/api/v1/parks/park-org/leads/${lead.leadId}/claim`, {}, store)
      assert.equal(steal.status, 409, '其他运营认领已有负责人的线索 → 409')
      assert.equal((await repo.getLead(lead.leadId))!.ownerId, 'ops', '负责人未被覆盖')
      const reClaim = await callPark(deps, opsAuth, 'POST', `/api/v1/parks/park-org/leads/${lead.leadId}/claim`, {}, store)
      assert.equal(reClaim.status, 200, 'owner 重复认领幂等')
      assert.equal(reClaim.body.owner_id, 'ops')
      // 认领后列表/详情带负责人名称与企业名称（ID→名称展示，计划 4.1-A）
      const ownerView = await callPark(deps, opsAuth, 'GET', '/api/v1/parks/park-org/leads', {}, store)
      const claimedRow = (ownerView.body.items as any[]).find(l => l.lead_id === lead.leadId)
      assert.equal(claimedRow?.owner_name, 'ops', '列表带负责人名称')
      const detailOwned = await callPark(deps, opsAuth, 'GET', `/api/v1/parks/park-org/leads/${lead.leadId}`, {}, store)
      assert.equal(detailOwned.body.owner_name, 'ops', '详情带负责人名称')
      assert.equal(detailOwned.body.enterprise_name, '星澜智能', '详情带企业名称')
      // 仅更新跟进字段（不带 status）也应落库（计划 2.3"跟进（owner 本人）"）
      const followUpOnly = await callPark(deps, opsAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead.leadId}`, { suggested_action: '下周回访' }, store)
      assert.equal(followUpOnly.status, 200, 'owner 仅跟进更新成功')
      assert.equal((await repo.getLead(lead.leadId))!.suggestedAction, '下周回访', '跟进字段已落库')
      const followUpDenied = await callPark(deps, opsBAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead.leadId}`, { suggested_action: '越权跟进' }, store)
      assert.equal(followUpDenied.status, 403, '非 owner 仅跟进更新 → 403')
      const badDirect = await callPark(deps, opsAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead.leadId}`, { status: 'converted' }, store)
      assert.equal(badDirect.status, 400, 'confirmed→converted 非法转换 400')
      // 非owner 改他人线索 → 403（ops2 属另一园区无法测——用 leader 当非 owner：leader 转状态应 403）
      const leaderTransition = await callPark(deps, leaderAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead.leadId}`, { status: 'assigned' }, store)
      assert.equal(leaderTransition.status, 403, '非 owner 转状态 403')
      const assigned = await callPark(deps, opsAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead.leadId}`, { status: 'assigned' }, store)
      assert.equal(assigned.body.status, 'assigned')
      const followingUp = await callPark(deps, opsAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead.leadId}`, { status: 'following_up' }, store)
      assert.equal(followingUp.body.status, 'following_up')
      const converted = await callPark(deps, opsAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead.leadId}`, { status: 'converted' }, store)
      assert.equal(converted.body.status, 'converted')
      const terminal = await callPark(deps, opsAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead.leadId}`, { status: 'following_up' }, store)
      assert.equal(terminal.status, 400, '终态再转 400')

      // 并发认领：同一 proposed 线索两个运营同时认领 → 恰一成功一 409（原子条件更新）
      const inquiryRace = await inquiryService.append({
        parkOrgId: 'park-org', enterpriseOrgId: 'ent-org', userId: 'ent-user',
        question: '并发认领线', category: 'consultation', intent: 'other', industryTags: [], policyHitCount: 0,
      })
      const raceLead = await leadService.propose({
        parkOrgId: 'park-org', enterpriseOrgId: 'ent-org', sourceInquiryId: inquiryRace.inquiryId,
        inquiryConfidence: inquiryRace.confidence, policyMatches: [], industryTags: [],
      })
      const [race1, race2] = await Promise.all([
        callPark(deps, opsAuth, 'POST', `/api/v1/parks/park-org/leads/${raceLead.leadId}/claim`, {}, store),
        callPark(deps, opsBAuth, 'POST', `/api/v1/parks/park-org/leads/${raceLead.leadId}/claim`, {}, store),
      ])
      assert.deepEqual([race1.status, race2.status].sort(), [200, 409], '并发认领恰一成功一冲突')

      // 驳回线：新提案 → 无理由 400 → 带理由成功
      const inquiry2 = await inquiryService.append({
        parkOrgId: 'park-org', enterpriseOrgId: 'ent-org-b', userId: 'ent-user-b',
        question: '沐芯咨询', category: 'consultation', intent: 'policy_inquiry', industryTags: [], policyHitCount: 0,
      })
      const lead2 = await leadService.propose({
        parkOrgId: 'park-org', enterpriseOrgId: 'ent-org-b', sourceInquiryId: inquiry2.inquiryId,
        inquiryConfidence: inquiry2.confidence, policyMatches: [], industryTags: [],
      })
      const noReason = await callPark(deps, opsAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead2.leadId}`, { status: 'rejected' }, store)
      assert.equal(noReason.status, 400, '驳回无理由 400')
      const withReason = await callPark(deps, opsAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead2.leadId}`, { status: 'rejected', reason: '重复线索' }, store)
      assert.equal(withReason.body.status, 'rejected')

      // lost 线
      const inquiry3 = await inquiryService.append({
        parkOrgId: 'park-org', enterpriseOrgId: 'ent-org', userId: 'ent-user',
        question: '再问一条', category: 'consultation', intent: 'other', industryTags: [], policyHitCount: 0,
      })
      const lead3 = await leadService.propose({
        parkOrgId: 'park-org', enterpriseOrgId: 'ent-org', sourceInquiryId: inquiry3.inquiryId,
        inquiryConfidence: inquiry3.confidence, policyMatches: [], industryTags: [],
      })
      await callPark(deps, opsAuth, 'POST', `/api/v1/parks/park-org/leads/${lead3.leadId}/claim`, {}, store)
      await callPark(deps, opsAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead3.leadId}`, { status: 'assigned' }, store)
      await callPark(deps, opsAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead3.leadId}`, { status: 'following_up' }, store)
      const lost = await callPark(deps, opsAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead3.leadId}`, { status: 'lost' }, store)
      assert.equal(lost.body.status, 'lost')

      // ---- S9 处理-手动创建 ----
      const manual = await callPark(deps, opsAuth, 'POST', '/api/v1/parks/park-org/leads', { enterprise_org_id: 'ent-org', note: '电话线索', industry_tags: ['机器人'] }, store)
      assert.equal(manual.status, 200)
      assert.equal(manual.body.source, 'manual')
      assert.equal(manual.body.owner_id, 'ops')

      // ---- S10 领导-关注 ----
      const watchOn = await callPark(deps, leaderAuth, 'POST', `/api/v1/parks/park-org/leads/${lead3.leadId}/watch`, {}, store)
      assert.equal(watchOn.status, 200)
      const watched = await callPark(deps, leaderAuth, 'GET', '/api/v1/parks/park-org/leads?watched=1', {}, store)
      assert.ok((watched.body.items as any[]).some(l => l.lead_id === lead3.leadId), '关注筛选含该线索')
      await callPark(deps, leaderAuth, 'DELETE', `/api/v1/parks/park-org/leads/${lead3.leadId}/watch`, {}, store)
      const watchedOff = await callPark(deps, leaderAuth, 'GET', '/api/v1/parks/park-org/leads?watched=1', {}, store)
      assert.ok(!(watchedOff.body.items as any[]).some(l => l.lead_id === lead3.leadId), '取消关注后不含')
      const opsWatch = await callPark(deps, opsAuth, 'POST', `/api/v1/parks/park-org/leads/${lead3.leadId}/watch`, {}, store)
      assert.equal(opsWatch.status, 403, '运营关注被拒（仅领导）')

      // ---- S11 领导-分派 ----
      // lead2 已 rejected（终态不可分派）；用一条新线验证领导仅能分派给本园区招商运营。
      const inquiry4 = await inquiryService.append({
        parkOrgId: 'park-org', enterpriseOrgId: 'ent-org', userId: 'ent-user',
        question: '分派线', category: 'consultation', intent: 'settlement_intent', industryTags: ['AI', '机器人'], policyHitCount: 2,
      })
      const lead4 = await leadService.propose({
        parkOrgId: 'park-org', enterpriseOrgId: 'ent-org', sourceInquiryId: inquiry4.inquiryId,
        inquiryConfidence: inquiry4.confidence,
        policyMatches: [
          { file: '租金减免政策.md', line_no: 1, line: '园区租金减免政策' },
          { file: '人才补贴政策.md', line_no: 1, line: '人才补贴' },
        ],
        industryTags: ['AI', '机器人'],
      })
      await callPark(deps, opsAuth, 'POST', `/api/v1/parks/park-org/leads/${lead4.leadId}/claim`, {}, store)
      await callPark(deps, opsAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead4.leadId}`, { status: 'assigned' }, store)
      const invalidOwner = await callPark(deps, leaderAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead4.leadId}`, { owner_id: 'sysop' }, store)
      assert.equal(invalidOwner.status, 400, '系统运营不能作为线索负责人')
      const crossParkOwner = await callPark(deps, leaderAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead4.leadId}`, { owner_id: 'ops2' }, store)
      assert.equal(crossParkOwner.status, 400, '其他园区运营不能作为负责人')
      const opsDispatch = await callPark(deps, opsAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead4.leadId}`, { owner_id: 'ops-b' }, store)
      assert.equal(opsDispatch.status, 403, '运营不能分派负责人')
      const dispatch = await callPark(deps, leaderAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead4.leadId}`, { owner_id: 'ops-b' }, store)
      assert.equal(dispatch.body.owner_id, 'ops-b', '领导分派给另一招商运营')
      const previousOwner = await callPark(deps, opsAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead4.leadId}`, { status: 'following_up' }, store)
      assert.equal(previousOwner.status, 403, '原负责人分派后不能继续变更状态')

      // ---- S12 展示-聚合 ----
      const metrics = await callPark(deps, leaderAuth, 'GET', '/api/v1/parks/park-org/metrics', {}, store)
      assert.equal(metrics.status, 200)
      assert.equal(metrics.body.lead_status.converted, 1)
      assert.equal(metrics.body.lead_status.rejected, 1)
      assert.equal(metrics.body.lead_status.lost, 1)
      assert.equal(metrics.body.funnel.prospect, 2, '漏斗=bindings lifecycle 计数')
      assert.ok((metrics.body.high_score_leads as any[]).some(l => l.lead_id === lead4.leadId), '高意向含 score≥80 的 lead4')

      // ---- S13 展示-审计 ----
      const auditOps = await callPark(deps, opsAuth, 'GET', '/api/v1/parks/park-org/audit-events', {}, store)
      assert.ok((auditOps.body.items as any[]).every(e => e.actor_user_id === 'ops'), '运营只见本人操作')
      const auditLeader = await callPark(deps, leaderAuth, 'GET', '/api/v1/parks/park-org/audit-events', {}, store)
      const auditItems = auditLeader.body.items as any[]
      const proposalAudit = auditItems.filter(e => e.action === 'park.lead_propose' && e.target_id === lead.leadId)
      assert.equal(proposalAudit.length, 1, 'S3 提案只产生一条审计记录')
      assert.ok(auditItems.some(e => e.action === 'park.lead_claim' && e.target_id === lead.leadId && e.actor_user_id === 'ops'), 'S8 认领审计')
      assert.ok(auditItems.some(e => e.action === 'park.lead_transition' && e.target_id === lead.leadId && e.before?.status === 'proposed' && e.after?.status === 'confirmed'), 'S8 确认审计含状态前后摘要')
      assert.ok(auditItems.some(e => e.action === 'park.lead_transition' && e.target_id === lead2.leadId && e.reason === '重复线索' && e.after?.status === 'rejected'), 'S8 驳回审计含理由')
      assert.ok(auditItems.some(e => e.action === 'park.lead_watch' && e.target_id === lead3.leadId && e.actor_user_id === 'leader'), 'S10 关注审计')
      assert.ok(auditItems.some(e => e.action === 'park.lead_unwatch' && e.target_id === lead3.leadId && e.actor_user_id === 'leader'), 'S10 取消关注审计')
      assert.ok(auditItems.some(e => e.action === 'park.lead_dispatch' && e.target_id === lead4.leadId && e.after?.owner_id === 'ops-b'), 'S11 分派审计')
      const leaderActions = (auditLeader.body.items as any[]).filter(e => e.actor_user_id === 'leader')
      assert.ok(leaderActions.some(e => e.action === 'park.lead_dispatch' || e.action === 'park.lead_transition'), '领导操作有记录')
      const rejectAudit = (auditOps.body.items as any[]).find(e => e.action === 'park.lead_transition' || e.action === 'park.lead_claim')
      assert.ok(rejectAudit && (rejectAudit.before || rejectAudit.after), '审计含 before/after 摘要')
      // 审计名称解析（ID→名称展示，计划 4.1-A）：操作人实时取名、对象按 target_type 分流
      assert.ok(auditItems.some(e => e.action === 'park.lead_claim' && e.target_id === lead.leadId && e.actor_name === 'ops'), '审计操作人带用户名')
      assert.ok(auditItems.some(e => e.action === 'park.lead_claim' && e.target_id === lead.leadId && e.target_name === '星澜智能'), 'lead 对象解析为企业名')
      assert.ok(auditItems.some(e => e.action === 'park.register_enterprise' && e.target_name === '星澜智能'), 'enterprise_org 对象解析为企业名')
      assert.ok(auditItems.some(e => e.action === 'park.register_enterprise' && e.actor_name === '张三'), '注册审计操作人取联系人名')

      // ---- S13b 候选端点（admin Modal 下拉，计划 4.1-B）----
      const candDenied = await callPark(deps, opsAuth, 'GET', '/api/v1/parks/park-org/assistant-candidates', {}, store)
      assert.equal(candDenied.status, 403, '非系统运营不能拉助手候选')
      const assistants = await callPark(deps, sysopAuth, 'GET', '/api/v1/parks/park-org/assistant-candidates', {}, store)
      assert.equal(assistants.status, 200)
      assert.deepEqual(assistants.body.items, [{ assistant_id: 'as-1', name: 'park-consultation', display_name: '园区咨询' }])
      const bindableEmpty = await callPark(deps, sysopAuth, 'GET', '/api/v1/parks/park-org/bindable-enterprises', {}, store)
      assert.equal(bindableEmpty.status, 200)
      assert.equal((bindableEmpty.body.items as any[]).length, 0, '注册企业已自动绑定，无候选')
      db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, 1)').run('ent-org-c', '未绑企业')
      await repo.upsertOrgProfile({ mossOrgId: 'ent-org-c', orgType: 'enterprise', displayName: '未绑企业' })
      const bindable = await callPark(deps, sysopAuth, 'GET', '/api/v1/parks/park-org/bindable-enterprises', {}, store)
      assert.deepEqual(bindable.body.items, [{ enterprise_org_id: 'ent-org-c', display_name: '未绑企业' }], '仅未绑定任何园区的企业可候选')
      const memberDenied = await callPark(deps, opsAuth, 'GET', '/api/v1/parks/park-org/member-candidates?q=ops', {}, store)
      assert.equal(memberDenied.status, 403, '非系统运营不能搜成员候选')
      const memberEmpty = await callPark(deps, sysopAuth, 'GET', '/api/v1/parks/park-org/member-candidates?q=', {}, store)
      assert.deepEqual(memberEmpty.body.items, [], '空关键字返回空')
      const memberHit = await callPark(deps, sysopAuth, 'GET', '/api/v1/parks/park-org/member-candidates?q=' + encodeURIComponent('ops2'), {}, store)
      assert.equal(memberHit.status, 200)
      assert.deepEqual(memberHit.body.items, [{ user_id: 'ops2', display_name: 'ops2' }], '按用户名精确命中（ops2 而非 ops）')
      const memberOps = await callPark(deps, sysopAuth, 'GET', '/api/v1/parks/park-org/member-candidates?q=ops', {}, store)
      const opsCandidates = memberOps.body.items as any[]
      assert.ok(opsCandidates.some(u => u.user_id === 'ops2'), '非本园区用户可搜到')
      assert.ok(!opsCandidates.some(u => u.user_id === 'ops' || u.user_id === 'ops-b'), '已是本园区成员的不出现')

      // ---- S13c 成员/分配列表带名称（计划 4.1-A）----
      const membersView = await callPark(deps, sysopAuth, 'GET', '/api/v1/parks/park-org/members', {}, store)
      assert.ok((membersView.body.items as any[]).some(m => m.user_id === 'ops' && m.user_name === 'ops'), '成员带用户名')
      const assignmentsView = await callPark(deps, sysopAuth, 'GET', '/api/v1/parks/park-org/assistant-assignments', {}, store)
      assert.ok((assignmentsView.body.items as any[]).some(
        a => a.assistant_id === 'as-1' && a.assistant_name === '园区咨询' && a.enterprise_name === '星澜智能',
      ), '分配带助手与企业名称')

      // ---- S14 企业侧 ----
      const entInquiries = await callPark(deps, entAuth, 'GET', '/api/v1/enterprise/inquiries', {}, store)
      assert.ok((entInquiries.body.items as any[]).some(i => i.inquiry_id === inquiry.inquiryId), '本企业含 S2 记录')
      const entBInquiries = await callPark(deps, makeAuth({ userId: 'ent-user-b', orgId: 'ent-org-b' }), 'GET', '/api/v1/enterprise/inquiries', {}, store)
      assert.ok(!(entBInquiries.body.items as any[]).some((i: any) => i.inquiry_id === inquiry.inquiryId), '他企业不可见')

      // ---- S15 低置信度-仍提案 ----
      const lowResponse = await callAgent(deps, entAuth, 'POST', '/api/v1/agent/park/inquiries', store, '', { question: '随便问问' })
      assert.equal(lowResponse.status, 200)
      const lowInquiry = await repo.getInquiry(lowResponse.body.inquiry_id)
      assert.ok(lowInquiry)
      assert.ok((lowInquiry.confidence ?? 0) < 30, '低置信输入构造生效')
      const lowProposal = await callAgent(deps, entAuth, 'POST', '/api/v1/agent/park/leads/propose', store, '', { source_inquiry_id: lowInquiry.inquiryId })
      assert.equal(lowProposal.status, 200)
      const lowLead = await repo.getLead(lowProposal.body.lead_id)
      assert.ok(lowLead)
      assert.equal(lowLead.status, 'proposed', '低置信度仍提案（§11.2）')
      assert.ok((lowLead.score ?? 0) < 30)

      // ---- S15b 命中数服务端证实（policy_matches 申报不再作为数据源，计划 2.4）----
      const forgedRef = { file: '伪造政策.md', line_no: 1, line: '伪造内容' }
      const forged = await callAgent(deps, entAuth, 'POST', '/api/v1/agent/park/inquiries', store, '', {
        question: '未检索先申报', intent: 'policy_inquiry', industry_tags: ['AI'],
        policy_matches: [forgedRef, forgedRef, forgedRef, forgedRef, forgedRef],
      })
      assert.equal(forged.status, 200)
      const forgedInquiry = await repo.getInquiry(forged.body.inquiry_id)
      assert.equal(JSON.parse(forgedInquiry!.sourceRefsJson ?? '[]').length, 0, '未检索的申报不落 sourceRefs')
      assert.equal(forgedInquiry!.confidence, 50, '申报命中不计入 confidence（30 intent + 20 tags + 0 政策）')

      const searchAgain = await callAgent(deps, entAuth, 'GET', '/api/v1/agent/park/policies/search', store, '?q=' + encodeURIComponent('租金'))
      assert.equal(searchAgain.status, 200)
      const realHits = (searchAgain.body.matches as any[]).length
      assert.ok(realHits > 0, 'S15b 前置：检索有命中')
      const overstated = await callAgent(deps, entAuth, 'POST', '/api/v1/agent/park/inquiries', store, '', {
        question: '检索后申报超量', intent: 'policy_inquiry', industry_tags: ['AI'],
        policy_matches: [forgedRef, forgedRef, forgedRef, forgedRef, forgedRef],
      })
      const overstatedInquiry = await repo.getInquiry(overstated.body.inquiry_id)
      assert.equal(JSON.parse(overstatedInquiry!.sourceRefsJson ?? '[]').length, realHits, 'sourceRefs 以服务端检索为准')
      assert.equal(overstatedInquiry!.confidence, 30 + 20 + Math.min(40, realHits * 20), 'confidence 按真实命中数计')
      const secondAppend = await callAgent(deps, entAuth, 'POST', '/api/v1/agent/park/inquiries', store, '', {
        question: '同轮第二次记录', intent: 'other', industry_tags: [],
      })
      const secondInquiry = await repo.getInquiry(secondAppend.body.inquiry_id)
      assert.equal(JSON.parse(secondInquiry!.sourceRefsJson ?? '[]').length, 0, 'take：记录被消费后不再复用')

      // ---- S16 咨询摘要列表：独立创建一条未提案的咨询 ----
      const noLeadResponse = await callAgent(deps, entAuth, 'POST', '/api/v1/agent/park/inquiries', store, '', { question: '只咨询，不生成线索' })
      assert.equal(noLeadResponse.status, 200)
      const consultations = await callPark(deps, opsAuth, 'GET', '/api/v1/parks/park-org/consultations', {}, store)
      assert.equal(consultations.status, 200)
      const items = consultations.body.items as any[]
      assert.ok(items.some(i => i.inquiry_id === inquiry.inquiryId && i.hasLead === true), 'S2 记录含已产生线索标记')
      assert.ok(items.some(i => i.inquiry_id === lowInquiry.inquiryId && i.hasLead === true), '低置信提案仍有线索')
      assert.ok(items.some(i => i.inquiry_id === noLeadResponse.body.inquiry_id && i.hasLead === false), '未产生线索的咨询同样可见且 hasLead=false')
      assert.ok(!JSON.stringify(consultations.body).includes('question_ref'), '响应无原文 ref')
      const consultCross = await callPark(deps, makeAuth({ userId: 'ops2', orgId: 'park-org-2' }), 'GET', '/api/v1/parks/park-org/consultations', {}, store)
      assert.equal(consultCross.status, 403, '另一园区运营 403')

      // 按企业筛选（计划 2.3 咨询摘要列表）：ent-org 的咨询不含 ent-org-b 的
      const byEnterprise = await callPark(deps, opsAuth, 'GET', '/api/v1/parks/park-org/consultations?enterprise_org_id=ent-org', {}, store)
      assert.equal(byEnterprise.status, 200)
      const enterpriseItems = byEnterprise.body.items as any[]
      assert.ok(enterpriseItems.length > 0 && enterpriseItems.every(i => i.enterprise_org_id === 'ent-org'), '按企业筛选仅含该企业')
      assert.ok(!enterpriseItems.some(i => i.inquiry_id === inquiry2.inquiryId), 'ent-org-b 的咨询被滤除')
      // 按时间筛选：after_created_at 取 S2 之后 → 不含 S2；before 取 S2 之前 → 为空
      const afterS2 = await callPark(deps, opsAuth, 'GET', `/api/v1/parks/park-org/consultations?after_created_at=${inquiry.createdAt + 1}`, {}, store)
      assert.ok(!((afterS2.body.items as any[]).some(i => i.inquiry_id === inquiry.inquiryId)), 'after 边界不含 S2')
      const beforeS2 = await callPark(deps, opsAuth, 'GET', `/api/v1/parks/park-org/consultations?before_created_at=${inquiry.createdAt}`, {}, store)
      assert.ok(!((beforeS2.body.items as any[]).some(i => i.inquiry_id === inquiry.inquiryId)), 'before 边界不含 S2')
    } finally {
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
