import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { RedisLegacyTokenStore, type RedisCommands } from './redisLegacyStore.js'

class FakeRedis implements RedisCommands {
  readonly values = new Map<string, string>()
  readonly ttls = new Map<string, number>()

  async setex(key: string, seconds: number, value: string): Promise<unknown> {
    this.values.set(key, value)
    this.ttls.set(key, seconds)
    return 'OK'
  }

  async keys(pattern: string): Promise<string[]> {
    return [...this.values.keys()].filter((key) => pattern === '*' || key === pattern)
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0
    for (const key of keys) count += this.values.delete(key) ? 1 : 0
    return count
  }

  async eval(_script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown> {
    assert.equal(keyCount, 2)
    const [oldKey, newKey, expectedValue, ttl, nextValue] = args.map(String)
    if (this.values.get(oldKey!) !== expectedValue) return 0
    this.values.set(newKey!, nextValue!)
    this.ttls.set(newKey!, Number(ttl))
    this.values.delete(oldKey!)
    return 1
  }

  async ttl(key: string): Promise<number> { return this.ttls.get(key) ?? -2 }
  async incr(key: string): Promise<number> {
    const value = Number(this.values.get(key) ?? '0') + 1
    this.values.set(key, String(value))
    return value
  }
  async expire(key: string, seconds: number): Promise<number> {
    if (!this.values.has(key)) return 0
    this.ttls.set(key, seconds)
    return 1
  }
}

describe('Redis legacy token store', () => {
  test('delegates ordinary commands and atomically rotates only the expected value', async () => {
    const client = new FakeRedis()
    const store = new RedisLegacyTokenStore(client)
    await store.setex('old', 60, 'claims')
    assert.deepEqual(await store.keys('old'), ['old'])
    assert.equal(await store.get('old'), 'claims')

    assert.equal(await store.rotate('old', 'new', 120, 'claims'), true)
    assert.equal(await store.get('old'), null)
    assert.equal(await store.get('new'), 'claims')
    assert.equal(client.ttls.get('new'), 120)

    await store.setex('changed', 60, 'new-claims')
    assert.equal(await store.rotate('changed', 'should-not-exist', 120, 'stale-claims'), false)
    assert.equal(await store.get('changed'), 'new-claims')
    assert.equal(await store.get('should-not-exist'), null)
  })
})
