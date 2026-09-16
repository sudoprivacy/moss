import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseP5QmsMigrationArgs } from './p5QmsMigrationCli.js'

describe('P5 QMS 迁移命令参数', () => {
  it('要求显式提供两个不同数据库、Moss 数据库和执行确认摘要', () => {
    const base = [
      '--source-url', 'postgres://old/qms',
      '--target-url', 'postgres://new/qms',
      '--moss-db', '/data/moss.db',
      '--aggregate-mode', 'regular',
    ]
    assert.deepEqual(parseP5QmsMigrationArgs(['--mode', 'plan', ...base]), {
      mode: 'plan', sourceUrl: 'postgres://old/qms', targetUrl: 'postgres://new/qms',
      mossDbPath: '/data/moss.db', aggregateMode: 'regular', batchSize: 500,
      runId: undefined, confirmedChecksum: undefined,
    })
    assert.throws(() => parseP5QmsMigrationArgs([
      '--mode', 'plan', '--source-url', 'postgres://same/qms', '--target-url', 'postgres://same/qms',
      '--moss-db', '/data/moss.db',
    ]), /源库与目标库不能相同/)
    assert.throws(() => parseP5QmsMigrationArgs(['--mode', 'execute', ...base]), /confirm-source-checksum/)
  })

  it('拒绝未知参数、非法模式和不安全批次大小', () => {
    assert.throws(() => parseP5QmsMigrationArgs(['--wat']), /未知参数/)
    assert.throws(() => parseP5QmsMigrationArgs([
      '--mode', 'drop', '--source-url', 'a', '--target-url', 'b', '--moss-db', 'c',
    ]), /mode/)
    assert.throws(() => parseP5QmsMigrationArgs([
      '--mode', 'plan', '--source-url', 'a', '--target-url', 'b', '--moss-db', 'c', '--batch-size', '0',
    ]), /batch-size/)
  })
})
