import type { DbDriver } from '../db/driver.js'
import { ParkApiError } from './parkAuthorization.js'
import { ParkAuditService } from './parkAuditService.js'
import { ParkRepository, type Lead, type LeadStatus } from './parkRepository.js'

/**
 * Lead state machine + idempotent proposal + manual creation (方案 §7.3/§11.3).
 *
 * Transitions (plan 2.3):
 *   proposed → confirmed | rejected   (park_ops; rejection reason mandatory)
 *   confirmed → assigned
 *   assigned → following_up
 *   following_up → converted | lost   (owner)
 *   converted / lost / rejected are terminal.
 *
 * lead.propose always creates a `proposed` lead — even at low confidence — so
 * every suggestion lands in human confirmation (§11.2 第 4 条).
 */

export const LEAD_TRANSITIONS: Record<LeadStatus, LeadStatus[] | null> = {
  proposed: ['confirmed', 'rejected'],
  confirmed: ['assigned'],
  assigned: ['following_up'],
  following_up: ['converted', 'lost'],
  converted: null,
  lost: null,
  rejected: null,
}

export const HIGH_SCORE_THRESHOLD = 80

/**
 * Deterministic lead score (plan 2.4): derived from the source inquiry's
 * confidence, policy matches and assistant-supplied tags — same inputs as the
 * inquiry confidence rule, explanation recorded for §11.3 评分展示原因.
 */
export function computeLeadScore(input: {
  inquiryConfidence: number | null
  policyMatchCount: number
  industryTagCount: number
}): { score: number; explanation: string } {
  const parts: string[] = []
  let score = 0
  const confidence = input.inquiryConfidence ?? 0
  const confidencePart = Math.round(confidence * 0.4)
  score += confidencePart
  parts.push(`咨询置信度 ${confidence}/100 ×40% = ${confidencePart}`)
  const policyPart = Math.min(40, input.policyMatchCount * 20)
  if (policyPart > 0) {
    score += policyPart
    parts.push(`政策命中 ${input.policyMatchCount} 项 = ${policyPart}`)
  }
  const tagPart = Math.min(20, input.industryTagCount * 10)
  if (tagPart > 0) {
    score += tagPart
    parts.push(`行业标签 ${input.industryTagCount} 个 = ${tagPart}`)
  }
  return { score: Math.min(100, score), explanation: parts.join('；') }
}

export class LeadService {
  private readonly repo: ParkRepository
  private readonly audit: ParkAuditService

  constructor(private readonly driver: DbDriver) {
    this.repo = new ParkRepository(driver)
    this.audit = new ParkAuditService(driver)
  }

  /** Idempotent proposal from the consultation assistant (lead.propose tool). */
  async propose(input: {
    parkOrgId: string
    enterpriseOrgId: string
    sourceInquiryId: string
    inquiryConfidence: number | null
    policyMatches: Array<{ file: string; line_no: number; line: string }>
    industryTags: string[]
    suggestedAction?: string | null
    actorUserId?: string
  }): Promise<Lead> {
    return this.driver.transaction(async () => {
      const idempotencyKey = `inquiry:${input.sourceInquiryId}`
      const existing = await this.repo.getLeadByIdempotencyKey(input.parkOrgId, idempotencyKey)
      if (existing) return existing
      const { score, explanation } = computeLeadScore({
        inquiryConfidence: input.inquiryConfidence,
        policyMatchCount: input.policyMatches.length,
        industryTagCount: input.industryTags.length,
      })
      const lead = await this.repo.insertLead({
        parkOrgId: input.parkOrgId,
        enterpriseOrgId: input.enterpriseOrgId,
        source: 'inquiry',
        sourceInquiryId: input.sourceInquiryId,
        score,
        scoreExplanation: explanation,
        industryTagsJson: input.industryTags.length > 0 ? JSON.stringify(input.industryTags) : null,
        policyMatchesJson: input.policyMatches.length > 0 ? JSON.stringify(input.policyMatches) : null,
        suggestedAction: input.suggestedAction ?? null,
        ownerId: null,
        status: 'proposed',
        idempotencyKey,
      })
      if (input.actorUserId) {
        await this.audit.record({
          parkOrgId: input.parkOrgId, actorUserId: input.actorUserId, actorOrgId: input.enterpriseOrgId,
          action: 'park.lead_propose', targetType: 'lead', targetId: lead.leadId,
          after: { status: lead.status, source_inquiry_id: input.sourceInquiryId, score },
        })
      }
      return lead
    })
  }

