import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { WebSocketServer } from 'ws'
import { productConversation } from './productConversation.js'

async function fixture(t: TestContext, response: unknown[]) {
  const directory = mkdtempSync(join(tmpdir(), 'moss-product-conversation-'))
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>(resolve => server.once('listening', resolve))
  const received: string[] = []
  server.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'hello' }))
    socket.on('message', bytes => {
      received.push(JSON.parse(bytes.toString()).type)
      for (const event of response) socket.send(JSON.stringify(event))
    })
  })
  const address = server.address()
  assert(address && typeof address !== 'string')
  const client = productConversation(`ws://127.0.0.1:${address.port}`, 'synthetic', directory, 'test')
  t.after(async () => {
    client.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  })
  await client.ready()
  return { client, received }
}

const clarification = { type: 'control_request', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion',
  rawInput: JSON.stringify({ questions: [{ id: 'task', prompt: 'What would you like me to do?' }] }) } }

void test('ordinary turns still require a successful text reply', async t => {
  const { client } = await fixture(t, [{ type: 'assistant', message: { content: [{ type: 'text', text: '24' }] } },
    { type: 'result', status: 'success' }])
  assert.equal(await client.turn('Compute 11 + 13.'), '24')
})

void test('whole-record observation records a clarification without approving it', async t => {
  const { client, received } = await fixture(t, [clarification])
  assert.deepEqual(await client.turnWithClarification('[REDACTED:PROTECTED_RECORD]'), { kind: 'clarification', questionCount: 1 })
  assert.deepEqual(received, ['user'])
})

void test('ordinary turns reject even a valid clarification request', async t => {
  const { client } = await fixture(t, [clarification])
  await assert.rejects(client.turn('Compute 11 + 13.'), /Unexpected live event: control_request/)
})

void test('clarification observation refuses execution tools', async t => {
  const { client } = await fixture(t, [{ ...clarification, request: { ...clarification.request, tool_name: 'Bash' } }])
  await assert.rejects(client.turnWithClarification('[REDACTED:PROTECTED_RECORD]'), /AskUserQuestion/)
})

void test('clarification observation refuses malformed questions and error events', async t => {
  const malformed = await fixture(t, [{ ...clarification, request: { ...clarification.request, rawInput: '{}' } }])
  await assert.rejects(malformed.client.turnWithClarification('[REDACTED:PROTECTED_RECORD]'))
  const failed = await fixture(t, [{ type: 'error', message: 'failure' }])
  await assert.rejects(failed.client.turnWithClarification('[REDACTED:PROTECTED_RECORD]'), /Unexpected live event: error/)
})
