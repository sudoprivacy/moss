import { randomUUID } from 'node:crypto'
import type { DbDriver, SqlRow } from '../db/driver.js'
import { initializeParkSchema } from './schema.js'
import type { WikiSourceSnapshot } from '../wikiSourceSnapshot.js'
import { isPolicyPublic, type LeadSignal, type PublicPolicy } from './rules.js'

export type ParkRole = 'park_leader' | 'park_recruiter' | 'park_system_operator'
export type LeadStatus = 'proposed' | 'claimed' | 'following_up' | 'converted' | 'invalid' | 'closed'

export interface ParkConfigRow extends SqlRow {
  org_id: string
  display_name: string
  logo_url: string | null
  welcome_text: string
  contact_enabled: number
  park_profile: string
  service_catalog: string
  service_catalog_version: string
  assistant_status: string
  assistant_config: string
  rate_config: string
  redaction_config: string
  consent_text: string
  updated_at: number
}

export interface ParkSessionRow extends SqlRow {
  id: string
  org_id: string
  source_channel: string
  started_at: number
  last_active_at: number
  expires_at: number
  risk_state: string
  message_count: number
  token_budget_used: number
  moss_session_id: string | null
}

export interface ParkLeadRow extends SqlRow {
  id: string
  org_id: string
  source_session_id: string
  source_inquiry_id: string
  score: number
  score_explanation: string
  tags_json: string
  suggested_action: string
  contact_status: string
  status: LeadStatus
  owner_id: string | null
  created_at: number
  updated_at: number
}

export interface ParkPolicyRow extends SqlRow, PublicPolicy {
  id: string
  org_id: string
  title: string
  version: string
  section: string
  content: string
  status: string
  effective_from: number
  effective_until: number | null
  created_at: number
  updated_at: number
  effectiveFrom: number
  effectiveUntil: number | null
}

export class ParkStore {
  constructor(readonly db: DbDriver) {}

  async init(): Promise<void> { await initializeParkSchema(this.db) }

  async config(orgId: string): Promise<ParkConfigRow | undefined> {
    return this.db.get<ParkConfigRow>('SELECT * FROM park_config WHERE org_id = ?', [orgId])
  }

  async rememberDocument(orgId: string, document: WikiSourceSnapshot): Promise<void> {
    await this.db.run(`INSERT INTO park_document_history (org_id, document_id, file_name, node_name, size_bytes) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (org_id, document_id) DO NOTHING`, [orgId, document.id, document.fileName, document.nodeName, document.sizeBytes])
  }

  async documentHistory(orgId: string, id: string): Promise<WikiSourceSnapshot | undefined> {
    const row = await this.db.get('SELECT * FROM park_document_history WHERE org_id = ? AND document_id = ?', [orgId, id])
    return row ? { id, fileName: String(row.file_name), nodeName: String(row.node_name), sizeBytes: Number(row.size_bytes) } : undefined
  }

  async wasPolicyDocumentDeleted(orgId: string, id: string): Promise<boolean> {
    const row = await this.db.get(`SELECT id FROM operation_audit_events WHERE org_id = ? AND method = 'DELETE' AND response_status = 204 AND path = ? LIMIT 1`,
      [orgId, `/api/v1/parks/${orgId}/admin/policy/documents/${id}`])
    return !!row
  }

  async deletePublicLink(orgId: string, id: string): Promise<'deleted' | 'enabled' | 'missing'> {
    const count = await this.db.run('DELETE FROM park_public_links WHERE org_id = ? AND id = ? AND enabled = 0', [orgId, id])
    if (count === 1) return 'deleted'
    const row = await this.db.get('SELECT id FROM park_public_links WHERE org_id = ? AND id = ?', [orgId, id])
    return row ? 'enabled' : 'missing'
  }

