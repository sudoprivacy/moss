import { randomUUID } from 'node:crypto'
import { redactInquiry } from './rules.js'
import type { ParkStore } from './store.js'

export interface AgentInquiryInput {
  orgId: string
  sessionId: string
  question: string
  answer: string
  intent: string
  industryTags: string[]
  /** Server-recorded policy hits for this turn (client reports are ignored). */
  policyHitCount: number
  sourceRefs: Array<{ name: string; version: string; section: string }>
  redactionConfig?: { extra_terms?: string[]; summary_max_length?: number }
}

const VALID_INTENTS = new Set(['policy_inquiry', 'settlement_intent', 'rent_consultation', 'subsidy_application', 'service_request', 'other'])

/**
 * Deterministic confidence, ported from the reference branch's inquiry service:
 * valid intent +30, industry tags +20 (+10 more at ≥2), policy hits ×20 capped
 * at 40, total capped at 100. No model judgement is trusted for scoring.
 */
export function computeAgentConfidence(intent: string, industryTags: string[], policyHitCount: number): number {
  let score = 0
  if (VALID_INTENTS.has(intent)) score += 30
  if (industryTags.length > 0) score += 20
  if (industryTags.length >= 2) score += 10
  score += Math.min(40, Math.max(0, policyHitCount) * 20)
  return Math.min(100, score)
}

export function isValidAgentIntent(intent: string): boolean {
  return VALID_INTENTS.has(intent)
}

/** Persist one agent-recorded consultation turn (redacted, idempotent per server-generated request id). */
export async function appendAgentInquiry(store: ParkStore, input: AgentInquiryInput): Promise<string> {
  const id = randomUUID()
  const confidence = computeAgentConfidence(input.intent, input.industryTags, input.policyHitCount)
  await store.db.run(
    `INSERT INTO park_inquiries (id, org_id, session_id, client_request_id, redacted_question, redacted_answer, category, intent, industry, scale, urgency, concerns_json, confidence, source_refs_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.orgId,
      input.sessionId,
      `agent-${id}`,
      redactInquiry(input.question, input.redactionConfig),
      redactInquiry(input.answer, input.redactionConfig),
      'consultation',
      VALID_INTENTS.has(input.intent) ? input.intent : 'other',
      input.industryTags.length ? input.industryTags.join('、').slice(0, 200) : null,
      null,
      null,
      JSON.stringify(input.industryTags.slice(0, 20)),
      confidence,
      JSON.stringify(input.sourceRefs.slice(0, 20)),
      Date.now(),
    ],
  )
  return id
}
