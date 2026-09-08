import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import type { AccessKeyValueStore } from './accessMigrationPhase.js'
import type { SourceComponentReader, SourceComponentSnapshot } from './sudoworkSourceSnapshot.js'
import type { SudoworkP5QmsSourceReader } from './sudoworkP5QmsSourceReader.js'

export class SqliteFileComponentReader implements SourceComponentReader {
  constructor(private readonly databasePath: string) {}

  async capture(): Promise<SourceComponentSnapshot> {
    const before = await lstat(this.databasePath)
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('SQLite 快照必须是普通文件且不能是符号链接')
    const bytes = await readFile(this.databasePath)
    const after = await lstat(this.databasePath)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('SQLite 文件在快照读取期间发生变化')
    }
    return {
      name: 'sqlite',
      checksum: createHash('sha256').update(bytes).digest('hex'),
      itemCount: 1,
      readOnly: true,
      metadata: { size: bytes.byteLength },
    }
  }
}

export class RedisAccessComponentReader implements SourceComponentReader {
  constructor(private readonly redis: Pick<AccessKeyValueStore, 'keys' | 'get' | 'ttl'>) {}

  async capture(): Promise<SourceComponentSnapshot> {
    const keys = [...new Set([
      ...await this.redis.keys('refresh_token:*'),
      ...await this.redis.keys('register_token:*'),
    ])].sort()
    const entries: Array<{ key: string; value: string }> = []
    for (const key of keys) {
      const [value, ttl] = await Promise.all([this.redis.get(key), this.redis.ttl(key)])
      if (value !== null && ttl > 0) entries.push({ key, value })
    }
    return {
      name: 'redis',
      checksum: hash(stableJson(entries)),
      itemCount: entries.length,
      readOnly: true,
      metadata: { keys: entries.map(entry => entry.key) },
    }
  }
}

export class QmsSourceComponentReader implements SourceComponentReader {
  constructor(
    private readonly source: Pick<SudoworkP5QmsSourceReader, 'inspect'>,
    private readonly batchSize: number,
  ) {}

  async capture(): Promise<SourceComponentSnapshot> {
    const snapshot = await this.source.inspect(this.batchSize)
    const tables = Object.entries(snapshot.tables)
      .map(([name, value]) => ({ name, checksum: value.checksum, rowCount: value.count }))
      .sort((left, right) => left.name.localeCompare(right.name))
    return {
      name: 'qms',
      checksum: hash(stableJson({
        timescaleAvailable: snapshot.timescaleAvailable,
        aggregateMode: snapshot.aggregateMode,
        tables,
      })),
      itemCount: tables.reduce((total, table) => total + table.rowCount, 0),
      readOnly: true,
      metadata: { tables },
    }
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]))
  }
  return value
}
