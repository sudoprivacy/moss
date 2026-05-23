/**
 * Session-scoped coordinator mode via AsyncLocalStorage.
 *
 * Enables per-session coordinator mode without global state or env vars.
 * Each ClaudeSession.send() call establishes its own context.
 *
 * WHY AsyncLocalStorage:
 * - Sessions in the same process can run concurrently
 * - The same session processes queries sequentially (queue)
 * - Context must survive all awaits within a single query
 * - Different sessions must not interfere with each other
 */

import { AsyncLocalStorage } from 'async_hooks'

const coordinatorModeStorage = new AsyncLocalStorage<{
  coordinatorMode: boolean
}>()

/**
 * Get the current session's coordinator mode.
 * Returns undefined if not running within a session context.
 */
export function getSessionCoordinatorMode(): boolean | undefined {
  return coordinatorModeStorage.getStore()?.coordinatorMode
}

/**
 * Run a function within a coordinator mode context.
 * Always establishes a context boundary, even when coordinatorMode is false.
 */
export function runWithCoordinatorMode<T>(
  coordinatorMode: boolean,
  fn: () => T,
): T {
  return coordinatorModeStorage.run({ coordinatorMode }, fn)
}
