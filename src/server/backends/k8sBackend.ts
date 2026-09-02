import { execFile, spawn } from 'child_process'
import { mkdir, readFile } from 'fs/promises'
import { join, posix as posixPath } from 'path'
import { promisify } from 'util'
import { MOSS_HOME } from '../../utils/skills/localSkillDirectories.js'
import { syncWorkspaceSkills } from '../../utils/scodeBridge.js'
import type {
  BackendHandle,
  BackendSpawnOptions,
  SessionBackend,
  SessionRuntimeInfo,
} from '../sessionManager.js'
import {
  buildSessionEnv,
  buildConfigDir,
  getAssistantRuntimeConfig,
  buildAvailableSkillSnapshot,
} from './backendUtils.js'
import { createAcpBridgeHandle } from './acpBridge.js'
import { buildAllModelsConfig, ensureOpenAIModelConfig } from '../modelListCache.js'

const execFileAsync = promisify(execFile)

/** Label used to select/GC every pod + secret this backend owns. */
const MOSS_POD_APP_LABEL = 'moss-scode'
const MOSS_POD_SESSION_LABEL = 'moss.sudo.dev/session-id'

export type K8sBackendDefaults = {
  /** Container image that ships the node runtime scode links against. `MOSS_SCODE_IMAGE`. */
  image?: string
  /** Namespace pods are created in. Defaults to `default`. `MOSS_K8S_NAMESPACE`. */
  namespace?: string
  /** RuntimeClass that provides the gvisor (runsc) sandbox. Defaults to `gvisor`. */
  runtimeClassName?: string
  /** Path to the kubeconfig that reaches the k3s API server. `MOSS_K8S_KUBECONFIG`. */
  kubeconfig?: string
  /**
   * Path of the scode binary ON THE COMPUTE NODE. It is `hostPath`-mounted into
   * the pod at the same path (node-local, pre-staged out-of-band per node — see
   * docs/k8s-gvisor-backend.md). Defaults to `/usr/local/bin/scode`. `MOSS_K8S_SCODE_PATH`.
   */
  scodePath?: string
  /** CPU limit for the pod (k8s quantity). Defaults to `2`. */
  cpuLimit?: string
  /** Memory limit for the pod (k8s quantity). Defaults to `4Gi`. */
  memoryLimit?: string
  /** Seconds to wait for the pod to reach Running before giving up. Defaults to 90. */
  podReadyTimeoutSec?: number
  /** Extra labels stamped on every pod (in addition to the GC labels). */
  labels?: Record<string, string>
}

/** A k8s volume + the mounts that reference it. */
type PodVolume = Record<string, unknown> & { name: string }
type PodVolumeMount = {
  name: string
  mountPath: string
  subPath?: string
  readOnly?: boolean
}

/** Drop mounts that would collide on the same in-pod path (first wins). */
function dedupeMounts(mounts: PodVolumeMount[]): PodVolumeMount[] {
  const seen = new Set<string>()
  const out: PodVolumeMount[] = []
  for (const mount of mounts) {
    const composite = mount.subPath ? mount.mountPath : `dir:${mount.mountPath}`
    if (seen.has(composite)) continue
    seen.add(composite)
    out.push(mount)
  }
  return out
}

async function readScodeSessionId(filePath: string): Promise<string | undefined> {
  try {
    const value = (await readFile(filePath, 'utf8')).trim()
    return value || undefined
  } catch {
    return undefined
  }
}

/**
 * SessionBackend that runs each session's scode inside a gvisor-isolated
 * Kubernetes pod. Correct for the real multi-node topology: moss (control
 * plane) and the k3s kubelet run on DIFFERENT hosts, so the pod's filesystem is
 * the *compute node's*, never moss's.
 *
 * Config delivery is therefore k8s-native, not hostPath:
 *  - scode config (`sudocode.json` — carries the sudorouter proxy auth token —
 *    plus `settings.json` and any enabled-skill `SKILL.md`) is packed into a
 *    per-session {@link https://kubernetes.io/docs/concepts/configuration/secret Secret}
 *    `scode-cfg-<sid>` and mounted read-only at the exact in-container paths
 *    scode reads (`SUDO_CODE_CONFIG_HOME` and the workspace skills dir).
 *  - HOME / `CLAUDE_CONFIG_DIR` and the session workspace/cwd are pod-local
 *    `emptyDir`s (scode writes there; moss reads results back over the ACP
 *    stream, and the transcript is written moss-side by {@link createAcpBridgeHandle},
 *    so a pod-local workspace is correct).
 *  - only the scode BINARY is a `hostPath` — it is legitimately node-local
 *    (pre-staged per compute node at `MOSS_K8S_SCODE_PATH`).
 *
 * The ACP bridge is reused UNCHANGED: `spawn('kubectl', ['exec','-i', …])`'s
 * stdio ARE the pod's exec stdio, interchangeable with a docker `exec` child.
 * The container command is `sleep infinity` so moss can `kubectl exec` scode per
 * turn. Teardown deletes the pod + Secret; {@link gcOrphanedPods} reaps leaks.
 */
