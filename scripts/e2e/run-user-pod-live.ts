/** Run the real owner Pod, recovery and release journeys with an isolated issuer and controlled model. */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { readRuntimeRelease } from '@sudo/user-runtime/release'
import { provisionMossIssuer } from '../../deploy/nexus/mossIssuer.js'
import { startIsolatedNexus } from './fixtures/isolated-nexus.js'

const [binaryInput, configurationInput, releaseInput, evidenceInput] = process.argv.slice(2)
assert(binaryInput && configurationInput && releaseInput && evidenceInput,
  'Installed daemon, Kubernetes configuration, verified release and evidence directory are required')
const configuration = z.object({ nodeHost: z.string().min(1), namespace: z.string().regex(/^moss-owner-e2e-[a-z0-9-]+$/),
  kubeconfig: z.string().min(1), runtimeClassName: z.string().min(1) })
  .parse(JSON.parse(readFileSync(configurationInput, 'utf8')))
const release = readRuntimeRelease(releaseInput)
const evidence = resolve(evidenceInput)
mkdirSync(evidence, { recursive: true })
const issuer = await startIsolatedNexus(resolve(binaryInput))
const children = new Set<ChildProcess>()
const scripts = dirname(fileURLToPath(import.meta.url))
let isPassed = false

async function stop(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  timer.unref()
  try { await exited } finally { clearTimeout(timer) }
}

async function run(name: string, arguments_: string[]): Promise<void> {
  const child = spawn(process.execPath, [join(scripts, name + '.mjs'), ...arguments_], {
    env: { ...issuer.environment, MOSS_USER_POD_E2E: '1' }, stdio: 'inherit', windowsHide: true,
    timeout: 600_000,
  })
  children.add(child)
  try {
    const [code, signal] = await once(child, 'exit')
    assert.equal(signal, null, name + ' must finish before its deadline')
    assert.equal(code, 0, name + ' must pass against the real Kubernetes runtime')
  } finally { children.delete(child) }
}

try {
  const controller = await provisionMossIssuer(issuer.data, issuer.endpoint)
  const modelPort = 18484
  const modelLog = openSync(join(issuer.privateRoot, 'model.log'), 'wx', 0o600)
  const model = spawn(process.execPath, [join(scripts, 'mock-openai-server.mjs'), '--host', '0.0.0.0',
    '--port', String(modelPort), '--api-key', 'moss-e2e-key'], {
    env: issuer.environment, stdio: ['ignore', modelLog, modelLog], windowsHide: true,
  })
  closeSync(modelLog)
  children.add(model)
  const modelBase = `http://${configuration.nodeHost}:${modelPort}`
  const deadline = Date.now() + 15_000
  let isModelReady = false
  while (Date.now() < deadline) {
    assert.equal(model.exitCode, null, 'the controlled provider exited during startup')
    try {
      isModelReady = (await fetch(modelBase + '/healthz', { signal: AbortSignal.timeout(1000) })).ok
      if (isModelReady) break
    } catch { /* Retry only the read-only readiness request. */ }
    await delay(100)
  }
  assert(isModelReady, 'the controlled provider must become reachable from the node network')
  const options = join(issuer.privateRoot, 'options.private.json')
  const modelOptions = join(issuer.privateRoot, 'model.private.json')
  writeFileSync(options, JSON.stringify({ ...configuration, image: release.image.reference, release,
    storageClass: 'local-path', storageSize: '1Gi', cpuLimit: '1', memoryLimit: '768Mi',
    imagePullPolicy: 'Never', issuer: controller }), { flag: 'wx', mode: 0o600 })
  writeFileSync(modelOptions, JSON.stringify({ model: 'claude-sonnet-4-6', baseUrl: modelBase + '/v1', apiKey: 'moss-e2e-key' }),
    { flag: 'wx', mode: 0o600 })
  const runtime = join(evidence, 'runtime')
  await run('user-pod-runtime', [options, modelOptions, runtime])
  await run('user-pod-recovery', [options, modelOptions, runtime, join(evidence, 'recovery')])
  await run('user-pod-release-upgrade', [options, modelOptions, runtime, join(evidence, 'upgrade')])
  isPassed = true
} finally {
  await Promise.all([...children].map(child => stop(child)))
  await issuer.stop()
  writeFileSync(join(evidence, 'acceptance.json'), JSON.stringify({ success: isPassed,
    release: release.releaseId, runtimeClassName: configuration.runtimeClassName,
    realKubernetes: true, controlledModel: true, privateIssuerMaterialUploaded: false,
    journeys: ['owner mTLS isolation and two cohosts', 'same PVC and exact durable recovery', 'release rejection and rollback'],
  }, null, 2))
}
