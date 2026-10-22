import { createHash } from 'node:crypto'
import type { ParkStore } from './store.js'
import { extractLeadSignal, redactInquiry } from './rules.js'

interface TranscriptEvent {
  type?: string
  uuid?: string
  request_id?: string
  timestamp?: string
  status?: string
  subtype?: string
  stop_reason?: string
  is_error?: boolean
  isSidechain?: boolean
  errors?: unknown[]
  message?: { content?: unknown }
}
export interface HistoricalTurn {
  requestId: string
  question: string
  answer: string
  completedAt: number | null
  isVerified: boolean
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
}

/** A question/answer pair alone is insufficient; completion must be explicit and tied to its request. */
export function inspectHistoricalTurns(transcript: string): HistoricalTurn[] {
  const turns: HistoricalTurn[] = []
  let current: HistoricalTurn | null = null
  const finish = () => { if (current) turns.push(current); current = null }
  for (const line of transcript.split(/\r?\n/)) {
    if (!line.trim()) continue
    const event = JSON.parse(line) as TranscriptEvent
    if (event.isSidechain) continue
    if (event.type === 'user') {
      const question = textContent(event.message?.content)
      if (!question) continue
      finish()
      current = { requestId: event.uuid ?? '', question, answer: '', completedAt: null, isVerified: false }
    } else if (event.type === 'assistant' && current && !event.is_error) {
      current.answer += textContent(event.message?.content)
    } else if (event.type === 'result' && current) {
      const time = Date.parse(event.timestamp ?? '')
      current.isVerified = Boolean(current.answer.trim() && /^[0-9a-f-]{36}$/i.test(current.requestId)
        && event.request_id === current.requestId && event.status === 'success' && !event.is_error
        && !event.errors?.length && (!event.stop_reason || event.stop_reason === 'end_turn') && Number.isFinite(time))
      current.completedAt = Number.isFinite(time) ? time : null
      finish()
    }
  }
  finish()
  return turns
}

/** Apply only proven completions; preserve legacy records and never infer historical policy versions. */
export async function recoverHistoricalTurns(store: ParkStore, orgId: string, sessionId: string,
  turns: HistoricalTurn[], isApply = false) {
  const session = await store.session(orgId, sessionId)
  if (!session) throw new Error('Park session not found')
  const config = await store.config(orgId)
  const redaction = JSON.parse(config?.redaction_config ?? '{}')
  const report: Array<{ request_id: string; status: string }> = []
  for (const turn of turns) {
    if (!turn.isVerified || turn.completedAt === null) {
      report.push({ request_id: turn.requestId, status: 'completion_unverified' }); continue
    }
    const existing = await store.inquiryByRequest(sessionId, turn.requestId)
    if (existing) { report.push({ request_id: turn.requestId, status: 'already_recorded' }); continue }
    const hasReservations = await store.db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'park_consultation_turns'")
    const reservation = hasReservations ? await store.db.get('SELECT id FROM park_consultation_turns WHERE session_id = ? AND request_id = ?', [sessionId, turn.requestId]) : null
    if (reservation) { report.push({ request_id: turn.requestId, status: 'reservation_requires_review' }); continue }
    const question = redactInquiry(turn.question, redaction), answer = redactInquiry(turn.answer, redaction)
    // Legacy agent IDs cannot be matched to public IDs. Even exact text may represent a repeated question.
    const ambiguous = await store.db.get('SELECT id FROM park_inquiries WHERE org_id = ? AND session_id = ? AND redacted_question = ? AND redacted_answer = ?',
      [orgId, sessionId, question, answer])
    if (ambiguous) { report.push({ request_id: turn.requestId, status: 'legacy_pair_requires_review' }); continue }
    if (isApply) await store.db.transaction(async () => {
      const id = await store.recordInquiry({ orgId, sessionId, requestId: turn.requestId, inquiryId: turn.requestId,
        question, answer, signal: extractLeadSignal(question), sourceRefs: [] })
      await store.db.run('UPDATE park_inquiries SET created_at = ? WHERE id = ?', [turn.completedAt!, id])
      await store.db.run(`INSERT INTO park_consultation_turns (id, org_id, session_id, request_id, question_hash, status, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`,
      [id, orgId, sessionId, turn.requestId, createHash('sha256').update(turn.question).digest('hex'), turn.completedAt!, turn.completedAt!])
      await store.db.run(`UPDATE park_sessions SET message_count = MAX(message_count, (SELECT COUNT(*) FROM park_inquiries WHERE session_id = ? AND completion_status = 'completed')) WHERE org_id = ? AND id = ?`,
        [sessionId, orgId, sessionId])
    })
    report.push({ request_id: turn.requestId, status: isApply ? 'recovered' : 'recoverable' })
  }
  return report
}