export class K8sBackend implements SessionBackend {
  constructor(private readonly defaults: K8sBackendDefaults = {}) {}

  async spawn(options: BackendSpawnOptions): Promise<BackendHandle> {
    const runtime = options.runtime
    const image = runtime?.k8sImage || this.defaults.image
    if (!image) {
      throw new Error(
        'k8s runtime requested but no scode container image was configured (set MOSS_SCODE_IMAGE)',
      )
    }

    const namespace = runtime?.k8sNamespace || this.defaults.namespace || 'default'
    const runtimeClassName =
      runtime?.k8sRuntimeClassName || this.defaults.runtimeClassName || 'gvisor'
    const kubeconfig = runtime?.k8sKubeconfig || this.defaults.kubeconfig
    // Node-local scode binary path. hostPath-mounted into the pod at the SAME
    // path; scode is exec'd from there.
    const scodePath = runtime?.k8sScodePath || this.defaults.scodePath || '/usr/local/bin/scode'
    const cpuLimit = this.defaults.cpuLimit || '2'
    const memoryLimit = this.defaults.memoryLimit || '4Gi'
    const podReadyTimeoutSec = this.defaults.podReadyTimeoutSec ?? 90

    // Read the assistant config (same as the docker/scode backend).
    const assistantConfig = await getAssistantRuntimeConfig(options.assistantName)
    const enabledSkills = options.assistantName
      ? assistantConfig.enabledSkills
      : (options.enabledSkillNames ?? assistantConfig.enabledSkills)

    // memory mode: assistant memory_mode wins, else 'session'
    const memoryMode: 'session' | 'user' =
      runtime?.k8sMode || (assistantConfig.memoryMode === 'user' ? 'user' : 'session')

    // These path strings double as the in-pod mount paths. moss also touches
    // `safeCwd` on its own host (acpBridge drafts / scode-session-id), but the
    // pod gets an independent emptyDir at the same path — the two filesystems
    // are separate now, which is exactly the cross-node contract.
    const configDir = runtime?.configDir || buildConfigDir(options, memoryMode)
    const scodeHomeDir = runtime?.scodeHomeDir || join(configDir, '.nexus', 'sudocode')

    // Workspace cwd: never mount '/' — fall back to a real per-session dir.
    const safeCwd = options.cwd === '/' ? configDir : options.cwd
    // The local `kubectl` process chdir's here and acpBridge writes drafts /
    // scode-session-id here on the moss host, so it must exist moss-side.
    await mkdir(safeCwd, { recursive: true })

    // Sync skills into the workspace dir: the symlinks land on moss's host fs (harmless), but
    // we only need the returned links to (a) build the UI snapshot and (b) read
    // each SKILL.md so it can be packed into the per-session Secret and mounted
    // into the pod (hostPath symlinks would dangle on the remote node).
    let workspaceSkillLinks = [] as Awaited<ReturnType<typeof syncWorkspaceSkills>>
    try {
      workspaceSkillLinks = await syncWorkspaceSkills(safeCwd, enabledSkills, options.visibilityFilter)
      process.stderr.write(`[K8sBackend] Enumerated ${workspaceSkillLinks.length} skills for session ${options.sessionId}\n`)
    } catch (err) {
      process.stderr.write(`[K8sBackend] Workspace skills sync warning: ${err}\n`)
    }
    const availableSkills = await buildAvailableSkillSnapshot(workspaceSkillLinks)

    const env = buildSessionEnv(options, {
      ...(options.sessionToken ? { SESSION_TOKEN: options.sessionToken } : {}),
    })

    // Resolve model (identical priority to docker/scode backend).
    let model = env.MOSS_DEFAULT_MODEL || runtime?.model || 'gemini-3-flash-preview'
    if (model && !model.includes('/') && !['opus', 'sonnet', 'haiku', 'claude-opus', 'claude-sonnet', 'claude-haiku'].includes(model)) {
      model = `proxy/${model}`
    }

    // ---- Build the per-session Secret payload (delivered into the pod) ----
    // Keys map 1:1 to files mounted read-only at the paths scode reads. This is
    // the ONLY channel that carries the sudorouter proxy auth token to the
    // (remote) pod — hence a Secret, not a ConfigMap or hostPath.
    const secretData: Record<string, string> = {}
    const secretMounts: Array<{ key: string; mountPath: string }> = []

    // sudocode.json — preloaded auth + models, exactly like docker backend.
    try {
      const baseUrl = env.ANTHROPIC_BASE_URL || 'https://hk.sudorouter.ai/v1'
      const apiKey = env.ANTHROPIC_API_KEY || ''
      const allModels = ensureOpenAIModelConfig(
        await buildAllModelsConfig(baseUrl),
        env.MOSS_DEFAULT_MODEL || runtime?.model || 'gemini-3-flash-preview',
      )
      const scodeConfig = {
        auth_modes: { proxy: { 'moss-proxy': { baseUrl, apiKey } } },
        models: allModels,
      }
      secretData['sudocode.json'] = JSON.stringify(scodeConfig, null, 2)
      secretMounts.push({ key: 'sudocode.json', mountPath: posixPath.join(scodeHomeDir, 'sudocode.json') })
      process.stderr.write(`[K8sBackend] Packed ${Object.keys(allModels).length} models into sudocode.json secret\n`)
    } catch (e) {
      process.stderr.write(`[K8sBackend] Failed to build sudocode.json: ${e}\n`)
    }

    const scodeSettings = buildScodeSettings(options)
    if (Object.keys(scodeSettings).length > 0) {
      secretData['settings.json'] = JSON.stringify(scodeSettings, null, 2)
      secretMounts.push({ key: 'settings.json', mountPath: posixPath.join(scodeHomeDir, 'settings.json') })
    }

    // Skills: pack each enabled skill's SKILL.md into the Secret and mount it at
    // the workspace skills dir scode discovers (`<cwd>/.nexus/sudocode/skills`).
    // NOTE (PoC): a flat Secret can only carry the top-level SKILL.md manifest,
    // not a skill's nested asset tree (scripts/, references/); those need the
    // image bake / a PVC in production.
    const workspaceSkillsDir = posixPath.join(safeCwd, '.nexus', 'sudocode', 'skills')
    let skillIdx = 0
    for (const link of workspaceSkillLinks) {
      const md = await readFile(join(link.sourcePath, 'SKILL.md'), 'utf8').catch(() => null)
      if (!md) continue
      const key = `skill_${skillIdx++}_${link.name.replace(/[^-._a-zA-Z0-9]/g, '_')}`
      secretData[key] = md
      secretMounts.push({ key, mountPath: posixPath.join(workspaceSkillsDir, link.name, 'SKILL.md') })
    }

    // Env injected into the container spec. `kubectl exec` inherits the
    // container env (containerd behaviour), so scode sees these when exec'd.
    const passthroughEnvKeys = [
      'MOSS_SESSION_USER_ID',
      'MOSS_SESSION_ORG_ID',
      'MOSS_SESSION_ROLE',
      'MOSS_SESSION_SCOPES',
      'MOSS_ASSISTANT_NAME',
      'MOSS_DEFAULT_MODEL',
      'MOSS_SERVER_URL',
      'SESSION_TOKEN',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
      'PROXY_AUTH_TOKEN',
      'SUDOWORK_AUTH_PROXY_URL',
      'SUDOWORK_AUTH_PROXY_BASE_URL',
      'SUDOWORK_AUTH_PROXY_TOKEN',
    ]
    const podEnv: Record<string, string> = {}
    for (const key of passthroughEnvKeys) {
      if (env[key]) podEnv[key] = env[key] as string
    }
    podEnv.HOME = configDir
    podEnv.MOSS_HOME = MOSS_HOME
    podEnv.SUDO_CODE_CONFIG_HOME = scodeHomeDir
    podEnv.CLAUDE_CONFIG_DIR = configDir
    podEnv.CLAUDE_CODE_REMOTE_MEMORY_DIR = configDir
    podEnv.MOSS_SESSION_ID = options.sessionId

    // DNS-1123 names for the pod + its Secret (same sanitized suffix).
    const { podName, secretName } = buildResourceNames(options.sessionId)
    const kubectlBase = buildKubectlBaseArgs(namespace, kubeconfig)

    // ---- Volumes / mounts (cross-node correct) ----
    // emptyDir: pod-local writable HOME / workspace / scode config dir.
    // secret:   read-only config + skill files delivered from moss.
    // hostPath: ONLY the node-local scode binary.
    const volumes: PodVolume[] = [
      { name: 'home', emptyDir: {} },
      { name: 'workspace', emptyDir: {} },
      { name: 'scode-cfg', emptyDir: {} },
      { name: 'scode-secret', secret: { secretName } },
      { name: 'scode-bin', hostPath: { path: scodePath, type: 'File' } },
    ]
    const volumeMounts = dedupeMounts([
      { name: 'home', mountPath: configDir },
      { name: 'workspace', mountPath: safeCwd },
      { name: 'scode-cfg', mountPath: scodeHomeDir },
      ...secretMounts.map(m => ({
        name: 'scode-secret',
        mountPath: m.mountPath,
        subPath: m.key,
        readOnly: true,
      })),
      { name: 'scode-bin', mountPath: scodePath, readOnly: true },
    ])

    const podManifest = buildPodManifest({
      podName,
      namespace,
      runtimeClassName,
      image,
      sessionId: options.sessionId,
      workDir: safeCwd,
      env: podEnv,
      volumes,
      volumeMounts,
      cpuLimit,
      memoryLimit,
      extraLabels: this.defaults.labels,
    })
    const secretManifest = buildSecretManifest({
      secretName,
      namespace,
      sessionId: options.sessionId,
      data: secretData,
      extraLabels: this.defaults.labels,
    })

    process.stderr.write(`\n[K8sBackend] Creating gvisor pod for session ${options.sessionId}:\n`)
    process.stderr.write(`  pod: ${podName}  secret: ${secretName}  ns: ${namespace}  runtimeClass: ${runtimeClassName}\n`)
    process.stderr.write(`  image: ${image}\n`)
    process.stderr.write(`  scode (node hostPath): ${scodePath}\n`)
    process.stderr.write(`  cwd (emptyDir): ${safeCwd}\n`)
    process.stderr.write(`  HOME (emptyDir): ${configDir}\n`)
    process.stderr.write(`  SUDO_CODE_CONFIG_HOME (emptyDir + secret): ${scodeHomeDir}\n`)
    process.stderr.write(`  secret files: ${secretMounts.map(m => m.mountPath).join(', ')}\n`)
    process.stderr.write(`  model: ${model}\n\n`)

    // Secret first — the pod mounts it, so it must exist before the pod starts.
    await kubectlApply(kubectlBase, secretManifest)
    await kubectlApply(kubectlBase, podManifest)
    try {
      await waitPodRunning(kubectlBase, podName, podReadyTimeoutSec)
    } catch (err) {
      // Pod never came up — reap both so we don't leak the Secret (auth token).
      await deletePod(kubectlBase, podName).catch(() => {})
      await deleteSecret(kubectlBase, secretName).catch(() => {})
      throw err
    }

    // Bridge ACP via `kubectl exec -i`. The local kubectl process's stdio IS
    // the pod's exec stdio — feed it straight into acpBridge, same as docker.
    const execArgs = [
      ...kubectlBase,
      'exec',
      '-i',
      podName,
      '--',
      scodePath,
      'acp',
      '--output-format', 'json',
      '--permission-mode', 'danger-full-access',
      '--auth', 'proxy',
      '--model', model,
    ]

    const child = spawn('kubectl', execArgs, {
      cwd: safeCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const runtimeInfo: SessionRuntimeInfo = {
      type: 'k8s',
      engine: 'scode',
      model,
      configDir,
      scodeHomeDir,
      k8sImage: image,
      k8sNamespace: namespace,
      k8sRuntimeClassName: runtimeClassName,
      k8sScodePath: scodePath,
      k8sPodName: podName,
      k8sMode: memoryMode,
    }

    const scodeSessionIdPath = join(safeCwd, '.moss', 'scode-session-id')
    const resumeSessionId = options.resumeSessionId
      ? await readScodeSessionId(scodeSessionIdPath)
      : undefined

    const handle = createAcpBridgeHandle({
      child,
      sessionId: options.sessionId,
      cwd: safeCwd,
      model,
      transcriptPath: options.transcriptPath,
      resumeSessionId,
      scodeSessionIdPath,
      assistantName: options.assistantName,
      assistantDisplayName: options.assistantDisplayName,
      enabledSkillNames: enabledSkills,
      availableWikis: options.availableWikis,
      availableCorpApps: options.availableCorpApps,
      sharedMemory: options.sharedMemory,
      runtime: runtimeInfo,
    })
    handle.availableSkills = availableSkills

    let cleanedUp = false
    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      // Delete the pod (emptyDir workspace/config go with it) and the Secret.
      // Best-effort, detached. Mirrors docker `rm -f`.
      deletePod(kubectlBase, podName).catch(err => {
        process.stderr.write(`[K8sBackend] pod delete failed (${podName}): ${err}\n`)
      })
      deleteSecret(kubectlBase, secretName).catch(err => {
        process.stderr.write(`[K8sBackend] secret delete failed (${secretName}): ${err}\n`)
      })
    }

    child.once('close', () => cleanup())

    const originalDestroy = handle.destroy.bind(handle)
    handle.destroy = async (force = false) => {
      const destroyResult = originalDestroy(force)
      if (destroyResult instanceof Promise) {
        await destroyResult.catch(() => {})
      }
      cleanup()
    }

    return handle
  }
}

function buildKubectlBaseArgs(namespace: string, kubeconfig?: string): string[] {
  const args: string[] = []
  if (kubeconfig) {
    args.push('--kubeconfig', kubeconfig)
  }
  args.push('--namespace', namespace)
  return args
}

/** Deterministic, DNS-1123 pod + Secret names derived from the session id. */
function buildResourceNames(sessionId: string): { podName: string; secretName: string } {
  const suffix = sessionId
    .slice(0, 12)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+$/, '')
  return { podName: `scode-${suffix}`, secretName: `scode-cfg-${suffix}` }
}

