import { AsyncLocalStorage } from 'async_hooks'
import { getCwdState, getOriginalCwd } from '../bootstrap/state.js'

type CwdOverrideContext = {
  cwd: string
  originalCwd: string
}

const cwdOverrideStorage = new AsyncLocalStorage<CwdOverrideContext>()

function normalizeCwd(cwd: string): string {
  return cwd.normalize('NFC')
}

/**
 * Run a function with an overridden working directory for the current async context.
 * All calls to pwd()/getCwd() within the function (and its async descendants) will
 * return the overridden cwd instead of the global one. This enables concurrent
 * agents to each see their own working directory without affecting each other.
 */
export function runWithCwdOverride<T>(cwd: string, fn: () => T): T {
  const normalized = normalizeCwd(cwd)
  return cwdOverrideStorage.run(
    { cwd: normalized, originalCwd: normalized },
    fn,
  )
}

function runWithExistingCwdOverride<T>(
  context: CwdOverrideContext,
  fn: () => T,
): T {
  return cwdOverrideStorage.run(context, fn)
}

export function setCurrentCwdOverride(cwd: string): boolean {
  const context = cwdOverrideStorage.getStore()
  if (!context) {
    return false
  }
  context.cwd = normalizeCwd(cwd)
  return true
}

export async function* runWithCwdOverrideGenerator<T, TReturn = void>(
  cwd: string,
  fn: () => AsyncGenerator<T, TReturn, unknown>,
): AsyncGenerator<T, TReturn, unknown> {
  const normalized = normalizeCwd(cwd)
  const context: CwdOverrideContext = {
    cwd: normalized,
    originalCwd: normalized,
  }
  const iterator = runWithExistingCwdOverride(context, fn)

  try {
    while (true) {
      const result = await runWithExistingCwdOverride(context, () =>
        iterator.next(),
      )
      if (result.done) {
        return result.value
      }
      yield result.value
    }
  } finally {
    if (typeof iterator.return === 'function') {
      await runWithExistingCwdOverride(context, () => iterator.return!())
    }
  }
}

/**
 * Get the current working directory
 */
export function pwd(): string {
  return cwdOverrideStorage.getStore()?.cwd ?? getCwdState()
}

/**
 * Get the current working directory or the original working directory if the current one is not available
 */
export function getCwd(): string {
  try {
    return pwd()
  } catch {
    return getOriginalCwd()
  }
}

export function getSessionOriginalCwd(): string {
  return cwdOverrideStorage.getStore()?.originalCwd ?? getOriginalCwd()
}
