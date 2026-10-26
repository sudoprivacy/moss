import { z } from 'zod'

/** Moss owns control authorization. Nexus remains the Agent identity/A2A owner. */
export const AGENT_CONTROL_PROTOCOL = 'moss-agent-control/v1' as const
export const AGENT_CONTROL_AUDIENCE = 'moss:agent-control:v1' as const
export const AGENT_CONTROL_SCOPE = 'agent-control:invoke' as const
export const AGENT_CONTROL_KEY_PREFIX = 'agent-control:'

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
const agentName = z.string().min(1).max(256).regex(/^[^/\\\0]+$/)
export const deploymentPlanSchema = z.object({ planId: identifier, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()

// One catalog supplies server argument validation and native tool discovery.
// Transport annotations never grant permission.
export const agentControlCatalog = {
  'agents.list': { name: 'moss_agents_list', description: 'List the Agents visible within the delegated owner and deployment.', mutating: false,
    arguments: z.object({ after: identifier.optional(), limit: z.number().int().min(1).max(100).default(25) }).strict() },
  'agents.inspect': { name: 'moss_agent_inspect', description: 'Inspect an existing Agent, its sessions and runtime.', mutating: false,
    arguments: z.object({ agent: agentName }).strict() },
  'agents.spawn': { name: 'moss_agent_spawn', description: 'Start a session for an existing authorized Agent using its actual owner and runtime.', mutating: true,
    arguments: z.object({ agent: agentName }).strict() },
  'runtime.inspect': { name: 'moss_runtime_inspect', description: 'Inspect the delegated owner runtime without installing or starting it.', mutating: false,
    arguments: z.object({}).strict() },
  'runtime.deploy': { name: 'moss_runtime_deploy', description: 'Submit one operator-approved device deployment plan. Recover the original operation to observe completion.', mutating: true,
    arguments: z.object({ planId: identifier }).strict() },
} as const

export type AgentControlAction = keyof typeof agentControlCatalog
export const agentControlActionSchema = z.enum(Object.keys(agentControlCatalog) as [AgentControlAction, ...AgentControlAction[]])
export const agentControlTargetSchema = z.object({ deploymentId: identifier, ownerId: identifier }).strict()
export type AgentControlTarget = z.infer<typeof agentControlTargetSchema>
export const agentControlDelegationRequest = z.object({
  actorSessionId: identifier,
  target: agentControlTargetSchema,
  actions: z.array(agentControlActionSchema).min(1).max(5).refine(actions => new Set(actions).size === actions.length),
  deploymentPlans: z.array(deploymentPlanSchema).min(1).max(20).optional(),
  ttlSeconds: z.number().int().min(1).max(300).default(120),
}).strict()

export const agentControlInvocationSchema = z.object({
  protocol: z.literal(AGENT_CONTROL_PROTOCOL), operationId: identifier,
  action: agentControlActionSchema, arguments: z.record(z.string(), z.unknown()),
}).strict()

/** These fields come from a read of the authenticated cohost, never request JSON. */
export interface ManagedControlActor {
  plane: 'managed-cohost'
  ownerId: string
  agentId: string
  sessionId: string
  taskId: string
  attemptId: string
  durableSessionId: string
  repositoryPath: string
  executionId: string
}

export function agentControlTools(actions: readonly AgentControlAction[], plans?: readonly z.infer<typeof deploymentPlanSchema>[]) {
  return actions.map(action => {
    const descriptor = agentControlCatalog[action]
    const argumentsSchema = action === 'runtime.deploy' && plans?.length
      ? z.object({ planId: z.enum(plans.map(plan => plan.planId) as [string, ...string[]]) }).strict() : descriptor.arguments
    return { action, name: descriptor.name, description: descriptor.description, mutating: descriptor.mutating,
      inputSchema: z.toJSONSchema(argumentsSchema, { io: 'input' }) }
  })
}
