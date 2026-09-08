import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  QmsSourceComponentReader,
  RedisAccessComponentReader,
  SqliteFileComponentReader,
} from './sourceComponentReaders.js'

describe('migration source component readers', () => {
  test('SQLite 文件摘要包含内容并检测读取期间变化', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'moss-sqlite-component-'))
    const path = join(directory, 'sudowork.sqlite')
    writeFileSync(path, 'snapshot-a')
    try {
      const first = await new SqliteFileComponentReader(path).capture()
      const second = await new SqliteFileComponentReader(path).capture()
      assert.equal(first.name, 'sqlite')
      assert.equal(first.checksum, second.checksum)
      assert.equal(first.itemCount, 1)
      writeFileSync(path, 'snapshot-b')
      assert.notEqual((await new SqliteFileComponentReader(path).capture()).checksum, first.checksum)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('Redis 摘要只包含需迁移的登录态且不受 TTL 自然递减影响', async () => {
    let ttl = 100
    const values = new Map([
      ['refresh_token:1:d:t', 'refresh'],
      ['register_token:r', 'register'],
      ['rate_limit:ignored', '1'],
    ])
    const redis = {
      async keys(pattern: string) {
        const prefix = pattern.slice(0, -1)
        return [...values.keys()].filter(key => key.startsWith(prefix))
      },
      async get(key: string) { return values.get(key) ?? null },
      async ttl() { return ttl-- },
    }
    const reader = new RedisAccessComponentReader(redis)
    const first = await reader.capture()
    const second = await reader.capture()
    assert.equal(first.checksum, second.checksum)
    assert.equal(first.itemCount, 2)
    assert.deepEqual(first.metadata.keys, ['refresh_token:1:d:t', 'register_token:r'])
  })

  test('QMS 摘要由每张表的校验和与行数构成', async () => {
    const source = {
      async inspect(batchSize: number) {
        assert.equal(batchSize, 500)
        return {
          tables: {
            b: { checksum: 'bbb', count: 2 },
            a: { checksum: 'aaa', count: 1 },
          },
        }
      },
    }
    const snapshot = await new QmsSourceComponentReader(source as never, 500).capture()
    assert.equal(snapshot.name, 'qms')
    assert.equal(snapshot.itemCount, 3)
    assert.deepEqual(snapshot.metadata.tables, [
      { name: 'a', checksum: 'aaa', rowCount: 1 },
      { name: 'b', checksum: 'bbb', rowCount: 2 },
    ])
  })
})
