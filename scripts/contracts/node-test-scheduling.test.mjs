import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { nodeTestConcurrencyArgs } from '../node-test-scheduling.mjs'

test('PostgreSQL test workers finish one shared-resource fixture before starting another', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moss-node-test-scheduling-'))
  try {
    const fixture = `
      import test from 'node:test'
      import { appendFileSync, closeSync, openSync, unlinkSync } from 'node:fs'
      import { setTimeout } from 'node:timers/promises'
      test('exclusive fixture', async () => {
        const lock = process.env.MOSS_SCHEDULING_FIXTURE_LOCK
        const fd = openSync(lock, 'wx')
        try {
          appendFileSync(lock + '.events', 'enter\\n')
          await setTimeout(50)
          appendFileSync(lock + '.events', 'leave\\n')
        } finally {
          closeSync(fd)
          unlinkSync(lock)
        }
      })
    `
    const files = ['first.test.mjs', 'second.test.mjs'].map(name => join(directory, name))
    for (const file of files) writeFileSync(file, fixture)
    const environment = {
      ...process.env,
      MOSS_PG_TEST_URL: 'postgresql://unused/fixture',
      MOSS_SCHEDULING_FIXTURE_LOCK: join(directory, 'resource.lock'),
    }
    delete environment.MOSS_NODE_TEST_CONCURRENCY
    // This is a separate test coordinator, not another worker of this suite.
    delete environment.NODE_TEST_CONTEXT
    const child = spawnSync(process.execPath, ['--test', ...nodeTestConcurrencyArgs(environment), ...files], {
      env: environment,
      encoding: 'utf8',
    })
    assert.ifError(child.error)
    assert.equal(child.status, 0, child.stdout + child.stderr)
    assert.equal(readFileSync(environment.MOSS_SCHEDULING_FIXTURE_LOCK + '.events', 'utf8'), 'enter\nleave\nenter\nleave\n')
  } finally {
    for (const name of ['first.test.mjs', 'second.test.mjs', 'resource.lock', 'resource.lock.events']) {
      const file = join(directory, name)
      if (existsSync(file)) unlinkSync(file)
    }
    rmdirSync(directory)
  }
})

test('unsafe PostgreSQL parallelism and invalid worker settings fail before fixtures start', () => {
  for (const configured of ['0', 'invalid', '9007199254740992']) {
    assert.throws(() => nodeTestConcurrencyArgs({ MOSS_NODE_TEST_CONCURRENCY: configured }), /must be a positive integer/)
  }
  assert.throws(() => nodeTestConcurrencyArgs({ MOSS_PG_TEST_URL: 'postgresql://unused/fixture', MOSS_NODE_TEST_CONCURRENCY: '2' }), /share a migration lock/)
})
