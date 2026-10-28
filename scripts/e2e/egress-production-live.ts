/** Qualify an isolated organization's deployed Moss -> cohost -> Nexus -> real model path. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { parseEgressPolicy, policyApplicationStatus, readEgressPolicyStatus, type EgressPolicy } from '@sudo/egress-policy'
import { UserPodService, userPodName } from '@sudo/user-runtime'
import { buildKubectlBaseArgs, readK8sResource } from '@sudo/user-runtime/kubernetes'
import { readRuntimeRelease } from '@sudo/user-runtime/release'
import { resolveCohostNexusConfig } from '../../src/server/nexus/nexusEnvConfig.js'
import { connectSessionRuntime, waitForSessionRuntime } from '../../src/server/nexus/sessionConnection.js'
import { productConversation } from './productConversation.js'
import { assertProductConversationUrl } from './productConversationUrl.js'
import type { EgressPolicyService } from '../../src/server/configuration/egressPolicyService.js'

type PolicyView = Awaited<ReturnType<EgressPolicyService['view']>>
const fixtureSchema = z.object({
  fixture: z.literal('sudo-egress-production'),
  baseUrl: z.string().url(), accessToken: z.string().min(1),
  ownerId: z.string().uuid(), organizationId: z.string().uuid(),
  modelId: z.string().min(1), modelMount: z.string().regex(/^\/[a-zA-Z0-9/_-]+$/),
  outputDirectory: z.string().refine(isAbsolute),
  userPod: z.object({
    allocationId: z.string().optional(), image: z.string().min(1),
    nodeHost: z.string().min(1), namespace: z.string().min(1),
    kubeconfig: z.string().optional(), storageClass: z.string().min(1),
    storageSize: z.string().optional(), runtimeClassName: z.string().optional(),
    cpuLimit: z.string().optional(), memoryLimit: z.string().optional(),
    imagePullPolicy: z.enum(['Always', 'IfNotPresent', 'Never']).optional(),
    imagePullSecrets: z.array(z.string()).optional(),
    egressAnalyzerRelay: z.object({ image: z.string().min(1), secretName: z.string().min(1) }).strict(),
  }).strict(),
}).strict()

async function main() {
  assert(process.argv.includes('--execute'), 'Pass --execute for this isolated live qualification')
  assert.equal(process.env.MOSS_COHOST_LIVE, '1', 'Explicit live-provider opt-in is required')
  const input = fixtureSchema.parse(JSON.parse(readFileSync(0, 'utf8')))
  const origin = new URL(input.baseUrl)
  assert(!origin.username && !origin.password && !origin.search && !origin.hash)
  assert(origin.pathname === '/' || origin.pathname === '')
  assert(origin.protocol === 'https:' || (origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname)))
  const issuer = resolveCohostNexusConfig()
  assert(issuer.mode === 'external' && issuer.tls, 'Use the deployed mTLS issuer')
  const manifestPath = process.env.MOSS_RUNTIME_MANIFEST_PATH
  assert(manifestPath && isAbsolute(manifestPath), 'Use the deployed absolute runtime manifest path')
  const release = readRuntimeRelease(manifestPath)
  assert.equal(input.userPod.image, release.image.reference)
  // Refuse reused evidence before creating sessions or changing a saved policy.
  mkdirSync(input.outputDirectory, { mode: 0o700 })
  const proof = { passed: false, realModel: false, scope: 'organization',
    ownerId: input.ownerId, organizationId: input.organizationId, releaseId: release.releaseId,
    engineCommit: release.engine.commit, cohostVersion: release.cohost.version,
    nexusVersion: release.cohost.nexusVersion, imageDigest: release.image.digest,
    platformPolicyMutations: 0, policyRestored: false, sameOwnerPod: false,
    coldRestartTested: false, retainedRuntimeForExplicitCleanup: true,
    createdSessions: [] as string[], terminatedSessions: [] as string[],
    rows: [] as Array<Record<string, unknown>>, cleanupErrors: [] as string[], error: '' }
  const save = () => writeFileSync(join(input.outputDirectory, 'acceptance.json'), JSON.stringify(proof, null, 2), { mode: 0o600 })
  save()
  const headers = { authorization: `Bearer ${input.accessToken}`, 'content-type': 'application/json' }
  async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`${origin.origin}${path}`, { method, headers, redirect: 'error',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180_000) })
    assert.equal(response.status, 200, `${method} ${path} returned ${response.status}`)
    return await response.json() as T
  }
  const policyPath = '/api/v1/settings/egress?scope=organization'
  async function view(): Promise<PolicyView> {
    const result = await request<PolicyView>(policyPath)
    assert.equal(result.scopeType, 'organization')
    assert.equal(result.organizationId, input.organizationId)
    result.policy = parseEgressPolicy(result.policy)
    assert(result.runtimes.every(row => !row.isPresent || row.ownerId === input.ownerId),
      'The acceptance organization must not contain another running owner')
    return result
  }
  const me = await request<{ user: { id: string }; organization: { id: string; name: string } }>('/api/v1/auth/me')
  const profile = await request<{ data: { login_name: string } }>('/api/v1/user/profile')
  assert.equal(me.user.id, input.ownerId)
  assert.equal(me.organization.id, input.organizationId)
  assert(profile.data.login_name.startsWith('egress-canary-') && me.organization.name.startsWith('DLP acceptance '),
    'Use a dedicated synthetic account and organization, never a human workspace')
  const platform = await fetch(`${origin.origin}/api/v1/settings/egress?scope=platform`, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) })
  assert.equal(platform.status, 403, 'Use an organization administrator without platform policy authority')
  const original = await view()
  assert(original.isInherited && !original.policy.enabled && original.policy.mode === 'redact')
  assert(original.policy.modelMounts.includes(input.modelMount), 'Install the Cloud outbound profile before qualifying it')
  assert(original.policy.analyzer, 'The real shared analyzer must be configured')
  const owners = new UserPodService({ ...input.userPod, release,
    issuer: { endpoint: issuer.endpoint, tls: issuer.tls } }, undefined, waitForSessionRuntime)
  let observer: Awaited<ReturnType<typeof connectSessionRuntime>> | undefined
  let current = original
  const ownPolicies = new Set<string>()
  const fingerprint = (policy: EgressPolicy) => JSON.stringify({ ...policy, revision: 0 })
  // Keep random fixture markers from resembling built-in numeric identifiers.
  const nonce = () => randomUUID().replaceAll('-', '')
    .replace(/[0-9a-f]/g, value => String.fromCharCode(65 + Number.parseInt(value, 16)))
  const sensitive = `SUDO_DLP_CONFIDENTIAL_${nonce()}`
  const answer = `DLP_MODEL_OK_${nonce()}`
  const userPrompt = `Synthetic acceptance record ${sensitive}. Reply only ${answer}. Do not use tools.`
  const ordinaryPrompt = `Reply only ${answer}. Do not use tools.`
  const base = buildKubectlBaseArgs(input.userPod.namespace, input.userPod.kubeconfig)
  const name = userPodName(input.ownerId, input.userPod.allocationId)
  const podSchema = z.object({ metadata: z.object({ uid: z.string().min(1) }), status: z.object({
    containerStatuses: z.array(z.object({ name: z.string(), restartCount: z.number().int().nonnegative(),
      state: z.object({ running: z.object({ startedAt: z.string().min(1) }).optional() }) })),
  }) })
  async function snapshot() {
    const pod = podSchema.parse(await readK8sResource(base, 'pod', name))
    const runtime = pod.status.containerStatuses.find(item => item.name === 'runtime')
    assert(runtime?.state.running, 'The isolated native runtime must be running')
    return { uid: pod.metadata.uid, restarts: runtime.restartCount, startedAt: runtime.state.running.startedAt }
  }
  async function applied(policy: EgressPolicy) {
    const deadline = Date.now() + 90_000
    while (true) {
      const status = await readEgressPolicyStatus(observer!.client, observer!.authToken)
      current = await view()
      const own = current.runtimes.filter(row => row.ownerId === input.ownerId && row.isPresent)
      if (policyApplicationStatus(policy, status).state === 'applied' && own.length > 0 && own.every(row => row.state === 'applied')) return status
      assert(Date.now() < deadline, 'Saved policy did not reach the actual native runtime within 90 seconds')
      await delay(1000)
    }
  }
  async function prompts() {
    return new Set((await observer!.client.readdir(input.modelMount, observer!.authToken))
      .filter(entry => entry.name.endsWith('.prompt')).map(entry => entry.name))
  }
  async function terminate(sessionId: string) {
    await request(`/api/v1/sessions/${sessionId}/terminate`, 'POST', {})
    proof.terminatedSessions.push(sessionId); save()
  }
  async function conversation(label: string, text: string, isDenied: boolean) {
    const created = await request<{ session_id: string; runtime: { type: string }; ws_url: string }>('/api/v1/sessions', 'POST',
      { runtime: { type: 'cohost' }, title: `DLP acceptance ${label}` })
    z.string().uuid().parse(created.session_id)
    proof.createdSessions.push(created.session_id); save()
    let stream: ReturnType<typeof productConversation> | undefined
    try {
      assert.equal(created.runtime.type, 'cohost')
      assertProductConversationUrl(created.ws_url, origin.origin, origin.origin, created.session_id, 'moss_route')
      stream = productConversation(created.ws_url, input.accessToken, input.outputDirectory, label)
      await stream.ready()
      if (isDenied) await assert.rejects(stream.turn(text))
      else assert.equal((await stream.turn(text)).trim(), answer, 'The real model must return the fresh requested marker')
      const context = await request<{ context: { messages: unknown[] } }>(`/api/v1/sessions/${created.session_id}/context`)
      assert(JSON.stringify(context.context.messages).includes(text), 'The local original must remain in persisted HTTP context')
    } finally {
      try { stream?.close() } finally { await terminate(created.session_id) }
    }
    if (isDenied) {
      const events = readFileSync(join(input.outputDirectory, `${label}.private.json`), 'utf8')
      assert(/egress|classif|redact|hook|出口|脱敏|检测/i.test(events), 'The caller must receive a content-gate failure, not an unrelated transport error')
    }
  }
  try {
    await request('/api/v1/users/me/model', 'PUT', { modelId: input.modelId })
    // The harmless bootstrap creates the real owner through the product entrypoint.
    await conversation('bootstrap', ordinaryPrompt, false)
    proof.realModel = true
    const connection = await owners.find(input.ownerId)
    assert(connection, 'The product did not create the isolated owner runtime')
    observer = await connectSessionRuntime(connection, input.ownerId)
    await applied(original.policy)
    const initialPod = await snapshot()
    proof.rows.push({ scenario: 'bootstrap', realModelAnswered: true, podUid: initialPod.uid })
    for (const scenario of ['disabled-before', 'allow', 'redact', 'deny', 'outage', 'disabled-after']) {
      const isDenied = scenario === 'deny' || scenario === 'outage'
      const desired: EgressPolicy = { ...original.policy,
        enabled: !scenario.startsWith('disabled-'), mode: scenario === 'deny' ? 'deny' : 'redact',
        modelMounts: [input.modelMount], a2aMounts: [],
        // Isolate the explicit business rule from model-specific NER confidence.
        // Public-corpus NER quality is measured by the shared analyzer benchmarks.
        analyzer: { ...original.policy.analyzer!, entities: ['PERSON'], scoreThreshold: 1,
          ...(scenario === 'outage' ? { url: 'http://127.0.0.1:1', timeoutMs: 1000 } : {}) },
        businessPolicy: { version: 1, public_organizations: [], protected_terms: [sensitive], protected_markers: [] } }
      ownPolicies.add(fingerprint(desired))
      current = await request<PolicyView>(policyPath, 'PUT', { policy: desired, expectedRevision: current.policy.revision })
      await applied(current.policy)
      const before = await prompts()
      const text = scenario === 'allow' ? ordinaryPrompt : userPrompt
      await conversation(scenario, text, isDenied)
      const added = [...await prompts()].filter(value => !before.has(value))
      assert.equal(added.length, isDenied ? 0 : 1, 'Native model cache must agree with the allowed or denied call')
      const requestDigests: string[] = []
      for (const filename of added) {
        const bytes: Buffer = await observer.client.read(`${input.modelMount}/${filename}`, observer.authToken)
        requestDigests.push(createHash('sha256').update(bytes).digest('hex'))
        const sent: string = JSON.stringify(JSON.parse(bytes.toString('utf8')))
        assert.equal(sent.includes(sensitive), scenario.startsWith('disabled-'))
        if (scenario === 'redact') assert(sent.includes('[REDACTED:'))
        if (scenario === 'allow') assert(sent.includes(ordinaryPrompt))
      }
      assert.deepEqual(await snapshot(), initialPod, 'A hot policy update must not replace or restart the owner runtime')
      proof.rows.push({ scenario, revision: current.policy.revision, nativeApplied: true,
        modelRequests: added.length, requestDigests, realModelAnswered: !isDenied, callerGateFailure: isDenied,
        originalRetained: true, sameOwnerPod: true })
      save()
    }
    proof.sameOwnerPod = true
  } catch (error) {
    proof.error = error instanceof Error ? error.message.replaceAll(input.accessToken, '[hidden]') : 'Live qualification failed'
  } finally {
    for (const sessionId of proof.createdSessions.filter(id => !proof.terminatedSessions.includes(id))) {
      try { await terminate(sessionId) } catch { proof.cleanupErrors.push(`session-terminate:${sessionId}`) }
    }
    try {
      const observed = await view()
      if (!observed.isInherited) {
        assert(ownPolicies.has(fingerprint(observed.policy)), 'Preserve a policy changed by another administrator')
        current = await request<PolicyView>('/api/v1/settings/egress/inherit?scope=organization', 'POST', { expectedRevision: observed.policy.revision })
      } else current = observed
      assert(current.isInherited && !current.policy.enabled, 'Restore the inherited disabled policy')
      if (observer) await applied(current.policy)
      proof.policyRestored = true
    } catch { proof.cleanupErrors.push('policy-restore') }
    observer?.client.close()
    await owners.close()
    proof.passed = !proof.error && proof.policyRestored && proof.cleanupErrors.length === 0 && proof.rows.length === 7
    save()
    console.log(JSON.stringify(proof))
  }
  assert(proof.passed, 'Production DLP qualification failed; inspect the private receipt')
}

await main()
