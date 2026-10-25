import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { AuthContext } from './auth/token.js'
import { hasScope } from './auth/token.js'
import { ResourceAccessError } from './catalog/resourceError.js'
import { isUniqueViolation, type DbDriver, type SqlRow } from './db/driver.js'
import type { IdentityRepository } from './identity/identityRepository.js'
import type { MossAgentAccess } from './mossAgentAccess.js'
import { mossAgentName } from './agentIdentity.js'
import type { IUnifiedIncomingMessage } from '../channels/types.js'

const PROVIDER = 'feishu-moss'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export const MOSS_IM_IDENTITY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS moss_im_connections (
    plugin_id TEXT NOT NULL, connection_owner_id TEXT NOT NULL, org_id TEXT NOT NULL,
    app_id TEXT NOT NULL, tenant_key TEXT NOT NULL, revision TEXT NOT NULL,
    updated_by TEXT NOT NULL, updated_at BIGINT NOT NULL,
    PRIMARY KEY (plugin_id, connection_owner_id)
  );
  CREATE TABLE IF NOT EXISTS moss_im_link_challenges (
    digest TEXT PRIMARY KEY, org_id TEXT NOT NULL, connection_scope TEXT NOT NULL,
    plugin_id TEXT NOT NULL, connection_owner_id TEXT NOT NULL, platform_user_id TEXT NOT NULL,
    expires_at BIGINT NOT NULL, claimed_by TEXT, created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS moss_im_challenge_sender_idx
    ON moss_im_link_challenges (connection_scope, platform_user_id, created_at);
  CREATE TABLE IF NOT EXISTS moss_im_conversations (
    conversation_key TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
    agent_ref TEXT NOT NULL, connection_scope TEXT NOT NULL, chat_id TEXT NOT NULL,
    session_id TEXT NOT NULL, updated_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS moss_im_deliveries (
    connection_scope TEXT NOT NULL, message_id TEXT NOT NULL, platform_user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL, user_id TEXT, agent_ref TEXT, session_id TEXT,
    status TEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
    PRIMARY KEY (connection_scope, message_id)
  );
`

export interface MossImConnection {
  orgId: string
  ownerId: string
  pluginId: string
  appId: string
  tenantKey: string
  scope: string
}

export interface VerifiedMossImMessage {
  senderId: string
  messageId: string
  chatId: string
}

export interface MossImRoute {
  connection: MossImConnection
  userId: string
  role: string
  agentRef: string
  bindingId: string
  senderId: string
  scopes: string[]
}

/** Only stable SDK identities from the configured tenant are accepted. */
export function verifyMossLarkMessage(message: IUnifiedIncomingMessage, connection: MossImConnection): VerifiedMossImMessage {
  const raw = message.raw as { event?: {
    sender?: { sender_type?: unknown; tenant_key?: unknown; sender_id?: { user_id?: unknown; open_id?: unknown } }
    message?: { message_id?: unknown; chat_id?: unknown; chat_type?: unknown }
  } } | undefined
  const sender = raw?.event?.sender
  const event = raw?.event?.message
  const unifiedSenderId = sender?.sender_id?.user_id || sender?.sender_id?.open_id
  // open_id is stable within the pinned app and remains available when
  // employee-ID visibility changes. Preserve the legacy adapter normalization.
  const senderId = sender?.sender_id?.open_id || unifiedSenderId
  if (message.platform !== 'lark' || sender?.sender_type !== 'user' || sender.tenant_key !== connection.tenantKey ||
      typeof senderId !== 'string' || !senderId || senderId.length > 256 || unifiedSenderId !== message.user.id ||
      typeof event?.message_id !== 'string' || !event.message_id || event.message_id.length > 256 || event.message_id !== message.id ||
      typeof event.chat_id !== 'string' || !event.chat_id || event.chat_id !== message.chatId ||
      !['group', 'p2p'].includes(String(event.chat_type))) {
    throw new ResourceAccessError(403, 'Verified Feishu member message required')
  }
  return { senderId, messageId: event.message_id, chatId: event.chat_id }
}

/** Human binding and IM pointers share the existing identity database. */
export class MossImIdentity {
  constructor(private readonly driver: DbDriver, private readonly identities: IdentityRepository,
    private readonly access: MossAgentAccess, private readonly scopesForRole: (role: string) => string[]) {}

  async initialize(): Promise<void> { await this.driver.exec(MOSS_IM_IDENTITY_SCHEMA) }

  async connection(pluginId: string, ownerId: string, actualAppId?: string): Promise<MossImConnection | null> {
    const row = await this.driver.get<SqlRow>('SELECT * FROM channel_plugins WHERE id = ? AND user_id = ?', [pluginId, ownerId])
    if (!row) throw new ResourceAccessError(403, 'Channel connection is not available')
    const pins = await this.driver.get<SqlRow>('SELECT * FROM moss_im_connections WHERE plugin_id = ? AND connection_owner_id = ?', [pluginId, ownerId])
    if (!pins) {
      const config = JSON.parse(String(row.config_json || '{}')) as Record<string, unknown>
      if (config.identityMode && config.identityMode !== 'owner') throw new ResourceAccessError(403, 'Administrator Moss connection registration required')
      return null
    }
    // Owner-editable channel options cannot enable, downgrade or replace the
    // administrator's member identity configuration.
    const appId = pins.app_id, tenantKey = pins.tenant_key, revision = pins.revision
    if (pins.org_id !== row.org_id || row.type !== 'lark' || Number(row.enabled) !== 1 ||
        typeof tenantKey !== 'string' || !tenantKey || typeof revision !== 'string' || !revision ||
        typeof appId !== 'string' || !appId.startsWith('cli_') ||
        (actualAppId !== undefined && appId !== actualAppId)) {
      throw new ResourceAccessError(403, 'Moss member connection configuration is not valid')
    }
    const orgId = String(row.org_id || '')
    if (!orgId) throw new ResourceAccessError(403, 'Channel organization is not available')
    const owner = await this.driver.get<SqlRow>('SELECT org_id, status FROM users WHERE id = ?', [ownerId])
    if (!owner || owner.org_id !== orgId || owner.status !== 'active') throw new ResourceAccessError(403, 'Channel owner membership changed')
    const scope = JSON.stringify([orgId, ownerId, pluginId, tenantKey, appId, revision])
    return { orgId, ownerId, pluginId, tenantKey, appId, scope }
  }

  private async current(connection: MossImConnection): Promise<void> {
    const live = await this.connection(connection.pluginId, connection.ownerId)
    if (live?.scope !== connection.scope) throw new ResourceAccessError(403, 'Channel identity configuration changed')
  }

  private async human(auth: AuthContext): Promise<void> {
    const user = await this.driver.get<SqlRow>('SELECT org_id, status FROM users WHERE id = ?', [auth.userId])
    if (!['moss', 'sudowork'].includes(auth.authApp ?? '') || !user || user.org_id !== auth.orgId || user.status !== 'active') {
      throw new ResourceAccessError(403, 'Current human organization login required')
    }
  }

  async issueChallenge(connection: MossImConnection, senderId: string): Promise<string | null> {
    await this.current(connection)
    return this.driver.transaction(async () => {
      const recent = await this.driver.get<SqlRow>(`SELECT digest FROM moss_im_link_challenges
        WHERE connection_scope = ? AND platform_user_id = ? AND created_at > ? LIMIT 1`, [connection.scope, senderId, Date.now() - 60_000])
      if (recent) return null
      const code = randomBytes(24).toString('base64url')
      await this.driver.run(`INSERT INTO moss_im_link_challenges
        (digest, org_id, connection_scope, plugin_id, connection_owner_id, platform_user_id, expires_at, claimed_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`, [digest(code), connection.orgId, connection.scope,
        connection.pluginId, connection.ownerId, senderId, Date.now() + 600_000, Date.now()])
      return code
    })
  }

  async bind(auth: AuthContext, code: string): Promise<void> {
    await this.human(auth)
    if (!['moss', 'sudowork'].includes(auth.authApp ?? '') || !/^[A-Za-z0-9_-]{32}$/.test(code)) {
      throw new ResourceAccessError(403, 'Human login and private binding code required')
    }
    await this.access.requireUser(auth.orgId, auth.userId)
    await this.driver.transaction(async () => {
      const proof = await this.driver.get<SqlRow>('SELECT * FROM moss_im_link_challenges WHERE digest = ?', [digest(code)])
      if (!proof || proof.org_id !== auth.orgId || proof.claimed_by || Number(proof.expires_at) <= Date.now()) {
        throw new ResourceAccessError(403, 'Binding code is unavailable or expired')
      }
      const connection = await this.connection(String(proof.plugin_id), String(proof.connection_owner_id))
      if (!connection || connection.scope !== proof.connection_scope) throw new ResourceAccessError(403, 'Channel identity configuration changed')
      const linked = await this.identities.findAuthIdentity(PROVIDER, connection.scope, String(proof.platform_user_id))
      const own = await this.identities.findAuthIdentityByUser(auth.userId, PROVIDER, connection.scope)
      if ((linked && linked.userId !== auth.userId) || (own && own.normalizedSubject !== proof.platform_user_id)) {
        throw new ResourceAccessError(409, 'Account binding already exists; explicit unlink is required')
      }
      const claimed = await this.driver.run(`UPDATE moss_im_link_challenges SET claimed_by = ?
        WHERE digest = ? AND claimed_by IS NULL AND expires_at > ?`, [auth.userId, digest(code), Date.now()])
      if (claimed !== 1) throw new ResourceAccessError(409, 'Binding code was already used')
      if (!linked) await this.identities.createAuthIdentity({ id: randomUUID(), orgId: auth.orgId, userId: auth.userId,
        provider: PROVIDER, issuer: connection.scope, normalizedSubject: String(proof.platform_user_id),
        metadata: { pluginId: connection.pluginId, connectionOwnerId: connection.ownerId, appId: connection.appId } })
    }).catch(error => {
      if (isUniqueViolation(error)) throw new ResourceAccessError(409, 'Account binding already exists; explicit unlink is required')
      throw error
    })
  }

  async bindings(auth: AuthContext): Promise<SqlRow[]> {
    await this.human(auth)
    const rows = await this.driver.all(`SELECT id, issuer, normalized_subject AS sender_id, metadata_json FROM user_auth_identities
      WHERE user_id = ? AND org_id = ? AND provider = ?`, [auth.userId, auth.orgId, PROVIDER])
    return Promise.all(rows.map(async row => {
      const metadata = JSON.parse(String(row.metadata_json))
      const connection = await this.connection(String(metadata.pluginId), String(metadata.connectionOwnerId)).catch(() => null)
      return { id: String(row.id), senderId: String(row.sender_id), pluginId: String(metadata.pluginId),
        appId: String(metadata.appId), isCurrent: connection?.scope === row.issuer }
    }))
  }

  async unlink(auth: AuthContext, bindingId: string): Promise<void> {
    await this.human(auth)
    const changed = await this.driver.run('DELETE FROM user_auth_identities WHERE id = ? AND user_id = ? AND org_id = ? AND provider = ?',
      [bindingId, auth.userId, auth.orgId, PROVIDER])
    if (!changed) throw new ResourceAccessError(404, 'Binding not available')
  }

  async resolve(connection: MossImConnection, senderId: string): Promise<MossImRoute | null> {
    await this.current(connection)
    const binding = await this.identities.findAuthIdentity(PROVIDER, connection.scope, senderId)
    if (!binding) return null
    if (binding.orgId !== connection.orgId) throw new ResourceAccessError(403, 'Binding organization changed')
    const member = await this.access.requireUser(connection.orgId, binding.userId)
    return { connection, senderId, bindingId: binding.id, userId: member.id, role: member.role,
      agentRef: mossAgentName(connection.orgId, member.id), scopes: this.scopesForRole(member.role) }
  }

  async assertRoute(route: MossImRoute): Promise<void> {
    const current = await this.resolve(route.connection, route.senderId)
    if (!current || current.bindingId !== route.bindingId || current.userId !== route.userId || current.role !== route.role) {
      throw new ResourceAccessError(403, 'Moss member binding or permissions changed')
    }
  }

  conversationKey(route: MossImRoute, chatId: string): string {
    return 'moss-im:' + digest(JSON.stringify([route.connection.scope, route.agentRef, chatId]))
  }

  async pointer(route: MossImRoute, chatId: string): Promise<string | null> {
    const row = await this.driver.get<SqlRow>('SELECT session_id FROM moss_im_conversations WHERE conversation_key = ?', [this.conversationKey(route, chatId)])
    return row ? String(row.session_id) : null
  }

  async setPointer(route: MossImRoute, chatId: string, sessionId: string, previous: string | null): Promise<void> {
    await this.assertRoute(route)
    const key = this.conversationKey(route, chatId)
    const changed = previous === null
      ? await this.driver.run(`INSERT INTO moss_im_conversations
        (conversation_key, org_id, user_id, agent_ref, connection_scope, chat_id, session_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (conversation_key) DO NOTHING`,
      [key, route.connection.orgId, route.userId, route.agentRef, route.connection.scope, chatId, sessionId, Date.now()])
      : await this.driver.run(`UPDATE moss_im_conversations SET session_id = ?, updated_at = ?
        WHERE conversation_key = ? AND session_id = ?`, [sessionId, Date.now(), key, previous])
    if (changed !== 1) throw new ResourceAccessError(409, 'IM conversation changed; no input was sent')
  }

  async claim(connection: MossImConnection, event: VerifiedMossImMessage): Promise<boolean> {
    const changed = await this.driver.run(`INSERT INTO moss_im_deliveries
      (connection_scope, message_id, platform_user_id, chat_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'claimed', ?, ?) ON CONFLICT (connection_scope, message_id) DO NOTHING`,
    [connection.scope, event.messageId, event.senderId, event.chatId, Date.now(), Date.now()])
    return changed === 1
  }

  async delivery(connection: MossImConnection, messageId: string, status: 'completed' | 'failed' | 'dispatching' | 'unknown', route?: MossImRoute, sessionId?: string): Promise<void> {
    await this.driver.run(`UPDATE moss_im_deliveries SET status = ?, user_id = ?, agent_ref = ?, session_id = ?, updated_at = ?
      WHERE connection_scope = ? AND message_id = ?`,
    [status, route?.userId ?? null, route?.agentRef ?? null, sessionId ?? null, Date.now(), connection.scope, messageId])
  }

  async configure(auth: AuthContext, pluginId: string, ownerId: string, appId: string, tenantKey: string): Promise<void> {
    const actor = await this.driver.get<SqlRow>('SELECT role, status, org_id FROM users WHERE id = ?', [auth.userId])
    if (!actor || actor.status !== 'active' || !['admin', 'super_admin'].includes(String(actor.role)) ||
        (actor.org_id !== auth.orgId && actor.role !== 'super_admin') || !hasScope(auth.scopes, 'admin:users')) {
      throw new ResourceAccessError(403, 'Organization administrator required')
    }
    if (!/^cli_[a-zA-Z0-9]+$/.test(appId) || !/^[a-zA-Z0-9_-]{8,128}$/.test(tenantKey)) {
      throw new ResourceAccessError(400, 'Pinned Feishu app and tenant identities required')
    }
    await this.driver.transaction(async () => {
      const row = await this.driver.get<SqlRow>('SELECT * FROM channel_plugins WHERE id = ? AND user_id = ? AND org_id = ?', [pluginId, ownerId, auth.orgId])
      if (!row || row.type !== 'lark') throw new ResourceAccessError(404, 'Feishu connection not available')
      await this.driver.run(`INSERT INTO moss_im_connections
        (plugin_id, connection_owner_id, org_id, app_id, tenant_key, revision, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (plugin_id, connection_owner_id) DO UPDATE SET
          revision = CASE WHEN moss_im_connections.org_id = excluded.org_id
            AND moss_im_connections.app_id = excluded.app_id AND moss_im_connections.tenant_key = excluded.tenant_key
            THEN moss_im_connections.revision ELSE excluded.revision END,
          org_id = excluded.org_id, app_id = excluded.app_id, tenant_key = excluded.tenant_key,
          updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [pluginId, ownerId, auth.orgId, appId, tenantKey, randomUUID(), auth.userId, Date.now()])
    })
  }
}
