import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { NexusZoneApiClient } from '@nexus-ai-fs/vfs-client'
import { UserPodService, userPodName, type UserPodOptions, type UserPodResources } from './userPodService.js'
import type { K8sResource } from '../backends/k8sResources.js'
import type { RuntimeRelease } from './runtimeRelease.js'

const options: UserPodOptions = {
  image: 'runtime:verified', nodeHost: 'compute.internal', namespace: 'private-runtimes', storageClass: 'retained-local',
  issuer: { endpoint: 'https://control-plane', tls: { ca: '/ca', cert: '/moss', key: '/moss-key' } },
}

function platform() {
  const objects = new Map<string, K8sResource>()
  const writes: Array<{ kind: string; manifest: Record<string, unknown> }> = []
  const resources: UserPodResources = {
    async read(kind, name) { return objects.get(name.endsWith('-upgrade') ? 'upgrade-secret' : kind) },
    async write(manifest) {
      const kind = manifest.kind === 'PersistentVolumeClaim' ? 'pvc' : String(manifest.kind).toLowerCase()
      writes.push({ kind, manifest })
      const metadata = manifest.metadata as K8sResource['metadata']
      objects.set(metadata.name.endsWith('-upgrade') ? 'upgrade-secret' : kind,
        { metadata: { ...metadata, uid: randomUUID() },
        ...(manifest.spec ? { spec: manifest.spec as Record<string, unknown> } : {}),
        ...(kind === 'secret' ? { data: Object.fromEntries(Object.entries(manifest.stringData as Record<string, string>)
          .map(([key, value]) => [key, Buffer.from(value).toString('base64')])) } : {}),
        ...(kind === 'service' ? { spec: { ...manifest.spec as object,
          ports: [{ name: 'nexus', port: 8443, targetPort: 8443, nodePort: 31443 }] } } : {}),
        ...(kind === 'pod' ? { status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } } : {}) })
    },
    async remove(kind, name, uid) {
      const key = name.endsWith('-upgrade') ? 'upgrade-secret' : kind === 'pods' ? 'pod' : 'secret'
      assert.equal(objects.get(key)?.metadata.uid, uid, 'replacement must target the observed resource identity')
      objects.delete(key)
    },
  }
  return { objects, writes, resources }
}

void test('Agent discovery does not provision a missing box and refuses another owner before mutation', async t => {
  const kube = platform()
  const service = new UserPodService(options, kube.resources, async () => {})
  t.after(() => service.close())
  assert.equal(await service.find('alice'), undefined)
  assert.equal(kube.writes.length, 0)
  kube.objects.set('pod', { metadata: { name: userPodName('alice'),
    annotations: { 'moss.sudo.dev/runtime-owner': 'bob' } } })
  await assert.rejects(service.find('alice'), /another owner/)
  assert.equal(kube.writes.length, 0)
})

void test('an owner rollout waits for drain, retains the PVC and blocks competing starts', async t => {
  const kube = platform()
  t.mock.method(NexusZoneApiClient, 'withMtls', () => ({ mintUserRuntime: async () => ({
    subjectId: 'runtime-alice', caPem: Buffer.alloc(0), certPem: Buffer.alloc(0), keyPem: Buffer.alloc(0),
  }), close() {} }))
  const old = new UserPodService(options, kube.resources, async () => {})
  await old.resolve('alice')
  await old.close()
  const pvc = kube.objects.get('pvc')
  const podId = kube.objects.get('pod')!.metadata.uid
  const next = new UserPodService({ ...options, image: 'runtime:next-verified' }, kube.resources, async () => {})
  t.after(() => next.close())
  assert.equal((await next.inspect('alice')).isDrifted, true)
  await assert.rejects(next.upgrade('alice', async () => { throw new Error('Agent is busy') }), /Agent is busy/)
  assert.equal(kube.objects.get('pod')!.metadata.uid, podId, 'a busy owner keeps its original running Pod')
  assert.equal(kube.objects.has('upgrade-secret'), false)
  await next.upgrade('alice', async previous => {
    assert(previous?.runtimeEndpoint)
    assert.equal(kube.objects.get('pod')!.metadata.uid, podId)
    await assert.rejects(next.resolve('alice'), /draining/)
  })
  assert.notEqual(kube.objects.get('pod')!.metadata.uid, podId)
  assert.equal(kube.objects.get('pvc'), pvc, 'rollout retains exactly the original user volume')
  assert.equal((await next.inspect('alice')).isDrifted, false)
  assert.equal(kube.objects.has('upgrade-secret'), false)
})

