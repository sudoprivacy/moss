import { randomUUID } from 'node:crypto'
import type { DbDriver, SqlRow } from '../db/driver.js'

/** Park domain data access. SQL text lives here; both drivers accept `?` placeholders. */

export type ParkOrgProfile = {
  mossOrgId: string
  orgType: 'park' | 'enterprise'
  displayName: string
  lifecycle: string | null
  externalId: string | null
  metadataJson: string | null
  isDefaultPark: boolean
  createdAt: number
  updatedAt: number
}

export type ParkEnterpriseBinding = {
  bindingId: string
  parkOrgId: string
  enterpriseOrgId: string
  lifecycle: 'prospect' | 'active' | 'exiting' | 'exited'
  relationshipType: string
  serviceScopeJson: string | null
  assignedOwnerId: string | null
  joinedAt: number | null
  exitedAt: number | null
  createdAt: number
  updatedAt: number
}

export type ParkMember = {
  id: string
  parkOrgId: string
  userId: string
  parkRole: 'park_leader' | 'park_ops' | 'park_system_operator'
  createdAt: number
}

export type EnterpriseProfile = {
  enterpriseOrgId: string
  parkOrgId: string
  lifecycle: string
  enterpriseName: string
  industry: string | null
  scale: string | null
  contactName: string | null
  contactPhone: string | null
  assignedOwnerId: string | null
  tagsJson: string | null
  createdAt: number
  updatedAt: number
}

export type Inquiry = {
  inquiryId: string
  parkOrgId: string
  enterpriseOrgId: string
  userId: string
  assistantSessionId: string | null
  questionRef: string | null
  redactedQuestion: string | null
  answerRef: string | null
  redactedAnswer: string | null
  category: 'consultation' | 'service_request'
  intent: string | null
  confidence: number | null
  sourceRefsJson: string | null
  consentState: string
  createdAt: number
}

export type LeadStatus =
  | 'proposed' | 'confirmed' | 'assigned' | 'following_up' | 'converted' | 'lost' | 'rejected'

export type Lead = {
  leadId: string
  parkOrgId: string
  enterpriseOrgId: string
  source: 'inquiry' | 'manual'
  sourceInquiryId: string | null
  score: number | null
  scoreExplanation: string | null
  industryTagsJson: string | null
  policyMatchesJson: string | null
  suggestedAction: string | null
  ownerId: string | null
  status: LeadStatus
  idempotencyKey: string
  createdAt: number
  updatedAt: number
}

export type ParkAssistantAssignment = {
  id: string
  parkOrgId: string
  assistantId: string
  enterpriseOrgId: string
  createdAt: number
}

export type ParkAuditEvent = {
  auditId: string
  parkOrgId: string
  actorUserId: string
  actorOrgId: string
  action: string
  targetType: string
  targetId: string | null
  reason: string | null
  beforeSummaryJson: string | null
  afterSummaryJson: string | null
  result: string | null
  requestId: string | null
  createdAt: number
}

/** assistant-candidates 候选项（与 assignAssistant 校验同条件的已发布助手）。 */
export type AssistantCandidate = {
  assistantId: string
  name: string
  displayName: string
}

/** bindable-enterprises 候选项（org_type='enterprise' 且未绑定任何园区）。 */
export type BindableEnterpriseOrg = {
  enterpriseOrgId: string
  displayName: string
}

/** member-candidates 候选项（按关键字搜索、排除已是本园区成员的用户）。 */
export type MemberCandidate = {
  userId: string
  displayName: string
}

function parseJsonArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export class ParkRepository {
  constructor(private readonly driver: DbDriver) {}

  // ---- park_org_profiles ----

  async upsertOrgProfile(input: {
    mossOrgId: string
    orgType: 'park' | 'enterprise'
    displayName: string
    isDefaultPark?: boolean
    metadataJson?: string | null
  }): Promise<void> {
    const now = Date.now()
    await this.driver.run(`
      INSERT INTO park_org_profiles (moss_org_id, org_type, display_name, lifecycle, external_id, metadata_json, is_default_park, created_at, updated_at)
      VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?)
      ON CONFLICT (moss_org_id) DO UPDATE SET display_name = excluded.display_name, metadata_json = COALESCE(excluded.metadata_json, park_org_profiles.metadata_json), is_default_park = CASE WHEN excluded.is_default_park = 1 THEN 1 ELSE park_org_profiles.is_default_park END, updated_at = excluded.updated_at
    `, [input.mossOrgId, input.orgType, input.displayName, input.metadataJson ?? null, input.isDefaultPark ? 1 : 0, now, now])
  }

  async getOrgProfile(mossOrgId: string): Promise<ParkOrgProfile | null> {
    const row = await this.driver.get<SqlRow>(`SELECT * FROM park_org_profiles WHERE moss_org_id = ?`, [mossOrgId])
    return row ? mapOrgProfile(row) : null
  }

  async getDefaultParkOrgId(): Promise<string | null> {
    const row = await this.driver.get<SqlRow>(
      `SELECT moss_org_id FROM park_org_profiles WHERE org_type = 'park' AND is_default_park = 1 LIMIT 1`,
    )
    return row ? String(row.moss_org_id) : null
  }

  // ---- park_enterprise_bindings ----

  async insertBinding(input: {
    parkOrgId: string
    enterpriseOrgId: string
    lifecycle?: ParkEnterpriseBinding['lifecycle']
    relationshipType?: string
    assignedOwnerId?: string | null
  }): Promise<ParkEnterpriseBinding> {
    const bindingId = randomUUID()
    const now = Date.now()
    await this.driver.run(`
      INSERT INTO park_enterprise_bindings (binding_id, park_org_id, enterprise_org_id, lifecycle, relationship_type, service_scope_json, assigned_owner_id, joined_at, exited_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?)
    `, [bindingId, input.parkOrgId, input.enterpriseOrgId, input.lifecycle ?? 'prospect', input.relationshipType ?? 'prospective', input.assignedOwnerId ?? null, input.lifecycle === 'active' ? now : null, now, now])
    const row = await this.driver.get<SqlRow>(`SELECT * FROM park_enterprise_bindings WHERE binding_id = ?`, [bindingId])
    return mapBinding(row!)
  }

  async getBinding(parkOrgId: string, enterpriseOrgId: string): Promise<ParkEnterpriseBinding | null> {
    const row = await this.driver.get<SqlRow>(
      `SELECT * FROM park_enterprise_bindings WHERE park_org_id = ? AND enterprise_org_id = ?`,
      [parkOrgId, enterpriseOrgId],
    )
    return row ? mapBinding(row) : null
  }

  async getBindingByEnterprise(enterpriseOrgId: string): Promise<ParkEnterpriseBinding | null> {
    const row = await this.driver.get<SqlRow>(
      `SELECT * FROM park_enterprise_bindings WHERE enterprise_org_id = ? ORDER BY created_at DESC LIMIT 1`,
      [enterpriseOrgId],
    )
    return row ? mapBinding(row) : null
  }

  async listBindingsByPark(parkOrgId: string): Promise<ParkEnterpriseBinding[]> {
    const rows = await this.driver.all<SqlRow>(
      `SELECT * FROM park_enterprise_bindings WHERE park_org_id = ? ORDER BY created_at DESC`,
      [parkOrgId],
    )
    return rows.map(mapBinding)
  }

  async updateBindingLifecycle(bindingId: string, lifecycle: ParkEnterpriseBinding['lifecycle']): Promise<void> {
    const now = Date.now()
    await this.driver.run(
      `UPDATE park_enterprise_bindings SET lifecycle = ?, updated_at = ?, exited_at = CASE WHEN ? = 'exited' THEN ? ELSE exited_at END WHERE binding_id = ?`,
      [lifecycle, now, lifecycle, now, bindingId],
    )
  }

  // ---- park_members ----

  async insertMember(input: { parkOrgId: string; userId: string; parkRole: ParkMember['parkRole'] }): Promise<ParkMember> {
    const id = randomUUID()
    const now = Date.now()
    await this.driver.run(
      `INSERT INTO park_members (id, park_org_id, user_id, park_role, created_at) VALUES (?, ?, ?, ?, ?)`,
      [id, input.parkOrgId, input.userId, input.parkRole, now],
    )
    const row = await this.driver.get<SqlRow>(`SELECT * FROM park_members WHERE id = ?`, [id])
    return mapMember(row!)
  }

  async deleteMember(parkOrgId: string, userId: string): Promise<void> {
    await this.driver.run(`DELETE FROM park_members WHERE park_org_id = ? AND user_id = ?`, [parkOrgId, userId])
  }

  async listMembers(parkOrgId: string): Promise<ParkMember[]> {
    const rows = await this.driver.all<SqlRow>(
      `SELECT * FROM park_members WHERE park_org_id = ? ORDER BY created_at`, [parkOrgId],
    )
    return rows.map(mapMember)
  }

  async getMember(parkOrgId: string, userId: string): Promise<ParkMember | null> {
    const row = await this.driver.get<SqlRow>(
      `SELECT * FROM park_members WHERE park_org_id = ? AND user_id = ?`, [parkOrgId, userId],
    )
    return row ? mapMember(row) : null
  }

  // ---- enterprise_profiles ----

  async upsertEnterpriseProfile(input: {
    enterpriseOrgId: string
    parkOrgId: string
    enterpriseName: string
    industry?: string | null
    contactName?: string | null
    contactPhone?: string | null
  }): Promise<EnterpriseProfile> {
    const now = Date.now()
    await this.driver.run(`
      INSERT INTO enterprise_profiles (enterprise_org_id, park_org_id, lifecycle, enterprise_name, industry, scale, contact_name, contact_phone, assigned_owner_id, tags_json, created_at, updated_at)
      VALUES (?, ?, 'prospect', ?, ?, NULL, ?, ?, NULL, NULL, ?, ?)
      ON CONFLICT (enterprise_org_id) DO UPDATE SET enterprise_name = excluded.enterprise_name, industry = COALESCE(excluded.industry, enterprise_profiles.industry), contact_name = COALESCE(excluded.contact_name, enterprise_profiles.contact_name), contact_phone = COALESCE(excluded.contact_phone, enterprise_profiles.contact_phone), updated_at = excluded.updated_at
    `, [input.enterpriseOrgId, input.parkOrgId, input.enterpriseName, input.industry ?? null, input.contactName ?? null, input.contactPhone ?? null, now, now])
    const row = await this.driver.get<SqlRow>(`SELECT * FROM enterprise_profiles WHERE enterprise_org_id = ?`, [input.enterpriseOrgId])
    return mapEnterpriseProfile(row!)
  }

  async getEnterpriseProfile(enterpriseOrgId: string): Promise<EnterpriseProfile | null> {
    const row = await this.driver.get<SqlRow>(
      `SELECT * FROM enterprise_profiles WHERE enterprise_org_id = ?`, [enterpriseOrgId],
    )
    return row ? mapEnterpriseProfile(row) : null
  }

  async listEnterpriseProfiles(parkOrgId: string): Promise<EnterpriseProfile[]> {
    const rows = await this.driver.all<SqlRow>(`
      SELECT * FROM enterprise_profiles WHERE park_org_id = ? ORDER BY created_at DESC
    `, [parkOrgId])
    return rows.map(mapEnterpriseProfile)
  }

  async updateEnterpriseFollowUp(enterpriseOrgId: string, input: {
    tagsJson?: string | null
    assignedOwnerId?: string | null
    industry?: string | null
    scale?: string | null
  }): Promise<void> {
    const now = Date.now()
    await this.driver.run(`
      UPDATE enterprise_profiles SET
        tags_json = COALESCE(?, tags_json),
        assigned_owner_id = COALESCE(?, assigned_owner_id),
        industry = COALESCE(?, industry),
        scale = COALESCE(?, scale),
        updated_at = ?
      WHERE enterprise_org_id = ?
    `, [input.tagsJson ?? null, input.assignedOwnerId ?? null, input.industry ?? null, input.scale ?? null, now, enterpriseOrgId])
  }

  // ---- inquiries ----

  async insertInquiry(input: Omit<Inquiry, 'inquiryId' | 'createdAt'> & { inquiryId?: string }): Promise<Inquiry> {
    const inquiryId = input.inquiryId ?? randomUUID()
    const now = Date.now()
    await this.driver.run(`
      INSERT INTO inquiries (inquiry_id, park_org_id, enterprise_org_id, user_id, assistant_session_id, question_ref, redacted_question, answer_ref, redacted_answer, category, intent, confidence, source_refs_json, consent_state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [inquiryId, input.parkOrgId, input.enterpriseOrgId, input.userId, input.assistantSessionId ?? null,
      input.questionRef ?? null, input.redactedQuestion ?? null, input.answerRef ?? null, input.redactedAnswer ?? null,
      input.category, input.intent ?? null, input.confidence ?? null, input.sourceRefsJson ?? null,
      input.consentState ?? 'granted', now])
    const row = await this.driver.get<SqlRow>(`SELECT * FROM inquiries WHERE inquiry_id = ?`, [inquiryId])
    return mapInquiry(row!)
  }

  async getInquiry(inquiryId: string): Promise<Inquiry | null> {
    const row = await this.driver.get<SqlRow>(`SELECT * FROM inquiries WHERE inquiry_id = ?`, [inquiryId])
    return row ? mapInquiry(row) : null
  }

  /** Park-side inquiry listing (plan 2.3 咨询摘要列表: 按企业/时间筛选). */
  async listInquiriesByPark(parkOrgId: string, filter: {
    enterpriseOrgId?: string
    beforeCreatedAt?: number
    afterCreatedAt?: number
  } = {}, limit = 100): Promise<Inquiry[]> {
    const conditions = ['park_org_id = ?']
    const params: Array<string | number> = [parkOrgId]
    if (filter.enterpriseOrgId) {
      conditions.push('enterprise_org_id = ?')
      params.push(filter.enterpriseOrgId)
    }
    if (filter.beforeCreatedAt !== undefined) {
      conditions.push('created_at < ?')
      params.push(filter.beforeCreatedAt)
    }
    if (filter.afterCreatedAt !== undefined) {
      conditions.push('created_at >= ?')
      params.push(filter.afterCreatedAt)
    }
    params.push(limit)
    const rows = await this.driver.all<SqlRow>(
      `SELECT * FROM inquiries WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`, params,
    )
    return rows.map(mapInquiry)
  }

  async listInquiriesByEnterprise(enterpriseOrgId: string, limit = 100): Promise<Inquiry[]> {
    const rows = await this.driver.all<SqlRow>(
      `SELECT * FROM inquiries WHERE enterprise_org_id = ? ORDER BY created_at DESC LIMIT ?`, [enterpriseOrgId, limit],
    )
    return rows.map(mapInquiry)
  }

  async listInquiriesByUser(userId: string, limit = 100): Promise<Inquiry[]> {
    const rows = await this.driver.all<SqlRow>(
      `SELECT * FROM inquiries WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`, [userId, limit],
    )
    return rows.map(mapInquiry)
  }

  // ---- leads ----

  async insertLead(input: Omit<Lead, 'leadId' | 'createdAt' | 'updatedAt'> & { leadId?: string }): Promise<Lead> {
    const leadId = input.leadId ?? randomUUID()
    const now = Date.now()
    await this.driver.run(`
      INSERT INTO leads (lead_id, park_org_id, enterprise_org_id, source, source_inquiry_id, score, score_explanation, industry_tags_json, policy_matches_json, suggested_action, owner_id, status, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [leadId, input.parkOrgId, input.enterpriseOrgId, input.source, input.sourceInquiryId ?? null,
      input.score ?? null, input.scoreExplanation ?? null, input.industryTagsJson ?? null,
      input.policyMatchesJson ?? null, input.suggestedAction ?? null, input.ownerId ?? null,
      input.status, input.idempotencyKey, now, now])
    const row = await this.driver.get<SqlRow>(`SELECT * FROM leads WHERE lead_id = ?`, [leadId])
    return mapLead(row!)
  }

  async getLead(leadId: string): Promise<Lead | null> {
    const row = await this.driver.get<SqlRow>(`SELECT * FROM leads WHERE lead_id = ?`, [leadId])
    return row ? mapLead(row) : null
  }

  async listLeadsByInquiry(inquiryId: string): Promise<Lead[]> {
    const rows = await this.driver.all<SqlRow>(
      `SELECT * FROM leads WHERE source_inquiry_id = ? ORDER BY created_at DESC`, [inquiryId],
    )
    return rows.map(mapLead)
  }

  async getLeadByIdempotencyKey(parkOrgId: string, idempotencyKey: string): Promise<Lead | null> {
    const row = await this.driver.get<SqlRow>(
      `SELECT * FROM leads WHERE park_org_id = ? AND idempotency_key = ?`, [parkOrgId, idempotencyKey],
    )
    return row ? mapLead(row) : null
  }

  async listLeads(parkOrgId: string, filter: {
    statuses?: LeadStatus[]
    ownerId?: string
    watchedBy?: string
  } = {}, limit = 200): Promise<Lead[]> {
    const conditions = ['park_org_id = ?']
    const params: Array<string | number> = [parkOrgId]
    if (filter.statuses && filter.statuses.length > 0) {
      conditions.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`)
      params.push(...filter.statuses)
    }
    if (filter.ownerId) {
      conditions.push('owner_id = ?')
      params.push(filter.ownerId)
    }
    if (filter.watchedBy) {
      conditions.push('lead_id IN (SELECT lead_id FROM lead_watches WHERE user_id = ?)')
      params.push(filter.watchedBy)
    }
    params.push(limit)
    const rows = await this.driver.all<SqlRow>(
      `SELECT * FROM leads WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`, params,
    )
    return rows.map(mapLead)
  }

  async updateLead(leadId: string, input: Partial<Pick<Lead, 'status' | 'ownerId' | 'score' | 'scoreExplanation' | 'suggestedAction' | 'industryTagsJson'>>): Promise<void> {
    const now = Date.now()
    await this.driver.run(`
      UPDATE leads SET
        status = COALESCE(?, status),
        owner_id = COALESCE(?, owner_id),
        score = COALESCE(?, score),
        score_explanation = COALESCE(?, score_explanation),
        suggested_action = COALESCE(?, suggested_action),
        industry_tags_json = COALESCE(?, industry_tags_json),
        updated_at = ?
      WHERE lead_id = ?
    `, [input.status ?? null, input.ownerId ?? null, input.score ?? null, input.scoreExplanation ?? null,
      input.suggestedAction ?? null, input.industryTagsJson ?? null, now, leadId])
  }

  /**
   * Atomic claim (plan 2.3: 认领后仅 owner 可改 — another ops must not take
   * over an owned lead, and concurrent claims must not both win). The guard
   * `owner_id IS NULL OR owner_id = ?` makes the read-modify-write race-free:
   * 0 affected rows = the lead is owned by someone else (consume-style update,
   * same changes>0 pattern as authCenter consumePhoneLoginCode).
   */
  async claimLead(leadId: string, ownerId: string): Promise<number> {
    const now = Date.now()
    return this.driver.run(`
      UPDATE leads SET status = 'confirmed', owner_id = ?, updated_at = ?
      WHERE lead_id = ? AND (owner_id IS NULL OR owner_id = ?)
    `, [ownerId, now, leadId, ownerId])
  }

  async countLeadsByStatus(parkOrgId: string): Promise<Record<string, number>> {
    const rows = await this.driver.all<SqlRow>(
      `SELECT status, COUNT(*) AS n FROM leads WHERE park_org_id = ? GROUP BY status`, [parkOrgId],
    )
    const out: Record<string, number> = {}
    for (const row of rows) out[String(row.status)] = Number(row.n)
    return out
  }

  async countLeadsByEnterprise(parkOrgId: string): Promise<Record<string, number>> {
    const rows = await this.driver.all<SqlRow>(
      `SELECT enterprise_org_id, COUNT(*) AS n FROM leads WHERE park_org_id = ? GROUP BY enterprise_org_id`,
      [parkOrgId],
    )
    return Object.fromEntries(rows.map(row => [String(row.enterprise_org_id), Number(row.n)]))
  }

  async listHighScoreLeads(parkOrgId: string, minScore: number, limit = 20): Promise<Lead[]> {
    const rows = await this.driver.all<SqlRow>(
      `SELECT * FROM leads WHERE park_org_id = ? AND score >= ? ORDER BY score DESC, created_at DESC LIMIT ?`,
      [parkOrgId, minScore, limit],
    )
    return rows.map(mapLead)
  }

  // ---- lead_watches ----

  async addLeadWatch(leadId: string, userId: string): Promise<void> {
    await this.driver.run(
      `INSERT INTO lead_watches (lead_id, user_id, created_at) VALUES (?, ?, ?)
       ON CONFLICT (lead_id, user_id) DO NOTHING`,
      [leadId, userId, Date.now()],
    )
  }

  async removeLeadWatch(leadId: string, userId: string): Promise<void> {
    await this.driver.run(`DELETE FROM lead_watches WHERE lead_id = ? AND user_id = ?`, [leadId, userId])
  }

  // ---- park_assistant_assignments ----

  async insertAssignment(input: { parkOrgId: string; assistantId: string; enterpriseOrgId: string }): Promise<ParkAssistantAssignment> {
    const id = randomUUID()
    const now = Date.now()
    await this.driver.run(
      `INSERT INTO park_assistant_assignments (id, park_org_id, assistant_id, enterprise_org_id, created_at) VALUES (?, ?, ?, ?, ?)`,
      [id, input.parkOrgId, input.assistantId, input.enterpriseOrgId, now],
    )
    const row = await this.driver.get<SqlRow>(`SELECT * FROM park_assistant_assignments WHERE id = ?`, [id])
    return mapAssignment(row!)
  }

  async deleteAssignment(parkOrgId: string, assistantId: string, enterpriseOrgId: string): Promise<void> {
    await this.driver.run(
      `DELETE FROM park_assistant_assignments WHERE park_org_id = ? AND assistant_id = ? AND enterprise_org_id = ?`,
      [parkOrgId, assistantId, enterpriseOrgId],
    )
  }

  async listAssignmentsByPark(parkOrgId: string): Promise<ParkAssistantAssignment[]> {
    const rows = await this.driver.all<SqlRow>(
      `SELECT * FROM park_assistant_assignments WHERE park_org_id = ? ORDER BY created_at DESC`, [parkOrgId],
    )
    return rows.map(mapAssignment)
  }

  async listAssignmentsByEnterprise(enterpriseOrgId: string): Promise<ParkAssistantAssignment[]> {
    const rows = await this.driver.all<SqlRow>(
      `SELECT * FROM park_assistant_assignments WHERE enterprise_org_id = ? ORDER BY created_at DESC`, [enterpriseOrgId],
    )
    return rows.map(mapAssignment)
  }

  async findAssignmentByAssistantIds(assistantIds: string[], enterpriseOrgId: string): Promise<ParkAssistantAssignment | null> {
    if (assistantIds.length === 0) return null
    const placeholders = assistantIds.map(() => '?').join(', ')
    const row = await this.driver.get<SqlRow>(
      `SELECT * FROM park_assistant_assignments WHERE assistant_id IN (${placeholders}) AND enterprise_org_id = ? LIMIT 1`,
      [...assistantIds, enterpriseOrgId],
    )
    return row ? mapAssignment(row) : null
  }

  // ---- park_audit_events ----

  async insertAuditEvent(input: Omit<ParkAuditEvent, 'auditId' | 'createdAt'>): Promise<ParkAuditEvent> {
    const auditId = randomUUID()
    const now = Date.now()
    await this.driver.run(`
      INSERT INTO park_audit_events (audit_id, park_org_id, actor_user_id, actor_org_id, action, target_type, target_id, reason, before_summary_json, after_summary_json, result, request_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [auditId, input.parkOrgId, input.actorUserId, input.actorOrgId, input.action, input.targetType,
      input.targetId ?? null, input.reason ?? null, input.beforeSummaryJson ?? null,
      input.afterSummaryJson ?? null, input.result ?? null, input.requestId ?? null, now])
    const row = await this.driver.get<SqlRow>(`SELECT * FROM park_audit_events WHERE audit_id = ?`, [auditId])
    return mapAuditEvent(row!)
  }

  async listAuditEvents(filter: {
    parkOrgId: string
    actorUserId?: string
    limit?: number
  }): Promise<ParkAuditEvent[]> {
    const limit = filter.limit ?? 200
    const rows = filter.actorUserId
      ? await this.driver.all<SqlRow>(
        `SELECT * FROM park_audit_events WHERE park_org_id = ? AND actor_user_id = ? ORDER BY created_at DESC LIMIT ?`,
        [filter.parkOrgId, filter.actorUserId, limit],
      )
      : await this.driver.all<SqlRow>(
        `SELECT * FROM park_audit_events WHERE park_org_id = ? ORDER BY created_at DESC LIMIT ?`,
        [filter.parkOrgId, limit],
      )
    return rows.map(mapAuditEvent)
  }

  // ---- ID→名称映射与下拉候选查询（展示层用）----

  /** 批量取用户名（display_name 优先，空回退 name）；查不到的 id 不进 Map。 */
  async userNamesByIds(userIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds.filter(Boolean))]
    if (ids.length === 0) return new Map()
    const placeholders = ids.map(() => '?').join(', ')
    const rows = await this.driver.all<SqlRow>(
      `SELECT id, COALESCE(NULLIF(display_name, ''), name) AS display_name FROM users WHERE id IN (${placeholders})`,
      ids,
    )
    return new Map(rows.map(row => [String(row.id), String(row.display_name)]))
  }

  /** 批量取助手名（display_name 优先，空回退 name）；查不到的 id 不进 Map。 */
  async assistantNamesByIds(assistantIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(assistantIds.filter(Boolean))]
    if (ids.length === 0) return new Map()
    const placeholders = ids.map(() => '?').join(', ')
    const rows = await this.driver.all<SqlRow>(
      `SELECT id, COALESCE(NULLIF(display_name, ''), name) AS display_name FROM tenant_assistants WHERE id IN (${placeholders})`,
      ids,
    )
    return new Map(rows.map(row => [String(row.id), String(row.display_name)]))
  }

  /** lead_id → enterprise_org_id（审计对象列解析 lead 类型用）。 */
  async leadEnterprisesByIds(leadIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(leadIds.filter(Boolean))]
    if (ids.length === 0) return new Map()
    const placeholders = ids.map(() => '?').join(', ')
    const rows = await this.driver.all<SqlRow>(
      `SELECT lead_id, enterprise_org_id FROM leads WHERE lead_id IN (${placeholders})`,
      ids,
    )
    return new Map(rows.map(row => [String(row.lead_id), String(row.enterprise_org_id)]))
  }

  /** 本园区已发布助手（与 assignAssistant 的校验 SQL 同条件）。 */
  async listApprovedAssistants(parkOrgId: string): Promise<AssistantCandidate[]> {
    const rows = await this.driver.all<SqlRow>(
      `SELECT id, name, display_name FROM tenant_assistants WHERE org_id = ? AND status = 'approved' ORDER BY created_at DESC`,
      [parkOrgId],
    )
    return rows.map(row => ({
      assistantId: String(row.id),
      name: String(row.name ?? ''),
      displayName: row.display_name == null ? String(row.name ?? '') : String(row.display_name),
    }))
  }

  /** 未绑定任何园区的企业 org（数据源与 createBinding 校验 getOrgProfile 同表）。 */
  async listBindableEnterpriseOrgs(): Promise<BindableEnterpriseOrg[]> {
    const rows = await this.driver.all<SqlRow>(
      `SELECT p.moss_org_id, p.display_name
       FROM park_org_profiles p
       WHERE p.org_type = 'enterprise'
         AND NOT EXISTS (SELECT 1 FROM park_enterprise_bindings b WHERE b.enterprise_org_id = p.moss_org_id)
       ORDER BY p.display_name`,
    )
    return rows.map(row => ({
      enterpriseOrgId: String(row.moss_org_id),
      displayName: String(row.display_name ?? ''),
    }))
  }

  /** 按关键字（姓名/手机号/邮箱）搜可添加为成员的用户；排除已是本园区成员（UNIQUE 约束）。 */
  async searchUsersForMembership(parkOrgId: string, query: string, limit = 20): Promise<MemberCandidate[]> {
    const q = query.trim()
    if (!q) return []
    const pattern = `%${q.replace(/[\\%_]/g, match => `\\${match}`)}%`
    const rows = await this.driver.all<SqlRow>(
      `SELECT u.id, COALESCE(NULLIF(u.display_name, ''), u.name) AS display_name
       FROM users u
       WHERE (u.name LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\'
              OR u.phone LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')
         AND NOT EXISTS (SELECT 1 FROM park_members m WHERE m.park_org_id = ? AND m.user_id = u.id)
       LIMIT ?`,
      [pattern, pattern, pattern, pattern, parkOrgId, limit],
    )
    return rows.map(row => ({ userId: String(row.id), displayName: String(row.display_name) }))
  }
}

