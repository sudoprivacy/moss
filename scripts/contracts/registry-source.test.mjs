import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkSnapshot, validateLocks } from './registry-source.mjs'

test('Registry consumer retains byte-identical owner/assembly closure and rejects pin, path and identity changes', () => {
  const { stack, owner } = checkSnapshot()
  for (const change of [
    value => { value.revision = 'main' },
    value => { value.repository = 'https://github.com/other/repo' },
    value => { value.files['schema.json'].path = '../schema.json' },
    value => { value.files['schema.json'].digest = `sha256:${'0'.repeat(64)}` },
  ]) {
    const altered = structuredClone(stack); change(altered)
    assert.throws(() => validateLocks(altered, owner))
  }
  const altered = structuredClone(owner); altered.revision = 'develop'
  assert.throws(() => validateLocks(stack, altered))
})