type PodManifestInput = {
  podName: string
  namespace: string
  runtimeClassName: string
  image: string
  sessionId: string
  workDir: string
  env: Record<string, string>
  volumes: PodVolume[]
  volumeMounts: PodVolumeMount[]
  cpuLimit: string
  memoryLimit: string
  extraLabels?: Record<string, string>
}

function buildPodManifest(input: PodManifestInput): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: input.podName,
      namespace: input.namespace,
      labels: {
        app: MOSS_POD_APP_LABEL,
        [MOSS_POD_SESSION_LABEL]: input.sessionId,
        ...(input.extraLabels || {}),
      },
    },
    spec: {
      // The gvisor (runsc) sandbox. RuntimeClass `gvisor` must be registered.
      runtimeClassName: input.runtimeClassName,
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      containers: [
        {
          name: 'scode',
          image: input.image,
          // Keep the pod alive so moss can `kubectl exec` scode per turn.
          command: ['sleep', 'infinity'],
          workingDir: input.workDir,
          env: Object.entries(input.env).map(([name, value]) => ({ name, value })),
          volumeMounts: input.volumeMounts,
          resources: {
            limits: { cpu: input.cpuLimit, memory: input.memoryLimit },
            requests: { cpu: '250m', memory: '256Mi' },
          },
        },
      ],
      volumes: input.volumes,
    },
  }
}

