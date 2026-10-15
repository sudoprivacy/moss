import type { NexusVfsClient } from '@nexus-ai-fs/vfs-client'
import { z } from 'zod'
import type { RuntimeAgentNamespace } from '../agentManager.js'

const registrySchema = z.array(z.object({ name: z.string(), owner_id: z.string(),
  kind: z.string(), state: z.string(), pid: z.string().optional() }))

/** Read persistent Agent directories and live executions through the same owner credential. */
export async function readAgentNamespace(
  client: NexusVfsClient,
  authToken: string,
  ownerId: string,
  isOwnerConfined: boolean,
): Promise<RuntimeAgentNamespace> {
  const root = await client.stat('/agents', authToken)
  const entries = root ? await client.readdir('/agents', authToken) : []
  const names = entries.map(entry => entry.name.startsWith('/agents/') ? entry.name.slice('/agents/'.length) : entry.name)
    .filter(name => name && name !== '.' && name !== '..' && !/[\\/\0]/.test(name))
  const raw = await client.call('agent_list', JSON.stringify({ owner_id: ownerId }), authToken)
  const value: unknown = JSON.parse(raw)
  const records = registrySchema.parse(value && typeof value === 'object' && 'result' in value ? value.result : value)
    .filter(record => record.owner_id === ownerId)
  const managedNames: string[] = []
  if (isOwnerConfined) {
    for (const name of names) {
      if (await client.stat(`/agents/${name}/sessions`, authToken)) managedNames.push(name)
    }
  }
  return { isOwnerConfined, names, managedNames,
    executions: records.map(record => ({ name: record.name, ownerId: record.owner_id,
      state: record.state.toLowerCase(), kind: record.kind.toLowerCase(),
      ...(record.pid ? { processId: record.pid } : {}) })) }
}
