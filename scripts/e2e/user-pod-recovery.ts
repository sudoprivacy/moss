/** Restart an owned acceptance Pod and recover its exact PVC-backed sessions. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { buildKubectlBaseArgs, readK8sResource } from '../../src/server/backends/k8sResources.js'
import { UserPodService, userPodName, type UserPodOptions } from '../../src/server/runtime/userPodService.js'
import { connectSessionRuntime } from '../../src/server/nexus/sessionConnection.js'
import { ManagedAgentClient } from '../../src/server/nexus/managedAgentClient.js'
import { connectController } from './cohost-controller-live.js'

const [optionsFile, modelFile, previousEvidence, evidence] = process.argv.slice(2)
assert(optionsFile && modelFile && previousEvidence && evidence)
assert.equal(process.env.MOSS_USER_POD_E2E, '1')
const options = JSON.parse(await readFile(optionsFile, 'utf8')) as UserPodOptions
const model = z.object({ model: z.string().min(1) }).parse(JSON.parse(await readFile(modelFile, 'utf8')))
const fixture = z.object({ owner: z.string().startsWith('user-pod-e2e-'), agentId: z.string(),
  image: z.string(), pods: z.array(z.string()) }).parse(JSON.parse(await readFile(join(previousEvidence, 'fixture.json'), 'utf8')))
const result = z.object({ success: z.literal(true), durableSessionIds: z.array(z.string()).length(2) })
  .parse(JSON.parse(await readFile(join(previousEvidence, 'user-pod-result.json'), 'utf8')))
assert.equal(fixture.image, options.image)
const podName = userPodName(fixture.owner)
assert.equal(fixture.pods[0], podName)
const kubectl = buildKubectlBaseArgs(options.namespace, options.kubeconfig)
const beforePod = await readK8sResource(kubectl, 'pod', podName)
assert.equal(beforePod?.metadata.annotations?.['moss.sudo.dev/runtime-owner'], fixture.owner)
assert(beforePod?.metadata.uid)
const paths = [`/agents/${fixture.agentId}/memory/MEMORY.md`,
  ...result.durableSessionIds.map(sid => `/sessions/${sid}/transcript.jsonl`)]
const originalService = new UserPodService(options)
const original = await connectSessionRuntime(await originalService.resolve(fixture.owner), fixture.owner)
let snapshots: Buffer[]
try { snapshots = await Promise.all(paths.map(path => original.client.read(path, ''))) }
finally { original.client.close(); await originalService.close() }
assert(snapshots.every(content => content.length > 0))
await promisify(execFile)('kubectl', [...kubectl, 'delete', 'pod', podName, '--wait=true', '--timeout=90s'],
  { timeout: 100_000, windowsHide: true })
const service = new UserPodService(options)
let agent: ManagedAgentClient | undefined
const sessions: Awaited<ReturnType<ManagedAgentClient['startSession']>>[] = []
const controllers: ReturnType<typeof connectController>[] = []
try {
  const connection = await connectSessionRuntime(await service.resolve(fixture.owner), fixture.owner)
  agent = new ManagedAgentClient(connection.client, connection.authToken)
  const afterPod = await readK8sResource(kubectl, 'pod', podName)
  assert.notEqual(afterPod?.metadata.uid, beforePod.metadata.uid)
  for (const [index, path] of paths.entries()) {
    assert.deepEqual(await connection.client.read(path, ''), snapshots[index], 'Pod replacement preserves exact durable bytes')
  }
  for (const [index, sid] of result.durableSessionIds.entries()) {
    const session = await agent.startSession({ agentId: fixture.agentId, model: model.model,
      resumeSessionId: sid, repos: [{ hostPath: `/agents/${fixture.agentId}/workspaces/${index === 0 ? 'left' : 'right'}`, alias: 'workspace' }] })
    assert.equal(session.durableSessionId, sid)
    sessions.push(session)
    controllers.push(connectController({ agent, sessionId: session.sessionId, sessionEndpoint: session.sessionEndpoint }, new Set()))
  }
  await Promise.all(controllers.map(async (controller, index) => {
    const sid = result.durableSessionIds[index]!
    await controller.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
    await controller.rpc('session/load', { sessionId: sid, cwd: '/', mcpServers: [] })
    const marker = `RECOVERED_${index}_${randomUUID().replaceAll('-', '')}`
    const reply = await controller.rpc('session/prompt', { sessionId: sid,
      prompt: [{ type: 'text', text: `Reply exactly ${marker}. Use no tools.` }] }, 180_000)
    assert.equal(reply.stopReason, 'end_turn')
    controller.assertHealthy()
    assert(controller.updates.filter(update => update.sessionUpdate === 'agent_message_chunk')
      .map(update => update.content?.text ?? '').join('').includes(marker))
    const after = await connection.client.read(paths[index + 1]!, '')
    assert.deepEqual(after.subarray(0, snapshots[index + 1]!.length), snapshots[index + 1], 'recovered history remains an exact prefix')
  }))
  await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, 'user-pod-recovery.json'), JSON.stringify({ success: true,
    pod: podName, podReplaced: true, durableSessionIds: result.durableSessionIds, resumedReplies: sessions.length,
    preserved: paths.map((path, index) => ({ path, sha256: createHash('sha256').update(snapshots[index]!).digest('hex') })),
  }, null, 2))
  process.stdout.write('User Pod replacement preserves exact memory and two histories; both resumed model replies passed\n')
} finally {
  await Promise.allSettled(controllers.map(controller => controller.close()))
  if (agent) { await Promise.allSettled(sessions.map(session => agent!.cancel(session.sessionId))); agent.close() }
  await service.close()
}
