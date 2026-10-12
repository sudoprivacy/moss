import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { NexusZoneApiClient, userRuntimeServerName, type SessionCredential } from '@nexus-ai-fs/vfs-client'
import { buildKubectlBaseArgs, kubectlApply, readK8sResource, deleteK8sResource, observeK8sRuntime, type K8sResource } from '../backends/k8sResources.js'
import { parseCohostBuild, type RuntimeRelease } from './runtimeRelease.js'
import type { NexusTlsConfig } from '../nexus/nexusEnvConfig.js'
import { waitForSessionRuntime, type SessionConnectionConfig } from '../nexus/sessionConnection.js'

const OWNER_ANNOTATION = 'moss.sudo.dev/runtime-owner'
const SPEC_ANNOTATION = 'moss.sudo.dev/runtime-spec'
const APP_LABEL = 'moss-user-runtime'
const DATA_ROOT = '/data'
const RUNTIME_PORT = 8443
const CREDENTIAL_VALIDITY_SECS = 300

export interface UserPodOptions {
  image: string
  nodeHost: string
  namespace: string
  kubeconfig?: string
  storageClass: string
  storageSize?: string
  runtimeClassName?: string
  cpuLimit?: string
  memoryLimit?: string
  issuer: { endpoint: string; tls: NexusTlsConfig }
  configuration?: (ownerId: string) => Promise<Record<string, string>>
  imagePullPolicy?: string
  imagePullSecrets?: string[]
  release?: RuntimeRelease
}

interface UserPodConnection {
  config: SessionConnectionConfig
  close: () => Promise<void>
  configure: (configuration: Record<string, string>) => Promise<void>
}

export interface UserPodResources {
  read: (kind: string, name: string) => Promise<K8sResource | undefined>
  write: (manifest: Record<string, unknown>, verb?: 'create' | 'apply') => Promise<void>
  remove?: (kind: 'pods' | 'secrets', name: string, uid: string) => Promise<void>
  observe?: (name: string) => Promise<{ version: string; binaryDigest: string }>
}

function kubernetesResources(options: UserPodOptions): UserPodResources {
  const base = buildKubectlBaseArgs(options.namespace, options.kubeconfig)
  return {
    read: (kind, name) => readK8sResource(base, kind, name),
    write: (manifest, verb) => kubectlApply(base, manifest, verb),
    remove: (kind, name, uid) => deleteK8sResource(base, options.namespace, kind, name, uid),
    observe: name => observeK8sRuntime(base, name),
  }
}

/** Stable Kubernetes resource names are placement; signed owner identity controls access. */
export function userPodName(ownerId: string): string {
  userRuntimeServerName(ownerId)
  return `moss-user-${createHash('sha256').update(ownerId).digest('hex').slice(0, 40)}`
}

export function userRuntimeCredentialData(ownerId: string, credential: SessionCredential): Record<string, string> {
  return {
    'ca.pem': credential.caPem.toString('utf8'),
    'agent.pem': credential.certPem.toString('utf8'),
    'agent-key.pem': credential.keyPem.toString('utf8'),
    'credential.json': JSON.stringify({ version: 1, agent: credential.subjectId,
      server_name: userRuntimeServerName(ownerId), ca: 'ca.pem', cert: 'agent.pem', key: 'agent-key.pem' }),
  }
}

