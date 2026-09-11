// Runs under Node: `tsx --test`. Direct unit cover for the fencing liveness
// predicate (batch 4). Zero heavy imports — attemptLiveness only type-imports
// AttemptRecord, so this file loads without the runtimeService bundle chain.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isAttemptHeartbeatFresh } from '../attemptLiveness.js'

const TIMEOUT_MS = 30_000

describe('isAttemptHeartbeatFresh', () => {
  it('non-terminal state + recent heartbeat = fresh', () => {
    for (const state of ['starting', 'running', 'detached'] as const) {
      assert.equal(
        isAttemptHeartbeatFresh({ runtimeState: state, lastHeartbeatAt: Date.now() }, TIMEOUT_MS),
        true,
        `${state} with a recent heartbeat must be fresh`,
      )
    }
  })

  it('non-terminal state + expired heartbeat = stale', () => {
    assert.equal(
      isAttemptHeartbeatFresh(
        { runtimeState: 'running', lastHeartbeatAt: Date.now() - TIMEOUT_MS - 1 },
        TIMEOUT_MS,
      ),
      false,
    )
  })

  it('terminal state + just-written heartbeat = stale (the fencing self-block fix)', () => {
    // markAttemptStopped stamps last_heartbeat_at = now while flipping the
    // state to a terminal value; a timestamp-only check would wrongly report
    // fresh and block respawn for one heartbeat interval.
    for (const state of ['stopped', 'failed', 'lost'] as const) {
      assert.equal(
        isAttemptHeartbeatFresh({ runtimeState: state, lastHeartbeatAt: Date.now() }, TIMEOUT_MS),
        false,
        `${state} must never count as heartbeat-fresh even with a fresh timestamp`,
      )
    }
  })

  it('null heartbeat = stale', () => {
    assert.equal(
      isAttemptHeartbeatFresh({ runtimeState: 'running', lastHeartbeatAt: null }, TIMEOUT_MS),
      false,
    )
  })
})
