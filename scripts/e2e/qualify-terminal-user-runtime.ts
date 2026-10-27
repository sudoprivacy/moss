import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { UserPodService, userPodName, type UserPodOptions, type UserPodResources } from '@sudo/user-runtime'
import { buildKubectlBaseArgs, deleteK8sResource, kubectlApply, observeK8sRuntime,
  readK8sResource, refreshK8sPodProjection } from '@sudo/user-runtime/kubernetes'
import { readRuntimeRelease } from '@sudo/user-runtime/release'
import { resolveCohostNexusConfig } from '../../src/server/nexus/nexusEnvConfig.js'
import { waitForSessionRuntime } from '../../src/server/nexus/sessionConnection.js'

/** Actual Kubernetes storage, native release verification and the production mTLS readiness adapter. */
async function main() {
  assert(process.argv.includes('--execute'), 'Pass --execute for this isolated live fixture')
  const input = JSON.parse(readFileSync(0, 'utf8')) as {
    ownerId: string
    allocationId: string
    terminalPhase: 'Succeeded' | 'Failed'
    output: string
    userPod: Omit<UserPodOptions, 'issuer' | 'release' | 'allocationId'>
  }
  assert(/^acceptance-terminal-[a-z0-9-]+$/.test(input.allocationId) && input.allocationId.length <= 63)
  assert(input.terminalPhase === 'Succeeded' || input.terminalPhase === 'Failed')
  const issuer = resolveCohostNexusConfig()
  assert(issuer.tls, 'Use the existing authenticated runtime issuer')
  const release = readRuntimeRelease(process.env.MOSS_RUNTIME_MANIFEST_PATH!)
  assert.equal(input.userPod.image, release.image.reference)
  const options: UserPodOptions = { ...input.userPod, allocationId: input.allocationId,
    release, issuer: { endpoint: issuer.endpoint, tls: issuer.tls } }
  const name = userPodName(input.ownerId, input.allocationId)
  const base = buildKubectlBaseArgs(options.namespace, options.kubeconfig)
  const marker = randomUUID()
  const proof = { ownerId: input.ownerId, allocationId: input.allocationId, name,
    expectedTerminalPhase: input.terminalPhase, passed: false, newModelCalls: 0,
    primaryAllocationChanged: false, resources: {} as Record<string, { uid: string }>,
    terminalPodUid: '', replacementPodUid: '', pvcUid: '', initialAuthenticatedRuntimeReady: false,
    authenticatedReplacementReady: false,
    drainSawNoLivePreviousRuntime: false, markerRetained: false, ownedPodRemoved: false }
  const save = () => writeFileSync(input.output, JSON.stringify(proof, null, 2), { mode: 0o600 })
  save()
  for (const kind of ['pod', 'pvc', 'secret', 'service']) {
    assert.equal(await readK8sResource(base, kind, name), undefined, 'Preserve any pre-existing allocation')
  }
  let originalPodManifest: Record<string, unknown> | undefined
  const resources: UserPodResources = {
    read: (kind, resourceName) => readK8sResource(base, kind, resourceName),
    write: async (original, verb) => {
      const metadata = original.metadata as { name: string; annotations: Record<string, string> }
      assert(metadata.name === name || metadata.name === name + '-upgrade')
      assert.equal(metadata.annotations['moss.sudo.dev/runtime-owner'], input.ownerId)
      if (original.kind === 'Pod' && originalPodManifest === undefined) originalPodManifest = structuredClone(original)
      await kubectlApply(base, original, verb)
      if (metadata.name === name) {
        const kind = original.kind === 'PersistentVolumeClaim' ? 'pvc' : String(original.kind).toLowerCase()
        const observed = await readK8sResource(base, kind, name)
        assert(observed?.metadata.uid)
        proof.resources[kind] = { uid: observed.metadata.uid }
        save()
      }
    },
    remove: (kind, resourceName, uid) => deleteK8sResource(base, options.namespace, kind, resourceName, uid),
    observe: resourceName => observeK8sRuntime(base, resourceName),
    refreshProjection: (resourceName, uid, ownerId) => refreshK8sPodProjection(base, resourceName, uid, ownerId),
  }
  const initial = new UserPodService(options, resources, waitForSessionRuntime)
  let replacement: UserPodService | undefined
  try {
    await initial.resolve(input.ownerId)
    proof.initialAuthenticatedRuntimeReady = true
    proof.pvcUid = (await resources.read('pvc', name))!.metadata.uid!
    await initial.close()
    const firstPod = await resources.read('pod', name)
    assert(firstPod?.metadata.uid && originalPodManifest)
    await resources.remove!('pods', name, firstPod.metadata.uid)
    const removalDeadline = Date.now() + 60_000
    while (await resources.read('pod', name)) {
      assert(Date.now() < removalDeadline, 'Initial owned fixture Pod did not stop')
      await delay(500)
    }
    // Keep the established Service, Secret and PVC while a real container exits.
    const terminalManifest = structuredClone(originalPodManifest)
    const spec = terminalManifest.spec as { restartPolicy: string; containers: Array<Record<string, unknown>> }
    spec.restartPolicy = 'Never'
    const runtime = spec.containers.find(item => item.name === 'runtime')!
    runtime.command = ['sh', '-ec', 'printf %s "$SUDO_ACCEPTANCE_MARKER" > /data/files/terminal-upgrade-marker; exit ' +
      (input.terminalPhase === 'Succeeded' ? '0' : '17')]
    runtime.args = []
    runtime.env = [...runtime.env as object[], { name: 'SUDO_ACCEPTANCE_MARKER', value: marker }]
    await resources.write(terminalManifest, 'create')
    const terminalDeadline = Date.now() + 90_000
    let terminal = await resources.read('pod', name)
    while (terminal?.status?.phase !== input.terminalPhase) {
      assert(Date.now() < terminalDeadline, 'Fixture container did not reach its expected terminal phase')
      await delay(500)
      terminal = await resources.read('pod', name)
    }
    assert.equal(terminal?.status?.phase, input.terminalPhase)
    proof.terminalPodUid = terminal!.metadata.uid!
    assert.equal((await resources.read('pvc', name))!.metadata.uid, proof.pvcUid)
    save()
    replacement = new UserPodService(options, resources, async (connection, ownerId, signal) => {
      assert.notEqual((await resources.read('pod', name))!.metadata.uid, proof.terminalPodUid,
        'A terminated runtime cannot supply an authenticated readiness response')
      await waitForSessionRuntime(connection, ownerId, signal)
      proof.authenticatedReplacementReady = true
      save()
    })
    await replacement.upgrade(input.ownerId, async previous => {
      assert.equal(previous, undefined)
      proof.drainSawNoLivePreviousRuntime = true
      save()
    })
    const pod = await resources.read('pod', name)
    assert(pod?.metadata.uid)
    proof.replacementPodUid = pod.metadata.uid
    assert.notEqual(proof.replacementPodUid, proof.terminalPodUid)
    assert.equal((await resources.read('pvc', name))!.metadata.uid, proof.pvcUid)
    assert.equal((await replacement.inspect(input.ownerId)).isDrifted, false)
    const { stdout } = await promisify(execFile)('kubectl', [...base, 'exec', name, '-c', 'runtime', '--',
      'cat', '/data/files/terminal-upgrade-marker'], { windowsHide: true, timeout: 30_000 })
    assert.equal(stdout, marker)
    proof.markerRetained = true
    proof.passed = true
    save()
  } finally {
    await initial.close()
    await replacement?.close()
    const pod = await resources.read('pod', name)
    if (pod) {
      assert.equal(pod.metadata.annotations?.['moss.sudo.dev/runtime-owner'], input.ownerId)
      assert.equal(pod.metadata.uid, proof.resources.pod?.uid, 'Preserve a replacement not created by this fixture')
      await resources.remove!('pods', name, pod.metadata.uid!)
      const deadline = Date.now() + 60_000
      while (await resources.read('pod', name)) {
        assert(Date.now() < deadline, 'Owned fixture Pod did not stop')
        await delay(500)
      }
    }
    proof.ownedPodRemoved = true
    save()
    // The caller must retire the recorded PVC/Service/Secret through its approved cleanup identity.
    console.log(JSON.stringify(proof))
  }
}

await main()