/** Compose one native cohost and durable Nexus volume for the authenticated owner. */
export function userPodManifests(ownerId: string, options: UserPodOptions) {
  const name = userPodName(ownerId)
  const metadata = { name, namespace: options.namespace, labels: { app: APP_LABEL, runtime: name },
    annotations: { [OWNER_ANNOTATION]: ownerId } }
  const container = {
    name: 'runtime', image: options.image, imagePullPolicy: options.imagePullPolicy ?? 'IfNotPresent',
    command: ['nexusd-cohost'],
    args: ['--data-dir', `${DATA_ROOT}/nexus`, '--root-path', `${DATA_ROOT}/files`,
      '--plugin-dir', '/opt/scode-plugins', '--bind-addr', `0.0.0.0:${RUNTIME_PORT}`,
      'serve-user', '--owner', ownerId, '--credential', '/runtime-identity',
      '--backend-config', '/runtime-config/backend-config.json'],
    env: [{ name: 'SCODE_GLOBAL_CONFIG_DIR', value: `${DATA_ROOT}/scode` },
      { name: 'SCODE_CHECK_UPDATES', value: '0' }, { name: 'HOME', value: '/home/agent' }],
    resources: { requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: options.cpuLimit ?? '2', memory: options.memoryLimit ?? '4Gi' } },
    securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
    volumeMounts: [{ name: 'data', mountPath: DATA_ROOT }, { name: 'home', mountPath: '/home/agent' },
      { name: 'credentials', mountPath: '/runtime-identity', readOnly: true },
      { name: 'configuration', mountPath: '/runtime-config', readOnly: true }],
    readinessProbe: { tcpSocket: { port: RUNTIME_PORT }, initialDelaySeconds: 1, periodSeconds: 2 },
  }
  const spec = {
    automountServiceAccountToken: false, restartPolicy: 'Always',
    runtimeClassName: options.runtimeClassName ?? 'gvisor',
    securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
    containers: [container],
    initContainers: [{ name: 'configuration', image: options.image,
      imagePullPolicy: options.imagePullPolicy ?? 'IfNotPresent',
      command: ['sh', '-ec',
        'mkdir -p /data/scode /data/files; if [ -e /data/scode/sudocode.json ] || [ -L /data/scode/sudocode.json ]; then test "$(readlink /data/scode/sudocode.json)" = /runtime-config/sudocode.json; else ln -s /runtime-config/sudocode.json /data/scode/sudocode.json; fi'],
      securityContext: container.securityContext,
      volumeMounts: [{ name: 'data', mountPath: DATA_ROOT },
        { name: 'configuration', mountPath: '/runtime-config', readOnly: true }],
    }],
    imagePullSecrets: (options.imagePullSecrets ?? []).map(name => ({ name })),
    volumes: [{ name: 'data', persistentVolumeClaim: { claimName: name } },
      { name: 'home', emptyDir: {} }, { name: 'credentials', secret: { secretName: name } },
      { name: 'configuration', secret: { secretName: name, items: [
        { key: 'sudocode.json', path: 'sudocode.json' },
        { key: 'backend-config.json', path: 'backend-config.json' },
      ] } }],
  }
  const digest = createHash('sha256').update(JSON.stringify({ spec, release: options.release })).digest('hex')
  return {
    pod: { apiVersion: 'v1', kind: 'Pod', metadata: { ...metadata,
      annotations: { ...metadata.annotations, [SPEC_ANNOTATION]: digest,
        ...(options.release ? { 'moss.sudo.dev/runtime-release': options.release.releaseId,
          'moss.sudo.dev/engine-commit': options.release.engine.commit,
          'moss.sudo.dev/cohost-digest': options.release.cohost.binaryDigest } : {}) } }, spec },
    claim: { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata,
      spec: { accessModes: ['ReadWriteOnce'], storageClassName: options.storageClass,
        resources: { requests: { storage: options.storageSize ?? '10Gi' } } } },
    secret: { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata },
    service: { apiVersion: 'v1', kind: 'Service', metadata,
      spec: { type: 'NodePort', selector: metadata.labels,
        ports: [{ name: 'nexus', port: RUNTIME_PORT, targetPort: RUNTIME_PORT, protocol: 'TCP' }] } },
  }
}

/** Coordinates user boxes without storing addresses, credentials or PID presence in SQL. */
export class UserPodService {
  private readonly connections = new Map<string, Promise<UserPodConnection>>()
  private readonly lifecycle = new AbortController()
  private readonly runtimeHost: string

  constructor(private readonly options: UserPodOptions, private readonly resources = kubernetesResources(options),
    private readonly ready = waitForSessionRuntime) {
    if (!options.image || !options.storageClass) throw new Error('User Pods require an image and retained storage')
    if (!options.nodeHost) throw new Error('User Pods require a private compute node host')
    const host = new URL(`https://${options.nodeHost}`)
    if (host.username || host.password || host.port || host.pathname !== '/' || host.search || host.hash) {
      throw new Error('User Pod compute host must be a hostname or IP address')
    }
    this.runtimeHost = host.hostname
    if (options.release && options.release.image.reference !== options.image) throw new Error('User runtime image differs from the shared release manifest')
  }

  /** Report version drift without provisioning a missing runtime. */
  async inspect(ownerId: string) {
    const pod = await this.resources.read('pod', userPodName(ownerId))
    if (pod && pod.metadata.annotations?.[OWNER_ANNOTATION] !== ownerId) throw new Error('User Pod belongs to another owner')
    const expected = userPodManifests(ownerId, this.options).pod
    return { ownerId, isPresent: Boolean(pod), isDrifted: Boolean(pod && (pod.metadata.annotations?.[SPEC_ANNOTATION] !== expected.metadata.annotations[SPEC_ANNOTATION] ||
      (this.options.release && pod.status?.phase === 'Running' && !this.isReleaseImage(pod)))),
      phase: pod?.status?.phase ?? 'absent', expectedImage: this.options.image,
      observedImageDigest: pod?.status?.containerStatuses?.find(container => container.name === 'runtime')?.imageID ?? null,
      releaseId: this.options.release?.releaseId ?? null }
  }