// ---- row mappers ----

function mapOrgProfile(row: SqlRow): ParkOrgProfile {
  return {
    mossOrgId: String(row.moss_org_id),
    orgType: row.org_type === 'park' ? 'park' : 'enterprise',
    displayName: String(row.display_name ?? ''),
    lifecycle: row.lifecycle == null ? null : String(row.lifecycle),
    externalId: row.external_id == null ? null : String(row.external_id),
    metadataJson: row.metadata_json == null ? null : String(row.metadata_json),
    isDefaultPark: Number(row.is_default_park) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function mapBinding(row: SqlRow): ParkEnterpriseBinding {
  return {
    bindingId: String(row.binding_id),
    parkOrgId: String(row.park_org_id),
    enterpriseOrgId: String(row.enterprise_org_id),
    lifecycle: row.lifecycle as ParkEnterpriseBinding['lifecycle'],
    relationshipType: String(row.relationship_type ?? 'prospective'),
    serviceScopeJson: row.service_scope_json == null ? null : String(row.service_scope_json),
    assignedOwnerId: row.assigned_owner_id == null ? null : String(row.assigned_owner_id),
    joinedAt: row.joined_at == null ? null : Number(row.joined_at),
    exitedAt: row.exited_at == null ? null : Number(row.exited_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function mapMember(row: SqlRow): ParkMember {
  return {
    id: String(row.id),
    parkOrgId: String(row.park_org_id),
    userId: String(row.user_id),
    parkRole: row.park_role as ParkMember['parkRole'],
    createdAt: Number(row.created_at),
  }
}

function mapEnterpriseProfile(row: SqlRow): EnterpriseProfile {
  return {
    enterpriseOrgId: String(row.enterprise_org_id),
    parkOrgId: String(row.park_org_id),
    lifecycle: String(row.lifecycle ?? 'prospect'),
    enterpriseName: String(row.enterprise_name ?? ''),
    industry: row.industry == null ? null : String(row.industry),
    scale: row.scale == null ? null : String(row.scale),
    contactName: row.contact_name == null ? null : String(row.contact_name),
    contactPhone: row.contact_phone == null ? null : String(row.contact_phone),
    assignedOwnerId: row.assigned_owner_id == null ? null : String(row.assigned_owner_id),
    tagsJson: row.tags_json == null ? null : String(row.tags_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function mapInquiry(row: SqlRow): Inquiry {
  return {
    inquiryId: String(row.inquiry_id),
    parkOrgId: String(row.park_org_id),
    enterpriseOrgId: String(row.enterprise_org_id),
    userId: String(row.user_id),
    assistantSessionId: row.assistant_session_id == null ? null : String(row.assistant_session_id),
    questionRef: row.question_ref == null ? null : String(row.question_ref),
    redactedQuestion: row.redacted_question == null ? null : String(row.redacted_question),
    answerRef: row.answer_ref == null ? null : String(row.answer_ref),
    redactedAnswer: row.redacted_answer == null ? null : String(row.redacted_answer),
    category: row.category === 'service_request' ? 'service_request' : 'consultation',
    intent: row.intent == null ? null : String(row.intent),
    confidence: row.confidence == null ? null : Number(row.confidence),
    sourceRefsJson: row.source_refs_json == null ? null : String(row.source_refs_json),
    consentState: String(row.consent_state ?? 'granted'),
    createdAt: Number(row.created_at),
  }
}

function mapLead(row: SqlRow): Lead {
  return {
    leadId: String(row.lead_id),
    parkOrgId: String(row.park_org_id),
    enterpriseOrgId: String(row.enterprise_org_id),
    source: row.source === 'manual' ? 'manual' : 'inquiry',
    sourceInquiryId: row.source_inquiry_id == null ? null : String(row.source_inquiry_id),
    score: row.score == null ? null : Number(row.score),
    scoreExplanation: row.score_explanation == null ? null : String(row.score_explanation),
    industryTagsJson: row.industry_tags_json == null ? null : String(row.industry_tags_json),
    policyMatchesJson: row.policy_matches_json == null ? null : String(row.policy_matches_json),
    suggestedAction: row.suggested_action == null ? null : String(row.suggested_action),
    ownerId: row.owner_id == null ? null : String(row.owner_id),
    status: row.status as LeadStatus,
    idempotencyKey: String(row.idempotency_key),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function mapAssignment(row: SqlRow): ParkAssistantAssignment {
  return {
    id: String(row.id),
    parkOrgId: String(row.park_org_id),
    assistantId: String(row.assistant_id),
    enterpriseOrgId: String(row.enterprise_org_id),
    createdAt: Number(row.created_at),
  }
}

function mapAuditEvent(row: SqlRow): ParkAuditEvent {
  return {
    auditId: String(row.audit_id),
    parkOrgId: String(row.park_org_id),
    actorUserId: String(row.actor_user_id),
    actorOrgId: String(row.actor_org_id),
    action: String(row.action),
    targetType: String(row.target_type),
    targetId: row.target_id == null ? null : String(row.target_id),
    reason: row.reason == null ? null : String(row.reason),
    beforeSummaryJson: row.before_summary_json == null ? null : String(row.before_summary_json),
    afterSummaryJson: row.after_summary_json == null ? null : String(row.after_summary_json),
    result: row.result == null ? null : String(row.result),
    requestId: row.request_id == null ? null : String(row.request_id),
    createdAt: Number(row.created_at),
  }
}
