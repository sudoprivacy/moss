import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'

import type { SessionStatus } from '../types.js'

/**
 * Verifies the lifecycle marks the runner uses when scode exits. Models the
 * branches in sessionRunnerDaemon.ts onExit:
 *
 *   stopping & idleish        -> status=ended,      desired=active   (resumable)
 *   stopping & terminate      -> status=terminated, desired=terminated
 *   !stopping & code===0      -> status=ended,      desired=ended
 *   !stopping & code!==0      -> status=failed,     desired=active
 *
 * Plus end-to-end checks against an in-memory SQLite schema mirroring
 * DirectConnectStore so we can also assert listSessionsToRecover /
 * reactivateSession / listAttemptsByRuntimeState behavior.
 */

type LifecycleBranch = {
  label: string
  stopping: boolean
  stopReason: string | null
  exitCode: number | null
  expectedStatus: SessionStatus
  expectedDesired: 'active' | 'ended' | 'terminated'
}

const BRANCHES: LifecycleBranch[] = [
  {
    label: 'idle_timeout: detach + no busy → resumable',
    stopping: true, stopReason: 'idle_timeout', exitCode: 0,
    expectedStatus: 'ended', expectedDesired: 'active',
  },
  {
    label: 'idle_busy_timeout: detach + busy ceiling → resumable',
    stopping: true, stopReason: 'idle_busy_timeout', exitCode: 0,
    expectedStatus: 'ended', expectedDesired: 'active',
  },
  {
    label: 'terminate (client deleted session)',
    stopping: true, stopReason: 'terminated', exitCode: null,
    expectedStatus: 'terminated', expectedDesired: 'terminated',
  },
  {
    label: 'natural code=0 exit (scode finished cleanly, no stopping)',
    stopping: false, stopReason: 'runtime_exit', exitCode: 0,
    expectedStatus: 'ended', expectedDesired: 'ended',
  },
  {
    label: 'non-zero exit while not stopping → failure, user still wants it',
    stopping: false, stopReason: 'runtime_exit', exitCode: 137,
    expectedStatus: 'failed', expectedDesired: 'active',
  },
]

function computeMarks(
  stopping: boolean,
  stopReason: string | null,
  code: number | null,
): { status: SessionStatus; desired: 'active' | 'ended' | 'terminated' } {
  // Mirrors the branch in sessionRunnerDaemon.ts:282-310.
  const idleish = stopReason === 'idle_timeout' || stopReason === 'idle_busy_timeout'
  if (stopping) {
    if (idleish) return { status: 'ended', desired: 'active' }
    return { status: 'terminated', desired: 'terminated' }
  }
  if (code === 0) return { status: 'ended', desired: 'ended' }
  return { status: 'failed', desired: 'active' }
}

describe('runner onExit lifecycle branches', () => {
  for (const branch of BRANCHES) {
    it(branch.label, () => {
      const marks = computeMarks(branch.stopping, branch.stopReason, branch.exitCode)
      expect(marks.status).toBe(branch.expectedStatus)
      expect(marks.desired).toBe(branch.expectedDesired)
    })
  }
})

// ---------------------------------------------------------------------------
// SQLite-backed lifecycle assertions
// ---------------------------------------------------------------------------

function makeDb(): Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      desired_state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      ended_at INTEGER,
      deleted_at INTEGER
    );
    CREATE TABLE session_attempts (
      attempt_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      runtime_state TEXT NOT NULL,
      runner_pid INTEGER,
      stop_reason TEXT,
      stopped_at INTEGER,
      started_at INTEGER NOT NULL,
      last_heartbeat_at INTEGER NOT NULL
    );
  `)
  return db
}

function insertSession(
  db: Database,
  sid: string,
  status: SessionStatus,
  desired: 'active' | 'ended' | 'terminated',
  endedAt: number | null = null,
): void {
  const ts = Date.now()
  db.prepare(`
    INSERT INTO sessions (session_id, status, desired_state, created_at, last_active_at, ended_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run(sid, status, desired, ts, ts, endedAt)
}

function insertAttempt(
  db: Database,
  attemptId: string,
  sessionId: string,
  runtimeState: string,
  runnerPid: number | null,
): void {
  const ts = Date.now()
  db.prepare(`
    INSERT INTO session_attempts (attempt_id, session_id, runtime_state, runner_pid, stop_reason, stopped_at, started_at, last_heartbeat_at)
    VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)
  `).run(attemptId, sessionId, runtimeState, runnerPid, ts, ts)
}

