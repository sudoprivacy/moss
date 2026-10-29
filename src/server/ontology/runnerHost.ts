import type { DirectConnectStore } from '../db.js'
import type { OntologyContextPorts } from './projectRegistry.js'
import { ResourceAccessError } from '../catalog/resourceError.js'
import { AuthCenterDb } from '../authCenter/db.js'
import { McpStore } from '../mcp/db.js'
import { currentMcpMember } from '../mcp/currentMember.js'
import { systemMcpAuthSecrets } from '../mcp/systemAuthSecrets.js'
import { ReviewedMcpAccess } from '../mcp/reviewedAccess.js'
import { ToolGatewayStore } from '../agentFederation/toolGatewayStore.js'
import { NexusClient } from '../nexus/nexusClient.js'
import { resolveNexusConfigFromEnv } from '../nexus/nexusEnvConfig.js'
import { McpOntologyContextPorts } from './mcpContextPorts.js'

export interface SessionRunnerHost {
  ontologyContext?: OntologyContextPorts
  close?(): Promise<void>
}

/** Production composition. Only persisted model bindings activate host access. */
export async function createSessionRunnerHost(store: DirectConnectStore, sessionId: string): Promise<SessionRunnerHost> {
  if (!await store.ontologyProjects.resolveSession(sessionId)) return {}
  return createModelContextHost(store)
}

/** Shared trusted composition for project discovery, session creation and runner recovery. */
export async function createModelContextHost(store: DirectConnectStore): Promise<{ ontologyContext: McpOntologyContextPorts; close(): Promise<void> }> {
  const auth = new AuthCenterDb(store)
  const mcp = new McpStore(store.driver)
  const reviews = new ToolGatewayStore(store.driver)
  await reviews.ready
  let nexus: NexusClient | undefined
  let isClosed = false
  const access = new ReviewedMcpAccess(reviews, {
    mcp, member: currentMcpMember(auth),
    secrets: org => systemMcpAuthSecrets(store, async (namespace, subject) => {
      if (isClosed) throw new ResourceAccessError(503, 'Model context host is closed')
      if (!nexus) {
        // Root process environment is deployment-owned. Never read session.env or start a daemon here.
        const config = resolveNexusConfigFromEnv()
        if (config.mode !== 'external') throw new ResourceAccessError(503, 'Model worker credentials require the configured external Nexus cluster')
        nexus = new NexusClient(config.endpoint, config.authToken, config.tls)
      }
      return nexus.listSecrets(namespace, subject)
    }, org),
  })
  return {
    ontologyContext: new McpOntologyContextPorts(access, mcp),
    close: async () => { if (isClosed) return; isClosed = true; nexus?.close() },
  }
}
