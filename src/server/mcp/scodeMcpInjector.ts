import pMap from 'p-map'
import type { McpStore } from './db.js'
import type { McpServer } from './types.js'
import type { McpUserConfigApi } from '../api/mcpUserConfig.js'
import { isVisibleTo, type VisibilityFilter } from '../visibilityFilter.js'
import { resolveAuthHeaders, resolveSecretRefHeaders, type McpAuthSecretsApi } from './authResolver.js'

/**
 * Resolve the scode-format MCP settings for a session, to be written as
 * `${configDir}/.nexus/sudocode/settings.json` so the spawned scode process
 * loads the user's installed MCP servers.
 *
 * Runs in the MAIN process only: it touches `nexusClient` (via mcpUserConfig)
 * and the DB (via mcpStore), neither of which is reachable from the detached
 * runner child process. The resolved result travels to the backend through the
 * runner manifest; the backend only writes the JSON file.
 */
export async function resolveScodeMcpSettings(options: {
  mcpStore: McpStore
  mcpUserConfig: McpUserConfigApi
  secretsApi?: McpAuthSecretsApi
  orgId: string
  userId: string
  departmentId: string | null
  visibilityFilter: VisibilityFilter
}): Promise<{ mcpServers: Record<string, unknown> } | null> {
  const { mcpStore, mcpUserConfig, orgId, userId, departmentId, visibilityFilter } = options

  // SQL pre-filters enabled=1; the app layer adds isVisibleTo (department/user
  // scoping) and status==='enabled' so only connection-verified MCPs are sent.
  const allServers = mcpStore.listVisibleMcpServers(orgId, userId, departmentId)
  const userDisabledIds = new Set(mcpStore.getUserDisabledMcpIds(orgId, userId))
  const visibleServers = allServers.filter(
    s => isVisibleTo(s.visible_to, visibilityFilter) && s.status === 'enabled' && !userDisabledIds.has(s.id),
  )

  const policy = mcpStore.getMcpPolicy(orgId)
  const filtered = visibleServers.filter(s => {
    if (s.mcp_type === 'stdio' && !policy.allow_stdio_mcp) return false
    return true
  })

  if (filtered.length === 0) return null

  // Per-user secrets live in nexus; resolve concurrently but bounded so a large
  // MCP count does not overwhelm the local nexusd. One failure skips that MCP
  // only — it must not block the whole session from starting.
  const resolved = await pMap(
    filtered,
    async server => {
      try {
        const { env, headers } = await mcpUserConfig.getResolvedEnvAndHeaders(server, userId)

        // secret_ref 解析：与 resolvedHeaders 合并
        let secretRefHeaders: Record<string, string> = {}
        if (server.auth_type === 'secret_ref' && server.secret_ref && options.secretsApi) {
          secretRefHeaders = await resolveSecretRefHeaders(
            server.secret_ref,
            (pinyin) => options.secretsApi!.getConfigItemByPinyin(pinyin),
            (ns, subject) => options.secretsApi!.listSecrets(ns, subject),
          )
        }

        return { server, env, headers: { ...headers, ...secretRefHeaders } }
      } catch (err) {
        process.stderr.write(`[ScodeMcpInjector] resolve env failed for MCP ${server.id}: ${err}\n`)
        return null
      }
    },
    { concurrency: 8 },
  )
  const resolvedList = resolved.filter((x): x is NonNullable<typeof x> => x !== null)

  const mcpServers: Record<string, unknown> = {}
  for (const { server, env, headers } of resolvedList) {
    const entry = toScodeMcpEntry(server, env, headers)
    if (entry) mcpServers[server.name] = entry
  }

  if (Object.keys(mcpServers).length === 0) return null
  return { mcpServers }
}

function safeParseArray(json: string | null): string[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function safeParseStringMap(json: string | null): Record<string, string> {
  if (!json) return {}
  try {
    const parsed = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Convert an McpServer to a scode settings.json entry. Field names match the
 * sudocode rust parser (`config.rs` parse_mcp_server_config). Returns null to
 * skip entries that would be rejected by that parser (e.g. stdio without a
 * command), since a single bad entry fails the entire settings.json load.
 */
function toScodeMcpEntry(
  server: McpServer,
  resolvedEnv: Record<string, string>,
  resolvedHeaders: Record<string, string>,
): Record<string, unknown> | null {
  switch (server.mcp_type) {
    case 'stdio': {
      if (!server.command) return null
      const args = safeParseArray(server.args_json)
      const env = safeParseStringMap(server.env_json)
      return {
        type: 'stdio',
        command: server.command,
        ...(args.length ? { args } : {}),
        env: { ...env, ...resolvedEnv }, // user secrets override default env
        ...(server.timeout_ms ? { toolCallTimeoutMs: server.timeout_ms } : {}),
      }
    }
    case 'http': {
      if (!server.url) return null
      const baseHeaders = resolveAuthHeaders(server.auth_type, server.auth_config_json)
      return {
        type: 'http',
        url: server.url,
        headers: { ...baseHeaders, ...resolvedHeaders },
      }
    }
    case 'sse': {
      if (!server.url) return null
      const baseHeaders = resolveAuthHeaders(server.auth_type, server.auth_config_json)
      return {
        type: 'sse',
        url: server.url,
        headers: { ...baseHeaders, ...resolvedHeaders },
      }
    }
    default:
      return null
  }
}
