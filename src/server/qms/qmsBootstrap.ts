import type { DbDriver } from '../db/driver.js'
import type { ConfigKey } from '../configStore/configStore.js'
import { DEFAULT_QMS_API_KEY, type QmsRuntimeConfig } from './config.js'
import { QmsAuthorizationError, type QmsAuthorizationService } from './qmsAuthorization.js'
import type { StartedQmsRuntime } from './qmsRuntime.js'
import type { QmsLegacyOperationPort } from '../api/compat/sudowork/qmsRoutes.js'

export type QmsAvailability =
  | { status: 'disabled' }
  | { status: 'initializing' }
  | { status: 'ready' }
  | { status: 'failed' }

/** Keep the routes registered while the optional runtime starts in the background. */
export function createDeferredQmsRoutes(
  getRuntime: () => StartedQmsRuntime | undefined,
  apiKeyHeader: string,
  getAvailability: () => QmsAvailability = () => ({ status: 'initializing' }),
): {
  apiKeyHeader: string
  authorization: Pick<QmsAuthorizationService, 'requireApiKey' | 'adminScope'>
  operations: QmsLegacyOperationPort
} {
  const current = () => {
    const runtime = getRuntime()
    if (!runtime) {
      const availability = getAvailability()
      if (availability.status === 'disabled') {
        throw new QmsAuthorizationError(503, 'QMS_DISABLED', '质量管理未启用，请前往平台配置启用 QMS 并重启服务。')
      }
      if (availability.status === 'failed') {
        throw new QmsAuthorizationError(503, 'QMS_INITIALIZATION_FAILED', '质量管理初始化失败，请检查 Moss PostgreSQL 存储并重启服务。')
      }
      throw new QmsAuthorizationError(503, 'QMS_INITIALIZING', '质量管理正在初始化，请稍后重试。')
    }
    return runtime
  }
  return {
    apiKeyHeader,
    authorization: {
      requireApiKey: key => current().authorization.requireApiKey(key),
      adminScope: (actor, tenant) => current().authorization.adminScope(actor, tenant),
    },
    operations: { execute: input => current().operations.execute(input) },
  }
}

/** Optional QMS initialization must not hold the main HTTP server behind a stalled dependency. */
export async function initializeQmsWithDeadline<T extends { stop(): Promise<void> }>(options: {
  enabled: boolean
  initialize(signal: AbortSignal): Promise<T | undefined>
  onError(error: unknown): void
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<T | undefined> {
  if (!options.enabled || options.signal?.aborted) return undefined
  const controller = new AbortController()
  let isInterrupted = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const initialization = Promise.resolve().then(() => options.initialize(controller.signal)).then(async runtime => {
    if (controller.signal.aborted) {
      // A dependency can finish after the deadline; never leave its scheduler running unowned.
      await runtime?.stop()
      return undefined
    }
    return runtime
  }).catch(error => {
    if (!isInterrupted) options.onError(error)
    return undefined
  })
  try {
    return await Promise.race([
      initialization,
      new Promise<undefined>(resolve => {
        onAbort = () => {
          isInterrupted = true
          controller.abort(options.signal?.reason)
          resolve(undefined)
        }
        options.signal?.addEventListener('abort', onAbort, { once: true })
        timer = setTimeout(() => {
          isInterrupted = true
          const error = new Error('QMS initialization exceeded its startup budget')
          error.name = 'QmsStartupTimeoutError'
          controller.abort(error)
          options.onError(error)
          resolve(undefined)
        }, options.timeoutMs ?? 15_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) options.signal?.removeEventListener('abort', onAbort)
  }
}

/** Provision application data in the existing vault; no deployment secret or middleware change is required. */
export async function ensureQmsApiKey(options: {
  config: QmsRuntimeConfig
  driver: DbDriver
  signal?: AbortSignal
  secrets: {
    get(key: ConfigKey): string | undefined
    refreshKey(key: ConfigKey): Promise<void>
    put(key: ConfigKey, value: string): Promise<void>
  }
}): Promise<void> {
  if (!options.config.enabled) return
  options.signal?.throwIfAborted()
  options.config.secrets.apiKey = DEFAULT_QMS_API_KEY
}