  /** Manual creation by park ops (§4.2 "创建"). */
  async createManual(input: {
    parkOrgId: string
    enterpriseOrgId: string
    ownerId: string
    note: string
    industryTags: string[]
  }): Promise<Lead> {
    const idempotencyKey = `manual:${input.ownerId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
    return this.repo.insertLead({
      parkOrgId: input.parkOrgId,
      enterpriseOrgId: input.enterpriseOrgId,
      source: 'manual',
      sourceInquiryId: null,
      score: null,
      scoreExplanation: input.note || null,
      industryTagsJson: input.industryTags.length > 0 ? JSON.stringify(input.industryTags) : null,
      policyMatchesJson: null,
      suggestedAction: null,
      ownerId: input.ownerId,
      status: 'following_up',
      idempotencyKey,
    })
  }

  async claim(parkOrgId: string, leadId: string, ownerId: string): Promise<Lead> {
    // Claiming a proposed lead also confirms it (confirm+claim in one step,
    // §11.3); a confirmed-but-unowned lead just gains its owner. Taking over
    // an ALREADY-OWNED lead is rejected — after a claim only the owner (or a
    // leader dispatch) may change the lead (plan 2.3 口径②).
    return this.driver.transaction(async () => {
      const lead = await this.requireLead(parkOrgId, leadId)
      if (lead.status !== 'proposed' && lead.status !== 'confirmed') {
        throw new ParkApiError(400, 'lead_not_claimable', '仅 proposed/confirmed 状态的线索可认领')
      }
      const changes = await this.repo.claimLead(leadId, ownerId)
      if (changes === 0) {
        throw new ParkApiError(409, 'lead_already_owned', '线索已有负责人，不可认领')
      }
      return (await this.repo.getLead(leadId))!
    })
  }

  /**
   * State transition / follow-up update / leader dispatch.
   * Returns { before, after } for audit; throws on illegal transitions.
   * A follow-up-only update (suggested_action without status) persists too —
   * the API contract "跟进（owner 本人）" must work standalone (plan 2.3).
   */
  async transition(input: {
    parkOrgId: string
    leadId: string
    actorUserId: string
    actorIsLeader: boolean
    nextStatus?: LeadStatus
    ownerId?: string
    reason?: string
    suggestedAction?: string | null
  }): Promise<{ before: Lead; after: Lead }> {
    const before = await this.requireLead(input.parkOrgId, input.leadId)
    const isOwner = before.ownerId === input.actorUserId
    const isLeaderDispatch = input.actorIsLeader && input.ownerId !== undefined && input.ownerId !== before.ownerId

    if (isLeaderDispatch) {
      if (!isLeaderOnlyDispatchAllowed(before.status)) {
        throw new ParkApiError(400, 'lead_dispatch_invalid', '当前状态不可分派')
      }
      await this.repo.updateLead(input.leadId, { ownerId: input.ownerId })
      return { before, after: (await this.repo.getLead(input.leadId))! }
    }

    const wantsStatus = input.nextStatus !== undefined
    const wantsFollowUp = input.suggestedAction !== undefined
    if (!wantsStatus && !wantsFollowUp) {
      return { before, after: before }
    }
    // The proposed stage (confirm / reject) happens BEFORE anyone claims the
    // lead, so any park-ops caller may act; later stages — including a
    // follow-up-only update — are owner-only.
    const proposedStage = before.status === 'proposed'
      && (input.nextStatus === 'confirmed' || input.nextStatus === 'rejected')
    if (!isOwner && !proposedStage) {
      throw new ParkApiError(403, 'lead_not_owner', '仅线索负责人可更新状态')
    }
    if (wantsStatus) {
      if (input.nextStatus === 'rejected' && !(input.reason && input.reason.trim())) {
        throw new ParkApiError(400, 'lead_rejection_reason_required', '驳回必须填写理由')
      }
      const allowed = LEAD_TRANSITIONS[before.status]
      if (allowed === null || !allowed.includes(input.nextStatus)) {
        throw new ParkApiError(400, 'lead_transition_invalid', `不允许从 ${before.status} 转换到 ${input.nextStatus}`)
      }
    }
    await this.repo.updateLead(input.leadId, {
      ...(wantsStatus ? { status: input.nextStatus } : {}),
      ...(wantsFollowUp ? { suggestedAction: input.suggestedAction } : {}),
    })
    return { before, after: (await this.repo.getLead(input.leadId))! }
  }

  async requireLead(parkOrgId: string, leadId: string): Promise<Lead> {
    const lead = await this.repo.getLead(leadId)
    if (!lead || lead.parkOrgId !== parkOrgId) {
      throw new ParkApiError(404, 'lead_not_found', '线索不存在')
    }
    return lead
  }
}

function isLeaderOnlyDispatchAllowed(status: LeadStatus): boolean {
  return status === 'confirmed' || status === 'assigned' || status === 'following_up'
}
