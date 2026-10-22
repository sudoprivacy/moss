import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { SqliteDriver } from '../src/server/db/driver.js'
import { ParkStore } from '../src/server/park/store.js'
import { inspectHistoricalTurns, recoverHistoricalTurns } from '../src/server/park/historyRecovery.js'
import { PARK_PUBLIC_SESSION_SOURCE } from '../src/server/park/mossSessions.js'

const args = process.argv.slice(2)
const isApply = args.includes('--apply')
const [databasePath, orgId] = args.filter(arg => arg !== '--apply')
if (!databasePath || !orgId) throw new Error('Usage: node --import tsx scripts/recover-park-leadership-history.ts <moss.db> <org-id> [--apply]')
const db = new DatabaseSync(databasePath, { readOnly: !isApply })
const store = new ParkStore(new SqliteDriver(db))
try {
  // Dry-run opens the database read-only and performs no schema changes.
  if (isApply) await store.init()
  const sessions = db.prepare(`SELECT p.id, s.transcript_path FROM park_sessions p JOIN sessions s
    ON s.session_id = p.moss_session_id AND s.org_id = p.org_id WHERE p.org_id = ? AND s.source = ?`).all(orgId, PARK_PUBLIC_SESSION_SOURCE)
  for (const session of sessions) {
    try {
      const transcript = await readFile(String(session.transcript_path), 'utf8')
      const turns = inspectHistoricalTurns(transcript)
      // Older databases have no reservation table. Unverified pairs never need that table.
      const report = await recoverHistoricalTurns(store, orgId, String(session.id), turns, isApply)
      process.stdout.write(`${JSON.stringify({ session_id: session.id, mode: isApply ? 'apply' : 'dry-run', turns: report })}\n`)
    } catch {
      process.stdout.write(`${JSON.stringify({ session_id: session.id, status: 'transcript_or_schema_requires_review' })}\n`)
    }
  }
} finally { await store.db.close() }
