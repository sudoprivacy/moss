import Redis from 'ioredis'
import type { LegacyKeyValueStore } from '../../../identity/legacyToken.js'

export interface RedisCommands {
  setex(key: string, seconds: number, value: string): Promise<unknown>
  keys(pattern: string): Promise<string[]>
  get(key: string): Promise<string | null>
  del(...keys: string[]): Promise<number>
  eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>
  ttl(key: string): Promise<number>
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<number>
}

const ROTATE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current or current ~= ARGV[1] then
  return 0
end
redis.call('SETEX', KEYS[2], ARGV[2], ARGV[3])
redis.call('DEL', KEYS[1])
return 1
`

export class RedisLegacyTokenStore implements LegacyKeyValueStore {
  constructor(private readonly client: RedisCommands) {}

  async setex(key: string, seconds: number, value: string): Promise<void> {
    await this.client.setex(key, seconds, value)
  }

  keys(pattern: string): Promise<string[]> {
    return this.client.keys(pattern)
  }

  get(key: string): Promise<string | null> {
    return this.client.get(key)
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length > 0) await this.client.del(...keys)
  }

  async rotate(
    oldKey: string,
    newKey: string,
    seconds: number,
    value: string,
  ): Promise<boolean> {
    const result = await this.client.eval(
      ROTATE_SCRIPT,
      2,
      oldKey,
      newKey,
      value,
      seconds,
      value,
    )
    return Number(result) === 1
  }

  ttl(key: string): Promise<number> {
    return this.client.ttl(key)
  }

  async incrementWithExpiry(key: string, seconds: number): Promise<number> {
    const count = await this.client.incr(key)
    if (count === 1) await this.client.expire(key, seconds)
    return count
  }
}

export function createRedisLegacyTokenStore(redisUrl: string): {
  store: RedisLegacyTokenStore
  close: () => Promise<void>
} {
  if (!redisUrl.trim()) throw new Error('Sudowork Redis URL must be configured explicitly')
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  })
  return {
    store: new RedisLegacyTokenStore(client),
    close: async () => {
      if (client.status === 'wait') return
      await client.quit()
    },
  }
}
