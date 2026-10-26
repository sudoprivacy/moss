/** Verify certificate-bound session ownership through Moss and a real mTLS daemon. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'
import { NexusVfsClient } from '@nexus-ai-fs/vfs-client'

import { mintSessionIdentity, ownerField } from '../../src/server/nexus/sessionIdentity.js'
import { ManagedAgentClient } from '../../src/server/nexus/managedAgentClient.js'

const [tlsDirectory, endpoint] = process.argv.slice(2)
assert(tlsDirectory && endpoint, 'Node TLS directory and endpoint are required')
const user = `e2e-user-${process.pid}`
const agentId = `moss-e2e-${process.pid}`
const protoDirectory = join(process.cwd(), 'node_modules', '@nexus-ai-fs', 'vfs-client', 'proto')
const ZoneApi = (
  grpc.loadPackageDefinition(protoLoader.loadSync(join(protoDirectory, 'nexus', 'raft', 'transport.proto'), {
    keepCase: true, longs: String, defaults: true, includeDirs: [protoDirectory],
  })) as any
).nexus.raft.ZoneApiService
const node = new ZoneApi(endpoint, grpc.credentials.createSsl(
  readFileSync(join(tlsDirectory, 'ca.pem')),
  readFileSync(join(tlsDirectory, 'node-key.pem')),
  readFileSync(join(tlsDirectory, 'node.pem')),
), { 'grpc.ssl_target_name_override': 'nexus-node', 'grpc.default_authority': 'nexus-node' })
const admin = (method: string, request: unknown): Promise<any> => new Promise((resolve, reject) => {
  node[method](request, new grpc.Metadata({ waitForReady: true }), { deadline: Date.now() + 20_000 },
    (error: grpc.ServiceError | null, value: unknown) => error ? reject(error) : resolve(value))
})

const clients: ManagedAgentClient[] = []
const sessions: Array<{ client: ManagedAgentClient; id: string }> = []
function refusal(error: unknown, code: number | undefined, fragments: string[]): boolean {
  if (!(error instanceof Error)) return false
  try {
    const response: { code: number; message: string } = JSON.parse(error.message)
    return typeof response.code === 'number' && response.code < 0
      && (code === undefined || response.code === code) && typeof response.message === 'string'
      && fragments.every(fragment => response.message.includes(fragment))
  } catch { return false }
}
async function start(client: ManagedAgentClient, input: Parameters<ManagedAgentClient['startSession']>[0]) {
  const session = await client.startSession(input)
  sessions.push({ client, id: session.sessionId })
  return session
}
let failure: unknown
try {
  // The transport starts before the replicated issuer store is bound.
  const readyDeadline = Date.now() + 20_000
  let isIssuerReady = false
  while (Date.now() < readyDeadline) {
    const state = await admin('ListSessionMinters', {})
    if (state.success) {
      isIssuerReady = true
      break
    }
    assert.equal(state.error, 'this node has no session-mint plane (auth-off)',
      'unexpected issuer readiness failure')
    await delay(100)
  }
  assert(isIssuerReady, 'the authenticated issuer store must become ready')
  const minted = await admin('MintAgent', { subject_id: agentId, display_name: agentId })
  assert.equal(minted.success, true, `the Node operator must mint the Moss Agent: ${minted.error ?? 'missing result'}`)
  const allowed = await admin('AllowSessionMinter', { agent_id: agentId })
  assert.equal(allowed.success, true, 'the Node operator must authorize the session issuer')

  const directory = mkdtempSync(join(tmpdir(), 'moss-session-owner-'))
  for (const [name, value] of Object.entries({
    'ca.pem': minted.ca_pem, 'agent.pem': minted.agent_cert_pem, 'agent-key.pem': minted.agent_key_pem,
  })) writeFileSync(join(directory, name), value as string, { mode: 0o600 })
  const mossTls = { ca: join(directory, 'ca.pem'), cert: join(directory, 'agent.pem'),
    key: join(directory, 'agent-key.pem'), serverName: 'nexus-node' }
  const identity = await mintSessionIdentity(endpoint, mossTls, user)
  assert(identity, 'Moss must mint a user-bound session credential')
  const body = ownerField(identity, user)
  assert.deepEqual(body, {}, 'the proven owner is supplied by the certificate')

  // Keep each child alive until its ownership is inspected and explicitly cancelled.
  const childEnvironment: Record<string, string> = {}
  if (process.platform === 'win32') {
    assert(process.env.SystemRoot, 'Windows Node requires its system directory for cryptographic initialization')
    childEnvironment.SystemRoot = process.env.SystemRoot
  }
  const spawnSpec = { cmd: process.execPath,
    args: ['-e', 'setTimeout(() => process.exit(0), 90000); setInterval(() => {}, 1000)'],
    env: childEnvironment, cwd: process.cwd() }
  const delegated = new ManagedAgentClient(NexusVfsClient.withMtls(endpoint, identity.tls), '')
  clients.push(delegated)
  const started = await start(delegated, { agentId: 'scode-standard', ...body, spawnSpec })
  const recorded = await delegated.getSession(started.sessionId)
  assert.equal(recorded.owner_id, user, 'Nexus must derive the owner from the credential')

  await assert.rejects(start(delegated, { agentId: 'scode-standard', ownerId: `${user}-foreign`, spawnSpec }),
    error => refusal(error, undefined, ['owner_id', 'credential', user, `${user}-foreign`]),
    'a caller must not replace its authenticated owner through the body')

  const otherIdentity = await mintSessionIdentity(endpoint, mossTls, `${user}-other`)
  assert(otherIdentity)
  const other = new ManagedAgentClient(NexusVfsClient.withMtls(endpoint, otherIdentity.tls), '')
  clients.push(other)
  await assert.rejects(other.getSession(started.sessionId),
    error => refusal(error, undefined, ['session owner does not match the caller\'s credential']),
    'a different authenticated owner must be refused session inspection')

  const control = new ManagedAgentClient(NexusVfsClient.withMtls(endpoint, mossTls), '')
  clients.push(control)
  await assert.rejects(start(control, { agentId: 'scode-standard', spawnSpec }),
    error => refusal(error, -32003, ['zone_id', 'explicitly granted']),
    'a bare issuer certificate cannot impersonate a delegated session')
  process.stdout.write('PASS: certificate owns its session; forged body, foreign certificate and bare issuer are refused\n')
} catch (error) {
  failure = error
  throw error
} finally {
  const stopped = await Promise.allSettled(sessions.map(session => session.client.cancel(session.id)))
  clients.forEach(client => client.close())
  node.close()
  const rejected = stopped.filter(result => result.status === 'rejected')
  if (rejected.length) throw new AggregateError([
    ...(failure ? [failure] : []), ...rejected.map(result => result.reason),
  ], 'every owned child must be cancelled')
}
