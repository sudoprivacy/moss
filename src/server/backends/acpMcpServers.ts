import type { BackendSpawnOptions } from '../sessionManager.js'

/** Use the user's already resolved MCP authorization in native ACP sessions. */
export function acpMcpServers(settings: BackendSpawnOptions['mcpSettings']): Record<string, unknown>[] {
  return Object.entries(settings?.mcpServers ?? {}).map(([name, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid MCP configuration: ${name}`)
    const config = value as Record<string, unknown>
    if (config.type === 'http' || config.type === 'sse') {
      if (typeof config.url !== 'string') throw new Error(`MCP URL is required: ${name}`)
      return { name, type: config.type, url: config.url,
        headers: stringPairs(config.headers, name) }
    }
    if (config.type !== undefined && config.type !== 'stdio') throw new Error(`Unsupported ACP MCP transport: ${name}`)
    if (typeof config.command !== 'string') throw new Error(`MCP command is required: ${name}`)
    return { name, command: config.command, args: config.args ?? [], env: stringPairs(config.env, name) }
  })
}

function stringPairs(value: unknown, name: string): { name: string; value: string }[] {
  if (value === undefined) return []
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid MCP variables: ${name}`)
  return Object.entries(value).map(([key, entry]) => {
    if (typeof entry !== 'string') throw new Error(`Invalid MCP variable: ${name}/${key}`)
    return { name: key, value: entry }
  })
}