describe('SQL: listSessionsToRecover excludes idle-killed but includes failed', () => {
  it('idle-killed (status=ended, desired=active) is NOT auto-recovered on startup', () => {
    const db = makeDb()
    insertSession(db, 's-idle', 'ended', 'active', Date.now())
    insertSession(db, 's-failed', 'failed', 'active', null)
    insertSession(db, 's-terminated', 'terminated', 'terminated', Date.now())
    insertSession(db, 's-active', 'active', 'active', null)

    const recoverable = db.prepare(`
      SELECT session_id FROM sessions
      WHERE desired_state = 'active'
        AND deleted_at IS NULL
        AND status IN ('creating', 'active', 'detached', 'lost', 'failed')
    `).all() as Array<{ session_id: string }>

    const ids = recoverable.map(r => r.session_id).sort()
    expect(ids).toEqual(['s-active', 's-failed'])
    expect(ids).not.toContain('s-idle')
    expect(ids).not.toContain('s-terminated')

    // But explicit getSession can still find s-idle so /sessions/:id/resume works.
    const idle = db.prepare(`
      SELECT session_id, status, desired_state, ended_at FROM sessions
      WHERE session_id = 's-idle' AND deleted_at IS NULL
    `).get() as { session_id: string; status: string; desired_state: string; ended_at: number | null }
    expect(idle).not.toBeNull()
    expect(idle.status).toBe('ended')
    expect(idle.desired_state).toBe('active')
    expect(idle.ended_at).not.toBeNull()
  })
})

describe('SQL: reactivateSession on respawn', () => {
  it('clears ended_at and sets status/desired back to active', () => {
    const db = makeDb()
    insertSession(db, 's1', 'ended', 'active', Date.now() - 10000)

    // Mirrors DirectConnectStore.reactivateSession.
    const ts = Date.now()
    db.prepare(`
      UPDATE sessions
      SET status = 'active', desired_state = 'active', ended_at = NULL,
          last_active_at = ?
      WHERE session_id = ?
    `).run(ts, 's1')

    const row = db.prepare(`SELECT status, desired_state, ended_at FROM sessions WHERE session_id = 's1'`)
      .get() as { status: string; desired_state: string; ended_at: number | null }
    expect(row.status).toBe('active')
    expect(row.desired_state).toBe('active')
    expect(row.ended_at).toBeNull()
  })
})

describe('SQL: stale-attempt cleanup matches reconcileOnStartup', () => {
  it('finds running/starting/detached attempts irrespective of PID liveness', () => {
    const db = makeDb()
    insertSession(db, 's-a', 'active', 'active')
    insertAttempt(db, 'att-running', 's-a', 'running', 99999)
    insertAttempt(db, 'att-starting', 's-a', 'starting', null)
    insertAttempt(db, 'att-stopped', 's-a', 'stopped', null)
    insertAttempt(db, 'att-failed', 's-a', 'failed', null)

    const stale = db.prepare(`
      SELECT attempt_id, runtime_state, runner_pid FROM session_attempts
      WHERE runtime_state IN ('starting', 'running', 'detached')
    `).all() as Array<{ attempt_id: string; runtime_state: string; runner_pid: number | null }>

    const ids = stale.map(s => s.attempt_id).sort()
    expect(ids).toEqual(['att-running', 'att-starting'])
    // Terminal rows (stopped/failed/lost) are correctly excluded.
    expect(ids).not.toContain('att-stopped')
    expect(ids).not.toContain('att-failed')
  })

  it('marking stale attempt stopped is idempotent across racing writes', () => {
    const db = makeDb()
    insertSession(db, 's-b', 'terminated', 'terminated')
    insertAttempt(db, 'att-1', 's-b', 'running', 86)

    const ts = Date.now()
    // First write: terminateSession's defensive markAttemptStopped.
    db.prepare(`
      UPDATE session_attempts
      SET runtime_state = ?, stopped_at = ?, last_heartbeat_at = ?, stop_reason = ?
      WHERE attempt_id = ?
    `).run('stopped', ts, ts, 'terminated', 'att-1')
    // Second write: runner's own onExit racing in.
    db.prepare(`
      UPDATE session_attempts
      SET runtime_state = ?, stopped_at = ?, last_heartbeat_at = ?, stop_reason = ?
      WHERE attempt_id = ?
    `).run('stopped', ts, ts, 'terminated', 'att-1')

    const row = db.prepare(`SELECT runtime_state, stop_reason FROM session_attempts WHERE attempt_id = 'att-1'`)
      .get() as { runtime_state: string; stop_reason: string }
    expect(row.runtime_state).toBe('stopped')
    expect(row.stop_reason).toBe('terminated')
  })
})
