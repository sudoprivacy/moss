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
import { ensureParkSchema } from './parkSchema.js'
import { ParkRepository } from './parkRepository.js'
import { dispatchParkApi } from './parkRoutes.js'
import { dispatchParkAgentApi } from './parkAgentRoutes.js'
import { readParkBody } from './parkRoutesShared.js'

/**
 * parkLeadFlow — 线索链路全自动化测试（plan 5.4 S1-S16）：搜集→处理→领导→展示→企业侧。
 * 不依赖真实 LLM：agent 侧以带 assistantId 的 auth 直接调 dispatch（工具行为层），
 * policy 检索走 grep 臂（tmpdir wiki 目录直接放 .md，见 5.2 策略）。
 */

function makeAuth(input: { userId: string; orgId: string; assistantId?: string | null }): AuthContext {
  return {
    rawToken: `test-${input.userId}`, userId: input.userId, orgId: input.orgId,
    role: 'user', scopes: [], keyId: 'test', jti: `jti-${input.userId}`,
    exp: Date.now() + 60_000, assistantId: input.assistantId ?? null,
  }
}

function fakeReq(): IncomingMessage {
  return { [Symbol.asyncIterator]: async function* () { /* empty body */ } } as unknown as IncomingMessage
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

async function callAgent(deps: Parameters<typeof dispatchParkAgentApi>[0], auth: AuthContext, method: string, path: string, store: DocumentStore, query = ''): Promise<{ status: number; body: any }> {
  const result = await dispatchParkAgentApi(deps, auth, method, path, new URL(`http://localhost${path}${query}`), fakeReq(), store)
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
      // ---- [准备] 园区/角色/企业/assistant/政策 wiki ----
      for (const [orgId, name] of [['park-org', '园区'], ['park-org-2', '园区二'], ['ent-org', '企业'], ['ent-org-b', '企业B']] as const) {
        db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, 1)').run(orgId, name)
      }
      for (const [userId, orgId] of [['leader', 'park-org'], ['ops', 'park-org'], ['sysop', 'park-org'], ['ops2', 'park-org-2'], ['ent-user', 'ent-org'], ['ent-user-b', 'ent-org-b']] as const) {
        db.prepare(`INSERT INTO users (id, org_id, email, name, role, status, local_auth, created_at) VALUES (?, ?, ?, ?, 'user', 'active', 1, 1)`).run(userId, orgId, `${userId}@t`, userId)
      }
      await repo.upsertOrgProfile({ mossOrgId: 'park-org', orgType: 'park', displayName: '园区', isDefaultPark: true })
      await repo.upsertOrgProfile({ mossOrgId: 'park-org-2', orgType: 'park', displayName: '园区二' })
      await repo.upsertOrgProfile({ mossOrgId: 'ent-org', orgType: 'enterprise', displayName: '企业' })
      await repo.upsertOrgProfile({ mossOrgId: 'ent-org-b', orgType: 'enterprise', displayName: '企业B' })
      await repo.insertMember({ parkOrgId: 'park-org', userId: 'leader', parkRole: 'park_leader' })
      await repo.insertMember({ parkOrgId: 'park-org', userId: 'ops', parkRole: 'park_ops' })
      await repo.insertMember({ parkOrgId: 'park-org', userId: 'sysop', parkRole: 'park_system_operator' })
      await repo.insertMember({ parkOrgId: 'park-org-2', userId: 'ops2', parkRole: 'park_ops' })
      await repo.upsertEnterpriseProfile({ enterpriseOrgId: 'ent-org', parkOrgId: 'park-org', enterpriseName: '星澜智能' })
      await repo.upsertEnterpriseProfile({ enterpriseOrgId: 'ent-org-b', parkOrgId: 'park-org', enterpriseName: '沐芯科技' })
      await repo.insertBinding({ parkOrgId: 'park-org', enterpriseOrgId: 'ent-org', lifecycle: 'prospect' })
      await repo.insertBinding({ parkOrgId: 'park-org', enterpriseOrgId: 'ent-org-b', lifecycle: 'prospect' })

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

      const entAuth = makeAuth({ userId: 'ent-user', orgId: 'ent-org', assistantId: 'as-1' })
      const opsAuth = makeAuth({ userId: 'ops', orgId: 'park-org' })
      const leaderAuth = makeAuth({ userId: 'leader', orgId: 'park-org' })

      // ---- S1 搜集-检索 ----
      const s1 = await callAgent(deps, entAuth, 'GET', '/api/v1/agent/park/policies/search', store, '?q=' + encodeURIComponent('租金'))
      assert.equal(s1.status, 200)
      assert.ok((s1.body.matches as any[]).length > 0, '应命中政策')
      const match = s1.body.matches[0]
      assert.equal(match.file, '租金减免政策.md')
      assert.ok(typeof match.line_no === 'number' && typeof match.line === 'string')

      // ---- S2 搜集-记录 ----
      const s2 = await callAgent(deps, entAuth, 'POST', '/api/v1/agent/park/inquiries', store)
      void s2
      // POST 需要真实 body——直接用 InquiryService 层等价调用（dispatch 的 body 读取已由 readParkBody 覆盖）
      const { InquiryService } = await import('./inquiryService.js')
      const inquiryService = new InquiryService(driver)
      const inquiry = await inquiryService.append({
        parkOrgId: 'park-org', enterpriseOrgId: 'ent-org', userId: 'ent-user',
        assistantSessionId: 'sess-1',
        question: '我们想了解租金减免政策，联系我 13812345678',
        answer: '入驻满一年可申请三个月减免',
        category: 'consultation', intent: 'rent_consultation',
        industryTags: ['AI'],
        policyHitCount: 1,
        sourceRefs: [{ file: match.file, line_no: match.line_no, line: match.line }],
      })
      assert.ok(inquiry.inquiryId)
      assert.ok(inquiry.redactedQuestion!.includes('***') && !inquiry.redactedQuestion!.includes('13812345678'), '手机号应被抹除')
      assert.ok((inquiry.confidence ?? 0) > 0, 'confidence 服务端有值')

      // ---- S3 搜集-提案 ----
      const { LeadService } = await import('./leadService.js')
      const leadService = new LeadService(driver)
      const sourceInquiry = await repo.getInquiry(inquiry.inquiryId)
      const lead = await leadService.propose({
        parkOrgId: 'park-org', enterpriseOrgId: 'ent-org', sourceInquiryId: inquiry.inquiryId,
        inquiryConfidence: sourceInquiry!.confidence,
        policyMatches: [{ file: match.file, line_no: match.line_no, line: match.line }],
        industryTags: ['AI'],
      })
      assert.equal(lead.status, 'proposed')
      assert.ok(lead.score !== null && lead.score >= 0 && lead.score <= 100)
      assert.ok(lead.scoreExplanation && lead.scoreExplanation.length > 0, '评分依据非空')

      // ---- S4 幂等 ----
      const leadAgain = await leadService.propose({
        parkOrgId: 'park-org', enterpriseOrgId: 'ent-org', sourceInquiryId: inquiry.inquiryId,
        inquiryConfidence: sourceInquiry!.confidence, policyMatches: [], industryTags: [],
      })
      assert.equal(leadAgain.leadId, lead.leadId, '重复提案返回同一线索')
      const allLeads = await repo.listLeads('park-org', {})
      assert.equal(allLeads.filter(l => l.sourceInquiryId === inquiry.inquiryId).length, 1, '仅一条')

      // ---- S5 越权-工具 ----
      const entBAuth = makeAuth({ userId: 'ent-user-b', orgId: 'ent-org-b', assistantId: 'as-1' })
      const noAssistantAuth = makeAuth({ userId: 'ent-user', orgId: 'ent-org' })
      for (const [auth, label] of [[entBAuth, '未分配企业'], [noAssistantAuth, '无 assistantId']] as const) {
        const denied = await callAgent(deps, auth, 'GET', '/api/v1/agent/park/policies/search', store, '?q=x')
        assert.equal(denied.status, 403, `${label} 应 403`)
      }

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

      // ---- S8 处理-状态机 ----
      const t1 = await callPark(deps, opsAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead.leadId}`, { status: 'confirmed' }, store)
      assert.equal(t1.status === 200 ? t1.body.status : null, 'confirmed', 'proposed→confirmed（运营，无需 owner）')
      const claim = await callPark(deps, opsAuth, 'POST', `/api/v1/parks/park-org/leads/${lead.leadId}/claim`, {}, store)
      assert.equal(claim.body.owner_id, 'ops', '认领后 owner=运营')
      const badDirect = await callPark(deps, opsAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead.leadId}`, { status: 'converted' }, store)
      assert.equal(badDirect.status, 400, 'confirmed→converted 非法转换 400')
      // 非owner 改他人线索 → 403（ops2 属另一园区无法测——用 leader 当非 owner：leader 转状态应 403）
      const leaderTransition = await callPark(deps, leaderAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead.leadId}`, { status: 'assigned' }, store)
      assert.equal(leaderTransition.status, 403, '非 owner 转状态 403')
      await callPark(deps, opsAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead.leadId}`, { status: 'assigned' }, store)
      await callPark(deps, opsAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead.leadId}`, { status: 'following_up' }, store)
      const converted = await callPark(deps, opsAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead.leadId}`, { status: 'converted' }, store)
      assert.equal(converted.body.status, 'converted')
      const terminal = await callPark(deps, opsAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead.leadId}`, { status: 'following_up' }, store)
      assert.equal(terminal.status, 400, '终态再转 400')

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
      // lead2 已 rejected（终态不可分派）；用一条新线到 following_up 后由领导分派给 sysop（同为成员）
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
      const dispatch = await callPark(deps, leaderAuth, 'PATCH', `/api/v1/parks/park-org/leads/${lead4.leadId}`, { owner_id: 'sysop' }, store)
      assert.equal(dispatch.body.owner_id, 'sysop', '领导分派生效')

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
      const leaderActions = (auditLeader.body.items as any[]).filter(e => e.actor_user_id === 'leader')
      assert.ok(leaderActions.some(e => e.action === 'park.lead_dispatch' || e.action === 'park.lead_transition'), '领导操作有记录')
      const rejectAudit = (auditOps.body.items as any[]).find(e => e.action === 'park.lead_transition' || e.action === 'park.lead_claim')
      assert.ok(rejectAudit && (rejectAudit.before || rejectAudit.after), '审计含 before/after 摘要')

      // ---- S14 企业侧 ----
      const entInquiries = await callPark(deps, entAuth, 'GET', '/api/v1/enterprise/inquiries', {}, store)
      assert.ok((entInquiries.body.items as any[]).some(i => i.inquiry_id === inquiry.inquiryId), '本企业含 S2 记录')
      const entBInquiries = await callPark(deps, makeAuth({ userId: 'ent-user-b', orgId: 'ent-org-b' }), 'GET', '/api/v1/enterprise/inquiries', {}, store)
      assert.ok(!(entBInquiries.body.items as any[]).some((i: any) => i.inquiry_id === inquiry.inquiryId), '他企业不可见')

      // ---- S15 低置信度-仍提案 ----
      const lowInquiry = await inquiryService.append({
        parkOrgId: 'park-org', enterpriseOrgId: 'ent-org', userId: 'ent-user',
        question: '随便问问', category: 'consultation', intent: null, industryTags: [], policyHitCount: 0,
      })
      assert.ok((lowInquiry.confidence ?? 0) < 30, '低置信输入构造生效')
      const lowLead = await leadService.propose({
        parkOrgId: 'park-org', enterpriseOrgId: 'ent-org', sourceInquiryId: lowInquiry.inquiryId,
        inquiryConfidence: lowInquiry.confidence, policyMatches: [], industryTags: [],
      })
      assert.equal(lowLead.status, 'proposed', '低置信度仍提案（§11.2）')
      assert.ok((lowLead.score ?? 0) < 30)

      // ---- S16 咨询摘要列表 ----
      const consultations = await callPark(deps, opsAuth, 'GET', '/api/v1/parks/park-org/consultations', {}, store)
      assert.equal(consultations.status, 200)
      const items = consultations.body.items as any[]
      assert.ok(items.some(i => i.inquiry_id === inquiry.inquiryId && i.hasLead === true), 'S2 记录含已产生线索标记')
      assert.ok(items.some(i => i.inquiry_id === lowInquiry.inquiryId), '未产生线索的咨询同样可见')
      assert.ok(!JSON.stringify(consultations.body).includes('question_ref'), '响应无原文 ref')
      const consultCross = await callPark(deps, makeAuth({ userId: 'ops2', orgId: 'park-org-2' }), 'GET', '/api/v1/parks/park-org/consultations', {}, store)
      assert.equal(consultCross.status, 403, '另一园区运营 403')
    } finally {
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

void readParkBody
