import type { ParkStore } from './store.js'

export const PARK_PUBLIC_SESSION_SOURCE = 'park_public_consultation'

/** Session details reuse the persisted, redacted inquiry records. */
export async function parkPublicSessionMessages(store: ParkStore, orgId: string, sessionId: string): Promise<Record<string, unknown>[] | null> {
  if (!await store.session(orgId, sessionId)) return null
  const rows = await store.db.all<{ id: string; redacted_question: string; redacted_answer: string; source_refs_json: string; created_at: number }>(
    'SELECT id, redacted_question, redacted_answer, source_refs_json, created_at FROM park_inquiries WHERE org_id = ? AND session_id = ? ORDER BY created_at, id',
    [orgId, sessionId],
  )
  return rows.flatMap(row => {
    const timestamp = new Date(Number(row.created_at)).toISOString()
    return [
      { type: 'user', role: 'user', content: [{ type: 'text', text: row.redacted_question }], uuid: `${row.id}-user`, timestamp },
      { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: row.redacted_answer }], sourceRefs: JSON.parse(row.source_refs_json) as unknown[], uuid: `${row.id}-assistant`, timestamp },
    ]
  })
}
