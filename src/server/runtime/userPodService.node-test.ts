import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NexusZoneApiClient } from '@nexus-ai-fs/vfs-client'
import { UserPodService, userPodName, type UserPodOptions, type UserPodResources } from './userPodService.js'
import type { K8sResource } from '../backends/k8sResources.js'

const options: UserPodOptions = {
  image: 'runtime:verified', nodeHost: 'compute.internal', namespace: 'private-runtimes', storageClass: 'retained-local',
  issuer: { endpoint: 'https://control-plane', tls: { ca: '/ca', cert: '/moss', key: '/moss-key' } },
}

function platform() {
  const objects = new Map<string, K8sResource>()
  const writes: Array<{ kind: string; manifest: Record<string, unknown> }> = []
  const resources: UserPodResources = {
    async read(kind) { return objects.get(kind) },
    async write(manifest) {
      const kind = manifest.kind === 'PersistentVolumeClaim' ? 'pvc' : String(manifest.kind).toLowerCase()
      writes.push({ kind, manifest })
      objects.set(kind, { metadata: manifest.metadata as K8sResource['metadata'],
        ...(kind === 'secret' ? { data: Object.fromEntries(Object.entries(manifest.stringData as Record<string, string>)
          .map(([key, value]) => [key, Buffer.from(value).toString('base64')])) } : {}),
        ...(kind === 'service' ? { spec: { ...manifest.spec as object,
          ports: [{ name: 'nexus', port: 8443, targetPort: 8443, nodePort: 31443 }] } } : {}),
        ...(kind === 'pod' ? { status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } } : {}) })
    },
  }
  return { objects, writes, resources }
}

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
  const service = new UserPodService(options, kube.resources)
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
  const service = new UserPodService(options, kube.resources)
  t.after(() => service.close())
  await service.resolve('alice')
  await service.close()
  const restarted = new UserPodService(options, kube.resources)
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
  const service = new UserPodService(options, kube.resources)
  t.after(() => service.close())
  await assert.rejects(service.resolve('alice'), /another owner/)
  assert.equal(kube.writes.length, 0)
})

void test('controller restart preserves projected configuration and refuses a live provider change', async t => {
  const kube = platform()
  t.mock.method(NexusZoneApiClient, 'withMtls', () => ({ mintUserRuntime: async () => ({
    subjectId: 'runtime-alice', caPem: Buffer.alloc(0), certPem: Buffer.alloc(0), keyPem: Buffer.alloc(0),
  }), close() {} }))
  const configuration = { 'sudocode.json': '{"auth_modes":{"proxy":{"moss":{"apiKey":"fixture"}}}}',
    'backend-config.json': '{"mounts":[{"path":"/model","backend_type":"anthropic"}]}' }
  const first = new UserPodService(options, kube.resources)
  await first.resolve('alice', configuration)
  await first.close()
  const restarted = new UserPodService(options, kube.resources)
  t.after(() => restarted.close())
  await restarted.resolve('alice')
  const delivered = kube.writes.filter(write => write.kind === 'secret').at(-1)!.manifest.stringData as Record<string, string>
  assert.equal(delivered['sudocode.json'], configuration['sudocode.json'])
  assert.equal(delivered['backend-config.json'], configuration['backend-config.json'])
  await restarted.close()
  const changed = new UserPodService(options, kube.resources)
  t.after(() => changed.close())
  const before = kube.writes.length
  await assert.rejects(changed.resolve('alice', { ...configuration,
    'backend-config.json': '{"mounts":[]}' }), /explicit runtime restart/)
  assert.equal(kube.writes.length, before, 'restart cannot bypass the active backend configuration check')
})