void test('controller closure joins credential delivery before a replacement can write its Secret', async t => {
  const kube = platform()
  let isWaiting = false
  let releaseCredential!: () => void
  let markWaiting!: () => void
  const waiting = new Promise<void>(resolve => { markWaiting = resolve })
  const credentialReady = new Promise<void>(resolve => { releaseCredential = resolve })
  t.mock.method(NexusZoneApiClient, 'withMtls', () => ({ mintUserRuntime: async () => {
    if (isWaiting) { markWaiting(); await credentialReady }
    return { subjectId: 'runtime-alice', caPem: Buffer.alloc(0), certPem: Buffer.alloc(0), keyPem: Buffer.alloc(0) }
  }, close() {} }))
  const service = new UserPodService(options, kube.resources, async () => {})
  await service.resolve('alice')
  isWaiting = true
  const configuring = service.resolve('alice', { 'sudocode.json': '{"model":"next"}' })
  await waiting
  let isClosed = false
  const closing = service.close().then(() => { isClosed = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(isClosed, false, 'the prior controller cannot outlive its configuration write')
  releaseCredential()
  await Promise.all([configuring, closing])
  assert.equal(isClosed, true)
  const delivered = Buffer.from(kube.objects.get('secret')!.data!['sudocode.json']!, 'base64').toString()
  assert.equal(delivered, '{"model":"next"}')
})

void test('a failed replacement restores the prior owner image and model configuration on the retained volume', async t => {
  const kube = platform()
  t.mock.method(NexusZoneApiClient, 'withMtls', () => ({ mintUserRuntime: async () => ({
    subjectId: 'runtime-alice', caPem: Buffer.alloc(0), certPem: Buffer.alloc(0), keyPem: Buffer.alloc(0),
  }), close() {} }))
  const configuration = { 'sudocode.json': '{}', 'backend-config.json': '{"mounts":[{"owner":"alice"}]}' }
  const old = new UserPodService(options, kube.resources, async () => {})
  await old.resolve('alice', configuration)
  await old.close()
  const pvc = kube.objects.get('pvc')
  const write = kube.resources.write
  t.mock.method(kube.resources, 'write', async (manifest: Record<string, unknown>, verb?: 'create' | 'apply') => {
    await write(manifest, verb)
    const container = (manifest.spec as { containers?: Array<{ image: string }> })?.containers?.[0]
    if (manifest.kind === 'Pod' && container?.image === 'runtime:broken') kube.objects.get('pod')!.status = { phase: 'Failed' }
  })
  const service = new UserPodService({ ...options, image: 'runtime:broken' }, kube.resources, async () => {})
  t.after(() => service.close())
  await assert.rejects(service.upgrade('alice', async () => {}, { ...configuration,
    'backend-config.json': '{"mounts":[{"owner":"alice","new":true}]}' }), /exited before/)
  assert.equal(kube.objects.get('pvc'), pvc)
  assert.equal(kube.objects.has('upgrade-secret'), false)
  assert.equal((kube.objects.get('pod')!.spec!.containers as Array<{ image: string }>)[0]!.image, options.image)
  assert.equal(Buffer.from(kube.objects.get('secret')!.data!['backend-config.json']!, 'base64').toString(), configuration['backend-config.json'])
  assert.equal((await service.inspect('alice')).isDrifted, true, 'rollback remains visible as release drift')
  assert.equal((await service.resolve('alice', configuration)).runtimeEndpoint, 'https://compute.internal:31443')
})

void test('concurrent sessions share one user Pod without delivering cluster authority', async t => {
  const kube = platform()
  let issued = 0
  t.mock.method(NexusZoneApiClient, 'withMtls', (endpoint: string) => {
    assert.equal(endpoint, options.issuer.endpoint)
    return { mintUserRuntime: async (owner: string) => {
      assert.equal(owner, 'alice')
      issued++
      return { subjectId: 'runtime-alice', caPem: Buffer.from('public-ca'),
        certPem: Buffer.from('alice-certificate'), keyPem: Buffer.from('alice-private-key') }
    }, close() {} }
  })
  const service = new UserPodService(options, kube.resources, async () => {})
  t.after(() => service.close())
  const [a, b] = await Promise.all([service.resolve('alice'), service.resolve('alice')])
  assert.equal(a, b)
  assert.equal(issued, 1)
  assert.equal(kube.writes.filter(write => write.kind === 'service').length, 1)
  assert.equal(kube.writes.filter(write => write.kind === 'pod').length, 1)
  const secret = kube.writes.find(write => write.kind === 'secret')!.manifest.stringData as Record<string, string>
  assert.deepEqual(Object.keys(secret).sort(), ['agent-key.pem', 'agent.pem', 'backend-config.json', 'ca.pem', 'credential.json', 'sudocode.json'])
  assert.equal(JSON.stringify(kube.writes).includes('/moss-key'), false)
  assert.equal(a.tls, options.issuer.tls)
  assert.equal(a.authToken, '')
  assert.equal(a.endpoint, options.issuer.endpoint)
  assert.equal(a.runtimeEndpoint, 'https://compute.internal:31443')
  assert.notEqual(userPodName('alice'), userPodName('bob'))
  const updated = { 'sudocode.json': '{"auth_modes":{"proxy":{"moss":{"baseUrl":"https://model-gateway"}}}}' }
  await service.resolve('alice', updated)
  assert.equal(issued, 2)
  assert.equal(kube.writes.filter(write => write.kind === 'service').length, 1)
  assert.equal(kube.writes.filter(write => write.kind === 'pod').length, 1)
  const configured = kube.writes.filter(write => write.kind === 'secret').at(-1)!.manifest.stringData as Record<string, string>
  assert.equal(configured['sudocode.json'], updated['sudocode.json'])
  await service.resolve('alice', updated)
  assert.equal(issued, 2, 'an unchanged owner configuration keeps its existing service')
  const write = kube.resources.write
  let isFailing = true
  t.mock.method(kube.resources, 'write', async (manifest: Record<string, unknown>, verb?: 'create' | 'apply') => {
    if (manifest.kind === 'Secret' && isFailing) {
      isFailing = false
      throw new Error('temporary Kubernetes failure')
    }
    return write(manifest, verb)
  })
  const replacement = { 'sudocode.json': '{"auth_modes":{"proxy":{"moss":{"baseUrl":"https://new-gateway"}}}}' }
  await assert.rejects(service.resolve('alice', replacement), /temporary Kubernetes failure/)
  await service.resolve('alice', replacement)
  assert.equal(issued, 4, 'failed configuration delivery is retried')
  assert.equal(kube.writes.filter(write => write.kind === 'service').length, 1)
  await assert.rejects(service.resolve('alice', { ...replacement,
    'backend-config.json': '{"mounts":[{"path":"/model","backend_type":"openai","backend_name":"other"}]}' }), /explicit runtime restart/)
  assert.equal(issued, 4, 'an active model backend never receives another provider configuration')
  await service.close()
  assert.ok(kube.objects.has('service'), 'controller closure retains the runtime network address')
  assert.ok(kube.objects.has('pvc'), 'controller closure retains user storage')
})

void test('a restarted controller reuses the owned Pod, Service and retained volume', async t => {
  const kube = platform()
  t.mock.method(NexusZoneApiClient, 'withMtls', () => ({ mintUserRuntime: async () => ({
    subjectId: 'runtime-alice', caPem: Buffer.alloc(0), certPem: Buffer.alloc(0), keyPem: Buffer.alloc(0),
  }), close() {} }))
  const service = new UserPodService(options, kube.resources, async () => {})
  t.after(() => service.close())
  await service.resolve('alice')
  await service.close()
  const restarted = new UserPodService(options, kube.resources, async () => {})
  t.after(() => restarted.close())
  const [a, b] = await Promise.all([restarted.resolve('alice'), restarted.resolve('alice')])
  assert.equal(a, b)
  assert.equal(kube.writes.filter(write => write.kind === 'service').length, 1)
  assert.equal(kube.writes.filter(write => write.kind === 'pod').length, 1)
  assert.equal(kube.writes.filter(write => write.kind === 'pvc').length, 1)
})

void test('a resource with another owner is refused before any credential or volume mutation', async t => {
  const kube = platform()
  kube.objects.set('pod', { metadata: { name: userPodName('alice'),
    annotations: { 'moss.sudo.dev/runtime-owner': 'bob' } } })
  t.mock.method(NexusZoneApiClient, 'withMtls', () => { throw new Error('issuer must not be opened') })
  const service = new UserPodService(options, kube.resources, async () => {})
  t.after(() => service.close())
  await assert.rejects(service.resolve('alice'), /another owner/)
  assert.equal(kube.writes.length, 0)
})

void test('a matching requested image cannot hide a running image with another digest', async t => {
  const kube = platform()
  const digest = `sha256:${'a'.repeat(64)}`
  const release: RuntimeRelease = { schemaVersion: 1, releaseId: 'server-v0.1.51',
    engine: { version: '0.2.28', commit: 'b2e2c57' },
    cohost: { version: '0.2.28', nexusVersion: '0.8.10', pluginAbi: 7, binaryDigest: digest },
    issuerVersion: '0.8.10', image: { reference: options.image, digest, digestKind: 'oci-config' },
    archive: { name: 'runtime.tar.gz', digest } }
  t.mock.method(NexusZoneApiClient, 'withMtls', () => ({ mintUserRuntime: async () => ({
    subjectId: 'runtime-alice', caPem: Buffer.alloc(0), certPem: Buffer.alloc(0), keyPem: Buffer.alloc(0),
  }), close() {} }))
  kube.resources.observe = async () => ({ version: 'nexusd-cohost v0.2.28 (sudocode b2e2c57, nexus-vfs v0.8.10) (plugin-abi 7)', binaryDigest: digest })
  const write = kube.resources.write
  t.mock.method(kube.resources, 'write', async (manifest: Record<string, unknown>, verb?: 'create' | 'apply') => {
    await write(manifest, verb)
    if (manifest.kind === 'Pod') kube.objects.get('pod')!.status!.containerStatuses =
      [{ name: 'runtime', imageID: `sha256:${'b'.repeat(64)}` }]
  })
  const service = new UserPodService({ ...options, release }, kube.resources, async () => {})
  t.after(() => service.close())
  await assert.rejects(service.resolve('alice'), /runtime image differs/)
  assert.equal((await service.inspect('alice')).isDrifted, true)
  const status = kube.objects.get('pod')!.status!
  status.containerStatuses = [{ name: 'runtime', imageID: `docker.io/library/runtime@${digest}` }]
  await assert.rejects(service.resolve('alice'), /runtime image differs/, 'a manifest digest cannot substitute for a config digest')
  status.containerStatuses = [{ name: 'runtime', imageID: digest }]
  await service.resolve('alice')
  assert.equal((await service.inspect('alice')).isDrifted, false)
})

void test('controller restart preserves projected configuration and refuses a live provider change', async t => {
  const kube = platform()
  t.mock.method(NexusZoneApiClient, 'withMtls', () => ({ mintUserRuntime: async () => ({
    subjectId: 'runtime-alice', caPem: Buffer.alloc(0), certPem: Buffer.alloc(0), keyPem: Buffer.alloc(0),
  }), close() {} }))
  const configuration = { 'sudocode.json': '{"auth_modes":{"proxy":{"moss":{"apiKey":"fixture"}}}}',
    'backend-config.json': '{"mounts":[{"path":"/model","backend_type":"anthropic"}]}' }
  const first = new UserPodService(options, kube.resources, async () => {})
  await first.resolve('alice', configuration)
  await first.close()
  const restarted = new UserPodService(options, kube.resources, async () => {})
  t.after(() => restarted.close())
  await restarted.resolve('alice')
  const delivered = kube.writes.filter(write => write.kind === 'secret').at(-1)!.manifest.stringData as Record<string, string>
  assert.equal(delivered['sudocode.json'], configuration['sudocode.json'])
  assert.equal(delivered['backend-config.json'], configuration['backend-config.json'])
  await restarted.close()
  const changed = new UserPodService(options, kube.resources, async () => {})
  t.after(() => changed.close())
  const before = kube.writes.length
  await assert.rejects(changed.resolve('alice', { ...configuration,
    'backend-config.json': '{"mounts":[]}' }), /explicit runtime restart/)
  assert.equal(kube.writes.length, before, 'restart cannot bypass the active backend configuration check')
})

void test('placement waits for authenticated readiness and controller closure cancels the wait', async t => {
  const kube = platform()
  t.mock.method(NexusZoneApiClient, 'withMtls', () => ({ mintUserRuntime: async () => ({
    subjectId: 'runtime-alice', caPem: Buffer.alloc(0), certPem: Buffer.alloc(0), keyPem: Buffer.alloc(0),
  }), close() {} }))
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  let isResolved = false
  const service = new UserPodService(options, kube.resources, async (config, owner, signal) => {
    assert.equal(config.runtimeEndpoint, 'https://compute.internal:31443')
    assert.equal(owner, 'alice')
    markStarted()
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })
  const resolution = service.resolve('alice').then(() => { isResolved = true })
  const rejected = assert.rejects(resolution, /aborted/)
  await started
  assert.equal(isResolved, false, 'TCP Ready alone never publishes the connection')
  await service.close()
  await rejected
  assert.ok(kube.objects.has('pvc'))
})
