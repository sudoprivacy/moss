import type { DbDriver } from '../db/driver.js'
import { ParkApiError } from './parkAuthorization.js'
import { ParkRepository, type Inquiry } from './parkRepository.js'
import { redactText } from './redaction.js'

/**
 * Inquiry write path + projection (方案 §7.2). Raw question/answer live in the
 * session transcript; the DB stores refs plus rule-redacted copies. The
 * `projectForPark` view is the ONLY shape ever returned to park roles — it
 * never includes question_ref/answer_ref.
 */

export const INQUIRY_INTENTS = [
  'policy_inquiry', 'settlement_intent', 'rent_consultation', 'subsidy_application',
  'service_request', 'other',
] as const
export type InquiryIntent = typeof INQUIRY_INTENTS[number]

export type AppendInquiryInput = {
  parkOrgId: string
  enterpriseOrgId: string
  userId: string
  assistantSessionId?: string | null
  question: string
  answer?: string | null
  category: 'consultation' | 'service_request'
  intent?: string | null
  industryTags?: string[]
  policyHitCount?: number
  sourceRefs?: Array<{ file: string; line_no: number; line: string }>
}

/**
 * Deterministic confidence rule (plan 2.4): weighted completeness of the
 * assistant-supplied fields plus this turn's policy hits. Model-free so tests
 * can construct low/high confidence inputs exactly.
 *   intent valid           → 30
 *   industryTags present    → 20 (+10 when ≥2 tags)
 *   policy hits             → min(40, hits × 20)
 */
export function computeConfidence(input: {
  intent?: string | null
  industryTags?: string[]
  policyHitCount?: number
}): number {
  let score = 0
  if (input.intent && (INQUIRY_INTENTS as readonly string[]).includes(input.intent)) score += 30
  const tags = input.industryTags ?? []
  if (tags.length > 0) score += 20
  if (tags.length >= 2) score += 10
  score += Math.min(40, (input.policyHitCount ?? 0) * 20)
  return Math.min(100, score)
}

export class InquiryService {
  private readonly repo: ParkRepository

  constructor(driver: DbDriver) {
    this.repo = new ParkRepository(driver)
  }

  async append(input: AppendInquiryInput): Promise<Inquiry> {
    if (input.intent && !(INQUIRY_INTENTS as readonly string[]).includes(input.intent)) {
      throw new ParkApiError(400, 'invalid_intent', `intent 必须是 ${INQUIRY_INTENTS.join(' | ')} 之一`)
    }
    const confidence = computeConfidence(input)
    return this.repo.insertInquiry({
      parkOrgId: input.parkOrgId,
      enterpriseOrgId: input.enterpriseOrgId,
      userId: input.userId,
      assistantSessionId: input.assistantSessionId ?? null,
      questionRef: input.assistantSessionId ? `${input.assistantSessionId}#q` : null,
      redactedQuestion: redactText(input.question),
      answerRef: input.assistantSessionId ? `${input.assistantSessionId}#a` : null,
      redactedAnswer: redactText(input.answer ?? null),
      category: input.category,
      intent: input.intent ?? null,
      confidence,
      sourceRefsJson: input.sourceRefs && input.sourceRefs.length > 0 ? JSON.stringify(input.sourceRefs) : null,
      consentState: 'granted',
    })
  }

  async listForPark(parkOrgId: string): Promise<Array<ParkInquiryView & { hasLead: boolean }>> {
    const inquiries = await this.repo.listInquiriesByPark(parkOrgId)
    return Promise.all(inquiries.map(async inquiry => ({
      ...projectForPark(inquiry),
      hasLead: await this.hasLead(inquiry.inquiryId),
    })))
  }

  async listForEnterprise(enterpriseOrgId: string): Promise<ParkInquiryView[]> {
    const inquiries = await this.repo.listInquiriesByEnterprise(enterpriseOrgId)
    return inquiries.map(projectForEnterprise)
  }

  private async hasLead(inquiryId: string): Promise<boolean> {
    const rows = await this.repo.listLeadsByInquiry(inquiryId)
    return rows.length > 0
  }
}

export type ParkInquiryView = {
  inquiry_id: string
  park_org_id: string
  enterprise_org_id: string
  user_id: string
  assistant_session_id: string | null
  redacted_question: string | null
  redacted_answer: string | null
  category: Inquiry['category']
  intent: string | null
  confidence: number | null
  source_refs: Array<{ file: string; line_no: number; line: string }>
  consent_state: string
  created_at: number
}

function parseSourceRefs(raw: string | null): Array<{ file: string; line_no: number; line: string }> {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function projectForPark(inquiry: Inquiry): ParkInquiryView {
  return {
    inquiry_id: inquiry.inquiryId,
    park_org_id: inquiry.parkOrgId,
    enterprise_org_id: inquiry.enterpriseOrgId,
    user_id: inquiry.userId,
    assistant_session_id: inquiry.assistantSessionId,
    redacted_question: inquiry.redactedQuestion,
    redacted_answer: inquiry.redactedAnswer,
    category: inquiry.category,
    intent: inquiry.intent,
    confidence: inquiry.confidence,
    source_refs: parseSourceRefs(inquiry.sourceRefsJson),
    consent_state: inquiry.consentState,
    created_at: inquiry.createdAt,
  }
}

/** Enterprise view: own records — same redacted projection (refs stay internal). */
function projectForEnterprise(inquiry: Inquiry): ParkInquiryView {
  return projectForPark(inquiry)
}
