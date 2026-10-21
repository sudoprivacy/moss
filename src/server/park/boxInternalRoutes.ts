import type http from 'node:http'
import { readFile } from 'node:fs/promises'
import { timingSafeEqual, randomUUID } from 'node:crypto'
import type { AuthService } from '../auth/service.js'
import type { DocumentStore } from '../documentStore.js'
import { HttpError, writeJson } from '../httpRespond.js'
import { probeBoxBusiness, probeBoxModel } from './boxBusinessProbes.js'
import type { ParkAgentChannel } from './agentChannel.js'
import type { ParkStore } from './store.js'
import { readBoxBuild } from './boxVersion.js'

export async function boxMaintenanceToken(): Promise<string | null> {
  const file = process.env.PARK_BOX_MAINTENANCE_FILE
  if (!file) return null
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!value || typeof value !== 'object' || !('token' in value) || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)) throw new HttpError(503, 'Box maintenance state is invalid')
    return value.token
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new HttpError(503, 'Box maintenance state cannot be read') }
}

function matchesToken(expected: string | null, actual: unknown): boolean {
  return typeof actual === 'string' && expected !== null && Buffer.byteLength(actual) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}

/** Only the independent operations container can bypass the maintenance gate. */
export async function assertBoxAvailable(req: http.IncomingMessage): Promise<void> {
  const token = await boxMaintenanceToken()
  if (token && !matchesToken(token, req.headers['x-park-box-token'])) throw new HttpError(503, 'Park box maintenance is in progress')
}

export async function handleBoxInternalRoute(req: http.IncomingMessage, res: http.ServerResponse, path: string,
  deps: { store: ParkStore; orgId: string | null; auth: AuthService; documents: DocumentStore; channel: ParkAgentChannel }): Promise<boolean> {
  if (!path.startsWith('/internal/park-box/')) return false
  if (req.method !== 'POST' || !deps.orgId || !matchesToken(await boxMaintenanceToken(), req.headers['x-park-box-token'])) throw new HttpError(403, 'Box verification token is required')
  const action = path.split('/').at(-1)
  if (!['probe', 'verify', 'reindex', 'model-check', 'versions'].includes(action ?? '')) throw new HttpError(404, 'Unknown box verification')
  if (action === 'versions') {
    const build = await readBoxBuild()
    const revisions = await deps.store.db.all<{ revision: string }>('SELECT revision FROM park_box_database_revisions')
    writeJson(res, 200, { ...build, database_revisions: revisions.map(row => row.revision) })
    return true
  }
  if (action === 'model-check') {
    writeJson(res, 200, { healthy: true, model: await probeBoxModel(deps.auth, deps.orgId, true) })
    return true
  }
  const config = await deps.store.config(deps.orgId)
  const assistant = JSON.parse(config?.assistant_config ?? '{}') as { assistant_id?: string; policy_wiki_id?: string }
  if (action === 'reindex') {
    if (!assistant.policy_wiki_id || !(await deps.documents.getWiki(assistant.policy_wiki_id, deps.orgId))) throw new HttpError(503, 'The park policy Wiki is missing')
    const job = await deps.documents.createBuildJob({ wikiId: assistant.policy_wiki_id, triggeredBy: 'park-box-operations' })
    await deps.documents.setWikiBuildResult(assistant.policy_wiki_id, { status: 'pending' })
    const deadline = Date.now() + 9 * 60_000
    while (true) {
      const latest = await deps.documents.getLatestBuildJob(assistant.policy_wiki_id)
      if (latest?.id !== job.id) throw new HttpError(409, 'A newer policy build replaced this operation')
      if (latest.status === 'succeeded') break
      if (latest.status === 'failed' || latest.status === 'cancelled') throw new HttpError(502, 'Policy build failed; inspect the policy build result')
      if (Date.now() >= deadline) throw new HttpError(504, 'Policy build verification timed out')
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
  const result = await probeBoxBusiness(deps.store, deps.documents, deps.auth, deps.orgId, true)
  if (!result.assistant.healthy) throw new HttpError(503, 'The public Assistant is not published')
  let consultation: unknown
  if (action === 'verify') {
    if (!assistant.assistant_id) throw new HttpError(503, 'The public Assistant identifier is missing')
    const base = process.env.MOSS_SERVER_URL || 'http://moss:43127'
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-park-box-token': String(req.headers['x-park-box-token']) }
    const created = await fetch(`${base}/public/consult/sessions`, { method: 'POST', headers, body: JSON.stringify({ source_channel: 'other' }), signal: AbortSignal.timeout(120_000) })
    if (!created.ok) throw new HttpError(502, `Public session verification failed (HTTP ${created.status})`)
    const anonymous = await created.json() as { session_id: string }
    headers.cookie = `park_session=${anonymous.session_id}`
    try {
      const question = (await deps.store.quickQuestions(deps.orgId, true))[0]?.question
      if (typeof question !== 'string' || !question.trim()) throw new HttpError(503, 'Initialize the public quick questions')
      const response = await fetch(`${base}/public/sessions/${anonymous.session_id}/messages`, { method: 'POST', headers,
        body: JSON.stringify({ message: question, client_request_id: randomUUID() }), signal: AbortSignal.timeout(150_000) })
      if (!response.ok) throw new HttpError(502, `Public consultation verification failed (HTTP ${response.status})`)
      const stream = await response.text()
      if (!stream.includes('event: delta') || !stream.includes('event: done') || stream.includes('event: error')) throw new HttpError(502, 'The public Assistant did not complete its streamed answer')
      const inquiry = await deps.store.db.get<{ source_refs_json: string; redacted_answer: string }>('SELECT source_refs_json, redacted_answer FROM park_inquiries WHERE org_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 1', [deps.orgId, anonymous.session_id])
      if (!inquiry) throw new HttpError(502, 'The consultation did not record a real inquiry')
      if (!inquiry.redacted_answer.trim()) throw new HttpError(502, 'The recorded consultation answer is empty')
      const sources = JSON.parse(inquiry.source_refs_json) as Array<{ source_id?: string; wiki_id?: string }>
      if (!sources.length || sources.some(source => !source.source_id || source.wiki_id !== assistant.policy_wiki_id)) throw new HttpError(502, 'The consultation did not record verified policy citations')
      for (const source of sources) {
        const preview = await fetch(`${base}/public/sessions/${anonymous.session_id}/sources/${source.source_id}/preview`, { headers, signal: AbortSignal.timeout(10_000) })
        if (!preview.ok) throw new HttpError(502, 'The verified policy citation cannot be opened')
      }
      consultation = { healthy: true, recorded: true, verified_source_count: sources.length }
    } finally {
      const stored = await deps.store.session(deps.orgId, anonymous.session_id)
      if (stored?.moss_session_id) await deps.channel.terminate(stored.moss_session_id)
      await deps.store.db.run('UPDATE park_sessions SET expires_at = ? WHERE id = ?', [Date.now(), anonymous.session_id])
    }
  }
  writeJson(res, 200, { healthy: true, ...result, consultation })
  return true
}
