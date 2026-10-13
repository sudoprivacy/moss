/** Validate release rejection, rollback and durable recovery on an owned gVisor fixture. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { UserPodService, userPodName, type UserPodOptions } from '@sudo/user-runtime'
import { RuntimeReleaseSchema } from '@sudo/user-runtime/release'
import { connectSessionRuntime, waitForSessionRuntime } from '../../src/server/nexus/sessionConnection.js'
import { ManagedAgentClient } from '../../src/server/nexus/managedAgentClient.js'
import { connectController } from './cohost-controller-live.js'

const [optionsFile, modelFile, previousEvidence, evidence] = process.argv.slice(2)
assert(optionsFile && modelFile && previousEvidence && evidence)
assert.equal(process.env.MOSS_USER_POD_E2E, '1')
const options = JSON.parse(await readFile(optionsFile, 'utf8')) as UserPodOptions
const release = RuntimeReleaseSchema.parse(options.release)
const model = z.object({ model: z.string().min(1) }).parse(JSON.parse(await readFile(modelFile, 'utf8')))
const fixture = z.object({ owner: z.string().startsWith('user-pod-e2e-'), agentId: z.string(),
  image: z.string(), pods: z.array(z.string()) }).parse(JSON.parse(await readFile(join(previousEvidence, 'fixture.json'), 'utf8')))
const previous = z.object({ success: z.literal(true), durableSessionIds: z.array(z.string()).length(2) })
  .parse(JSON.parse(await readFile(join(previousEvidence, 'user-pod-result.json'), 'utf8')))
assert.equal(fixture.image, options.image)
assert.equal(fixture.pods[0], userPodName(fixture.owner))
const paths = [`/agents/${fixture.agentId}/memory/MEMORY.md`,
  ...previous.durableSessionIds.map(sid => `/sessions/${sid}/transcript.jsonl`)]
const original = new UserPodService(options, undefined, waitForSessionRuntime)
const originalConnection = await connectSessionRuntime(await original.resolve(fixture.owner), fixture.owner)
const snapshots = await Promise.all(paths.map(path => originalConnection.client.read(path, '')))
assert(snapshots.every(bytes => bytes.length > 0))
originalConnection.client.close()
await original.close()

const drain = async (connection?: Parameters<typeof connectSessionRuntime>[0]): Promise<void> => {
  assert(connection, 'The acceptance owner must already have a runtime')
  const current = await connectSessionRuntime(connection, fixture.owner)
  try {
    const raw: unknown = JSON.parse(await current.client.call('agent_list', JSON.stringify({ owner_id: fixture.owner, kind: 'managed' }), ''))
    const records = z.array(z.object({ owner_id: z.string(), kind: z.string(), state: z.string() }))
      .parse(raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw)
    assert.equal(records.filter(record => record.owner_id === fixture.owner && record.kind.toLowerCase() === 'managed' && record.state.toLowerCase() !== 'terminated').length, 0,
      'An acceptance upgrade must not replace a runtime with a live managed execution')
  } finally { current.client.close() }
}

const rejected = new UserPodService({ ...options, release: { ...release,
  releaseId: `${release.releaseId}-rejected`,
  cohost: { ...release.cohost, binaryDigest: `sha256:${'0'.repeat(64)}` },
} }, undefined, waitForSessionRuntime)
try {
  await assert.rejects(rejected.upgrade(fixture.owner, drain), /differs from the verified release manifest/)
} finally { await rejected.close() }
const restored = new UserPodService(options, undefined, waitForSessionRuntime)
try {
  const connection = await connectSessionRuntime(await restored.resolve(fixture.owner), fixture.owner)
  try {
    for (const [index, path] of paths.entries())
      assert.deepEqual(await connection.client.read(path, ''), snapshots[index], 'rollback preserves exact durable bytes')
    assert.equal((await restored.inspect(fixture.owner)).isDrifted, false)
  } finally { connection.client.close() }
} finally { await restored.close() }

const targetRelease = { ...release, releaseId: `${release.releaseId}-accepted` }
const target = new UserPodService({ ...options, release: targetRelease }, undefined, waitForSessionRuntime)
let agent: ManagedAgentClient | undefined
const sessions: Awaited<ReturnType<ManagedAgentClient['startSession']>>[] = []
const controllers: ReturnType<typeof connectController>[] = []
try {
  assert.equal((await target.inspect(fixture.owner)).isDrifted, true)
  await target.upgrade(fixture.owner, drain)
  assert.equal((await target.inspect(fixture.owner)).isDrifted, false)
  const connection = await connectSessionRuntime(await target.resolve(fixture.owner), fixture.owner)
  agent = new ManagedAgentClient(connection.client, connection.authToken)
  for (const [index, path] of paths.entries())
    assert.deepEqual(await connection.client.read(path, ''), snapshots[index], 'upgrade preserves exact durable bytes')
  for (const [index, sid] of previous.durableSessionIds.entries()) {
    const session = await agent.startSession({ agentId: fixture.agentId, model: model.model,
      resumeSessionId: sid, repos: [{ hostPath: `/agents/${fixture.agentId}/workspaces/${index === 0 ? 'left' : 'right'}`, alias: 'workspace' }] })
    assert.equal(session.durableSessionId, sid)
    sessions.push(session)
    controllers.push(connectController({ agent, sessionId: session.sessionId, sessionEndpoint: session.sessionEndpoint }, new Set()))
  }
  await Promise.all(controllers.map(async (controller, index) => {
    const sid = previous.durableSessionIds[index]!
    await controller.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
    await controller.rpc('session/load', { sessionId: sid, cwd: '/', mcpServers: [] })
    const marker = `UPGRADED_${index}_${randomUUID().replaceAll('-', '')}`
    const reply = await controller.rpc('session/prompt', { sessionId: sid,
      prompt: [{ type: 'text', text: `Reply exactly ${marker}. Use no tools.` }] }, 180_000)
    assert.equal(reply.stopReason, 'end_turn')
    controller.assertHealthy()
    assert(controller.updates.filter(update => update.sessionUpdate === 'agent_message_chunk')
      .map(update => update.content?.text ?? '').join('').includes(marker))
    const history = await connection.client.read(paths[index + 1]!, '')
    assert.deepEqual(history.subarray(0, snapshots[index + 1]!.length), snapshots[index + 1])
  }))
  await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, 'release-upgrade.json'), JSON.stringify({ success: true,
    pod: userPodName(fixture.owner), rejectedBinaryRolledBack: true, releaseId: targetRelease.releaseId,
    imageDigestVerified: release.image.digest, engineCommit: release.engine.commit,
    durableSessionIds: previous.durableSessionIds, resumedReplies: sessions.length,
    preserved: paths.map((path, index) => ({ path, sha256: createHash('sha256').update(snapshots[index]!).digest('hex') })),
  }, null, 2))
  process.stdout.write('Real owner runtime release verification, rollback and two durable resumed replies passed\n')
} finally {
  await Promise.allSettled(controllers.map(controller => controller.close()))
  if (agent) { await Promise.allSettled(sessions.map(session => agent!.cancel(session.sessionId))); agent.close() }
  await target.close()
}
