import { describe, expect, it } from 'bun:test'

/**
 * Pure-logic regression test for the SessionRunnerDaemon idle/busy ceiling
 * algorithm. The full runner runs SQLite + sockets + child processes which
 * are not unit-testable here; the reschedule loop itself is small enough
 * that we re-implement the timer model directly and assert the invariants
 * the user contract depends on:
 *
 *   - WS close ≠ terminate. Detached sessions enter idle countdown but stay
 *     in the runner's record so a future attach can reset state.
 *   - detached && !busy -> idleTimer only, base = max(detachedSince, notBusySince).
 *   - detached && busy  -> busyCeilingTimer only, base = detachedBusySince.
 *   - busy flips reset detachedBusySince (no carry from prior bouts).
 *   - reattach cancels both.
 *
 * Mirrors sessionRunnerDaemon.ts:#reschedule.
 */

type State = {
  sockets: number
  busy: boolean
  now: number
  idleTimeoutMs: number
  maxDetachedBusyMs: number
  // tracked via reschedule:
  detachedSince: number | null
  notBusySince: number | null
  detachedBusySince: number | null
  scheduledIdleAt: number | null
  scheduledBusyCeilingAt: number | null
}

function freshState(): State {
  return {
    sockets: 1,
    busy: false,
    now: 0,
    idleTimeoutMs: 600_000,                  // 10 min
    maxDetachedBusyMs: 2 * 60 * 60 * 1000,   // 2h
    detachedSince: null,
    notBusySince: null,
    detachedBusySince: null,
    scheduledIdleAt: null,
    scheduledBusyCeilingAt: null,
  }
}

function reschedule(state: State): void {
  state.scheduledIdleAt = null
  state.scheduledBusyCeilingAt = null
  if (state.sockets > 0) {
    state.detachedSince = null
    state.detachedBusySince = null
    return
  }
  if (state.detachedSince === null) {
    state.detachedSince = state.now
    if (state.busy) state.detachedBusySince = state.now
  }
  if (!state.busy) {
    if (state.idleTimeoutMs <= 0) return
    const base = Math.max(
      state.detachedSince ?? state.now,
      state.notBusySince ?? state.detachedSince ?? state.now,
    )
    const remaining = Math.max(0, state.idleTimeoutMs - (state.now - base))
    state.scheduledIdleAt = state.now + remaining
    return
  }
  if (state.maxDetachedBusyMs <= 0) return
  const since = state.detachedBusySince ?? state.now
  const remaining = Math.max(0, state.maxDetachedBusyMs - (state.now - since))
  state.scheduledBusyCeilingAt = state.now + remaining
}

function setBusy(state: State, next: boolean): void {
  if (next === state.busy) return
  state.busy = next
  if (next) {
    state.notBusySince = null
    if (state.detachedSince !== null && state.detachedBusySince === null) {
      state.detachedBusySince = state.now
    }
  } else {
    state.notBusySince = state.now
    state.detachedBusySince = null
  }
  reschedule(state)
}

function setSockets(state: State, n: number): void {
  state.sockets = n
  reschedule(state)
}

describe('Runner reschedule (sessionRunnerDaemon)', () => {
  it('attached session arms no timer', () => {
    const s = freshState()
    reschedule(s)
    expect(s.scheduledIdleAt).toBeNull()
    expect(s.scheduledBusyCeilingAt).toBeNull()
  })

  it('WS close on idle session arms idleTimeoutMs only', () => {
    const s = freshState()
    s.now = 1000
    setSockets(s, 0)
    expect(s.scheduledIdleAt).toBe(1000 + s.idleTimeoutMs)
    expect(s.scheduledBusyCeilingAt).toBeNull()
  })

  it('WS close on busy session arms busy-ceiling only (NOT idle)', () => {
    const s = freshState()
    s.busy = true
    s.now = 1000
    setSockets(s, 0)
    expect(s.scheduledIdleAt).toBeNull()
    expect(s.scheduledBusyCeilingAt).toBe(1000 + s.maxDetachedBusyMs)
  })

  it('busy flip to false on detached re-arms FULL idleTimeoutMs, not residual', () => {
    const s = freshState()
    s.busy = true
    s.now = 1000
    setSockets(s, 0)
    // 9 minutes later, busy clears
    s.now = 1000 + 9 * 60_000
    setBusy(s, false)
    expect(s.scheduledIdleAt).toBe(s.now + s.idleTimeoutMs)
    expect(s.scheduledBusyCeilingAt).toBeNull()
  })

  it('busy flip true→false→true resets detachedBusySince (no carry from prior bout)', () => {
    const s = freshState()
    s.busy = true
    s.now = 1000
    setSockets(s, 0)
    expect(s.detachedBusySince).toBe(1000)

    s.now = 5000
    setBusy(s, false)
    expect(s.detachedBusySince).toBeNull()

    s.now = 7000
    setBusy(s, true)
    expect(s.detachedBusySince).toBe(7000)
    expect(s.scheduledBusyCeilingAt).toBe(7000 + s.maxDetachedBusyMs)
  })

  it('reattach cancels both timers and clears detached markers', () => {
    const s = freshState()
    s.busy = true
    s.now = 1000
    setSockets(s, 0)
    expect(s.scheduledBusyCeilingAt).not.toBeNull()

    s.now = 2000
    setSockets(s, 1)
    expect(s.scheduledIdleAt).toBeNull()
    expect(s.scheduledBusyCeilingAt).toBeNull()
    expect(s.detachedSince).toBeNull()
    expect(s.detachedBusySince).toBeNull()
  })

  it('long task crossing idleTimeoutMs does NOT get killed at the original detach + idleTimeoutMs', () => {
    const s = freshState()
    s.busy = true
    s.now = 0
    setSockets(s, 0)
    // 11 minutes later, still busy
    s.now = 11 * 60_000
    // No firing — only busyCeiling armed.
    expect(s.scheduledIdleAt).toBeNull()
    expect(s.scheduledBusyCeilingAt).toBe(s.maxDetachedBusyMs)
    // Now busy clears.
    setBusy(s, false)
    // idle re-arms from full timeout.
    expect(s.scheduledIdleAt).toBe(s.now + s.idleTimeoutMs)
    // Important: timer did NOT fire instantly even though (now - detachedSince > idleTimeoutMs).
  })
})