  async putConfig(orgId: string, patch: Partial<Pick<ParkConfigRow, 'display_name' | 'logo_url' | 'welcome_text' | 'contact_enabled' | 'park_profile' | 'service_catalog' | 'service_catalog_version' | 'assistant_status' | 'assistant_config' | 'rate_config' | 'redaction_config' | 'consent_text'>>): Promise<ParkConfigRow> {
    const current = await this.config(orgId)
    const value = {
      display_name: patch.display_name ?? current?.display_name ?? '',
      logo_url: patch.logo_url === undefined ? current?.logo_url ?? null : patch.logo_url,
      welcome_text: patch.welcome_text ?? current?.welcome_text ?? '',
      contact_enabled: patch.contact_enabled ?? current?.contact_enabled ?? 1,
      park_profile: patch.park_profile ?? current?.park_profile ?? '',
      service_catalog: patch.service_catalog ?? current?.service_catalog ?? '[]',
      service_catalog_version: patch.service_catalog_version ?? current?.service_catalog_version ?? '1',
      assistant_status: patch.assistant_status ?? current?.assistant_status ?? 'draft',
      assistant_config: patch.assistant_config ?? current?.assistant_config ?? '{}',
      rate_config: patch.rate_config ?? current?.rate_config ?? '{}',
      redaction_config: patch.redaction_config ?? current?.redaction_config ?? '{}',
      consent_text: patch.consent_text ?? current?.consent_text ?? '',
    }
    if (!value.display_name.trim()) throw new Error('Park display name is required')
    await this.db.run(`INSERT INTO park_config (org_id, display_name, logo_url, welcome_text, contact_enabled, park_profile, service_catalog, service_catalog_version, assistant_status, assistant_config, rate_config, redaction_config, consent_text, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (org_id) DO UPDATE SET display_name = excluded.display_name, logo_url = excluded.logo_url,
      welcome_text = excluded.welcome_text, contact_enabled = excluded.contact_enabled,
      park_profile = excluded.park_profile, service_catalog = excluded.service_catalog,
      service_catalog_version = excluded.service_catalog_version, assistant_status = excluded.assistant_status,
      assistant_config = excluded.assistant_config, rate_config = excluded.rate_config,
      redaction_config = excluded.redaction_config, consent_text = excluded.consent_text, updated_at = excluded.updated_at`,
    [orgId, value.display_name, value.logo_url, value.welcome_text, value.contact_enabled,
      value.park_profile, value.service_catalog, value.service_catalog_version, value.assistant_status,
      value.assistant_config, value.rate_config, value.redaction_config, value.consent_text, Date.now()])
    return (await this.config(orgId))!
  }

  async role(orgId: string, userId: string): Promise<ParkRole | null> {
    const row = await this.db.get<{ park_role: ParkRole }>('SELECT park_role FROM park_user_roles WHERE org_id = ? AND user_id = ?', [orgId, userId])
    return row?.park_role ?? null
  }

  async grantRole(orgId: string, userId: string, parkRole: ParkRole, grantedBy: string): Promise<void> {
    await this.db.run(`INSERT INTO park_user_roles (org_id, user_id, park_role, granted_by, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (org_id, user_id) DO UPDATE SET park_role = excluded.park_role, granted_by = excluded.granted_by, updated_at = excluded.updated_at`,
    [orgId, userId, parkRole, grantedBy, Date.now()])
  }

  async listPolicies(orgId: string): Promise<SqlRow[]> {
    return this.db.all('SELECT * FROM park_policies WHERE org_id = ? ORDER BY updated_at DESC', [orgId])
  }

  async publicPolicies(orgId: string, now = Date.now()): Promise<ParkPolicyRow[]> {
    const rows = await this.db.all<ParkPolicyRow>('SELECT * FROM park_policies WHERE org_id = ? AND status = ? AND effective_from <= ? AND (effective_until IS NULL OR effective_until >= ?) ORDER BY updated_at DESC', [orgId, 'published', now, now])
    return rows.map(row => ({ ...row, effectiveFrom: Number(row.effective_from), effectiveUntil: row.effective_until === null ? null : Number(row.effective_until) })).filter(row => isPolicyPublic(row, now))
  }

  async putPolicy(orgId: string, input: { id?: string; title: string; version: string; section: string; content: string; status: string; effectiveFrom: number; effectiveUntil: number | null }): Promise<string> {
    const id = input.id ?? randomUUID()
    const now = Date.now()
    await this.db.run(`INSERT INTO park_policies (id, org_id, title, version, section, content, status, effective_from, effective_until, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET title = excluded.title, version = excluded.version, section = excluded.section,
      content = excluded.content, status = excluded.status, effective_from = excluded.effective_from,
      effective_until = excluded.effective_until, updated_at = excluded.updated_at
      WHERE park_policies.org_id = excluded.org_id`,
    [id, orgId, input.title, input.version, input.section, input.content, input.status, input.effectiveFrom, input.effectiveUntil, now, now])
    return id
  }

  async setPolicyStatus(orgId: string, id: string, status: 'draft' | 'published' | 'offline'): Promise<boolean> {
    return (await this.db.run('UPDATE park_policies SET status = ?, updated_at = ? WHERE org_id = ? AND id = ?', [status, Date.now(), orgId, id])) === 1
  }

  async quickQuestions(orgId: string, enabledOnly = false): Promise<SqlRow[]> {
    return this.db.all(`SELECT * FROM park_quick_questions WHERE org_id = ?${enabledOnly ? ' AND enabled = 1' : ''} ORDER BY sort_order, created_at`, [orgId])
  }

