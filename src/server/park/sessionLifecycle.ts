import { HttpError } from '../httpRespond.js'
import { PerKeyMutex } from '../runtime/perKeyMutex.js'
import type { ParkAgentChannel, PreparedParkTurn } from './agentChannel.js'
import type { ParkSessionRow, ParkStore } from './store.js'

export function parkIdleMs(rateConfig: string): number {
  const rate = JSON.parse(rateConfig || '{}') as Record<string, unknown>
  return (Number(rate.anonymous_session_idle_minutes) || 30) * 60_000
}

/** One coordinator per store, shared by HTTP requests and the reclaim timer. */
export class ParkSessionLifecycle {
  private readonly sessions = new PerKeyMutex()
  private readonly admissions = new PerKeyMutex()

  constructor(private readonly store: ParkStore) {}

  withSession<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return this.sessions.run(id, operation)
  }

  async usable(orgId: string, id: string, now = Date.now()): Promise<ParkSessionRow | undefined> {
    const session = await this.store.session(orgId, id)
    if (!session || Number(session.expires_at) <= now) return undefined
    const config = await this.store.config(orgId)
    const running = await this.store.db.get(
      "SELECT id FROM park_consultation_turns WHERE session_id = ? AND status = 'running'", [id],
    )
    if (!running && now - Number(session.last_active_at) >= parkIdleMs(config?.rate_config || '{}')) return undefined
    return session
  }

  async prepare(session: ParkSessionRow, channel: ParkAgentChannel): Promise<PreparedParkTurn> {
    return this.admissions.run(session.org_id, async () => {
      const config = await this.store.config(session.org_id)
      const rate = JSON.parse(config?.rate_config || '{}') as Record<string, unknown>
      const boundId = session.moss_session_id
      if (boundId && !(await channel.isAlive(boundId))) {
        await this.store.db.run('UPDATE park_sessions SET expires_at = ? WHERE org_id = ? AND id = ?', [Date.now(), session.org_id, session.id])
        throw new HttpError(401, 'Session expired')
      }
      const isRunning = boundId ? await channel.isRunning(boundId) : false
      if (!isRunning && await channel.runningCount(session.org_id) >= (Number(rate.anonymous_session_max) || 16)) {
        throw new HttpError(503, 'SESSION_CAPACITY_REACHED')
      }
      let runtimeId = boundId
      try {
        if (!runtimeId) {
          if (config?.assistant_status !== 'published') throw new HttpError(503, 'Public Assistant is not published')
          const assistantId = (JSON.parse(config.assistant_config || '{}') as { assistant_id?: unknown }).assistant_id
          if (typeof assistantId !== 'string' || !assistantId) throw new HttpError(503, 'Public Assistant session binding is unavailable')
          await channel.retireVisitor(session.org_id, session.id)
          runtimeId = await channel.createSession({ orgId: session.org_id, assistantId, anonymousSessionId: session.id })
          await this.store.db.run('UPDATE park_sessions SET moss_session_id = ? WHERE org_id = ? AND id = ?',
            [runtimeId, session.org_id, session.id])
        }
        const prepared = await channel.prepareTurn(runtimeId, !isRunning)
        session.moss_session_id = runtimeId
        const acquiredId = runtimeId
        return {
          send: prepared.send,
          dispose: prepared.dispose,
          abandon: async () => {
            prepared.dispose()
            if (!isRunning) {
              await channel.terminate(acquiredId)
              if (!boundId) await this.store.db.run('UPDATE park_sessions SET moss_session_id = NULL WHERE org_id = ? AND id = ?', [session.org_id, session.id])
              else await this.store.db.run('UPDATE park_sessions SET expires_at = ? WHERE org_id = ? AND id = ?', [Date.now(), session.org_id, session.id])
            }
          },
        }
      } catch (error) {
        if (runtimeId && !isRunning) {
          await channel.terminate(runtimeId)
          if (!boundId) await this.store.db.run('UPDATE park_sessions SET moss_session_id = NULL WHERE org_id = ? AND id = ?',
            [session.org_id, session.id])
          else await this.store.db.run('UPDATE park_sessions SET expires_at = ? WHERE org_id = ? AND id = ?', [Date.now(), session.org_id, session.id])
        }
        throw error
      }
    })
  }

  async reclaim(orgId: string, channel: ParkAgentChannel, now: number): Promise<number> {
    const config = await this.store.config(orgId)
    const idleMs = parkIdleMs(config?.rate_config || '{}')
    const rows = await this.store.db.all<ParkSessionRow>(
      'SELECT * FROM park_sessions WHERE org_id = ? AND (expires_at <= ? OR last_active_at <= ?)',
      [orgId, now, now - idleMs],
    )
    let reclaimed = 0
    for (const row of rows) {
      await this.withSession(row.id, async () => {
        const current = await this.store.session(orgId, row.id)
        if (!current || (Number(current.expires_at) > now && now - Number(current.last_active_at) < idleMs)) return
        if (await this.store.db.get("SELECT id FROM park_consultation_turns WHERE session_id = ? AND status = 'running'", [row.id])) return
        // Keep the binding until termination succeeds so the next timer retries failures.
        if (current.moss_session_id) {
          if (await channel.isAlive(current.moss_session_id)) await channel.terminate(current.moss_session_id)
        } else {
          await channel.retireVisitor(orgId, current.id)
        }
        if (Number(current.expires_at) <= now) return
        await this.store.db.run('UPDATE park_sessions SET expires_at = ? WHERE org_id = ? AND id = ?',
          [now, orgId, row.id])
        reclaimed += 1
      })
    }
    return reclaimed
  }
}

const lifecycles = new WeakMap<ParkStore, ParkSessionLifecycle>()

export function parkSessionLifecycle(store: ParkStore): ParkSessionLifecycle {
  let lifecycle = lifecycles.get(store)
  if (!lifecycle) {
    lifecycle = new ParkSessionLifecycle(store)
    lifecycles.set(store, lifecycle)
  }
  return lifecycle
}
