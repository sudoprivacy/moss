/** Real provider: child reads an order, parent saves it, compact, continue, resume. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'
import { NexusVfsClient } from '@nexus-ai-fs/vfs-client'
import { ManagedAgentClient } from '../../src/server/nexus/managedAgentClient.js'
import { mintSessionIdentity } from '../../src/server/nexus/sessionIdentity.js'
import { connectController } from './cohost-controller-live.js'

const [tlsRoot, endpoint, evidence] = process.argv.slice(2)
assert(tlsRoot && endpoint && evidence, 'TLS directory, endpoint and evidence directory are required')
assert.equal(process.env.MOSS_COHOST_LIVE, '1', 'Explicit live-provider opt-in is required')
const model = process.env.COHOST_E2E_MODEL ?? 'gpt-6-luna'
const code = `ORDER_${randomUUID().replaceAll('-', '')}`
const owner = `live-${randomUUID()}`
const agentId = `agent-${owner}`
const root = `/agents/${agentId}/acceptance`
const input = `${root}/order.json`
const policy = `${root}/delivery-policy.json`
const packing = `${root}/packing-policy.json`
const result = `${root}/result.json`
const final = `${root}/final.json`
const restored = `${root}/resumed.json`
const units = 9 + Math.floor(Math.random() * 17)
const subtotal = units * 29 + 47
const sealCount = 3 + Math.floor(Math.random() * 7)
mkdirSync(evidence, { recursive: true })
const tls = { ca: join(tlsRoot, 'ca.pem'), cert: join(tlsRoot, 'node.pem'), key: join(tlsRoot, 'node-key.pem') }
const proto = join(process.cwd(), 'node_modules/@nexus-ai-fs/vfs-client/proto')
const defs = grpc.loadPackageDefinition(protoLoader.loadSync(join(proto, 'nexus/raft/transport.proto'), {
  keepCase: true, longs: String, defaults: true, includeDirs: [proto],
})) as any
const node = new defs.nexus.raft.ZoneApiService(endpoint, grpc.credentials.createSsl(
  readFileSync(tls.ca), readFileSync(tls.key), readFileSync(tls.cert),
), { 'grpc.ssl_target_name_override': 'nexus-node', 'grpc.default_authority': 'nexus-node' })
const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
  node[method](params, new grpc.Metadata(), { deadline: Date.now() + 25_000 }, (error: Error | null, value: any) => error ? reject(error) : resolve(value))
})
const operator = NexusVfsClient.withMtls(endpoint, tls)
let client: NexusVfsClient | undefined
let agent: ManagedAgentClient | undefined
let controller: ReturnType<typeof connectController> | undefined
let session: Awaited<ReturnType<ManagedAgentClient['startSession']>> | undefined
try {
  const subject = `live-front-door-${randomUUID()}`
  const minted = await rpc('MintAgent', { subject_id: subject, display_name: subject })
  assert.equal(minted.success, true)
  assert.equal((await rpc('AllowSessionMinter', { agent_id: subject })).success, true)
  const identity = await mintSessionIdentity(endpoint, {
    ca: minted.ca_pem, cert: minted.agent_cert_pem, key: minted.agent_key_pem,
  }, owner)
  assert(identity)
  client = NexusVfsClient.withMtls(endpoint, identity.tls)
  agent = new ManagedAgentClient(client, '')
  session = await agent.startSession({ agentId, model, ownerId: owner })
  await operator.mkdir(root, '', { parents: true, existOk: true })
  await operator.write(input, Buffer.from(JSON.stringify({ code, units, unit_price: 29, delivery: 47 })), '')
  const routes = Array.from({ length: 128 }, (_, index) => ({
    quoteCode: index === 83 ? code : `CATALOG_${index}_${randomUUID()}`,
    carrier: `Carrier ${index}`, destination: `Delivery district ${index}`,
    handling: index === 83 ? 13 : 21 + index,
    service: 'Tracked parcel delivery with an arrival confirmation and a separate handling charge per order',
  }))
  await operator.write(policy, Buffer.from(JSON.stringify({ routes })), '')
  const packages = Array.from({ length: 26 }, (_, index) => ({
    quoteCode: index === 12 ? code : `PACKAGE_${index}_${randomUUID()}`,
    seals: index === 12 ? sealCount : 15 + index,
    instructions: 'Inspect the parcel, apply each required tamper seal, verify the label matches the order, and retain the arrival confirmation with the delivery record.',
  }))
  await operator.write(packing, Buffer.from(JSON.stringify({ packages })), '')
  const requests = async () => (await operator.readdir('/model', '')).filter(entry => entry.name.endsWith('.prompt')).map(entry => entry.name)
  const before = new Set(await requests())
  controller = connectController({ agent, sessionEndpoint: session.sessionEndpoint }, new Set([input, policy, packing, result, final]), true)
  await controller.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const opened = await controller.rpc('session/new', { cwd: '/', mcpServers: [] })
  const sessionId = opened.sessionId
  assert.equal(sessionId, session.durableSessionId)
  await controller.rpc('session/setPermissionMode', { sessionId, permissionMode: 'prompt' })
  const turn = (text: string) => controller!.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 180_000)
  assert.equal((await turn(`Read ${policy} with the file tool, find quoteCode ${code}, and report its handling charge. We will apply that charge after calculating this order's subtotal. Do not use Bash or change files.`)).stopReason, 'end_turn')
  controller.assertHealthy()
  assert.equal((await turn(`Use one Explore sub-agent to read ${input} and return the code and numeric subtotal (units times unit_price plus delivery). The child must be read-only. Then you, the parent, save ${result} as JSON with code and subtotal. Do not use Bash. Report after saving.`)).stopReason, 'end_turn')
  controller.assertHealthy()
  const saved = JSON.parse((await operator.read(result, '')).toString())
  assert.deepEqual(saved, { code, subtotal })
  assert.equal(controller.exploreDelegations, 1, 'one actual child delegation is required')
  assert.equal((await turn(`Read ${packing} with the file tool and review the packing requirements for this order. Report the matching seal count and retain it for the final delivery quote. Do not change files or use Bash.`)).stopReason, 'end_turn')
  controller.assertHealthy()
  const preCompact = new Set(await requests())
  assert.equal((await turn('/compact')).stopReason, 'end_turn')
  const compact = [...controller.updates].reverse().find(update => update.sessionUpdate === 'tool_call_update' && update.rawOutput?.trigger === 'manual')?.rawOutput
  assert.equal(compact?.status, 'completed')
  assert(compact.after_tokens < compact.before_tokens, 'actual compacted history must be smaller')
  const postCompact = await requests()
  assert(postCompact.some(name => !preCompact.has(name)), 'compaction must issue a native Nexus model request')
  assert.equal((await turn(`Using this conversation's order code and subtotal, add the matching handling charge from the delivery policy you reviewed and save ${final} as JSON with code, numeric total and seal_count from the packing review. Do not reread policy, packing, input or result files. Report after saving.`)).stopReason, 'end_turn')
  assert.deepEqual(JSON.parse((await operator.read(final, '')).toString()), { code, total: subtotal + 13, seal_count: sealCount })
  controller.assertHealthy()
  assert(controller.approvals >= 3)
  let approvals = controller.approvals
  await controller.close()
  controller = undefined
  await agent.cancel(session.sessionId)
  const resumed = await agent.startSession({ agentId, model, ownerId: owner, resumeSessionId: sessionId })
  session = resumed
  assert.equal(resumed.durableSessionId, sessionId)
  controller = connectController({ agent, sessionEndpoint: resumed.sessionEndpoint }, new Set([restored]))
  await controller.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const loaded = await controller.rpc('session/load', { sessionId, cwd: '/', mcpServers: [] })
  assert(loaded)
  await controller.rpc('session/setPermissionMode', { sessionId, permissionMode: 'prompt' })
  assert.equal((await controller.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text:
    `Continue the delivery quote from your restored conversation. Save ${restored} as JSON with the same code, total and seal_count as the final quote. Use only your conversation memory; do not read any files. Report after saving.` }] }, 180_000)).stopReason, 'end_turn')
  assert.deepEqual(JSON.parse((await operator.read(restored, '')).toString()), { code, total: subtotal + 13, seal_count: sealCount })
  controller.assertHealthy()
  assert(controller.approvals > 0)
  approvals += controller.approvals
  const nativeRequests = (await requests()).filter(name => !before.has(name)).length
  assert(nativeRequests >= 5)
  const report = { passed: true, real_model: true, model, native_nexus_requests: nativeRequests,
    child_verified: true, compaction_verified: true, context_before: compact.before_tokens, context_after: compact.after_tokens, post_compaction_result_verified: true,
    resume_verified: true, persisted_results: 3, approvals, code }
  writeFileSync(join(evidence, 'acceptance.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally {
  if (controller) writeFileSync(join(evidence, 'updates.private.json'), JSON.stringify(controller.updates, null, 2))
  await controller?.close()
  if (session && agent) await agent.cancel(session.sessionId).catch(() => {})
  agent?.close()
  client?.close()
  operator.close()
  node.close()
}
