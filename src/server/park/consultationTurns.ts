import { createHash, randomUUID } from 'node:crypto'
import { HttpError } from '../httpRespond.js'
import { isUniqueViolation } from '../db/driver.js'
import type { SqlRow } from '../db/driver.js'
import type { ParkStore } from './store.js'
import { mergeSourceRanges, type ConsultationSource } from './consultationSources.js'
import { redactInquiry, extractLeadSignal } from './rules.js'

export interface ConsultationTurn extends SqlRow {
  id: string
  org_id: string
  session_id: string
  request_id: string
  question_hash: string
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  started_at: number
}

/** A persisted reservation makes retries and per-session serialization atomic. */
export class ConsultationTurns {
  constructor(private readonly store: ParkStore) {}

  async begin(orgId: string, sessionId: string, requestId: string, question: string): Promise<{ turn: ConsultationTurn; isNew: boolean }> {
    const hash = createHash('sha256').update(question).digest('hex')
    try {
      return await this.store.db.transaction(async () => {
        const previous = await this.store.db.get<ConsultationTurn>(
          'SELECT * FROM park_consultation_turns WHERE org_id = ? AND session_id = ? AND request_id = ?',
          [orgId, sessionId, requestId],
        )
        if (previous) {
          if (previous.question_hash !== hash) throw new HttpError(409, 'REQUEST_CONTENT_CONFLICT')
          return { turn: previous, isNew: false }
        }
        const turn: ConsultationTurn = { id: randomUUID(), org_id: orgId, session_id: sessionId,
          request_id: requestId, question_hash: hash, status: 'running', started_at: Date.now() }
        await this.store.db.run(`INSERT INTO park_consultation_turns
          (id, org_id, session_id, request_id, question_hash, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)`,
        [turn.id, orgId, sessionId, requestId, hash, turn.started_at])
        return { turn, isNew: true }
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, 'TURN_IN_PROGRESS')
      throw error
    }
  }

  active(orgId: string, sessionId: string): Promise<ConsultationTurn | undefined> {
    return this.store.db.get<ConsultationTurn>(
      "SELECT * FROM park_consultation_turns WHERE org_id = ? AND session_id = ? AND status = 'running'", [orgId, sessionId])
  }

  async suggest(turn: ConsultationTurn, suggestion: Record<string, unknown>): Promise<void> {
    await this.store.db.run("UPDATE park_consultation_turns SET suggestion_json = ? WHERE id = ? AND status = 'running'",
      [JSON.stringify(suggestion), turn.id])
  }

  async retainSources(turn: ConsultationTurn, refs: ConsultationSource[]): Promise<void> {
    await this.store.db.transaction(async () => {
      for (const ref of refs) {
        if (!ref.document_id || !ref.wiki_id) continue
        const key = [turn.id, ref.document_id, ref.wiki_id, ref.version]
        const existing = await this.store.db.get('SELECT source_json FROM park_turn_sources WHERE turn_id = ? AND document_id = ? AND wiki_id = ? AND version = ?', key)
        const old = existing ? JSON.parse(String(existing.source_json)) as ConsultationSource : null
        const merged = { ...ref, ranges: mergeSourceRanges([...(old?.ranges ?? []), ...(ref.ranges ?? [])]) }
        await this.store.db.run(`INSERT INTO park_turn_sources (turn_id, document_id, wiki_id, version, source_json)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT (turn_id, document_id, wiki_id, version) DO UPDATE SET source_json = excluded.source_json`,
        [...key, JSON.stringify(merged)])
      }
    })
  }

  async sources(turn: ConsultationTurn): Promise<ConsultationSource[]> {
    const rows = await this.store.db.all('SELECT source_json FROM park_turn_sources WHERE turn_id = ?', [turn.id])
    return rows.map(row => JSON.parse(String(row.source_json)) as ConsultationSource)
  }

  async complete(turn: ConsultationTurn, question: string, answer: string, refs: ConsultationSource[]): Promise<void> {
    const config = await this.store.config(turn.org_id)
    const redaction = JSON.parse(config?.redaction_config ?? '{}') as { extra_terms?: string[]; summary_max_length?: number }
    const redactedQuestion = redactInquiry(question, redaction)
    const redactedAnswer = redactInquiry(answer, redaction)
    await this.store.db.transaction(async () => {
      const changed = await this.store.db.run("UPDATE park_consultation_turns SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'running'", [Date.now(), turn.id])
      if (changed !== 1) throw new HttpError(409, 'TURN_NOT_RUNNING')
      await this.store.recordInquiry({ orgId: turn.org_id, sessionId: turn.session_id, requestId: turn.request_id,
        inquiryId: turn.id, question: redactedQuestion, answer: redactedAnswer,
        signal: extractLeadSignal(redactedQuestion), sourceRefs: refs })
      await this.store.db.run('UPDATE park_sessions SET last_active_at = ?, message_count = message_count + 1, token_budget_used = token_budget_used + ? WHERE org_id = ? AND id = ?',
        [Date.now(), question.length, turn.org_id, turn.session_id])
    })
  }

  async fail(turn: ConsultationTurn, code: string): Promise<void> {
    await this.store.db.run("UPDATE park_consultation_turns SET status = 'failed', failure_code = ? WHERE id = ? AND status = 'running'", [code, turn.id])
  }

  /** Called once when this single-box service initializes, never by schema migrations. */
  async interruptPending(orgId: string): Promise<string[]> {
    return this.store.db.transaction(async () => {
      const sessions = await this.store.db.all<{ id: string; moss_session_id: string | null }>(`SELECT DISTINCT s.id, s.moss_session_id FROM park_sessions s
        JOIN park_consultation_turns t ON t.org_id = s.org_id AND t.session_id = s.id
        WHERE t.org_id = ? AND t.status = 'running'`, [orgId])
      for (const session of sessions) {
        await this.store.db.run('UPDATE park_sessions SET expires_at = ? WHERE org_id = ? AND id = ?',
          [Date.now(), orgId, session.id])
      }
      await this.store.db.run("UPDATE park_consultation_turns SET status = 'interrupted', failure_code = 'SERVICE_RESTARTED' WHERE org_id = ? AND status = 'running'", [orgId])
      return sessions.flatMap(session => typeof session.moss_session_id === 'string' ? [session.moss_session_id] : [])
    })
  }
}
