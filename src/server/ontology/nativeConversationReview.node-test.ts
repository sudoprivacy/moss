import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createNativeConversationReview } from './nativeConversationReview.js'
import { createNativeReviewFixture as fixture } from './nativeReviewFixture.js'

const input = { conversationId: 'conversation', messageId: 'review-stable', content: 'Human comment', agentContent: 'Expanded anchored input' }

void test('review delivery uses the normal native input channel and recovers without another submission', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  let authorizations = 0, started = 0
  const answers: string[] = []
  const delivery = createNativeConversationReview(f.runtime, async () => { authorizations++ })
  t.after(() => delivery.close())
  assert.deepEqual(await delivery.deliver(input, { onStarted: async () => { started++ }, onCompleted: async text => { answers.push(text) } }), { success: true })
  assert.equal(started, 1)
  assert.deepEqual(answers, ['The original conversation reviewed the field.'])
  assert.equal(f.submissions.length, 1)
  assert.equal(f.submissions[0].clientId, input.messageId)
  assert.equal(f.submissions[0].display, input.content)
  assert.ok(JSON.stringify(f.submissions[0].content).includes(input.agentContent))
  assert.ok((await readFile(f.transcriptPath, 'utf8')).includes('native_input_complete'))
  const replacement = createNativeConversationReview(f.runtime, async () => { authorizations++ })
  t.after(() => replacement.close())
  assert.deepEqual(await replacement.recover(input), { state: 'complete', text: answers[0] })
  assert.equal(await replacement.messageExists(input.conversationId, input.messageId), true)
  assert.equal(await replacement.messageExists(input.conversationId, 'missing'), false)
  assert.equal(f.submissions.length, 1)
  assert.ok(authorizations >= 8)
})

void test('an older runner refuses review controls before any stdin is sent', { timeout: 10000 }, async t => {
  const f = await fixture(t, 'legacy')
  const delivery = createNativeConversationReview(f.runtime, async () => {})
  t.after(() => delivery.close())
  await assert.rejects(delivery.recover(input), /Upgrade the native runner/)
  assert.equal(f.controls.length, 0)
  assert.equal(f.submissions.length, 0)
})

void test('permission revoked after connection prevents native submission', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  let authorizations = 0
  const delivery = createNativeConversationReview(f.runtime, async () => { if (++authorizations > 1) throw new Error('Current access revoked') })
  t.after(() => delivery.close())
  await assert.rejects(delivery.deliver(input, { onStarted: async () => assert.fail(), onCompleted: async () => assert.fail() }), /revoked/)
  assert.equal(f.submissions.length, 0)
})

void test('connection loss after admission is unknown and never creates a completed answer', { timeout: 10000 }, async t => {
  const f = await fixture(t, 'drop')
  const delivery = createNativeConversationReview(f.runtime, async () => {})
  t.after(() => delivery.close())
  await assert.rejects(delivery.deliver(input, { onStarted: async () => {}, onCompleted: async () => assert.fail('Unknown completion cannot be acknowledged') }), /unknown/i)
  assert.deepEqual(await delivery.recover(input), { state: 'pending' })
  assert.equal(f.submissions.length, 1)
})