type SecretManifestInput = {
  secretName: string
  namespace: string
  sessionId: string
  data: Record<string, string>
  extraLabels?: Record<string, string>
}

function buildSecretManifest(input: SecretManifestInput): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: {
      name: input.secretName,
      namespace: input.namespace,
      labels: {
        app: MOSS_POD_APP_LABEL,
        [MOSS_POD_SESSION_LABEL]: input.sessionId,
        ...(input.extraLabels || {}),
      },
    },
    // stringData: kubectl base64-encodes on apply — we hand it raw file bodies.
    stringData: input.data,
  }
}

async function kubectlApply(kubectlBase: string[], manifest: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('kubectl', [...kubectlBase, 'apply', '-f', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr?.on('data', d => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) return resolve()
      reject(new Error(`kubectl apply failed (code ${code}): ${stderr.trim()}`))
    })
    child.stdin?.end(JSON.stringify(manifest))
  })
}

async function waitPodRunning(kubectlBase: string[], podName: string, timeoutSec: number): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000
  let lastPhase = ''
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync(
        'kubectl',
        [...kubectlBase, 'get', 'pod', podName, '-o', 'jsonpath={.status.phase}'],
        { windowsHide: true },
      )
      lastPhase = stdout.trim()
      if (lastPhase === 'Running') return
      if (lastPhase === 'Failed' || lastPhase === 'Succeeded') {
        throw new Error(`pod ${podName} entered terminal phase ${lastPhase} before exec`)
      }
    } catch (err) {
      // pod may not be visible yet immediately after apply — keep polling.
      if (Date.now() >= deadline) throw err
    }
    await sleep(1000)
  }
  throw new Error(`pod ${podName} did not reach Running within ${timeoutSec}s (last phase: ${lastPhase || 'unknown'})`)
}

