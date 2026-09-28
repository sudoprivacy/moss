import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import type { DbDriver } from '../db/driver.js'
import type { ConfigKey } from '../configStore/configStore.js'
import type { QmsRuntimeConfig } from './config.js'
import { QmsAuthorizationError, type QmsAuthorizationService } from './qmsAuthorization.js'
import type { StartedQmsRuntime } from './qmsRuntime.js'
import type { QmsLegacyOperationPort } from '../api/compat/sudowork/qmsRoutes.js'

/** Keep the routes registered while the optional runtime starts in the background. */
export function createDeferredQmsRoutes(getRuntime: () => StartedQmsRuntime | undefined, apiKeyHeader: string): {
  apiKeyHeader: string
  authorization: Pick<QmsAuthorizationService, 'requireApiKey' | 'adminScope'>
  operations: QmsLegacyOperationPort
} {
  const current = () => {
    const runtime = getRuntime()
    if (!runtime) throw new QmsAuthorizationError(503, 'QMS_NOT_CONFIGURED', '质量管理正在初始化或暂不可用，请稍后重试。')
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
  if (!options.config.enabled || options.driver.kind !== 'postgres' || options.config.secrets.apiKey) return
  for (let attempt = 0; attempt < 100; attempt++) {
    options.signal?.throwIfAborted()
    const key = await options.driver.tryRunExclusiveSession('moss:qms:api-key', async () => {
      options.signal?.throwIfAborted()
      // A peer may have created the canonical key since this process loaded its vault cache.
      await options.secrets.refreshKey('server.qms-api-key')
      options.signal?.throwIfAborted()
      const existing = options.secrets.get('server.qms-api-key')
      if (existing) return existing
      const value = options.secrets.get('qms.default-api-key')
        || options.secrets.get('client.product-improvement-api-key')
        || randomBytes(32).toString('base64url')
      await options.secrets.put('server.qms-api-key', value)
      return value
    })
    options.signal?.throwIfAborted()
    if (key) {
      options.config.secrets.apiKey = key
      return
    }
    await delay(100, undefined, { signal: options.signal })
  }
  throw new Error('QMS credential initialization is busy; retry startup')
}
