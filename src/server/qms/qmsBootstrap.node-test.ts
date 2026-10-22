import assert from 'node:assert/strict'
import { it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { DbDriver } from '../db/driver.js'
import type { ConfigKey } from '../configStore/configStore.js'
import { createDeferredQmsRoutes, ensureQmsApiKey, initializeQmsWithDeadline, type QmsAvailability } from './qmsBootstrap.js'
import { DEFAULT_QMS_API_KEY, resolveQmsConfig } from './config.js'

void it('uses the built-in QMS key without writing deployment credentials', async () => {
  const values = new Map<ConfigKey, string>()
  let writes = 0
  const secrets = { get: (key: ConfigKey) => values.get(key), refreshKey: async () => {}, put: async (key: ConfigKey, value: string) => { values.set(key, value); writes++ } }
  const driver = { kind: 'postgres', tryRunExclusiveSession: async (_key: string, fn: () => Promise<unknown>) => fn() } as DbDriver
  const config = () => resolveQmsConfig({}, {}, { dbBackend: 'postgres', validateSecrets: false })
  const first = config()
  await ensureQmsApiKey({ config: first, driver, secrets })
  assert.equal(first.secrets.apiKey, DEFAULT_QMS_API_KEY)
  const second = config()
  await ensureQmsApiKey({ config: second, driver, secrets })
  assert.equal(second.secrets.apiKey, first.secrets.apiKey)
  assert.equal(writes, 0)
})

void it('preserves previously dispatched credentials and respects disabled QMS', async () => {
  const values = new Map<ConfigKey, string>([['client.product-improvement-api-key', 'existing-client-key']])
  const secrets = { get: (key: ConfigKey) => values.get(key), refreshKey: async () => {}, put: async (key: ConfigKey, value: string) => { values.set(key, value) } }
  const driver = { kind: 'postgres', tryRunExclusiveSession: async (_key: string, fn: () => Promise<unknown>) => fn() } as DbDriver
  const config = resolveQmsConfig({}, {}, { dbBackend: 'postgres', validateSecrets: false })
  await ensureQmsApiKey({ config, driver, secrets })
  assert.equal(config.secrets.apiKey, DEFAULT_QMS_API_KEY)
  assert.equal(values.get('client.product-improvement-api-key'), 'existing-client-key')
  values.clear()
  await ensureQmsApiKey({ config: { ...config, enabled: false }, driver, secrets })
  assert.equal(values.size, 0)
})

void it('auto-enables only on the existing PostgreSQL backend without overriding an explicit opt-out', () => {
  assert.equal(resolveQmsConfig({}, {}, { dbBackend: 'postgres', validateSecrets: false }).enabled, true)
  assert.equal(resolveQmsConfig({}, {}, { dbBackend: 'sqlite', validateSecrets: false }).enabled, false)
  assert.equal(resolveQmsConfig({ enabled: false }, {}, { dbBackend: 'postgres' }).enabled, false)
  assert.equal(resolveQmsConfig({}, { QMS_ENABLED: 'false' }, { dbBackend: 'postgres' }).enabled, true)
})

void it('gives simultaneous starts the same built-in key without coordination writes', async () => {
  const values = new Map<ConfigKey, string>()
  let locked = false
  let writes = 0
  const driver = { kind: 'postgres', tryRunExclusiveSession: async (_key: string, fn: () => Promise<unknown>) => {
    if (locked) return null
    locked = true
    try { return await fn() } finally { locked = false }
  } } as DbDriver
  const secrets = { get: (key: ConfigKey) => values.get(key), refreshKey: async () => {}, put: async (key: ConfigKey, value: string) => { values.set(key, value); writes++ } }
  const first = resolveQmsConfig({}, {}, { dbBackend: 'postgres', validateSecrets: false })
  const second = resolveQmsConfig({}, {}, { dbBackend: 'postgres', validateSecrets: false })
  await Promise.all([ensureQmsApiKey({ config: first, driver, secrets }), ensureQmsApiKey({ config: second, driver, secrets })])
  assert.equal(first.secrets.apiKey, second.secrets.apiKey)
  assert.equal(writes, 0)
})

void it('does not start disabled QMS and isolates initialization failures from the main server', async () => {
  let calls = 0
  const errors: unknown[] = []
  const initialize = async () => { calls++; throw new Error('quality-only failure') }
  assert.equal(await initializeQmsWithDeadline({ enabled: false, initialize, onError: error => errors.push(error) }), undefined)
  assert.equal(calls, 0)
  assert.equal(await initializeQmsWithDeadline({ enabled: true, initialize, onError: error => errors.push(error) }), undefined)
  assert.equal(calls, 1)
  assert.equal(errors.length, 1)
})

void it('distinguishes disabled, initializing, and failed QMS routes', () => {
  let availability: QmsAvailability = { status: 'disabled' }
  const routes = createDeferredQmsRoutes(() => undefined, 'X-API-Key', () => availability)
  const execute = () => routes.operations.execute({} as never)
  assert.throws(execute, (error: unknown) => (error as { code?: string }).code === 'QMS_DISABLED')
  availability = { status: 'initializing' }
  assert.throws(execute, (error: unknown) => (error as { code?: string }).code === 'QMS_INITIALIZING')
  availability = { status: 'failed' }
  assert.throws(execute, (error: unknown) => (error as { code?: string }).code === 'QMS_INITIALIZATION_FAILED')
})

void it('bounds optional startup even when a QMS dependency never settles', async () => {
  let startupSignal: AbortSignal | undefined
  const errors: unknown[] = []
  const result = await initializeQmsWithDeadline({
    enabled: true, timeoutMs: 15,
    initialize: signal => { startupSignal = signal; return new Promise(() => {}) },
    onError: error => errors.push(error),
  })
  assert.equal(result, undefined)
  assert.equal(startupSignal?.aborted, true)
  assert.equal((errors[0] as Error).name, 'QmsStartupTimeoutError')
})

void it('cleans up a late runtime instead of leaving unowned scheduled tasks running', async () => {
  let finish!: (runtime: { stop(): Promise<void> }) => void
  let stops = 0
  const pending = initializeQmsWithDeadline<{ stop(): Promise<void> }>({
    enabled: true, timeoutMs: 15,
    initialize: () => new Promise(resolve => { finish = resolve }),
    onError: () => {},
  })
  assert.equal(await pending, undefined)
  finish({ stop: async () => { stops++ } })
  await delay(0)
  assert.equal(stops, 1)
})

void it('does not provision keys after optional startup has been cancelled', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  await assert.rejects(ensureQmsApiKey({
    config: resolveQmsConfig({}, {}, { dbBackend: 'postgres', validateSecrets: false }),
    signal: controller.signal,
    driver: { kind: 'postgres' } as DbDriver,
    secrets: { get: () => undefined, refreshKey: async () => { calls++ }, put: async () => { calls++ } },
  }), /abort/i)
  assert.equal(calls, 0)
})

void it('cancels background initialization immediately when the main server stops', async () => {
  const controller = new AbortController()
  let observedSignal: AbortSignal | undefined
  let errors = 0
  const pending = initializeQmsWithDeadline({
    enabled: true, signal: controller.signal,
    initialize: signal => { observedSignal = signal; return new Promise(() => {}) },
    onError: () => { errors++ },
  })
  await delay(0)
  controller.abort()
  assert.equal(await pending, undefined)
  assert.equal(observedSignal?.aborted, true)
  assert.equal(errors, 0)
})
