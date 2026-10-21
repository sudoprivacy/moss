import { readFileSync, statSync } from 'node:fs'
import type { DbDriver } from '../db/driver.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { object } from '../externalProviders/administration.js'
import { HostedEvaluationCoordinator } from './hostedEvaluationCoordinator.js'
import { HostedRunner, type HostedRunnerConfig } from './hostedRunner.js'
import { ExecutionModelGateway, type ExecutionModelResource } from './executionModelGateway.js'
import { NexusModelRelay } from './nexusModelRelay.js'
import { nexusModelExchange, nexusModelTargets, type NexusModelConfig } from './provider/nexusModelExecutor.js'
import { AgentRouterClient } from './routerAgentClient.js'
import type { ProductRegistryClient } from './registryClient.js'

function secret(path: unknown): string {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('private credential file required')
  const file = statSync(path)
  if (!file.isFile() || file.size > 8192 || (file.mode & 0o077)) throw new Error('private credential file required')
  const value = readFileSync(path, 'utf8').trim()
  if (!value || value.length > 8192 || /[\r\n]/.test(value)) throw new Error('invalid credential')
  return value
}
/** Deployment assembly only; artifacts, datasets and runs are managed through the UI. */
export async function hostedFromEnvironment(db: DbDriver, registry?: ProductRegistryClient) {
  const path = process.env.MOSS_AGENT_HOSTED_CONFIG_FILE
  if (!path) return undefined
  const relays = new Map<string, { relay: NexusModelRelay; targets: ReturnType<typeof nexusModelTargets> }>()
  try {
    if (!registry) throw new Error('registry required')
    if (!path.startsWith('/') || !statSync(path).isFile() || statSync(path).size > 1024 * 1024) throw new Error('invalid configuration file')
    const value = object(JSON.parse(readFileSync(path, 'utf8')), ['runner', 'relays', 'resources'])
    const runnerConfig = object(value.runner, ['python', 'docker', 'modulePath'])
    const runner = new HostedRunner(runnerConfig as unknown as HostedRunnerConfig)
    if (!Array.isArray(value.relays) || !value.relays.length || value.relays.length > 16
      || !Array.isArray(value.resources) || !value.resources.length || value.resources.length > 64) throw new Error('invalid configuration')
    for (const raw of value.relays) {
      const r = object(raw, ['id', 'port', 'credentialFile', 'nexus'])
      if (typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.id) || relays.has(r.id)
        || !Number.isInteger(r.port) || Number(r.port) < 1024 || Number(r.port) > 65535) throw new Error('invalid relay')
      const n = object(r.nexus, ['endpoint', 'model_mounts', 'tls', 'authTokenFile'])
      const tls = object(n.tls, ['ca', 'cert', 'key', 'serverName'])
      // TLS secret bytes are snapshotted by nexusModelExchange, never accepted from the browser.
      if (typeof tls.key !== 'string' || !tls.key.startsWith('/') || (statSync(tls.key).mode & 0o077)) throw new Error('private TLS key required')
      const config = { endpoint: n.endpoint, model_mounts: n.model_mounts, tls,
        ...(n.authTokenFile ? { authToken: secret(n.authTokenFile) } : {}) } as unknown as NexusModelConfig
      const relay = new NexusModelRelay(secret(r.credentialFile), nexusModelExchange(config))
      relays.set(r.id, { relay, targets: nexusModelTargets(config) })
      await relay.listen(Number(r.port))
    }
    const resources: ExecutionModelResource[] = value.resources.map(raw => {
      const r = object(raw, ['orgId', 'id', 'model', 'endpoint', 'maxOutputTokens', 'allowedAddresses', 'relayId', 'modelMount', 'router'])
      const router = object(r.router, ['baseUrl', 'accountId', 'consoleTokenFile', 'quotaPerCall', 'group'])
      if (typeof router.baseUrl !== 'string' || !Number.isSafeInteger(router.accountId)
        || !Number.isSafeInteger(router.quotaPerCall) || typeof router.group !== 'string') throw new Error('invalid router')
      const relay = relays.get(String(r.relayId)), target = relay?.targets.find(t => t.model_mount === r.modelMount)
      if (!relay || !target) throw new Error('invalid content path')
      if (typeof r.model !== 'string' || !r.model || r.model.length > 200
        || typeof r.endpoint !== 'string' || (r.allowedAddresses !== undefined && (!Array.isArray(r.allowedAddresses) || r.allowedAddresses.some(x => typeof x !== 'string')))) throw new Error('invalid resource')
      secret(router.consoleTokenFile)
      const client = new AgentRouterClient({ baseUrl: String(router.baseUrl), accountId: Number(router.accountId),
        quotaPerCall: Number(router.quotaPerCall), group: String(router.group), getConsoleToken: async () => secret(router.consoleTokenFile) })
      return { orgId: r.orgId, id: r.id, model: r.model, endpoint: r.endpoint, maxOutputTokens: r.maxOutputTokens,
        allowedAddresses: r.allowedAddresses, router: client, contentPath: { relay: relay.relay, target } } as ExecutionModelResource
    })
    const gateway = new ExecutionModelGateway(db, registry, resources)
    await gateway.ready
    const coordinator = new HostedEvaluationCoordinator(registry, gateway, runner,
      (org, resource, model) => resources.some(r => r.orgId === org && r.id === resource && r.model === model))
    return { coordinator, close: async () => { await coordinator.close(); await Promise.all([...relays.values()].map(r => r.relay.close())) } }
  } catch {
    await Promise.all([...relays.values()].map(r => r.relay.close().catch(() => {})))
    throw new ExternalProviderError(500, 'HOSTED_CONFIGURATION_INVALID')
  }
}
