/**
 * Two sessions, one co-host daemon — the shape sudocloud is moving to.
 *
 * Today a session gets its own pod and its own scode subprocess, so "one
 * daemon, many sessions" has never been exercised on our side. `nexusd-cohost`
 * turns a spawn into a thread inside the daemon, which makes the interesting
 * question not "does it start" but "do two of them stay apart": distinct
 * session ids, the owner each was opened for, and per-agent state that does not
 * bleed.
 *
 * Drives moss's own functions rather than a probe, so what passes here is the
 * code that would run in production.
 *
 * Needs a live auth-on daemon, so CI cannot run it; CI only keeps it compiling.
 *
 *   nexusd-cohost --cluster-init citest --hostname e2e --advertise-addr 127.0.0.1:22140
 *     --data-dir <d> --identity-dir <i>
 *   npx tsx scripts/e2e/cohost-two-sessions.ts <d>/tls 127.0.0.1:22140
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'
import { NexusVfsClient } from '@nexus-ai-fs/vfs-client'

import { mintSessionIdentity, ownerField } from '../../src/server/nexus/sessionIdentity.js'
import { ManagedAgentClient } from '../../src/server/nexus/managedAgentClient.js'

const TLS = process.argv[2]
const ENDPOINT = process.argv[3]
const SN = 'nexus-node'
const AGENT = `cohost-e2e-${process.pid}`
// Declared in the daemon's sudocode.json; an undeclared alias fails the spawn.
const MODEL = process.env.COHOST_E2E_MODEL ?? 'mock-model'
const OWNER_A = `alice-${process.pid}`
const OWNER_B = `bob-${process.pid}`

let failures = 0
const expect = (label: string, ok: boolean, detail?: unknown) => {
  // Detail only on failure: printing it on a pass made `alice != alice` read like one.
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : ` — ${String(detail)}`}`)
  if (!ok) failures += 1
}

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
    node[m](r, new grpc.Metadata({ waitForReady: true }), { deadline: Date.now() + 25000 }, (e: any, x: any) =>
      res(e ? { rpcError: `${grpc.status[e.code]}: ${e.details}` } : x),
    ),
  )

const minted = await admin('MintAgent', { subject_id: AGENT, display_name: AGENT })
expect('operator mints the agent moss acts as', minted.success === true, minted.error ?? minted.rpcError)
if (minted.success !== true) process.exit(1)
await admin('AllowSessionMinter', { agent_id: AGENT })

// moss reads its identity from disk, as a deployment does.
const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const dir = mkdtempSync(join(tmpdir(), 'cohost-e2e-'))
writeFileSync(join(dir, 'ca.pem'), minted.ca_pem)
writeFileSync(join(dir, 'agent.pem'), minted.agent_cert_pem)
writeFileSync(join(dir, 'agent-key.pem'), minted.agent_key_pem)
const mossTls = { ca: join(dir, 'ca.pem'), cert: join(dir, 'agent.pem'), key: join(dir, 'agent-key.pem') }

/** One session, opened the way moss opens one. */
async function open(owner: string) {
  const identity = await mintSessionIdentity(ENDPOINT, mossTls, owner)
  if (!identity) throw new Error(`no credential minted for ${owner}`)
  const client = NexusVfsClient.withMtls(ENDPOINT, identity.tls)
  const agent = new ManagedAgentClient(client, '')
  const started = await agent.startSession({
    // The model must be one the daemon's own sudocode.json declares: a co-hosted
    // agent never sees an `--auth` flag, so it takes what the config offers.
    agentId: `agent-${owner}`,
    model: MODEL,
    ...ownerField(identity, owner),
  })
  return { identity, client, agent, owner, ...started }
}

const a = await open(OWNER_A)
const b = await open(OWNER_B)

expect('two sessions start in the same daemon', Boolean(a.sessionId && b.sessionId), `${a.sessionId} / ${b.sessionId}`)
expect('they are distinct sessions', a.sessionId !== b.sessionId)
expect('their credentials are distinct', a.identity.subjectId !== b.identity.subjectId)

const session = async (s: { agent: ManagedAgentClient; sessionId: string }) =>
  (await (s.agent as any).call('managed_agent.get_session_v1', { session_id: s.sessionId })) ?? {}
const readOwner = async (s: { agent: ManagedAgentClient; sessionId: string }) => (await session(s)).owner_id

const ownerA = await readOwner(a)
const ownerB = await readOwner(b)
expect('the first session is recorded for its own owner', ownerA === OWNER_A, `${ownerA} != ${OWNER_A}`)
expect('the second is recorded for its own owner', ownerB === OWNER_B, `${ownerB} != ${OWNER_B}`)
expect('one did not overwrite the other', ownerA !== ownerB, `${ownerA} / ${ownerB}`)

// Co-hosting puts both on threads of one process, so "still there" has to be
// asserted after the second one exists — not before it.
const stillA = await readOwner(a)
expect('the first survives the second being opened', stillA === OWNER_A, `${stillA} != ${OWNER_A}`)

// Everything above passes on a plain `nexusd-cluster` too — it plants the same
// records. These two do not: that daemon installs the managed-agent control
// plane WITHOUT a runtime body, so a session never leaves `warming_up` and the
// per-agent storage the sudocode runtime writes is never created. Measured:
// cluster gives `warming_up` and an `/agents/<name>/` holding only `state`.
for (const [label, s] of [['first', a], ['second', b]] as const) {
  const state = (await session(s)).state
  expect(`the ${label} session reaches ready, which needs an in-process runtime`, state === 'ready', state)
}

const homes = await Promise.all(
  [a, b].map(async s => (await s.client.readdir(`/agents/agent-${s.owner}`, '')).map((e: any) => String(e.name ?? e).split('/').pop())),
)
for (const [i, entries] of homes.entries()) {
  expect(
    `agent ${i + 1} has the runtime's own per-agent storage`,
    entries.includes('sessions') && entries.includes('conversations'),
    entries.join(' '),
  )
}
expect(
  'each agent got its own home, not a shared one',
  a.owner !== b.owner && `/agents/agent-${a.owner}` !== `/agents/agent-${b.owner}`,
)

await a.agent.cancel(a.sessionId).catch(() => {})
await b.agent.cancel(b.sessionId).catch(() => {})
a.client.close()
b.client.close()
node.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL ASSERTIONS PASSED' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
