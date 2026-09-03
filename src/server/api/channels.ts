import type { DirectConnectStore } from '../db.js'
import { getChannelManager, getPairingService } from '../../channels/index.js'
import type { IChannelPluginConfig, PluginStatus, PluginType } from '../../channels/types.js'
import {
  KNOWN_CHANNEL_TYPES,
  defaultPluginId,
  generatePluginId,
  pluginTypeFromId,
  pluginScope,
} from '../../channels/types.js'
import { stripChannelSecretsForClient } from '../../channels/core/channelCredentialSecrets.js'

// Plugin type to name mapping
const PLUGIN_NAMES: Record<string, string> = {
  telegram: 'Telegram Bot',
  lark: '飞书 Bot',
  dingtalk: '钉钉 Bot',
  wechat: '个人微信 Bot',
  wecom: '企业微信 Bot',
}

export function createChannelsApi(db: DirectConnectStore) {
  const channelsApi = {
    /**
     * GET /api/v1/channels/plugins
     */
    getPlugins: async (orgId: string, userId: string) => {
      const rows = db.listChannelPlugins(userId)
      const KNOWN_TYPES = KNOWN_CHANNEL_TYPES
      const extractType = (id: string, rowType: string): string => {
        if (KNOWN_TYPES.includes(rowType)) return rowType
        return pluginTypeFromId(id)
      }
      const plugins = rows.map((row) => {
        const id = String(row.id)
        const type = extractType(id, String(row.type)) as PluginType
        // Never ship sensitive fields to the list endpoint: strip them (and internal meta),
        // exposing only the non-sensitive fields + which secrets are configured.
        const rawCreds = row.credentials_json ? JSON.parse(String(row.credentials_json)) : undefined
        const { credentials, configuredSecretFields } = stripChannelSecretsForClient(type, rawCreds)
        return {
          id,
          type,
          name: String(row.name) || PLUGIN_NAMES[type] || type,
          enabled: Boolean(row.enabled),
          credentials,
          configuredSecretFields,
          config: row.config_json ? JSON.parse(String(row.config_json)) : undefined,
          status: String(row.status) as PluginStatus,
          lastConnected: row.last_connected ? Number(row.last_connected) : undefined,
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
        }
      })

      // Show an empty placeholder card for a type with no connection yet, so every
      // platform stays discoverable in the UI. Types that already have one or more
      // connections render those instead — never a placeholder alongside them.
      const existingTypes = new Set(plugins.map(p => p.type))
      for (const type of KNOWN_TYPES) {
        if (!existingTypes.has(type)) {
          const id = defaultPluginId(type)
          plugins.push({
            id,
            type: type as PluginType,
            name: PLUGIN_NAMES[type] || type,
            enabled: false,
            credentials: undefined,
            configuredSecretFields: [],
            config: undefined,
            status: 'stopped' as PluginStatus,
            lastConnected: undefined,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
        }
      }

      return { plugins }
    },

    /**
     * GET /api/v1/channels/plugins/:id
     */
    getPlugin: async (orgId: string, userId: string, pluginId: string) => {
      const row = db.getChannelPlugin(pluginId, userId)
      const KNOWN_TYPES = KNOWN_CHANNEL_TYPES
      if (!row) {
        const type = KNOWN_TYPES.find(t => pluginId === t || pluginId.startsWith(`${t}_`))
        if (type) {
          return {
            id: pluginId,
            type,
            name: PLUGIN_NAMES[type] || type,
            enabled: false,
            status: 'stopped' as PluginStatus,
            lastConnected: undefined,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            credentials: undefined,
            configuredSecretFields: [],
            config: undefined,
          }
        }
        return null
      }
      const rowType = String(row.type)
      const type = KNOWN_TYPES.includes(rowType) ? rowType : pluginTypeFromId(pluginId)
      const rawCreds = row.credentials_json ? JSON.parse(String(row.credentials_json)) : undefined
      const { credentials, configuredSecretFields } = stripChannelSecretsForClient(type as PluginType, rawCreds)
      return {
        id: String(row.id),
        type,
        name: String(row.name),
        enabled: Boolean(row.enabled),
        status: String(row.status) as PluginStatus,
        lastConnected: row.last_connected ? Number(row.last_connected) : undefined,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        credentials,
        configuredSecretFields,
        config: row.config_json ? JSON.parse(String(row.config_json)) : undefined,
      }
    },

    /**
     * POST /api/v1/channels/plugins/:id/enable
     */
    enablePlugin: async (orgId: string, userId: string, pluginId: string, body: any) => {
      console.log(`[ChannelsAPI] enablePlugin called: orgId=${orgId}, userId=${userId}, pluginId=${pluginId}`)

      const manager = getChannelManager()
      if (!manager.isInitialized()) {
        console.error('[ChannelsAPI] ChannelManager not initialized')
        return { ok: false, message: 'ChannelManager not initialized' }
      }

      const result = await manager.enablePlugin(pluginId, body, undefined, userId, orgId)

      if (!result.success) {
        console.error(`[ChannelsAPI] Failed to enable plugin ${pluginId}:`, result.error)
        return { ok: false, message: result.error || 'Failed to enable plugin' }
      }

      console.log(`[ChannelsAPI] Plugin ${pluginId} enabled successfully for user ${userId}`)
      return { ok: true }
    },

    /**
     * POST /api/v1/channels/plugins/:id/disable
     */
    disablePlugin: async (orgId: string, userId: string, pluginId: string) => {
      console.log(`[ChannelsAPI] disablePlugin called: orgId=${orgId}, userId=${userId}, pluginId=${pluginId}`)

      const manager = getChannelManager()
      if (!manager.isInitialized()) {
        console.error('[ChannelsAPI] ChannelManager not initialized')
        return { ok: false, message: 'ChannelManager not initialized' }
      }

      const result = await manager.disablePlugin(pluginId, userId)

      if (!result.success) {
        console.error(`[ChannelsAPI] Failed to disable plugin ${pluginId}:`, result.error)
        return { ok: false, message: result.error || 'Failed to disable plugin' }
      }

      // Clean up pending pairings and authorized users for THIS connection only —
      // a sibling bot of the same type keeps its own pairings and authorizations.
      const scope = pluginScope(pluginId, pluginTypeFromId(pluginId))
      db.deletePairingRequestsByUserAndPlatform(userId, scope)
      db.deleteChannelUsersByPlatform(scope, userId)

      console.log(`[ChannelsAPI] Plugin ${pluginId} disabled successfully for user ${userId}`)
      return { ok: true }
    },

    /**
     * POST /api/v1/channels/plugins/create
     *
     * Allocate an additional connection of a type. Returns the new plugin id, which the
     * client then configures and enables like any other. The row is created disabled and
     * credential-less so an abandoned "add" leaves nothing running.
     */
    createPlugin: async (orgId: string, userId: string, body: { type?: string; name?: string }) => {
      const type = String(body?.type || '')
      if (!KNOWN_CHANNEL_TYPES.includes(type)) {
        return { ok: false, message: `Unknown channel type: ${type}` }
      }

      // The first connection of a type keeps the legacy `<type>_default` id, so existing
      // sessions, authorizations and pairings continue to resolve to it after upgrade.
      const existing = db.listChannelPlugins(userId).filter(
        (row) => pluginTypeFromId(String(row.id)) === type,
      )
      const id = existing.some((row) => String(row.id) === defaultPluginId(type))
        ? generatePluginId(type)
        : defaultPluginId(type)

      const label = PLUGIN_NAMES[type] || type
      const name = String(body?.name || '').trim() || `${label} ${existing.length + 1}`

      db.upsertChannelPlugin({
        id,
        type,
        name,
        enabled: 0,
        status: 'stopped',
        credentials_json: null,
        config_json: null,
        user_id: userId,
        org_id: orgId,
      })

      return { ok: true, id, type, name }
    },

    /**
     * POST /api/v1/channels/plugins/:id/remove
     *
     * Stop the connection and delete it outright, along with the authorizations and
     * pending pairings scoped to it. Sibling connections of the same type are untouched.
     */
    removePlugin: async (orgId: string, userId: string, pluginId: string) => {
      const manager = getChannelManager()
      if (manager.isInitialized()) {
        await manager.disablePlugin(pluginId, userId)
      }

      const scope = pluginScope(pluginId, pluginTypeFromId(pluginId))
      db.deletePairingRequestsByUserAndPlatform(userId, scope)
      db.deleteChannelUsersByPlatform(scope, userId)
      db.deleteChannelPlugin(pluginId, userId)

      // Remove the connection's sensitive secrets from Nexus so a reused pluginId can't read them.
      if (manager.isInitialized()) {
        await manager.deletePluginSecrets(pluginId, userId)
      }

      return { ok: true }
    },

    /**
     * POST /api/v1/channels/plugins/:id/test
     */
    testPlugin: async (orgId: string, userId: string, pluginId: string, body: any) => {
      const manager = getChannelManager()
      if (!manager.isInitialized()) {
        return { ok: false, message: 'ChannelManager not initialized' }
      }
      const result = await manager.testPlugin(pluginId, body)
      return { ok: result.success, message: result.error || result.botUsername }
    },

    /**
     * GET /api/v1/channels/pairings/pending
     */
    getPendingPairings: async (orgId: string, userId: string) => {
      const rows = db.listPendingPairingRequests(userId)
      const pairings = rows
        .map((row) => ({
          code: String(row.code),
          platformUserId: String(row.platform_user_id),
          platformType: String(row.platform_type) as PluginType,
          pluginScope: String(row.plugin_scope || row.platform_type),
          displayName: row.display_name ? String(row.display_name) : undefined,
          requestedAt: Number(row.requested_at || row.created_at || Date.now()),
          expiresAt: Number(row.expires_at),
          status: 'pending' as const,
        }))
      return { pairings }
    },

    /**
     * POST /api/v1/channels/pairings/:code/approve
     */
    approvePairing: async (orgId: string, userId: string, code: string) => {
      // Validate the pairing code belongs to this user
      const pairingRow = db.getPairingRequest(code)
      if (pairingRow && pairingRow.user_id && String(pairingRow.user_id) !== userId) {
        return { ok: false, message: 'Forbidden' }
      }
      const result = await getPairingService().approvePairing(code)
      if (result.success && result.user) {
        db.upsertChannelUser({
          id: result.user.id,
          platform_user_id: result.user.platformUserId,
          platform_type: result.user.platformType,
          // Authorize on the connection the code was issued for, not the whole platform.
          plugin_scope: result.user.pluginScope ?? result.user.platformType,
          display_name: result.user.displayName ?? null,
          authorized_at: result.user.authorizedAt,
          last_active: null,
          session_id: null,
          org_id: orgId,
          user_id: userId,
        })
      }
      return { ok: result.success }
    },

    /**
     * POST /api/v1/channels/pairings/:code/reject
     */
    rejectPairing: async (orgId: string, userId: string, code: string) => {
      // Validate the pairing code belongs to this user
      const pairingRow = db.getPairingRequest(code)
      if (pairingRow && pairingRow.user_id && String(pairingRow.user_id) !== userId) {
        return { ok: false, message: 'Forbidden' }
      }
      const result = await getPairingService().rejectPairing(code)
      return result
    },

    /**
     * GET /api/v1/channels/users
     */
    getUsers: async (orgId: string, userId: string) => {
      const rows = db.listChannelUsers(userId)
      const users = rows
        .map((row) => ({
          id: String(row.id),
          platformUserId: String(row.platform_user_id),
          platformType: String(row.platform_type) as PluginType,
          pluginScope: String(row.plugin_scope || row.platform_type),
          displayName: row.display_name ? String(row.display_name) : undefined,
          authorizedAt: Number(row.authorized_at),
          lastActive: row.last_active ? Number(row.last_active) : undefined,
          sessionId: row.session_id ? String(row.session_id) : undefined,
        }))
      return { users }
    },

    /**
     * DELETE /api/v1/channels/users/:id
     */
    deleteUser: async (orgId: string, userId: string, targetUserId: string) => {
      // Only allow deleting users that belong to this authenticated user
      const targetUser = db.getChannelUserById(targetUserId)
      if (targetUser && String(targetUser.user_id) !== userId) {
        return { ok: false, message: 'Forbidden' }
      }
      db.deleteChannelUser(targetUserId)
      return { ok: true }
    },

    /**
     * DELETE /api/v1/channels/users?platform=xxx
     */
    deleteUsersByPlatform: async (orgId: string, userId: string, platformType: string) => {
      // `platform` here is the connection scope: the bare platform for a type's first
      // connection, or a plugin id to clear just that one.
      const count = db.deleteChannelUsersByPlatform(platformType, userId)
      return { ok: true, count }
    },

    /**
     * GET /api/v1/channels/sessions
     */
    getSessions: async (orgId: string, userId: string) => {
      // Query moss sessions table for channel sessions belonging to this user
      const CHANNEL_SOURCES = KNOWN_CHANNEL_TYPES
      const sessions = db.listUserSessions(orgId, userId)
      return sessions
        .filter(s => s.source && CHANNEL_SOURCES.includes(s.source))
        .map((s) => {
          // channel_chat_id carries a "<pluginId>#<chatId>" prefix for every connection
          // after a type's first, so the UI can tell two bots of one type apart. Split it
          // back out rather than showing the raw composite key.
          const raw = s.channelChatId || ''
          const hash = raw.indexOf('#')
          const pluginId = hash > 0 ? raw.slice(0, hash) : defaultPluginId(s.source || '')
          const chatId = hash > 0 ? raw.slice(hash + 1) : raw
          return {
          id: s.sessionId,
          userId: s.userId,
          agentType: 'acp',
          conversationId: s.transcriptSessionId,
          workspace: s.cwd,
          chatId,
          pluginId,
          source: s.source,
          status: s.status,
          createdAt: s.createdAt,
          lastActivity: s.lastActiveAt,
          }
        })
    },

    /**
     * DELETE /api/v1/channels/sessions/:id
     */
    deleteSession: async (orgId: string, userId: string, sessionId: string) => {
      db.deleteChannelSession(sessionId)
      return { success: true }
    },

    /**
     * GET /api/v1/channels/plugins/:id/credentials
     */
    getPluginCredentials: async (orgId: string, userId: string, pluginId: string) => {
      const row = db.getChannelPlugin(pluginId, userId)
      if (!row) {
        const KNOWN_TYPES = KNOWN_CHANNEL_TYPES
        const type = KNOWN_TYPES.find(t => pluginId === t || pluginId.startsWith(`${t}_`))
        if (type) return {}
        return null
      }
      // Sensitive fields come only from Nexus (via the manager); internal meta is stripped.
      const manager = getChannelManager()
      return manager.getHydratedCredentials(pluginId, userId)
    },

    /**
     * GET /api/v1/channels/plugins/:id/agents
     *
     * Agents this connection can use, plus the connection-level default. The roster is
     * whatever is visible to the requesting user, so it matches what they see elsewhere.
     */
    getPluginAgents: async (
      orgId: string,
      userId: string,
      pluginId: string,
      listAgents: (ownerUserId: string) => Promise<Array<{ name: string; displayName: string; description?: string }>>,
    ) => {
      const row = db.getChannelPlugin(pluginId, userId)
      let defaultAgent: string | null = null
      if (row?.config_json) {
        try {
          const cfg = JSON.parse(String(row.config_json))
          const name = cfg?.agent?.name
          if (typeof name === 'string' && name) defaultAgent = name
        } catch { /* treat as unset */ }
      }
      const agents = await listAgents(userId)
      // A default pointing at an agent the user can no longer see is reported as unset.
      if (defaultAgent && !agents.some(a => a.name === defaultAgent)) defaultAgent = null
      return { agents, defaultAgent }
    },

    /**
     * PUT /api/v1/channels/plugins/:id/agents/default
     *
     * Set (or clear, with null) the agent new chats on this connection start with. Existing
     * chats keep whatever they were switched to.
     */
    setPluginDefaultAgent: async (
      orgId: string,
      userId: string,
      pluginId: string,
      agentName: string | null,
      listAgents: (ownerUserId: string) => Promise<Array<{ name: string; displayName: string }>>,
    ) => {
      const row = db.getChannelPlugin(pluginId, userId)
      if (!row) return { ok: false, message: 'Channel not configured' }

      if (agentName) {
        const agents = await listAgents(userId)
        if (!agents.some(a => a.name === agentName)) {
          return { ok: false, message: `智能体不存在或无权访问：${agentName}` }
        }
      }

      let cfg: Record<string, unknown> = {}
      if (row.config_json) {
        try {
          const parsed = JSON.parse(String(row.config_json))
          if (parsed && typeof parsed === 'object') cfg = parsed as Record<string, unknown>
        } catch { /* start from empty */ }
      }
      if (agentName) cfg.agent = { name: agentName }
      else delete cfg.agent

      db.upsertChannelPlugin({
        id: pluginId,
        type: String(row.type),
        name: String(row.name),
        enabled: Number(row.enabled) ? 1 : 0,
        status: String(row.status),
        credentials_json: typeof row.credentials_json === 'string' ? row.credentials_json : null,
        config_json: JSON.stringify(cfg),
        last_connected: typeof row.last_connected === 'number' ? row.last_connected : null,
        user_id: userId,
        org_id: row.org_id ? String(row.org_id) : orgId,
      })
      return { ok: true }
    },

    /**
     * POST /api/v1/channels/settings/sync
     */
    syncChannelSettings: async (
      orgId: string,
      userId: string,
      body: {
        platform: string
        /** Target connection; omitted by older clients, which only ever had one per type. */
        pluginId?: string
        agent?: { backend: string; customAgentId?: string; name?: string }
        model?: { id: string; useModel: string }
      }
    ) => {
      console.log(`[ChannelsAPI] syncChannelSettings called: platform=${body.platform}`)

      const manager = getChannelManager()
      if (!manager.isInitialized()) {
        return { ok: false, message: 'ChannelManager not initialized' }
      }

      const sessionManager = manager.getSessionManager()
      if (sessionManager) {
        const cleared = sessionManager.clearAllSessions()
        console.log(`[ChannelsAPI] Cleared ${cleared} sessions for settings sync`)
      }

      const { platform, agent, model } = body
      // Settings belong to one connection; fall back to the type's first connection for
      // older clients that only send a platform.
      const pluginId = body.pluginId || defaultPluginId(platform)
      const existing = db.getChannelPlugin(pluginId, userId)

      if (existing) {
        const config = existing.config_json ? JSON.parse(String(existing.config_json)) : {}
        if (agent) {
          config.agent = agent
        }
        if (model) {
          config.defaultModel = model
        }
        db.upsertChannelPlugin({
          id: pluginId,
          type: String(existing.type),
          name: String(existing.name),
          enabled: Boolean(existing.enabled) ? 1 : 0,
          status: String(existing.status),
          credentials_json: existing.credentials_json,
          config_json: JSON.stringify(config),
          last_connected: existing.last_connected ? Number(existing.last_connected) : null,
          user_id: userId,
          org_id: orgId,
        })
      }

      return { ok: true }
    },

    /**
     * POST /api/v1/channels/wechat/qr-start
     */
    startWechatQrLogin: async () => {
      try {
        const { WeChatApiClient } = await import('../../channels/plugins/wechat/WeChatApiClient.js')
        const client = new WeChatApiClient('')
        const response = await client.startQrLogin()
        if (!response.qrcode || !response.qrcode_img_content) {
          return { ok: false, error: response.errmsg || 'Failed to get QR code' }
        }
        return { ok: true, qrcode: response.qrcode, qrcodeImgContent: response.qrcode_img_content }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error('[ChannelsAPI] startWechatQrLogin error:', msg)
        return { ok: false, error: msg }
      }
    },

    /**
     * GET /api/v1/channels/wechat/qr-poll?qrcode=xxx
     */
    pollWechatQrStatus: async (qrcodeToken: string) => {
      try {
        const { WeChatApiClient } = await import('../../channels/plugins/wechat/WeChatApiClient.js')
        const client = new WeChatApiClient('')
        const response = await client.pollQrStatus(qrcodeToken)
        return {
          ok: true,
          status: response.status,
          botToken: response.bot_token,
          accountId: response.ilink_bot_id,
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return { ok: false, error: msg }
      }
    },
  }

  return channelsApi
}

export type ChannelsApi = ReturnType<typeof createChannelsApi>

type PluginType = 'telegram' | 'lark' | 'dingtalk' | 'wechat' | 'wecom'