  async putQuickQuestion(orgId: string, input: { id?: string; question: string; sortOrder: number; enabled: boolean }): Promise<string> {
    const id = input.id ?? randomUUID()
    const now = Date.now()
    await this.db.run(`INSERT INTO park_quick_questions (id, org_id, question, sort_order, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET question = excluded.question, sort_order = excluded.sort_order,
      enabled = excluded.enabled, updated_at = excluded.updated_at
      WHERE park_quick_questions.org_id = excluded.org_id`,
    [id, orgId, input.question, input.sortOrder, Number(input.enabled), now, now])
    return id
  }

  async deleteQuickQuestion(orgId: string, id: string): Promise<boolean> {
    return (await this.db.run('DELETE FROM park_quick_questions WHERE org_id = ? AND id = ?', [orgId, id])) === 1
  }

  async createSession(orgId: string, sourceChannel: string, ttlMs: number, mossSessionId?: string): Promise<ParkSessionRow> {
    const id = mossSessionId ?? randomUUID()
    const now = Date.now()
    await this.db.run('INSERT INTO park_sessions (id, org_id, source_channel, started_at, last_active_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', [id, orgId, sourceChannel, now, now, now + ttlMs])
    return (await this.session(orgId, id))!
  }

  async session(orgId: string, id: string): Promise<ParkSessionRow | undefined> {
    return this.db.get<ParkSessionRow>('SELECT * FROM park_sessions WHERE org_id = ? AND id = ?', [orgId, id])
  }

  async inquiryByRequest(sessionId: string, requestId: string): Promise<SqlRow | undefined> {
    return this.db.get('SELECT * FROM park_inquiries WHERE session_id = ? AND client_request_id = ?', [sessionId, requestId])
  }

  async recordInquiry(input: { orgId: string; sessionId: string; requestId: string; question: string; answer: string; signal: LeadSignal; sourceRefs: unknown[] }): Promise<string> {
    const id = randomUUID()
    return this.db.transaction(async () => {
      const inserted = await this.db.run(`INSERT INTO park_inquiries (id, org_id, session_id, client_request_id, redacted_question, redacted_answer, category, intent, industry, scale, urgency, concerns_json, confidence, source_refs_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (session_id, client_request_id) DO NOTHING`,
      [id, input.orgId, input.sessionId, input.requestId, input.question, input.answer,
        input.signal.category, input.signal.intent, input.signal.industry, input.signal.scale,
        input.signal.urgency, JSON.stringify(input.signal.concerns), 1, JSON.stringify(input.sourceRefs), Date.now()])
      const row = await this.inquiryByRequest(input.sessionId, input.requestId)
      const inquiryId = String(row!.id)
      if (inserted === 1 && input.signal.score >= 40) {
        await this.db.run(`INSERT INTO park_lead_jobs (inquiry_id, org_id, session_id, signal_json, status, attempts, next_at)
          VALUES (?, ?, ?, ?, 'queued', 0, ?) ON CONFLICT (inquiry_id) DO NOTHING`,
        [inquiryId, input.orgId, input.sessionId, JSON.stringify(input.signal), Date.now()])
      }
      return inquiryId
    })
  }

  async processLeadJobs(): Promise<void> {
    await this.db.tryRunExclusive('park:lead-jobs', async () => {
      const due = await this.db.all<{ inquiry_id: string; org_id: string; session_id: string; signal_json: string; attempts: number }>(
        "SELECT * FROM park_lead_jobs WHERE status = 'queued' AND next_at <= ? ORDER BY next_at LIMIT 20", [Date.now()])
      for (const job of due) {
        try {
          await this.saveLead(job.org_id, job.session_id, job.inquiry_id, JSON.parse(job.signal_json) as LeadSignal)
          await this.db.run('UPDATE park_lead_jobs SET status = ?, last_error = NULL WHERE inquiry_id = ?', ['done', job.inquiry_id])
        } catch (error) {
          const attempts = Number(job.attempts) + 1
          await this.db.run('UPDATE park_lead_jobs SET attempts = ?, next_at = ?, last_error = ? WHERE inquiry_id = ?',
            [attempts, Date.now() + Math.min(60_000, attempts * 5000), String(error).slice(0, 500), job.inquiry_id])
        }
      }
    })
  }

  async saveLead(orgId: string, sessionId: string, inquiryId: string | null, signal: LeadSignal): Promise<ParkLeadRow> {
    const id = randomUUID()
    const now = Date.now()
    await this.db.run(`INSERT INTO park_leads (id, org_id, source_session_id, source_inquiry_id, score, score_explanation, tags_json, suggested_action, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_session_id) DO UPDATE SET source_inquiry_id = excluded.source_inquiry_id,
      score = excluded.score, score_explanation = excluded.score_explanation, tags_json = excluded.tags_json,
      suggested_action = excluded.suggested_action, updated_at = excluded.updated_at`,
    [id, orgId, sessionId, inquiryId, signal.score, signal.scoreExplanation,
      JSON.stringify(signal.concerns), signal.suggestedAction, now, now])
    return (await this.leadBySession(orgId, sessionId))!
  }

