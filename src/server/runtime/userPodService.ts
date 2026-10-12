import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { NexusZoneApiClient, userRuntimeServerName, type SessionCredential } from '@nexus-ai-fs/vfs-client'
import { buildKubectlBaseArgs, kubectlApply, readK8sResource, type K8sResource } from '../backends/k8sResources.js'
import { forwardK8sPod, type PodForward } from '../backends/k8sForward.js'
import type { NexusTlsConfig } from '../nexus/nexusEnvConfig.js'
import type { SessionConnectionConfig } from '../nexus/sessionConnection.js'

const OWNER_ANNOTATION = 'moss.sudo.dev/runtime-owner'
const SPEC_ANNOTATION = 'moss.sudo.dev/runtime-spec'
const APP_LABEL = 'moss-user-runtime'
const DATA_ROOT = '/data'
const RUNTIME_PORT = 8443
const CREDENTIAL_VALIDITY_SECS = 300

export interface UserPodOptions {
  image: string
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
}

interface UserPodConnection {
  forward: PodForward
  config: SessionConnectionConfig
  close: () => void
  configure: (configuration: Record<string, string>) => Promise<void>
}

export interface UserPodResources {
  read: (kind: string, name: string) => Promise<K8sResource | undefined>
  write: (manifest: Record<string, unknown>, verb?: 'create' | 'apply') => Promise<void>
  forward: (name: string) => Promise<PodForward>
}

function kubernetesResources(options: UserPodOptions): UserPodResources {
  const base = buildKubectlBaseArgs(options.namespace, options.kubeconfig)
  return {
    read: (kind, name) => readK8sResource(base, kind, name),
    write: (manifest, verb) => kubectlApply(base, manifest, verb),
    forward: name => forwardK8sPod(base, name, RUNTIME_PORT),
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
  const metadata = { name, namespace: options.namespace, labels: { app: APP_LABEL },
    annotations: { [OWNER_ANNOTATION]: ownerId } }
  const container = {
    name: 'runtime', image: options.image, imagePullPolicy: options.imagePullPolicy ?? 'IfNotPresent',
    command: ['nexusd-cohost'],
    args: ['--data-dir', DATA_ROOT, '--root-fs', `${DATA_ROOT}/files`,
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
        'mkdir -p /data/scode; if [ -e /data/scode/sudocode.json ] || [ -L /data/scode/sudocode.json ]; then test "$(readlink /data/scode/sudocode.json)" = /runtime-config/sudocode.json; else ln -s /runtime-config/sudocode.json /data/scode/sudocode.json; fi'],
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
  const digest = createHash('sha256').update(JSON.stringify(spec)).digest('hex')
  return {
    pod: { apiVersion: 'v1', kind: 'Pod', metadata: { ...metadata,
      annotations: { ...metadata.annotations, [SPEC_ANNOTATION]: digest } }, spec },
    claim: { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata,
      spec: { accessModes: ['ReadWriteOnce'], storageClassName: options.storageClass,
        resources: { requests: { storage: options.storageSize ?? '10Gi' } } } },
    secret: { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata },
  }
}

/** Coordinates user boxes without storing addresses, credentials or PID presence in SQL. */
export class UserPodService {
  private readonly connections = new Map<string, Promise<UserPodConnection>>()
  private isClosed = false

  constructor(private readonly options: UserPodOptions, private readonly resources = kubernetesResources(options)) {
    if (!options.image || !options.storageClass) throw new Error('User Pods require an image and retained storage')
  }

  async resolve(ownerId: string, configuration?: Record<string, string>): Promise<SessionConnectionConfig> {
    if (this.isClosed) throw new Error('User Pod service is closed')
    userPodName(ownerId)
    let connection = this.connections.get(ownerId)
    if (connection) {
      const existing = await connection
      if (existing.forward.isOpen()) {
        if (configuration) await existing.configure(configuration)
        return existing.config
      }
      if (this.connections.get(ownerId) === connection) {
        existing.close()
        this.connections.delete(ownerId)
      }
      return this.resolve(ownerId, configuration)
    }
    connection = this.open(ownerId, configuration)
    this.connections.set(ownerId, connection)
    try { return (await connection).config } catch (error) {
      if (this.connections.get(ownerId) === connection) this.connections.delete(ownerId)
      throw error
    }
  }

  private async open(ownerId: string, suppliedConfiguration?: Record<string, string>): Promise<UserPodConnection> {
    const manifests = userPodManifests(ownerId, this.options)
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
    await ensureCreated('pvc', manifests.claim)
    const defaults = { 'sudocode.json': '{}', 'backend-config.json': '{"mounts":[]}' }
    const savedSecret = await assertOwner('secret')
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
      if (this.isClosed) throw new Error('User Pod service is closed')
      const current = await assertOwner('pod')
      if (current?.status?.phase === 'Running') break
      if (current?.status?.phase === 'Failed' || current?.status?.phase === 'Succeeded') {
        throw new Error('User Pod exited before its service became ready')
      }
      if (Date.now() >= deadline) throw new Error('User Pod did not reach Running within 90 seconds')
      await delay(1000)
    }
    const forward = await this.resources.forward(name)
    let timer: ReturnType<typeof setTimeout> | undefined
    let isActive = true
    const renew = async () => {
      if (!isActive || this.isClosed || !forward.isOpen()) return
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
      forward,
      configure: async (next) => {
        const replacement = { ...defaults, ...next }
        if (configuration['backend-config.json'] !== replacement['backend-config.json']) {
          throw new Error('User Pod model backend changes require an explicit runtime restart')
        }
        if (JSON.stringify(configuration) === JSON.stringify(replacement)) return
        await refresh(replacement)
      },
      config: { ...this.options.issuer, authToken: '', runtimeEndpoint: forward.endpoint },
      close: () => { isActive = false; clearTimeout(timer); forward.close() },
    }
  }

  /** Disconnect controller transports while retaining owned Pods and user volumes. */
  async close(): Promise<void> {
    this.isClosed = true
    await Promise.allSettled([...this.connections.values()].map(async connection => (await connection).close()))
    this.connections.clear()
  }
}