  private isReleaseImage(pod: K8sResource): boolean {
    const imageId = pod.status?.containerStatuses?.find(container => container.name === 'runtime')?.imageID
    const release = this.options.release
    if (!release) return true
    // Config hashes from loaded image archives differ from registry manifest
    // hashes. Refuse an ambiguous report instead of comparing unlike digests.
    const observed = release.image.digestKind === 'oci-config'
      ? /^(?:docker:\/\/)?(sha256:[a-f0-9]{64})$/.exec(imageId ?? '')?.[1]
      : /@(sha256:[a-f0-9]{64})$/.exec(imageId ?? '')?.[1]
    return observed === release.image.digest
  }

  /** Serialize rollouts across controllers; only the Pod is replaced and the owner PVC is retained. */
  async upgrade(ownerId: string, drain: (previous?: SessionConnectionConfig) => Promise<void>, configuration?: Record<string, string>): Promise<SessionConnectionConfig> {
    if (this.lifecycle.signal.aborted) throw new Error('User Pod service is closed')
    if (!this.resources.remove) throw new Error('Runtime replacement is unavailable')
    const name = userPodName(ownerId)
    const lockName = `${name}-upgrade`
    const operation = randomUUID()
    await this.resources.write({ apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
      metadata: { name: lockName, namespace: this.options.namespace,
        annotations: { [OWNER_ANNOTATION]: ownerId, 'moss.sudo.dev/upgrade-operation': operation } }, stringData: {} }, 'create')
    const lock = await this.resources.read('secret', lockName)
    if (!lock?.metadata.uid || lock.metadata.annotations?.['moss.sudo.dev/upgrade-operation'] !== operation) throw new Error('Runtime upgrade lock was not acquired')
    try {
      const pending = this.connections.get(ownerId)
      if (pending) await pending
      const pod = await this.resources.read('pod', name)
      if (pod && (pod.metadata.annotations?.[OWNER_ANNOTATION] !== ownerId || !pod.metadata.uid)) throw new Error('User Pod belongs to another owner or lacks an identity')
      await drain(pod ? await this.runtimeConnection(ownerId) : undefined)
      const connection = this.connections.get(ownerId)
      if (connection) await (await connection).close()
      this.connections.delete(ownerId)
      // Join configuration delivery and certificate renewal before capturing
      // rollback state or replacing the Secret with the next runtime's data.
      const savedSecret = await this.resources.read('secret', name)
      if (savedSecret && savedSecret.metadata.annotations?.[OWNER_ANNOTATION] !== ownerId) throw new Error('User Pod Secret belongs to another owner')
      const saved: Record<string, string> = {}
      for (const key of ['sudocode.json', 'backend-config.json']) {
        if (savedSecret?.data?.[key]) saved[key] = Buffer.from(savedSecret.data[key], 'base64').toString('utf8')
      }
      if (pod) {
        await this.resources.remove('pods', name, pod.metadata.uid!)
        await this.waitForPodRemoval(name)
      }
      const next = this.open(ownerId, configuration)
      this.connections.set(ownerId, next)
      try { return (await next).config }
      catch (error) {
        this.connections.delete(ownerId)
        if (pod?.spec) {
          try {
            const failed = await this.resources.read('pod', name)
            if (failed) {
              const expected = userPodManifests(ownerId, this.options).pod
              if (failed.metadata.annotations?.[OWNER_ANNOTATION] !== ownerId || !failed.metadata.uid ||
                failed.metadata.annotations?.[SPEC_ANNOTATION] !== expected.metadata.annotations[SPEC_ANNOTATION]) {
                throw new Error('Runtime rollback refused a replacement with another identity')
              }
              await this.resources.remove('pods', name, failed.metadata.uid)
              await this.waitForPodRemoval(name)
            }
            const restored = this.open(ownerId, saved, pod)
            this.connections.set(ownerId, restored)
            await restored
          } catch (rollbackError) {
            this.connections.delete(ownerId)
            throw new AggregateError([error, rollbackError], 'Runtime upgrade and rollback failed; the owner volume is retained')
          }
        }
        throw error
      }
    } finally {
      await this.resources.remove('secrets', lockName, lock.metadata.uid)
    }
  }

