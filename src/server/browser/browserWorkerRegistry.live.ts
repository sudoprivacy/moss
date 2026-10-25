/** Opt-in real Docker/Chrome acceptance. All resources use fresh test owners. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket, { WebSocketServer } from 'ws'
import { runDocker } from '../runtime/dockerCommand.js'
import { BrowserWorkerRegistry } from './browserWorkerRegistry.js'
import { browserController, type BrowserBinding } from './browserGateway.js'
import { bridgeBrowserWindowStream } from './browserWindowStream.js'

interface State { browserSessionId: string; profileId: string; state: string; controlEpoch: number; targetEpoch: number; capabilities?: { windowStream?: boolean } }
interface Reply { session: State }

if (!process.env.MOSS_BROWSER_IMAGE || !process.env.MOSS_BROWSER_SECRET) throw new Error('Set MOSS_BROWSER_IMAGE and MOSS_BROWSER_SECRET for owned Docker acceptance')
const orgId = `browser-live-${randomUUID()}`
const a = { orgId, userId: randomUUID(), sessionId: randomUUID() }
const b = { orgId, userId: randomUUID(), sessionId: randomUUID() }
const next = { ...a, sessionId: randomUUID() }
const sessions = new Map<string, BrowserBinding & { desiredState: string }>([a, b, next].map(binding => [binding.sessionId, { ...binding, desiredState: 'active' }]))
const registry = new BrowserWorkerRegistry(async id => sessions.get(id) ?? null)
const key = (binding: BrowserBinding) => createHash('sha256').update(JSON.stringify([binding.orgId, binding.userId])).digest('hex').slice(0, 32)
console.log(JSON.stringify({ phase: 'owned-fixtures', orgId, owners: [key(a), key(b)] }))
const receipts: unknown[] = []
const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return }
  res.setHeader('Content-Type', 'text/html')
  if (req.url === '/owner-a' || req.url === '/owner-b') res.setHeader('Set-Cookie', `profile_login=${req.url === '/owner-a' ? 'owner-a' : 'owner-b'}; Path=/; SameSite=Lax; Max-Age=3600`)
  res.end(`<title>${req.url}</title><h1>${req.url}</h1><input aria-label="Review"><button>Submit</button>`)
})
await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve))
const port = (server.address() as { port: number }).port
const fixtureHost = process.env.MOSS_BROWSER_LIVE_HOST || 'host.docker.internal'
let rpc = 0
async function invoke(binding: BrowserBinding, action: Record<string, unknown>): Promise<Reply> {
  return await registry.invoke(binding, browserController(binding), action) as Reply
}
async function tool(binding: BrowserBinding, name: string, args: unknown): Promise<Record<string, unknown>> {
  const reply = await registry.mcp(binding, { jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }) as { result: Record<string, unknown> }
  return reply.result
}
async function command(binding: BrowserBinding, method: string, params: unknown): Promise<Record<string, unknown>> {
  const { session } = await invoke(binding, { kind: 'state' })
  return tool(binding, 'browser_action', { kind: 'command', controlEpoch: session.controlEpoch, targetEpoch: session.targetEpoch, method, paramsJson: JSON.stringify(params) })
}
async function waitCookie(binding: BrowserBinding, expected: string): Promise<string> {
  let last = ''
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await command(binding, 'Runtime.evaluate', { expression: 'JSON.stringify({url:location.href,cookie:document.cookie,ready:document.readyState})', returnByValue: true })
    last = JSON.stringify(result)
    if (last.includes(expected)) return last
    if (result.isError && !last.includes('stale_browser_operation')) throw new Error(`Browser observation failed: ${last}`)
    await delay(250)
  }
  throw new Error(`Browser did not load the isolated fixture: ${last}`)
}

/** Exercise the real registry, public worker and Node relay through viewer refresh. */
async function verifyWindowStream(binding: BrowserBinding): Promise<void> {
  const prior = (await invoke(binding, { kind: 'state' })).session
  const restarted = await tool(binding, 'browser_restart', { isHeadless: false, transport: 'extension',
    acknowledgeStateLoss: true, controlEpoch: prior.controlEpoch, targetEpoch: prior.targetEpoch })
  assert.notEqual(restarted.isError, true, JSON.stringify(restarted))
  assert.deepEqual(await registry.conversationControl(binding, browserController(binding), 'interrupt'), { changed: true })
  const viewerId = randomUUID()
  const attached = (await invoke(binding, { kind: 'attach', viewerId, surface: 'window' })).session
  assert.equal(attached.state, 'human')
  assert.equal(attached.capabilities?.windowStream, true)
  assert.equal(attached.profileId, prior.profileId)
  const operation = { viewerId, controlEpoch: attached.controlEpoch, targetEpoch: attached.targetEpoch }
  await invoke(binding, { kind: 'window-stream', ...operation })
  const gateway = createServer()
  const wss = new WebSocketServer({ noServer: true })
  const upstreams = new Set<WebSocket>()
  const viewers = new Set<WebSocket>()
  const latencies: number[] = []
  let upstreamFailure: unknown
  gateway.on('upgrade', (request, socket, head) => {
    void registry.openWindowStream(binding, browserController(binding), operation).then(upstream => {
      upstreams.add(upstream)
      upstream.once('close', () => upstreams.delete(upstream))
      wss.handleUpgrade(request, socket, head, downstream => {
        bridgeBrowserWindowStream(downstream, upstream, async () => {
          const current = (await invoke(binding, { kind: 'state' })).session
          return current.browserSessionId === attached.browserSessionId && current.profileId === attached.profileId &&
            current.controlEpoch === attached.controlEpoch && current.targetEpoch === attached.targetEpoch
        })
      })
    }).catch(error => { upstreamFailure = error; socket.destroy() })
  })
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve))
  const open = async (): Promise<WebSocket> => {
    const started = performance.now()
    const viewer = new WebSocket(`ws://127.0.0.1:${(gateway.address() as { port: number }).port}`, ['binary'])
    viewers.add(viewer)
    const [data, isBinary] = await once(viewer, 'message', { signal: AbortSignal.timeout(15_000) })
      .catch(error => { throw new Error('Real worker RFB banner did not reach the viewer', { cause: upstreamFailure ?? error }) })
    assert.equal(isBinary, true)
    assert.equal(Buffer.from(data).toString(), 'RFB 003.008\n')
    latencies.push(Math.round(performance.now() - started))
    return viewer
  }
  try {
    const first = await open()
    const refreshed = once(first, 'close')
    first.close()
    await refreshed
    const afterRefresh = (await invoke(binding, { kind: 'state' })).session
    assert.equal(afterRefresh.browserSessionId, attached.browserSessionId)
    assert.equal(afterRefresh.controlEpoch, attached.controlEpoch)
    assert.equal(afterRefresh.state, 'human')
    const second = await open()
    const revoked = once(second, 'close', { signal: AbortSignal.timeout(8000) })
    await invoke(binding, { kind: 'detach', viewerId })
    await revoked
    await assert.rejects(registry.openWindowStream(binding, browserController(binding), operation), /browser_window_stream_unavailable/)
    const detached = (await invoke(binding, { kind: 'state' })).session
    assert.equal(detached.browserSessionId, attached.browserSessionId)
    assert.equal(detached.state, 'human')
    assert.equal(detached.controlEpoch, attached.controlEpoch)
    assert.deepEqual(await registry.conversationControl(binding, browserController(binding), 'continue'), { changed: true })
    const current = (await invoke(binding, { kind: 'state' })).session
    const navigation = await tool(binding, 'browser_action', { kind: 'navigate', controlEpoch: current.controlEpoch,
      targetEpoch: current.targetEpoch, url: `http://${fixtureHost}:${port}/owner-a?window-stream=1` })
    assert.notEqual(navigation.isError, true)
    await waitCookie(binding, 'profile_login=owner-a')
    receipts.push({ realWorkerWindowStream: true, refreshPreservesHumanLease: true, detachedViewerRevoked: true,
      sameProfileCookie: true, firstBannerLatencyMs: latencies, publicWebUiRouteAccepted: false })
  } finally {
    for (const socket of [...viewers, ...upstreams, ...wss.clients]) socket.terminate()
    wss.close()
    await new Promise<void>(resolve => gateway.close(() => resolve()))
  }
}
try {
  const savedOwners = process.env.MOSS_BROWSER_ALLOWED_OWNERS
  try {
    process.env.MOSS_BROWSER_ALLOWED_OWNERS = JSON.stringify([{ orgId: a.orgId, userId: a.userId }])
    await registry.mcp(a, { jsonrpc: '2.0', id: ++rpc, method: 'tools/list' })
    await assert.rejects(invoke(b, { kind: 'state' }), /browser_not_enabled_for_owner/)
    await assert.rejects(registry.mcp(b, { jsonrpc: '2.0', id: ++rpc, method: 'tools/list' }), /browser_not_enabled_for_owner/)
    for (const binding of [a, b]) assert.notEqual((await runDocker(['inspect', `moss-browser-${key(binding)}`])).code, 0)
    console.log(JSON.stringify({ phase: 'restricted-rollout', outsideOwnerDenied: true, containersNotCreated: true }))
  } finally {
    if (savedOwners === undefined) delete process.env.MOSS_BROWSER_ALLOWED_OWNERS
    else process.env.MOSS_BROWSER_ALLOWED_OWNERS = savedOwners
  }
  for (const binding of [a, next, b]) {
    await registry.mcp(binding, { jsonrpc: '2.0', id: ++rpc, method: 'initialize', params: {} })
    const listed = await registry.mcp(binding, { jsonrpc: '2.0', id: ++rpc, method: 'tools/list' }) as { result: { tools: unknown[] } }
    assert.equal(listed.result.tools.length, 5)
    assert.deepEqual(await registry.conversationControl(binding, browserController(binding), 'interrupt'), { changed: false })
    assert.deepEqual(await registry.conversationControl(binding, browserController(binding), 'continue'), { changed: false })
    assert.notEqual((await runDocker(['inspect', `moss-browser-${key(binding)}`])).code, 0)
  }
  console.log(JSON.stringify({ phase: 'discovery', profilesNotClaimed: true, containersNotCreated: true }))
  const initialA = (await invoke(a, { kind: 'state' })).session
  const initialB = (await invoke(b, { kind: 'state' })).session
  assert.notEqual(initialA.profileId, initialB.profileId)
  for (const binding of [a, b]) {
    const launched = await tool(binding, 'browser_launch', { isHeadless: true, transport: 'extension' })
    if (launched.isError === true) throw new Error(`browser_launch failed for ${binding.userId}: ${JSON.stringify(launched)}`)
    const { session } = await invoke(binding, { kind: 'state' })
    const owner = binding === a ? 'owner-a' : 'owner-b'
    const navigation = await tool(binding, 'browser_action', { kind: 'navigate', controlEpoch: session.controlEpoch, targetEpoch: session.targetEpoch, url: `http://${fixtureHost}:${port}/${owner}` })
    if (navigation.isError === true) throw new Error(`browser navigation failed for ${owner}: ${JSON.stringify(navigation)}`)
    const cookie = await waitCookie(binding, `profile_login=${owner}`)
    assert.ok(!cookie.includes(`profile_login=${owner === 'owner-a' ? 'owner-b' : 'owner-a'}`))
    console.log(JSON.stringify({ phase: 'owner-isolation', owner, profileId: session.profileId }))
  }
  const original = (await invoke(a, { kind: 'state' })).session
  assert.deepEqual(await registry.conversationControl(next, browserController(next), 'continue'), { changed: false }, 'Chat in another conversation must not claim this profile')
  await assert.rejects(invoke(next, { kind: 'state' }), /browser_profile_in_use/)
  assert.deepEqual(await registry.conversationControl(a, browserController(a), 'interrupt'), { changed: true })
  const human = (await invoke(a, { kind: 'state' })).session
  sessions.get(a.sessionId)!.desiredState = 'terminated'
  const moved = (await invoke(next, { kind: 'state' })).session
  assert.equal(moved.profileId, original.profileId)
  assert.equal(moved.browserSessionId, original.browserSessionId)
  assert.equal(moved.state, 'human')
  assert.ok(moved.targetEpoch > human.targetEpoch)
  const denied = await command(next, 'Runtime.evaluate', { expression: 'document.title="Must not run"', returnByValue: true })
  assert.equal(denied.isError, true)
  assert.ok(JSON.stringify(denied).includes('browser_control_held_by_user'))
  await assert.rejects(invoke(a, { kind: 'reload', controlEpoch: original.controlEpoch, targetEpoch: original.targetEpoch }), /browser_profile_in_use/)
  assert.deepEqual(await registry.conversationControl(next, browserController(next), 'continue'), { changed: true })
  const returned = (await invoke(next, { kind: 'state' })).session
  assert.equal(returned.state, 'ai')
  const cookie = await command(next, 'Runtime.evaluate', { expression: 'document.cookie', returnByValue: true })
  assert.ok(JSON.stringify(cookie).includes('profile_login=owner-a'))
  const stopped = await runDocker(['stop', '--time', '15', `moss-browser-${key(a)}`])
  assert.equal(stopped.code, 0)
  await delay(300)
  const recovered = (await invoke(next, { kind: 'state' })).session
  assert.equal(recovered.profileId, original.profileId)
  assert.equal(recovered.state, 'stopped')
  assert.ok(recovered.controlEpoch > returned.controlEpoch)
  const resumed = (await invoke(next, { kind: 'start', isHeadless: true, transport: 'extension' })).session
  assert.equal(resumed.state, 'human')
  await invoke(next, { kind: 'return', controlEpoch: resumed.controlEpoch, targetEpoch: resumed.targetEpoch })
  // Chrome preserves the profile cookie even though the selected tab may be
  // new after restart. Navigate the new page before reading its origin cookie.
  const current = (await invoke(next, { kind: 'state' })).session
  const navigation = await tool(next, 'browser_action', { kind: 'navigate', controlEpoch: current.controlEpoch, targetEpoch: current.targetEpoch, url: `http://${fixtureHost}:${port}/owner-a?restore=1` })
  assert.notEqual(navigation.isError, true)
  await waitCookie(next, 'profile_login=owner-a')
  await verifyWindowStream(next)
  receipts.push({ restrictedRolloutVerified: true, ownersIsolated: true, concurrentConversationRejected: true, sameProfileAcrossConversations: true, humanLeasePreserved: true, staleSessionRejected: true, restartRequiresExplicitReturn: true })
  console.log(JSON.stringify({ status: 'passed', receipts }))
} finally {
  server.close()
  for (const binding of [a, b]) {
    const owner = key(binding)
    const name = `moss-browser-${owner}`
    const inspected = await runDocker(['inspect', name])
    if (inspected.code === 0) {
      assert.equal(JSON.parse(inspected.stdout)[0]?.Config?.Labels?.['moss.browser.owner'], owner)
      const stop = await runDocker(['stop', '--time', '15', name])
      assert.equal(stop.code, 0)
      const remove = await runDocker(['rm', name])
      assert.equal(remove.code, 0)
    }
    const volume = `moss-browser-profile-${owner}`
    const inspectedVolume = await runDocker(['volume', 'inspect', volume])
    if (inspectedVolume.code === 0) {
      assert.equal(JSON.parse(inspectedVolume.stdout)[0]?.Labels?.['moss.browser.owner'], owner)
      assert.equal((await runDocker(['volume', 'rm', volume])).code, 0)
    }
  }
}
