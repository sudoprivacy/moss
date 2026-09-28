import assert from 'node:assert/strict'
import { it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { DbDriver } from '../db/driver.js'
import type { ConfigKey } from '../configStore/configStore.js'
import { ensureQmsApiKey, initializeQmsWithDeadline } from './qmsBootstrap.js'
import { resolveQmsConfig } from './config.js'

void it('generates one persistent QMS key in the existing vault and reuses it on subsequent starts', async () => {
  const values = new Map<ConfigKey, string>()
  let writes = 0
  const secrets = { get: (key: ConfigKey) => values.get(key), refreshKey: async () => {}, put: async (key: ConfigKey, value: string) => { values.set(key, value); writes++ } }
  const driver = { kind: 'postgres', tryRunExclusiveSession: async (_key: string, fn: () => Promise<unknown>) => fn() } as DbDriver
  const config = () => resolveQmsConfig({}, {}, { dbBackend: 'postgres', validateSecrets: false })
  const first = config()
  await ensureQmsApiKey({ config: first, driver, secrets })
  assert.match(first.secrets.apiKey!, /^[A-Za-z0-9_-]{43}$/)
  const second = config()
  await ensureQmsApiKey({ config: second, driver, secrets })
  assert.equal(second.secrets.apiKey, first.secrets.apiKey)
  assert.equal(writes, 1)
})

void it('preserves previously dispatched credentials and respects disabled QMS', async () => {
  const values = new Map<ConfigKey, string>([['client.product-improvement-api-key', 'existing-client-key']])
  const secrets = { get: (key: ConfigKey) => values.get(key), refreshKey: async () => {}, put: async (key: ConfigKey, value: string) => { values.set(key, value) } }
  const driver = { kind: 'postgres', tryRunExclusiveSession: async (_key: string, fn: () => Promise<unknown>) => fn() } as DbDriver
  const config = resolveQmsConfig({}, {}, { dbBackend: 'postgres', validateSecrets: false })
  await ensureQmsApiKey({ config, driver, secrets })
  assert.equal(config.secrets.apiKey, 'existing-client-key')
  assert.equal(values.get('server.qms-api-key'), 'existing-client-key')
  values.clear()
  await ensureQmsApiKey({ config: { ...config, enabled: false }, driver, secrets })
  assert.equal(values.size, 0)
})

void it('auto-enables only on the existing PostgreSQL backend without overriding an explicit opt-out', () => {
  assert.equal(resolveQmsConfig({}, {}, { dbBackend: 'postgres', validateSecrets: false }).enabled, true)
  assert.equal(resolveQmsConfig({}, {}, { dbBackend: 'sqlite', validateSecrets: false }).enabled, false)
  assert.equal(resolveQmsConfig({ enabled: false }, {}, { dbBackend: 'postgres' }).enabled, false)
  assert.equal(resolveQmsConfig({}, { QMS_ENABLED: 'false' }, { dbBackend: 'postgres' }).enabled, false)
})

void it('serializes simultaneous first starts so instances do not publish different API keys', async () => {
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
  assert.equal(writes, 1)
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