async function deletePod(kubectlBase: string[], podName: string): Promise<void> {
  await execFileAsync(
    'kubectl',
    [...kubectlBase, 'delete', 'pod', podName, '--ignore-not-found', '--wait=false', '--grace-period=5'],
    { windowsHide: true },
  )
}

async function deleteSecret(kubectlBase: string[], secretName: string): Promise<void> {
  await execFileAsync(
    'kubectl',
    [...kubectlBase, 'delete', 'secret', secretName, '--ignore-not-found', '--wait=false'],
    { windowsHide: true },
  )
}

/**
 * GC path for orphaned resources: delete every `app=moss-scode` pod AND
 * `scode-cfg-*` Secret whose session-id label is NOT in `activeSessionIds`.
 * Call this periodically (or on server startup) to reap leaks from crashes.
 * Mirrors the docker reaper's orphan sweep.
 */
export async function gcOrphanedPods(
  activeSessionIds: Iterable<string>,
  opts: { namespace?: string; kubeconfig?: string } = {},
): Promise<{ deleted: string[]; skipped: string[]; deletedSecrets: string[] }> {
  const kubectlBase = buildKubectlBaseArgs(opts.namespace || 'default', opts.kubeconfig)
  const active = new Set(activeSessionIds)
  const deleted: string[] = []
  const skipped: string[] = []
  const deletedSecrets: string[] = []
  const sessionLabelPath = MOSS_POD_SESSION_LABEL.replace(/\./g, '\\.')

  const { stdout: podStdout } = await execFileAsync(
    'kubectl',
    [
      ...kubectlBase,
      'get', 'pods',
      '-l', `app=${MOSS_POD_APP_LABEL}`,
      '-o', `jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.metadata.labels.${sessionLabelPath}}{"\\n"}{end}`,
    ],
    { windowsHide: true },
  )
  for (const line of podStdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [podName, sessionId] = trimmed.split('\t')
    if (!podName) continue
    if (sessionId && active.has(sessionId)) {
      skipped.push(podName)
      continue
    }
    await deletePod(kubectlBase, podName).catch(() => {})
    deleted.push(podName)
  }

  // Reap orphaned per-session Secrets the same way (the auth token lives here).
  const { stdout: secretStdout } = await execFileAsync(
    'kubectl',
    [
      ...kubectlBase,
      'get', 'secrets',
      '-l', `app=${MOSS_POD_APP_LABEL}`,
      '-o', `jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.metadata.labels.${sessionLabelPath}}{"\\n"}{end}`,
    ],
    { windowsHide: true },
  )
  for (const line of secretStdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [secretName, sessionId] = trimmed.split('\t')
    if (!secretName) continue
    if (sessionId && active.has(sessionId)) continue
    await deleteSecret(kubectlBase, secretName).catch(() => {})
    deletedSecrets.push(secretName)
  }

  return { deleted, skipped, deletedSecrets }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function buildScodeSettings(options: BackendSpawnOptions): Record<string, unknown> {
  const settings: Record<string, unknown> = {}
  if (options.mcpSettings && Object.keys(options.mcpSettings.mcpServers).length > 0) {
    Object.assign(settings, options.mcpSettings)
  }
  if (options.enabledSkillNames?.includes('cabin-hardware-control')) {
    settings.sandbox = {
      ...(typeof settings.sandbox === 'object' && settings.sandbox !== null ? settings.sandbox : {}),
      enabled: false,
      enabledPlatforms: ['macos'],
      allowUnsandboxedCommands: true,
    }
  }
  return settings
}
