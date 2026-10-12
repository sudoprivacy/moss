/** Real Kubernetes boxes, delegated identities and simultaneous native ACP sessions. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { NexusRpcError, NexusVfsClient, userRuntimeServerName } from '@nexus-ai-fs/vfs-client'
import { UserPodService, userPodName, type UserPodOptions } from '../../src/server/runtime/userPodService.js'
import { connectSessionRuntime } from '../../src/server/nexus/sessionConnection.js'
import { ManagedAgentClient } from '../../src/server/nexus/managedAgentClient.js'
import { buildCohostProxyConfig } from '../../src/server/backends/scodeProxyConfig.js'
import { connectController } from './cohost-controller-live.js'

const [optionsFile, modelFile, evidence] = process.argv.slice(2)
assert(optionsFile && modelFile && evidence, 'User Pod options, model configuration and evidence directory are required')
assert.equal(process.env.MOSS_USER_POD_E2E, '1', 'Explicit runtime E2E selection is required')
const options = JSON.parse(await readFile(optionsFile, 'utf8')) as UserPodOptions
const model = z.object({ model: z.string().min(1), baseUrl: z.string().url(), apiKey: z.string() })
  .parse(JSON.parse(await readFile(modelFile, 'utf8')))
const service = new UserPodService(options)
const owner = `user-pod-e2e-${randomUUID()}`
const otherOwner = `user-pod-e2e-${randomUUID()}`
const agentId = `agent-${randomUUID()}`
const configuration = buildCohostProxyConfig(model.baseUrl, model.apiKey, model.model)
const controllers: ReturnType<typeof connectController>[] = []
const sessions: Awaited<ReturnType<ManagedAgentClient['startSession']>>[] = []
let agent: ManagedAgentClient | undefined
let other: Awaited<ReturnType<typeof connectSessionRuntime>> | undefined
let impostor: NexusVfsClient | undefined
let misplaced: Awaited<ReturnType<typeof connectSessionRuntime>> | undefined
await mkdir(evidence, { recursive: true })
await writeFile(join(evidence, 'fixture.json'), JSON.stringify({ owner, otherOwner, agentId,
  pods: [userPodName(owner), userPodName(otherOwner)], image: options.image,
}, null, 2))
try {
  const [target, repeated, foreign] = await Promise.all([
    service.resolve(owner, configuration), service.resolve(owner, configuration),
    service.resolve(otherOwner, configuration),
  ])
  assert.equal(target, repeated, 'both sessions use the same owner box connection')
  assert.notEqual(target.runtimeEndpoint, foreign.runtimeEndpoint)
  const connection = await connectSessionRuntime(target, owner)
  agent = new ManagedAgentClient(connection.client, connection.authToken)
  other = await connectSessionRuntime(foreign, otherOwner)
  assert(other.identity && target.runtimeEndpoint)
  impostor = NexusVfsClient.withMtls(target.runtimeEndpoint, {
    ...other.identity.tls, serverName: userRuntimeServerName(owner),
  })
  misplaced = await connectSessionRuntime(target, otherOwner)
  const privatePath = `/agents/${agentId}/memory/MEMORY.md`
  const marker = `PRIVATE_${randomUUID()}`
  await connection.client.mkdir(`/agents/${agentId}/memory`, '', { parents: true, existOk: true })
  await connection.client.write(privatePath, Buffer.from(marker), '')
  await assert.rejects(impostor.read(privatePath, ''), (error: unknown) => {
    if (error instanceof NexusRpcError) return error.code === 7
    if (!(error instanceof Error)) return false
    try {
      return JSON.parse(error.message).code === -32003
    } catch {
      return false
    }
  }, 'a foreign owner must receive permission denied, rather than a transport failure')
  await assert.rejects(misplaced.client.read(privatePath, ''), (error: unknown) =>
    error instanceof NexusRpcError && [4, 14].includes(error.code),
  'the placement connection must validate its owner-derived runtime server name')
  assert.equal(await other.client.stat(privatePath, ''), null,
    'the other owner box must not contain the private file metadata')
  for (const lane of ['left', 'right']) {
    const repository = `/agents/${agentId}/workspaces/${lane}`
    await connection.client.mkdir(repository, '', { parents: true, existOk: true })
    const session = await agent.startSession({ agentId, model: model.model,
      repos: [{ hostPath: repository, alias: 'workspace' }] })
    assert(session.durableSessionId)
    sessions.push(session)
    controllers.push(connectController({ agent, sessionEndpoint: session.sessionEndpoint,
      sessionId: session.sessionId }, new Set()))
  }
  assert.notEqual(sessions[0]!.sessionId, sessions[1]!.sessionId)
  assert.notEqual(sessions[0]!.durableSessionId, sessions[1]!.durableSessionId)
  const replies = await Promise.all(controllers.map(async (controller, index) => {
    await controller.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const opened = await controller.rpc('session/new', { cwd: '/', mcpServers: [] })
    assert.equal(opened.sessionId, sessions[index]!.durableSessionId)
    const expected = `LANE_${index}_${randomUUID().replaceAll('-', '')}`
    const result = await controller.rpc('session/prompt', { sessionId: opened.sessionId,
      prompt: [{ type: 'text', text: `Reply with exactly ${expected}. Use no tools.` }] }, 180_000)
    assert.equal(result.stopReason, 'end_turn')
    controller.assertHealthy()
    const text = controller.updates.filter(update => update.sessionUpdate === 'agent_message_chunk')
      .map(update => update.content?.text ?? '').join('')
    assert(text.includes(expected), 'the native runtime must deliver its own model reply')
    return true
  }))
  await writeFile(join(evidence, 'user-pod-result.json'), JSON.stringify({ success: true,
    pods: [userPodName(owner), userPodName(otherOwner)], agentId,
    sameOwnerRuntimeCount: sessions.length, modelReplies: replies.length,
    privateFileIsolated: true, crossOwnerCredentialRefused: true, runtimeTargetBoundToOwner: true,
    durableSessionIds: sessions.map(session => session.durableSessionId),
  }, null, 2))
  process.stdout.write('User Pod mTLS, private storage and two native ACP replies passed\n')
} finally {
  await Promise.allSettled(controllers.map(controller => controller.close()))
  if (agent) {
    await Promise.allSettled(sessions.map(session => agent!.cancel(session.sessionId)))
    agent.close()
  }
  other?.client.close()
  impostor?.close()
  misplaced?.client.close()
  await service.close()
}
