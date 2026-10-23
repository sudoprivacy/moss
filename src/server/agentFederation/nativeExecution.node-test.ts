import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { NativeConversion } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import { nativeExecutionProfile, verifyNativeOutput } from './nativeExecution.js'

const conversion = { id: 'native-candidate', spec_digest: `sha256:${'a'.repeat(64)}`, image: {
  definition_digest: `sha256:${'b'.repeat(64)}`, image_id: `sha256:${'c'.repeat(64)}`,
  runtime: { kind: 'sudocode', commit: 'd'.repeat(40), executable_digest: `sha256:${'e'.repeat(64)}`,
    runner_digest: `sha256:${'f'.repeat(64)}`, platform: 'linux/amd64' },
} } as NativeConversion
const profile = nativeExecutionProfile(conversion)
const trace = [{ node: 'native-sudocode', phase: 'started' }, { node: 'native-sudocode', phase: 'completed' }]
void test('native Verify binds the same canonical owner profile and validates shape, not business correctness', () => {
  const verified = verifyNativeOutput(profile, '42', ['a'], trace, true, true)
  // Same independent canonical vector in Nexus test_native_execution.py.
  assert.equal(verified.profile_digest, 'sha256:dc34ebe2be844fae07108f35e191bf1f98cf58575f907387ba25393f22da532c')
  assert.equal(verified.verdict, 'passed')
  assert.equal(verifyNativeOutput(profile, 'possibly incorrect', ['a'], trace, true, true).verdict, 'passed')
  assert.equal(verifyNativeOutput(profile, '中文🙂', ['a'], trace, true, true).verdict, 'passed')
  for (const text of ['', ' \t\n\r\v\f', '\0', '中'.repeat(42667), '\ud800']) {
    assert.deepEqual(verifyNativeOutput(profile, text, ['a'], trace, true, true).failures, ['output_text'])
  }
  assert.deepEqual(verifyNativeOutput(profile, '42', [], [], false, false).failures, ['model_call_count', 'native_trace', 'execution_cleanup'])
})
void test('Task Verify projection follows the pinned Nexus schema with all response fields required', () => {
  const owner = JSON.parse(readFileSync(new URL('../../../contracts/agent-registry/v1alpha1/schema.json', import.meta.url), 'utf8')).$defs.NativeOutputVerification
  const task = JSON.parse(readFileSync(new URL('../../../contracts/task/v1alpha1/schema.json', import.meta.url), 'utf8')).$defs.NativeOutputVerification
  assert.deepEqual(task, { ...owner, required: Object.keys(owner.properties) })
})