  private async waitForPodRemoval(name: string): Promise<void> {
    const deadline = Date.now() + 90_000
    while (await this.resources.read('pod', name)) {
      if (Date.now() >= deadline) throw new Error('User runtime did not finish draining within 90 seconds')
      await delay(1000)
    }
  }

  private async runtimeConnection(ownerId: string): Promise<SessionConnectionConfig> {
    const name = userPodName(ownerId)
    const service = await this.resources.read('service', name)
    if (service?.metadata.annotations?.[OWNER_ANNOTATION] !== ownerId) throw new Error('User Pod Service belongs to another owner')
    const serviceSpec = z.object({ type: z.literal('NodePort'), selector: z.record(z.string(), z.string()),
      ports: z.array(z.object({ name: z.literal('nexus'), port: z.literal(RUNTIME_PORT),
        targetPort: z.literal(RUNTIME_PORT), nodePort: z.number().int().min(1).max(65535) })).length(1),
    }).parse(service.spec)
    if (serviceSpec.selector.app !== APP_LABEL || serviceSpec.selector.runtime !== name) throw new Error('User Pod Service does not select its owned runtime')
    return { ...this.options.issuer, authToken: '', runtimeEndpoint: `https://${this.runtimeHost}:${serviceSpec.ports[0]!.nodePort}` }
  }

  /** Discover an existing owner box without creating a Pod or workspace for a list request. */
  async find(ownerId: string): Promise<SessionConnectionConfig | undefined> {
    const pod = await this.resources.read('pod', userPodName(ownerId))
    if (!pod) return undefined
    if (pod.metadata.annotations?.[OWNER_ANNOTATION] !== ownerId) throw new Error('User Pod belongs to another owner')
    return this.resolve(ownerId)
  }

  async resolve(ownerId: string, configuration?: Record<string, string>): Promise<SessionConnectionConfig> {
    if (this.lifecycle.signal.aborted) throw new Error('User Pod service is closed')
    userPodName(ownerId)
    if (await this.resources.read('secret', `${userPodName(ownerId)}-upgrade`)) throw new Error('User runtime is draining for an upgrade')
    let connection = this.connections.get(ownerId)
    if (connection) {
      const existing = await connection
      if (configuration) await existing.configure(configuration)
      return existing.config
    }
    connection = this.open(ownerId, configuration)
    this.connections.set(ownerId, connection)
    try { return (await connection).config } catch (error) {
      if (this.connections.get(ownerId) === connection) this.connections.delete(ownerId)
      throw error
    }
  }