  async leadBySession(orgId: string, sessionId: string): Promise<ParkLeadRow | undefined> {
    return this.db.get<ParkLeadRow>('SELECT * FROM park_leads WHERE org_id = ? AND source_session_id = ?', [orgId, sessionId])
  }

  async lead(orgId: string, id: string): Promise<ParkLeadRow | undefined> {
    return this.db.get<ParkLeadRow>('SELECT * FROM park_leads WHERE org_id = ? AND id = ?', [orgId, id])
  }

  async listLeads(orgId: string, status?: string): Promise<ParkLeadRow[]> {
    return status
      ? this.db.all<ParkLeadRow>('SELECT * FROM park_leads WHERE org_id = ? AND status = ? ORDER BY created_at DESC', [orgId, status])
      : this.db.all<ParkLeadRow>('SELECT * FROM park_leads WHERE org_id = ? ORDER BY created_at DESC', [orgId])
  }

  async contact(orgId: string, leadId: string): Promise<SqlRow | undefined> {
    return this.db.get('SELECT * FROM park_contacts WHERE org_id = ? AND lead_id = ?', [orgId, leadId])
  }

  async saveContact(orgId: string, leadId: string, input: { name: string | null; companyName: string | null; phone: string | null; email: string | null; consentText: string; retentionUntil: number; phoneVerifiedAt?: number | null }): Promise<void> {
    const now = Date.now()
    await this.db.transaction(async () => {
      await this.db.run(`INSERT INTO park_contacts (lead_id, org_id, name, company_name, phone, email, consent_text, consent_at, retention_until, phone_verified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (lead_id) DO UPDATE SET name = excluded.name, company_name = excluded.company_name,
        phone = excluded.phone, email = excluded.email, consent_text = excluded.consent_text,
        consent_at = excluded.consent_at, retention_until = excluded.retention_until,
        phone_verified_at = excluded.phone_verified_at`,
      [leadId, orgId, input.name, input.companyName, input.phone, input.email,
        input.consentText, now, input.retentionUntil, input.phoneVerifiedAt ?? null])
      await this.db.run('UPDATE park_leads SET contact_status = ?, updated_at = ? WHERE org_id = ? AND id = ?',
        [input.phoneVerifiedAt ? 'verified' : 'submitted', now, orgId, leadId])
    })
  }

  async claimLead(orgId: string, id: string, ownerId: string): Promise<boolean> {
    return (await this.db.run("UPDATE park_leads SET status = 'claimed', owner_id = ?, updated_at = ? WHERE org_id = ? AND id = ? AND status = 'proposed' AND owner_id IS NULL", [ownerId, Date.now(), orgId, id])) === 1
  }

  async closeLead(orgId: string, id: string, ownerId: string, status: 'converted' | 'invalid' | 'closed'): Promise<boolean> {
    return (await this.db.run("UPDATE park_leads SET status = ?, updated_at = ? WHERE org_id = ? AND id = ? AND owner_id = ? AND status IN ('claimed', 'following_up')", [status, Date.now(), orgId, id, ownerId])) === 1
  }

  async addFollowUp(orgId: string, leadId: string, actorId: string, note: string, outcome: string | null): Promise<string | null> {
    const id = randomUUID()
    return this.db.transaction(async () => {
      const updated = await this.db.run("UPDATE park_leads SET status = 'following_up', updated_at = ? WHERE org_id = ? AND id = ? AND owner_id = ? AND status IN ('claimed', 'following_up')", [Date.now(), orgId, leadId, actorId])
      if (updated !== 1) return null
      await this.db.run('INSERT INTO park_follow_ups (id, org_id, lead_id, actor_user_id, note, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, orgId, leadId, actorId, note, outcome, Date.now()])
      return id
    })
  }

  async followUps(orgId: string, leadId: string): Promise<SqlRow[]> {
    return this.db.all('SELECT * FROM park_follow_ups WHERE org_id = ? AND lead_id = ? ORDER BY created_at', [orgId, leadId])
  }

  async recordRejection(orgId: string, sessionId: string | null, reason: string, status: number, ipPrefix: string | null): Promise<void> {
    await this.db.run('INSERT INTO park_rejection_hits (id, org_id, session_id, reason, response_status, ip_prefix, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [randomUUID(), orgId, sessionId, reason, status, ipPrefix, Date.now()])
  }
}
