import type {
  ClaimedTelemetryMessage,
  TelemetryQueueBackend,
  TelemetryQueueMessage,
} from './reliableTelemetryQueue.js'

export interface RedisScriptPort {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>
  llen(key: string): Promise<number>
  hlen(key: string): Promise<number>
  rpush(key: string, ...values: string[]): Promise<number>
}

const CLAIM_SCRIPT = `
local output = {}
for i = 1, tonumber(ARGV[2]) do
  local message = redis.call('RPOP', KEYS[1])
  if not message then break end
  local sequence = redis.call('INCR', KEYS[4])
  local receipt = ARGV[1] .. ':' .. sequence
  redis.call('HSET', KEYS[2], receipt, message)
  redis.call('ZADD', KEYS[3], tonumber(ARGV[3]) + tonumber(ARGV[4]), receipt)
  table.insert(output, receipt)
  table.insert(output, message)
end
return output
`

const ACK_SCRIPT = `
local removed = 0
for i = 1, #ARGV do
  removed = removed + redis.call('HDEL', KEYS[1], ARGV[i])
  redis.call('ZREM', KEYS[2], ARGV[i])
end
return removed
`

const RECOVER_SCRIPT = `
local receipts = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', ARGV[1])
local recovered = 0
for _, receipt in ipairs(receipts) do
  local message = redis.call('HGET', KEYS[2], receipt)
  if message then
    redis.call('LPUSH', KEYS[1], message)
    redis.call('HDEL', KEYS[2], receipt)
    recovered = recovered + 1
  end
  redis.call('ZREM', KEYS[3], receipt)
end
return recovered
`

function parseMessage(value: string): TelemetryQueueMessage {
  const parsed = JSON.parse(value) as Partial<TelemetryQueueMessage>
  if (typeof parsed.ingestId !== 'string' || typeof parsed.kind !== 'string'
    || !parsed.payload || typeof parsed.payload !== 'object' || Array.isArray(parsed.payload)) {
    throw new Error('Invalid QMS telemetry queue message')
  }
  return parsed as TelemetryQueueMessage
}

export class RedisTelemetryQueueBackend implements TelemetryQueueBackend {
  private readonly pendingKey: string
  private readonly processingKey: string
  private readonly deadlineKey: string
  private readonly sequenceKey: string

  constructor(private readonly redis: RedisScriptPort, namespace = 'moss:qms') {
    const prefix = namespace.replace(/:+$/, '')
    this.pendingKey = `${prefix}:telemetry:pending`
    this.processingKey = `${prefix}:telemetry:processing`
    this.deadlineKey = `${prefix}:telemetry:deadlines`
    this.sequenceKey = `${prefix}:telemetry:receipt-sequence`
  }

  enqueue(message: TelemetryQueueMessage): Promise<number> {
    return this.redis.rpush(this.pendingKey, JSON.stringify(message))
  }

  enqueueMany(messages: readonly TelemetryQueueMessage[]): Promise<number> {
    if (messages.length === 0) return this.redis.llen(this.pendingKey)
    return this.redis.rpush(this.pendingKey, ...messages.map(message => JSON.stringify(message)))
  }

  async claim(workerId: string, limit: number, now: number, visibilityTimeoutMs: number): Promise<ClaimedTelemetryMessage[]> {
    const raw = await this.redis.eval(
      CLAIM_SCRIPT,
      4,
      this.pendingKey,
      this.processingKey,
      this.deadlineKey,
      this.sequenceKey,
      workerId,
      String(limit),
      String(now),
      String(visibilityTimeoutMs),
    )
    if (!Array.isArray(raw) || raw.length % 2 !== 0) throw new Error('Invalid QMS Redis claim response')
    const claimed: ClaimedTelemetryMessage[] = []
    for (let index = 0; index < raw.length; index += 2) {
      const receipt = String(raw[index])
      const message = parseMessage(String(raw[index + 1]))
      claimed.push({ ...message, receipt, claimedAt: now, visibleAt: now + visibilityTimeoutMs })
    }
    return claimed
  }

  async acknowledge(receipts: string[]): Promise<void> {
    if (receipts.length === 0) return
    await this.redis.eval(ACK_SCRIPT, 2, this.processingKey, this.deadlineKey, ...receipts)
  }

  async recoverExpired(now: number): Promise<number> {
    const recovered = await this.redis.eval(
      RECOVER_SCRIPT,
      3,
      this.pendingKey,
      this.processingKey,
      this.deadlineKey,
      String(now),
    )
    return Number(recovered)
  }

  async depths(): Promise<{ pending: number; processing: number }> {
    const [pending, processing] = await Promise.all([
      this.redis.llen(this.pendingKey),
      this.redis.hlen(this.processingKey),
    ])
    return { pending, processing }
  }
}