  private async open(ownerId: string, suppliedConfiguration?: Record<string, string>, previousPod?: K8sResource): Promise<UserPodConnection> {
    const manifests = userPodManifests(ownerId, this.options)
    if (previousPod) {
      if (previousPod.metadata.annotations?.[OWNER_ANNOTATION] !== ownerId || !previousPod.spec) throw new Error('Runtime rollback requires the observed owner Pod')
      manifests.pod = { ...manifests.pod, metadata: { ...manifests.pod.metadata,
        annotations: previousPod.metadata.annotations as typeof manifests.pod.metadata.annotations },
      spec: previousPod.spec as typeof manifests.pod.spec }
    }
    const name = manifests.pod.metadata.name
    const assertOwner = async (kind: string) => {
      const existing = await this.resources.read(kind, name)
      if (existing && existing.metadata.annotations?.[OWNER_ANNOTATION] !== ownerId) {
        throw new Error(`User Pod ${kind} belongs to another owner`)
      }
      return existing
    }
    const ensureCreated = async (kind: string, manifest: Record<string, unknown>) => {
      if (await assertOwner(kind)) return
      try { await this.resources.write(manifest, 'create') } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('AlreadyExists')) throw error
        await assertOwner(kind)
      }
    }
    const existingPod = await assertOwner('pod')
    if (existingPod && existingPod.metadata.annotations?.[SPEC_ANNOTATION] !== manifests.pod.metadata.annotations[SPEC_ANNOTATION]) {
      throw new Error('User Pod image or configuration requires an explicit runtime upgrade')
    }
    const defaults = { 'sudocode.json': '{}', 'backend-config.json': '{"mounts":[]}' }
    const savedSecret = await assertOwner('secret')
    await assertOwner('service')
    await assertOwner('pvc')
    const saved: Record<string, string> = {}
    for (const key of Object.keys(defaults)) {
      const encoded = savedSecret?.data?.[key]
      if (encoded !== undefined) saved[key] = Buffer.from(encoded, 'base64').toString('utf8')
      else if (existingPod) throw new Error('Existing User Pod configuration is incomplete')
    }
    const requested = suppliedConfiguration ?? await this.options.configuration?.(ownerId)
    let configuration: Record<string, string> = { ...defaults, ...saved, ...requested }
    if (existingPod && saved['backend-config.json'] !== configuration['backend-config.json']) {
      throw new Error('User Pod model backend changes require an explicit runtime restart')
    }
    await ensureCreated('pvc', manifests.claim)
    let updates = Promise.resolve()
    const refresh = (replacement?: Record<string, string>) => {
      const update = updates.catch(() => {}).then(async () => {
        await assertOwner('secret')
        const next = replacement ?? configuration
        const issuer = NexusZoneApiClient.withMtls(this.options.issuer.endpoint, this.options.issuer.tls)
        try {
          const credential = await issuer.mintUserRuntime(ownerId, { validitySecs: CREDENTIAL_VALIDITY_SECS })
          await this.resources.write({ ...manifests.secret,
            stringData: { ...next, ...userRuntimeCredentialData(ownerId, credential) } })
          configuration = next
        } finally { issuer.close() }
      })
      updates = update
      return update
    }
    await refresh()
    await ensureCreated('pod', manifests.pod)
    const pod = await assertOwner('pod')
    if (pod?.metadata.annotations?.[SPEC_ANNOTATION] !== manifests.pod.metadata.annotations[SPEC_ANNOTATION]) {
      throw new Error('User Pod image or configuration requires an explicit runtime upgrade')
    }
    const deadline = Date.now() + 90_000
    while (true) {
      if (this.lifecycle.signal.aborted) throw new Error('User Pod service is closed')
      const current = await assertOwner('pod')
      if (current?.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True')) break
      if (current?.status?.phase === 'Failed' || current?.status?.phase === 'Succeeded') {
        throw new Error('User Pod exited before its service became ready')
      }
      if (Date.now() >= deadline) throw new Error('User Pod service did not become Ready within 90 seconds')
      await delay(1000)
    }
    await ensureCreated('service', manifests.service)
    const config = await this.runtimeConnection(ownerId)
    if (this.options.release && !previousPod) {
      const runningPod = await assertOwner('pod')
      if (!runningPod || !this.isReleaseImage(runningPod)) throw new Error('Running user runtime image differs from the verified release manifest')
      if (!this.resources.observe) throw new Error('Runtime build verification is unavailable')
      const observed = await this.resources.observe(name)
      const build = parseCohostBuild(observed.version)
      const expected = this.options.release
      if (build.commit !== expected.engine.commit || build.version !== expected.cohost.version ||
        build.nexusVersion !== expected.cohost.nexusVersion || build.pluginAbi !== expected.cohost.pluginAbi ||
        observed.binaryDigest !== expected.cohost.binaryDigest) throw new Error('Running user runtime differs from the verified release manifest')
    }
    await this.ready(config, ownerId, this.lifecycle.signal)
    let timer: ReturnType<typeof setTimeout> | undefined
    let isActive = true
    const renew = async () => {
      if (!isActive || this.lifecycle.signal.aborted) return
      let retryMs = 90_000
      try { await refresh() } catch {
        retryMs = 5_000
        process.stderr.write('[UserPodService] runtime credential renewal failed; retrying in five seconds\n')
      }
      if (isActive) { timer = setTimeout(() => { void renew() }, retryMs); timer.unref() }
    }
    timer = setTimeout(() => { void renew() }, 90_000)
    timer.unref()
    return {
      configure: async (next) => {
        if (!isActive || this.lifecycle.signal.aborted) throw new Error('User Pod connection is closed')
        const replacement = { ...defaults, ...next }
        if (configuration['backend-config.json'] !== replacement['backend-config.json']) {
          throw new Error('User Pod model backend changes require an explicit runtime restart')
        }
        if (JSON.stringify(configuration) === JSON.stringify(replacement)) return
        await refresh(replacement)
      },
      config,
      close: async () => {
        isActive = false
        clearTimeout(timer)
        await updates.catch(() => {})
      },
    }
  }

  /** Disconnect controller transports while retaining owned Pods and user volumes. */
  async close(): Promise<void> {
    this.lifecycle.abort()
    await Promise.allSettled([...this.connections.values()].map(async connection => (await connection).close()))
    this.connections.clear()
  }
}
