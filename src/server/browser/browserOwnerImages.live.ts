/** Opt-in real Docker acceptance for a staged image upgrade with a human lease. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { runDocker } from '../runtime/dockerCommand.js'
import { BrowserWorkerRegistry } from './browserWorkerRegistry.js'
import { browserController, type BrowserBinding } from './browserGateway.js'

interface State { browserSessionId: string; profileId: string; state: string; controlEpoch: number; targetEpoch: number }
interface Reply { session: State }
interface ContainerInfo { Id: string; Image: string; Config: { Image: string; Labels: Record<string, string> }; State: { Running: boolean; StartedAt: string } }

const currentImage = process.env.MOSS_BROWSER_IMAGE
const priorImage = process.env.MOSS_BROWSER_PRIOR_IMAGE
assert.ok(currentImage && priorImage && currentImage !== priorImage && process.env.MOSS_BROWSER_SECRET,
  'Set distinct immutable current/prior images and an isolated test secret')
const orgId = `browser-image-live-${randomUUID()}`
const a = { orgId, userId: randomUUID(), sessionId: randomUUID() }
const b = { orgId, userId: randomUUID(), sessionId: randomUUID() }
const ownerKey = (binding: BrowserBinding) => createHash('sha256').update(JSON.stringify([binding.orgId, binding.userId])).digest('hex').slice(0, 32)
const sessions = new Map<string, BrowserBinding & { desiredState: string }>([a, b].map(binding => [binding.sessionId, { ...binding, desiredState: 'active' }]))
const lookup = async (id: string) => sessions.get(id) ?? null
console.log(JSON.stringify({ phase: 'owned-fixtures', orgId, owners: [ownerKey(a), ownerKey(b)] }))
process.env.MOSS_BROWSER_ALLOWED_OWNERS = JSON.stringify([a, b].map(({ orgId, userId }) => ({ orgId, userId })))
const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return }
  const owner = req.url === '/owner-a' ? 'owner-a' : 'owner-b'
  res.setHeader('Content-Type', 'text/html')
  res.setHeader('Set-Cookie', `image_upgrade_login=${owner}; Path=/; SameSite=Lax; Max-Age=3600`)
  res.end(`<title>${owner}</title><input aria-label="Review" value="${owner}">`)
})
await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve))
const host = process.env.MOSS_BROWSER_LIVE_HOST || 'host.docker.internal'
const origin = `http://${host}:${(server.address() as { port: number }).port}`
let rpc = 0
async function state(registry: BrowserWorkerRegistry, binding: BrowserBinding): Promise<State> {
  return (await registry.invoke(binding, browserController(binding), { kind: 'state' }) as Reply).session
}
async function tool(registry: BrowserWorkerRegistry, binding: BrowserBinding, name: string, args: unknown): Promise<Record<string, unknown>> {
  const reply = await registry.mcp(binding, { jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }) as { result: Record<string, unknown> }
  return reply.result
}
async function observe(registry: BrowserWorkerRegistry, binding: BrowserBinding): Promise<Record<string, unknown>> {
  const current = await state(registry, binding)
  return tool(registry, binding, 'browser_action', { kind: 'command', controlEpoch: current.controlEpoch,
    targetEpoch: current.targetEpoch, method: 'Runtime.evaluate',
    paramsJson: JSON.stringify({ expression: 'JSON.stringify({url:location.href,cookie:document.cookie,title:document.title})', returnByValue: true }) })
}
async function navigate(registry: BrowserWorkerRegistry, binding: BrowserBinding, owner: string): Promise<void> {
  const current = await state(registry, binding)
  const reply = await tool(registry, binding, 'browser_action', { kind: 'navigate', controlEpoch: current.controlEpoch,
    targetEpoch: current.targetEpoch, url: `${origin}/${owner}` })
  assert.notEqual(reply.isError, true, JSON.stringify(reply))
  for (let attempt = 0; attempt < 40; attempt++) {
    const observation = await observe(registry, binding)
    const text = JSON.stringify(observation)
    if (text.includes(`image_upgrade_login=${owner}`)) return
    if (observation.isError && !text.includes('stale_browser_operation')) throw new Error(text)
    await delay(250)
  }
  throw new Error(`Isolated profile did not observe its ${owner} cookie`)
}
async function inspect(binding: BrowserBinding): Promise<ContainerInfo> {
  const result = await runDocker(['inspect', `moss-browser-${ownerKey(binding)}`])
  assert.equal(result.code, 0, result.stderr)
  return JSON.parse(result.stdout)[0]
}
let failure: unknown
try {
  process.env.MOSS_BROWSER_IMAGE = priorImage
  delete process.env.MOSS_BROWSER_OWNER_IMAGES
  const previous = new BrowserWorkerRegistry(lookup)
  await state(previous, a)
  const launchA = await tool(previous, a, 'browser_launch', { isHeadless: true, transport: 'extension' })
  assert.notEqual(launchA.isError, true, JSON.stringify(launchA))
  await navigate(previous, a, 'owner-a')
  assert.deepEqual(await previous.conversationControl(a, browserController(a), 'interrupt'), { changed: true })
  const human = await state(previous, a)
  assert.equal(human.state, 'human')
  const before = await inspect(a)
  assert.equal(before.Config.Image, priorImage)

  process.env.MOSS_BROWSER_IMAGE = currentImage
  process.env.MOSS_BROWSER_OWNER_IMAGES = JSON.stringify([{ orgId: a.orgId, userId: a.userId, image: priorImage }])
  const upgraded = new BrowserWorkerRegistry(lookup)
  const retained = await state(upgraded, a)
  for (const field of ['browserSessionId', 'profileId', 'controlEpoch', 'targetEpoch', 'state'] as const) {
    assert.equal(retained[field], human[field], `Upgrade changed human ${field}`)
  }
  const denied = await observe(upgraded, a)
  assert.equal(denied.isError, true)
  assert.ok(JSON.stringify(denied).includes('browser_control_held_by_user'))

  await state(upgraded, b)
  const launchedB = await tool(upgraded, b, 'browser_launch', { isHeadless: true, transport: 'extension' })
  assert.notEqual(launchedB.isError, true, JSON.stringify(launchedB))
  await navigate(upgraded, b, 'owner-b')
  const fresh = await inspect(b)
  assert.equal(fresh.Config.Image, currentImage)
  assert.notEqual((await state(upgraded, b)).profileId, human.profileId)
  assert.ok(!JSON.stringify(await observe(upgraded, b)).includes('image_upgrade_login=owner-a'))

  delete process.env.MOSS_BROWSER_OWNER_IMAGES
  const unpinned = new BrowserWorkerRegistry(lookup)
  await assert.rejects(state(unpinned, a), /Managed browser upgrade requires a drained profile/)
  const after = await inspect(a)
  assert.equal(after.Id, before.Id)
  assert.equal(after.State.StartedAt, before.State.StartedAt)
  assert.equal(after.State.Running, true)
  assert.equal(after.Image, before.Image)
  const unchanged = await state(upgraded, a)
  assert.equal(unchanged.state, 'human')
  assert.equal(unchanged.controlEpoch, human.controlEpoch)
  assert.equal(unchanged.targetEpoch, human.targetEpoch)
  assert.deepEqual(await upgraded.conversationControl(a, browserController(a), 'continue'), { changed: true })
  const cookie = await observe(upgraded, a)
  assert.notEqual(cookie.isError, true, JSON.stringify(cookie))
  assert.ok(JSON.stringify(cookie).includes('image_upgrade_login=owner-a'))
  assert.ok(!JSON.stringify(cookie).includes('image_upgrade_login=owner-b'))
  console.log(JSON.stringify({ status: 'passed', currentImage, priorImage, retainedHumanContainer: true,
    retainedHumanEpochs: true, pinnedOwnerCookiePreserved: true, defaultOwnerUsesNewImage: true,
    unpinnedMismatchStillRefused: true, normalConversationContinuesSameProfile: true }))
} catch (error) {
  failure = error
  throw error
} finally {
  const cleanupErrors: unknown[] = []
  for (const binding of [a, b]) {
    try {
      const key = ownerKey(binding)
      const name = `moss-browser-${key}`
      const result = await runDocker(['inspect', name])
      if (result.code === 0) {
        const info = JSON.parse(result.stdout)[0]
        assert.equal(info?.Config?.Labels?.['moss.kind'], 'managed-browser')
        assert.equal(info?.Config?.Labels?.['moss.browser.owner'], key)
        assert.equal((await runDocker(['stop', '--time', '15', name])).code, 0)
        assert.equal((await runDocker(['rm', name])).code, 0)
      }
      const volume = `moss-browser-profile-${key}`
      const existing = await runDocker(['volume', 'inspect', volume])
      if (existing.code === 0) {
        assert.equal(JSON.parse(existing.stdout)[0]?.Labels?.['moss.browser.owner'], key)
        assert.equal((await runDocker(['volume', 'rm', volume])).code, 0)
      }
    } catch (error) { cleanupErrors.push(error) }
  }
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Owned image-upgrade fixture cleanup failed')
}
