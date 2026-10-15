import { createHash } from 'node:crypto'
import Ajv2020 from 'ajv/dist/2020.js'
import schema from '../../../../contracts/agent-http/v1alpha2/schema.json' with { type: 'json' }
import type { AgentRun, SubmitAgentRun } from '../../../../contracts/agent-http/v1alpha2/contract.js'

const ajv = new Ajv2020({ strict: true })
ajv.addSchema(schema)
const submission = ajv.compile<SubmitAgentRun>({ $ref: `${schema.$id}#/$defs/SubmitAgentRun` })
const run = ajv.compile<AgentRun>({ $ref: `${schema.$id}#/$defs/AgentRun` })
export class AgentProtocolError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}
export const contentDigest = (value: unknown): string => `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
export function parseSubmitAgentRun(value: unknown): SubmitAgentRun {
  if (!submission(value) || !value.query.trim()) throw new AgentProtocolError(400, 'INVALID_AGENT_SUBMISSION')
  return value
}
export function parseAgentRun(value: unknown): AgentRun {
  if (!run(value)) throw new AgentProtocolError(502, 'INVALID_AGENT_RUN')
  return value
}
