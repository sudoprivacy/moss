/**
 * Live end-to-end for moss's session-credential half, against a real daemon.
 *
 * What was previously only unit-tested is the composition: mint a credential,
 * dial as it, and send NO owner_id. A unit test can show `ownerField` returns
 * `{}`; only a daemon can show that nexus then records the right person. This
 * drives moss's own exported functions — not a hand-written probe — and reads
 * the answer back with `get_session_v1`, which is the only party that can say
 * what was actually stored.
 *
 * Needs a real auth-on daemon, so CI cannot run it; CI only checks that it
 * still parses, which keeps it from rotting into something nobody can run.
 *
 * Boot one and run it:
 *
 *   nexusd-cluster --cluster-init citest --hostname e2e --advertise-addr 127.0.0.1:22131
 *     --data-dir <d> --identity-dir <i>
 *   npx tsx scripts/e2e/session-owner-live.ts <d>/tls 127.0.0.1:22131
 *
 * The assertion that matters is the pair: moss sends an EMPTY body, and the
 * daemon still records the right person. Verified to discriminate — dialling
 * with moss's own certificate instead (no owner SAN, same empty body) records
 * `system`, so the owner demonstrably comes from the certificate and not from
 * somewhere that would have agreed by accident.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'
import { NexusVfsClient } from '@nexus-ai-fs/vfs-client'

import { mintSessionIdentity, ownerField } from '../../src/server/nexus/sessionIdentity.js'
import { ManagedAgentClient } from '../../src/server/nexus/managedAgentClient.js'

const TLS = process.argv[2]
const ENDPOINT = process.argv[3]
const SN = 'nexus-node'
const USER = `e2e-user-${process.pid}`
const AGENT = `moss-e2e-${process.pid}`

let failures = 0
const expect = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${String(detail)}`}`)
  if (!ok) failures += 1
}

// --- operator side: the allow-list is node-gated, so raw gRPC as the node ---
// The protos ship inside the client package, so this reads the same bytes the
// daemon was built from rather than a second copy that could drift.
const PROTO_DIR = join(process.cwd(), 'node_modules', '@nexus-ai-fs', 'vfs-client', 'proto')
const ZoneApi = (
  grpc.loadPackageDefinition(
    protoLoader.loadSync(join(PROTO_DIR, 'nexus', 'raft', 'transport.proto'), {
      keepCase: true,
      longs: String,
      defaults: true,
      includeDirs: [PROTO_DIR],
    }),
  ) as any
).nexus.raft.ZoneApiService
const opts = { 'grpc.ssl_target_name_override': SN, 'grpc.default_authority': SN }
const node = new ZoneApi(
  ENDPOINT,
  grpc.credentials.createSsl(
    readFileSync(join(TLS, 'ca.pem')),
    readFileSync(join(TLS, 'node-key.pem')),
    readFileSync(join(TLS, 'node.pem')),
  ),
  opts,
)
const admin = (m: string, r: unknown): Promise<any> =>
  new Promise(res =>
    node[m](r, new grpc.Metadata({ waitForReady: true }), { deadline: Date.now() + 20000 }, (e: any, x: any) =>
      res(e ? { rpcError: `${grpc.status[e.code]}: ${e.details}` } : x),
    ),
  )

const minted = await admin('MintAgent', { subject_id: AGENT, display_name: AGENT })
expect('operator mints the agent moss will act as', minted.success === true, minted.error ?? minted.rpcError)
await admin('AllowSessionMinter', { agent_id: AGENT })

// moss reads its own identity from disk, so put it there the way a deployment does.
const dir = mkdtempSync(join(tmpdir(), 'moss-e2e-'))
writeFileSync(join(dir, 'ca.pem'), minted.ca_pem)
writeFileSync(join(dir, 'agent.pem'), minted.agent_cert_pem)
writeFileSync(join(dir, 'agent-key.pem'), minted.agent_key_pem)
const mossTls = { ca: join(dir, 'ca.pem'), cert: join(dir, 'agent.pem'), key: join(dir, 'agent-key.pem') }

// --- moss's own code path, composed exactly as k8sBackend composes it ---
const identity = await mintSessionIdentity(ENDPOINT, mossTls, USER)
expect('moss mints a session credential', identity !== null, identity?.subjectId)
if (!identity) process.exit(1)

const body = ownerField(identity, USER)
expect('moss sends NO owner_id once it holds a credential', Object.keys(body).length === 0, JSON.stringify(body))

const starter = NexusVfsClient.withMtls(ENDPOINT, identity.tls)
const agent = new ManagedAgentClient(starter, '')
// A harmless spawn spec: k8sBackend always supplies one (kubectl), so leaving
// it out would exercise a shape moss never sends.
const started = await agent.startSession({
  agentId: 'scode-standard',
  ...body,
  spawnSpec: { cmd: 'cmd', args: ['/c', 'exit', '0'], env: {}, cwd: process.cwd() },
})
expect('start_session succeeds', typeof started.sessionId === 'string' && started.sessionId.length > 0, started.sessionId)

// --- the assertion that only a daemon can answer ---
const recorded = await (agent as any).call('managed_agent.get_session_v1', { session_id: started.sessionId })
expect(
  'nexus recorded the user moss never named',
  recorded?.owner_id === USER,
  `owner_id=${recorded?.owner_id} expected=${USER}`,
)
expect('and it is not the "system" default', recorded?.owner_id !== 'system', recorded?.owner_id)

await agent.cancel(started.sessionId).catch(() => {})
starter.close()
node.close()
console.log(`\n${failures === 0 ? 'ALL ASSERTIONS PASSED' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
