/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared session-recovery classification.
 *
 * Every entry point that reuses a long-lived session (IM channels, cron,
 * cabin, event triggers) needs the same question answered: is this session
 * still usable, respawnable, or dead? Each one used to answer it with its own
 * ad-hoc status allowlist, and they disagreed — notably on 'ended', which the
 * runner daemon writes for BOTH an idle recycle (desired='active', respawn
 * wanted) and a natural retirement (desired='ended', respawn not wanted).
 * Collapsing that to status alone is what made IM chats silently lose their
 * history after `idleTimeoutMs`.
 *
 * Originally `classifyMossSession` in cabin/service.ts; extracted verbatim so
 * the other callers can share it.
 */

import type { SessionSnapshot } from './runtimeService.js'

export type SessionRecoveryAction = 'reuse' | 'recover' | 'replace'

function isTerminalAttemptRuntime(state: string): boolean {
  return state === 'stopped' || state === 'failed' || state === 'lost'
}

/**
 * Map a read-only session snapshot to a recovery action:
 *   reuse   - runtime is live, attach to it as-is.
 *   recover - session is wanted but its runtime is gone; ensureSessionReady()
 *             respawns it and ACP session/load replays the transcript.
 *   replace - unusable or deliberately retired; create a fresh session.
 *
 * Null (session id unknown) is always 'replace' — never 'reuse'. ended splits
 * on desired_state: an idle-recycled session (desired=active) can be
 * respawned; a naturally-retired one (desired=ended) is replaced outright.
 */
export function classifyMossSession(
  snapshot: SessionSnapshot | null,
): SessionRecoveryAction {
  if (!snapshot) return 'replace'
  switch (snapshot.status) {
    case 'lost':
    case 'failed':
    case 'terminated':
      return 'replace'
    case 'active':
      if (snapshot.attempt && isTerminalAttemptRuntime(snapshot.attempt.runtimeState)) return 'recover'
      return 'reuse'
    case 'detached':
      if (snapshot.attempt?.attachPath && !isTerminalAttemptRuntime(snapshot.attempt.runtimeState)) return 'reuse'
      return 'recover'
    case 'ended':
      return snapshot.desiredState === 'active' ? 'recover' : 'replace'
    case 'creating':
      return 'recover'
    default:
      return 'recover'
  }
}
