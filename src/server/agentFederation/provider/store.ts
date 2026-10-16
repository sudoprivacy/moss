import { randomUUID } from 'node:crypto'
import type { DbDriver, SqlRow } from '../../db/driver.js'
import { DURABLE_AGENT_HTTP_API, type AgentRun, type SubmitAgentRun } from '../../../../contracts/agent-http/v1alpha2/contract.js'
import { AgentProtocolError, contentDigest, parseAgentRun, parseSubmitAgentRun } from './protocol.js'

type RunRow = SqlRow & { client_id: string; invocation_id: string; request_digest: string; request: string; document: string; owner: string | null; lease_until: number; status: AgentRun['status']; session_id: string }
export type ModelMessage = { role: 'user' | 'assistant'; content: string }
export interface ClaimedRun { clientId: string; request: SubmitAgentRun; run: AgentRun; owner: string; history: ModelMessage[] }
const terminal = (status: AgentRun['status']) => !['accepted', 'running'].includes(status)
export const RUN_LEASE_MS = 30_000

/** Provider-private durable store. A running model request is never automatically repeated. */
export class AgentRunStore {
  readonly ready: Promise<void>
  constructor(readonly db: DbDriver) {
    this.ready = db.exec(`
      CREATE TABLE IF NOT EXISTS http_agent_clients (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS http_agent_maintenance (id TEXT PRIMARY KEY, next_run_at BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS http_agent_sessions (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL, end_user TEXT NOT NULL, agent_id TEXT NOT NULL,
        revision TEXT NOT NULL, active_run TEXT, history TEXT NOT NULL, turns INTEGER NOT NULL, updated_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS http_agent_sessions_retention ON http_agent_sessions(updated_at);
      CREATE TABLE IF NOT EXISTS http_agent_runs (
        client_id TEXT NOT NULL, invocation_id TEXT NOT NULL, request_digest TEXT NOT NULL,
        session_id TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL,
        owner TEXT, lease_until BIGINT NOT NULL, deadline_at BIGINT NOT NULL,
        execution_revision TEXT NOT NULL, sequence INTEGER NOT NULL, updated_at BIGINT NOT NULL, retired INTEGER NOT NULL DEFAULT 0, document TEXT NOT NULL,
        PRIMARY KEY(client_id, invocation_id)
      );
      CREATE INDEX IF NOT EXISTS http_agent_runs_queue ON http_agent_runs(status, deadline_at, client_id, invocation_id);
      CREATE INDEX IF NOT EXISTS http_agent_runs_lease ON http_agent_runs(status, lease_until);
      CREATE INDEX IF NOT EXISTS http_agent_runs_revision_queue ON http_agent_runs(execution_revision, status, deadline_at);
      CREATE INDEX IF NOT EXISTS http_agent_runs_retention ON http_agent_runs(retired, updated_at);
    `)
  }
  async now(): Promise<number> {
    const row = await this.db.get(this.db.kind === 'postgres'
      ? 'SELECT CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT) AS now'
      : "SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now")
    return Number(row!.now)
  }
  private async row(clientId: string, invocationId: string): Promise<RunRow | undefined> {
    return this.db.get<RunRow>('SELECT * FROM http_agent_runs WHERE client_id = ? AND invocation_id = ?', [clientId, invocationId])
  }
  async get(clientId: string, invocationId: string): Promise<AgentRun> {
    await this.ready
    const row = await this.row(clientId, invocationId)
    if (!row) throw new AgentProtocolError(404, 'RUN_NOT_FOUND')
    return parseAgentRun(JSON.parse(row.document))
  }
  async submit(clientId: string, value: SubmitAgentRun): Promise<AgentRun> {
    const input = parseSubmitAgentRun(value), hash = contentDigest(input)
    await this.ready
    return this.db.transaction(async () => {
      await this.db.run('INSERT INTO http_agent_clients(id) VALUES (?) ON CONFLICT(id) DO NOTHING', [clientId])
      await this.db.run('UPDATE http_agent_clients SET id = id WHERE id = ?', [clientId])
      const previous = await this.row(clientId, input.invocation_id)
      if (previous) {
        if (previous.request_digest !== hash) throw new AgentProtocolError(409, 'IDEMPOTENCY_CONFLICT')
        return parseAgentRun(JSON.parse(previous.document))
      }
      const now = await this.now()
      if (input.deadline_at <= now || input.deadline_at > now + 120_000) throw new AgentProtocolError(400, 'INVALID_RUN_DEADLINE')
      const count = await this.db.get('SELECT COUNT(*) AS total FROM http_agent_runs WHERE client_id = ?', [clientId])
      if (Number(count?.total) >= 100_000) throw new AgentProtocolError(429, 'RUN_CAPACITY_REACHED')
      const active = await this.db.get("SELECT COUNT(*) AS total FROM http_agent_runs WHERE client_id = ? AND status IN ('accepted', 'running')", [clientId])
      if (Number(active?.total) >= 32) throw new AgentProtocolError(429, 'RUN_CONCURRENCY_LIMIT')
      const sessionId = input.provider_session_id ?? randomUUID()
      if (!input.provider_session_id) {
        await this.db.run('INSERT INTO http_agent_sessions(id, client_id, end_user, agent_id, revision, history, turns, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)', [sessionId, clientId, input.end_user, input.external_agent_id, input.execution_revision, '[]', now])
      }
      const locked = await this.db.run(`UPDATE http_agent_sessions SET active_run = ?, updated_at = ?
        WHERE id = ? AND client_id = ? AND end_user = ? AND agent_id = ? AND revision = ? AND active_run IS NULL AND turns < 100`,
      [input.invocation_id, now, sessionId, clientId, input.end_user, input.external_agent_id, input.execution_revision])
      if (!locked) throw new AgentProtocolError(409, 'SESSION_UNAVAILABLE')
      const run: AgentRun = {
        api_version: DURABLE_AGENT_HTTP_API, kind: 'AgentRun', invocation_id: input.invocation_id,
        request_digest: hash, external_agent_id: input.external_agent_id, execution_revision: input.execution_revision,
        provider_run_id: randomUUID(), provider_session_id: sessionId, status: 'accepted', sequence: 1,
        output: { text: '' }, error_code: null, created_at: now, updated_at: now,
      }
      await this.db.run(`INSERT INTO http_agent_runs(client_id, invocation_id, request_digest, session_id, request, status, lease_until, deadline_at, execution_revision, sequence, updated_at, document)
        VALUES (?, ?, ?, ?, ?, 'accepted', 0, ?, ?, 1, ?, ?)`, [clientId, input.invocation_id, hash, sessionId, JSON.stringify(input), input.deadline_at, input.execution_revision, now, JSON.stringify(run)])
      return run
    })
  }
  async queued(revisions: string[], limit = 32): Promise<{ clientId: string; invocationId: string }[]> {
    await this.ready
    if (!revisions.length) return []
    return (await this.db.all(`SELECT client_id, invocation_id FROM http_agent_runs WHERE status = 'accepted' AND execution_revision IN (${revisions.map(() => '?').join(',')}) ORDER BY deadline_at, client_id, invocation_id LIMIT ?`, [...revisions, limit])).map(row => ({ clientId: String(row.client_id), invocationId: String(row.invocation_id) }))
  }
  private async lock(clientId: string, invocationId: string) {
    await this.db.run('UPDATE http_agent_runs SET sequence = sequence WHERE client_id = ? AND invocation_id = ?', [clientId, invocationId])
    return this.row(clientId, invocationId)
  }
  async claim(clientId: string, invocationId: string): Promise<ClaimedRun | null> {
    await this.ready
    return this.db.transaction(async () => {
      const row = await this.lock(clientId, invocationId), now = await this.now()
      if (!row || row.status !== 'accepted') return null
      if (Number(row.deadline_at) <= now) { await this.settle(row, 'failed', '', 'DEADLINE_EXPIRED', now); return null }
      const owner = randomUUID(), run = parseAgentRun(JSON.parse(row.document))
      const request = parseSubmitAgentRun(JSON.parse(row.request))
      const session = await this.db.get('SELECT history FROM http_agent_sessions WHERE id = ? AND client_id = ?', [row.session_id, clientId])
      if (!session) throw new AgentProtocolError(500, 'SESSION_STATE_MISSING')
      run.status = 'running'; run.sequence++; run.updated_at = now
      // Commit intent before the model call. Expired ownership becomes unknown, never accepted.
      await this.db.run("UPDATE http_agent_runs SET status = 'running', owner = ?, lease_until = ?, sequence = ?, updated_at = ?, document = ? WHERE client_id = ? AND invocation_id = ?", [owner, now + RUN_LEASE_MS, run.sequence, now, JSON.stringify(run), clientId, invocationId])
      return { clientId, request, run, owner, history: JSON.parse(String(session.history)) as ModelMessage[] }
    })
  }
  async renew(claim: ClaimedRun): Promise<boolean> {
    return this.db.transaction(async () => {
      const row = await this.lock(claim.clientId, claim.request.invocation_id), now = await this.now()
      if (!row || row.status !== 'running' || row.owner !== claim.owner || Number(row.lease_until) <= now || Number(row.deadline_at) <= now) return false
      return Boolean(await this.db.run('UPDATE http_agent_runs SET lease_until = ? WHERE client_id = ? AND invocation_id = ? AND owner = ?', [now + RUN_LEASE_MS, claim.clientId, claim.request.invocation_id, claim.owner]))
    })
  }
  async finish(claim: ClaimedRun, text: string, status: 'succeeded' | 'failed' | 'unknown', error: string | null = null): Promise<boolean> {
    if (text.length > 128_000 || (status !== 'succeeded' && text)) throw new AgentProtocolError(500, 'INVALID_RUN_OUTPUT')
    return this.db.transaction(async () => {
      const row = await this.lock(claim.clientId, claim.request.invocation_id), now = await this.now()
      if (!row || row.status !== 'running' || row.owner !== claim.owner || Number(row.lease_until) <= now || Number(row.deadline_at) <= now) return false
      await this.settle(row, status, text, error, now)
      return true
    })
  }
  private async settle(row: RunRow, status: AgentRun['status'], text: string, error: string | null, now: number) {
    const run = parseAgentRun(JSON.parse(row.document))
    run.status = status; run.output = { text }; run.error_code = error; run.sequence++; run.updated_at = now
    parseAgentRun(run)
    await this.db.run('UPDATE http_agent_runs SET status = ?, owner = NULL, lease_until = 0, sequence = ?, updated_at = ?, document = ? WHERE client_id = ? AND invocation_id = ?', [status, run.sequence, now, JSON.stringify(run), row.client_id, row.invocation_id])
    if (status === 'unknown') return // Unknown sessions stay closed to subsequent execution.
    const session = await this.db.get('SELECT history FROM http_agent_sessions WHERE id = ? AND client_id = ?', [row.session_id, row.client_id])
    const history = session ? JSON.parse(String(session.history)) as ModelMessage[] : []
    if (status === 'succeeded') {
      const input = parseSubmitAgentRun(JSON.parse(row.request))
      history.push({ role: 'user', content: input.query }, { role: 'assistant', content: text })
      // Bounded context of complete turns, not unbounded transcript concatenation.
      while (history.length > 20 || JSON.stringify(history).length > 128_000) history.splice(0, 2)
    }
    await this.db.run('UPDATE http_agent_sessions SET active_run = NULL, history = ?, turns = turns + 1, updated_at = ? WHERE id = ? AND client_id = ? AND active_run = ?', [JSON.stringify(history), now, row.session_id, row.client_id, row.invocation_id])
  }
  /** Guaranteed cancellation only before dispatch. Running cancellation remains unsupported. */
  async cancelQueued(clientId: string, invocationId: string): Promise<AgentRun> {
    await this.ready
    return this.db.transaction(async () => {
      const row = await this.lock(clientId, invocationId)
      if (!row) throw new AgentProtocolError(404, 'RUN_NOT_FOUND')
      if (row.status === 'running' || row.status === 'unknown') throw new AgentProtocolError(409, 'REMOTE_CANCELLATION_UNSUPPORTED')
      if (!terminal(row.status)) await this.settle(row, 'cancelled', '', 'CANCELLED_BEFORE_DISPATCH', await this.now())
      return this.get(clientId, invocationId)
    })
  }
  async maintain(): Promise<number> {
    await this.ready
    const now = await this.now()
    const rows = await this.db.all<RunRow>("SELECT * FROM http_agent_runs WHERE (status = 'running' AND lease_until <= ?) OR (status IN ('accepted', 'running') AND deadline_at <= ?) ORDER BY deadline_at LIMIT 100", [now, now])
    let settled = 0
    for (const candidate of rows) await this.db.transaction(async () => {
      const row = await this.lock(candidate.client_id, candidate.invocation_id), current = await this.now()
      if (!row || terminal(row.status) || (Number(row.deadline_at) > current && (row.status !== 'running' || Number(row.lease_until) > current))) return
      await this.settle(row, row.status === 'accepted' ? 'failed' : 'unknown', '', row.status === 'accepted' ? 'DEADLINE_EXPIRED' : 'MODEL_EXECUTION_UNCONFIRMED', current)
      settled++
    })
    // Permanent key/hash tombstones prevent execution after retention. Unknown evidence is retained.
    const retired = await this.db.all<RunRow>("SELECT * FROM http_agent_runs WHERE retired = 0 AND status IN ('succeeded', 'failed', 'cancelled') AND updated_at < ? ORDER BY updated_at LIMIT 100", [now - 30 * 86400_000])
    for (const row of retired) {
      const run = parseAgentRun(JSON.parse(row.document)); run.output.text = ''; run.error_code = 'RUN_PAYLOAD_RETIRED'
      await this.db.run('UPDATE http_agent_runs SET request = ?, document = ?, retired = 1 WHERE client_id = ? AND invocation_id = ? AND retired = 0', ['{}', JSON.stringify(run), row.client_id, row.invocation_id])
    }
    await this.db.run(`DELETE FROM http_agent_sessions WHERE id IN (
      SELECT id FROM http_agent_sessions WHERE active_run IS NULL AND updated_at < ? ORDER BY updated_at, id LIMIT 100)`, [now - 30 * 86400_000])
    return settled
  }

  /** Shared maintenance claim; idle workers read the schedule instead of each scanning/writing expiry. */
  async scheduledMaintenance(): Promise<void> {
    await this.ready
    const now = await this.now()
    const schedule = await this.db.get("SELECT next_run_at FROM http_agent_maintenance WHERE id = 'runs'")
    if (schedule && Number(schedule.next_run_at) > now) return
    await this.db.transaction(async () => {
      await this.db.run("INSERT INTO http_agent_maintenance(id, next_run_at) VALUES ('runs', 0) ON CONFLICT(id) DO NOTHING")
      if (!await this.db.run("UPDATE http_agent_maintenance SET next_run_at = ? WHERE id = 'runs' AND next_run_at <= ?", [now + 1000, now])) return
      await this.maintain()
    })
  }
}
