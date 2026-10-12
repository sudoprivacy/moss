import { z } from 'zod'
import { resolveCohostNexusConfig } from './nexusEnvConfig.js'
import type { SessionConnectionConfig } from './sessionConnection.js'

const tlsSchema = z.object({
  ca: z.string().min(1), cert: z.string().min(1), key: z.string().min(1),
  serverName: z.string().min(1).optional(),
}).strict()
const connectionSchema = z.object({
  endpoint: z.string().url(), tls: tlsSchema.nullable(), authToken: z.string(),
  runtimeEndpoint: z.string().url().optional(),
}).strict()

/** Ephemeral execution connection passed from the main coordinator to its runner. */
export function encodeCohostConnection(config: SessionConnectionConfig): string {
  return JSON.stringify(connectionSchema.parse(config))
}

/** Resolve exactly the coordinator's connection, or the external deployment endpoint. */
export function resolveCohostConnection(env: NodeJS.ProcessEnv = process.env): SessionConnectionConfig {
  if (env.MOSS_COHOST_CONNECTION) return connectionSchema.parse(JSON.parse(env.MOSS_COHOST_CONNECTION))
  const { mode: _mode, ...config } = resolveCohostNexusConfig(env)
  return config
}
