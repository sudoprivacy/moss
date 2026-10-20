import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HttpBrowserWorker, addBrowserFrameCoordinateHint, browserController, invokeSessionBrowser } from './browserGateway.js'

function jpeg(width: number, height: number): string {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]).toString('base64')
}

void test('browser observations declare the screenshot coordinate space before pixels', () => {
  const response = addBrowserFrameCoordinateHint({
    jsonrpc: '2.0', id: 1,
    result: { content: [
      { type: 'text', text: '{"session":{}}' },
      { type: 'image', mimeType: 'image/jpeg', data: jpeg(1280, 674) },
    ] },
  }) as { result: { content: Array<{ type: string; text?: string }> } }
  assert.equal(response.result.content.length, 3)
  assert.deepEqual(JSON.parse(response.result.content[1]!.text!), {
    screenshotPixelDimensions: {
      width: 1280,
      height: 674,
    },
    browserInputCoordinates: {
      unit: 'css-pixel',
      instruction:
        'Do not pass raw screenshot pixel positions to browser_action. First call browser_action command with method Runtime.evaluate and paramsJson {"expression":"({width:innerWidth,height:innerHeight,devicePixelRatio})","returnByValue":true}; divide screenshot x and y by the returned devicePixelRatio before clicking or scrolling.',
    },
  })
  assert.equal(response.result.content[2]!.type, 'image')
})

void test('opening a panel does not retain revoked profile authorization', async () => {
  const principal = { orgId: 'org', userId: 'owner' }
  let active = true
  const calls: unknown[] = []
  const deps = {
    getSession: async (sessionId: string) => ({ sessionId, ...principal, cwd: '/private-workspace', runtime: { type: 'cohost' } }),
    isUserActive: async () => active,
    worker: { invoke: async (...args: unknown[]) => { calls.push(args); return { ok: true } } },
  }
  await invokeSessionBrowser(deps, principal, 'conversation', { kind: 'state' })
  active = false
  await assert.rejects(invokeSessionBrowser(deps, principal, 'conversation', { kind: 'frame', viewerId: '00000000-0000-4000-8000-000000000000', controlEpoch: 1, targetEpoch: 0 }), /Forbidden/)
  await assert.rejects(invokeSessionBrowser(deps, { ...principal, userId: 'manager' }, 'conversation', { kind: 'take', controlEpoch: 1, targetEpoch: 0 }), /Forbidden/)
  assert.equal(calls.length, 1)
})

void test('human requests cannot impersonate AI or switch browser ownership', async () => {
  const principal = { orgId: 'org', userId: 'owner' }
  const calls: unknown[] = []
  const deps = {
    getSession: async (sessionId: string) => ({ sessionId, ...principal, cwd: '/private-workspace', runtime: { type: 'cohost' } }),
    isUserActive: async () => true,
    worker: { invoke: async (...args: unknown[]) => { calls.push(args); return { ok: true } } },
  }
  await invokeSessionBrowser(deps, principal, 'conversation', {
    kind: 'input', controlEpoch: 4, targetEpoch: 2, input: { kind: 'text', text: 'Manual login' },
    actor: 'ai', controller: 'ai', profile: 'someone-else', endpoint: 'http://attacker', binding: { userId: 'other' },
  })
  assert.deepEqual(calls, [[{ sessionId: 'conversation', ...principal }, browserController(principal), {
    kind: 'input', controlEpoch: 4, targetEpoch: 2, input: { kind: 'text', text: 'Manual login' },
  }]])
  await assert.rejects(invokeSessionBrowser(deps, principal, 'conversation', { kind: 'input', controlEpoch: true, targetEpoch: 2 }), /Invalid browser epoch/)
})

void test('a timed out input is sent once and carries only the trusted host credential', async () => {
  let calls = 0
  const worker = new HttpBrowserWorker('http://127.0.0.1:8000/', 'fixture-host-token', async (url, options) => {
    calls++
    assert.equal(String(url), 'http://127.0.0.1:8000/invoke')
    assert.equal(options?.redirect, 'error')
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer fixture-host-token')
    throw new Error('Input may have reached Chrome')
  })
  await assert.rejects(worker.invoke({ orgId: 'org', userId: 'owner', sessionId: 'conversation' }, 'trusted-controller', { kind: 'input' }), /not replayed/)
  assert.equal(calls, 1)
})
