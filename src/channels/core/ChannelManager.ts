/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

import { LocalChannelProvider } from './IChannelProvider.js';
import { SessionManager } from './SessionManager.js';
import { PluginManager } from '../gateway/PluginManager.js';
import type { IChannelProvider } from './IChannelProvider.js';
import type { DirectConnectStore } from '../../server/db.js';
import type { NexusClient } from '../../server/nexus/nexusClient.js';
import type { IChannelPluginConfig, IChannelPluginStatus, PluginType } from '../types.js';
import { channelCredentialIdentity, pluginTypeFromId } from '../types.js';
import {
  persistChannelSecrets,
  fillMissingSecrets,
  hydrateChannelSecrets,
  deleteChannelSecrets,
  stripChannelSecretsForClient,
  stripInternalMeta,
} from './channelCredentialSecrets.js';
import type { PluginMessageHandler } from '../plugins/BasePlugin.js';

/** Human-readable channel names for user-facing errors. */
const PLUGIN_TYPE_LABELS: Record<string, string> = {
  telegram: 'Telegram Bot',
  lark: '飞书 Bot',
  dingtalk: '钉钉 Bot',
  wechat: '个人微信 Bot',
  wecom: '企业微信 Bot',
};

/**
 * ChannelManager - Full orchestrator for Moss Server
 *
 * In Moss, we manage the full channel lifecycle including:
 * - Plugin lifecycle management
 * - Session management
 * - Message routing
 */
class ChannelManager {
  private static instance: ChannelManager | null = null;
  private provider: IChannelProvider | null = null;
  private sessionManager: SessionManager | null = null;
  private pluginManager: PluginManager | null = null;
  private db: DirectConnectStore | null = null;
  private nexus: NexusClient | null = null;
  private initialized: boolean = false;
  private staleSweepTimer: ReturnType<typeof setInterval> | null = null;

  /** How often to sweep stale channel_sessions rows. */
  private static readonly STALE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

  private constructor() {}

  static getInstance(): ChannelManager {
    if (!ChannelManager.instance) {
      ChannelManager.instance = new ChannelManager();
    }
    return ChannelManager.instance;
  }

  /**
   * Initialize with database reference
   */
  initialize(db: DirectConnectStore, nexus?: NexusClient | null): void {
    if (this.initialized) {
      console.log('[ChannelManager] Already initialized');
      return;
    }

    this.db = db;
    this.nexus = nexus ?? null;
    this.provider = new LocalChannelProvider(db);
    this.sessionManager = new SessionManager(db);
    this.pluginManager = new PluginManager(this.sessionManager, db, this.nexus);

    this.initialized = true;
    console.log('[ChannelManager] Initialized');
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the channel provider
   */
  getProvider(): IChannelProvider {
    if (!this.provider) {
      throw new Error('ChannelManager not initialized. Call initialize() first.');
    }
    return this.provider;
  }

  /**
   * Get the session manager
   */
  getSessionManager(): SessionManager | null {
    return this.sessionManager;
  }

  /**
   * Get the plugin manager
   */
  getPluginManager(): PluginManager | null {
    return this.pluginManager;
  }

  /**
   * Set message handler for plugins
   */
  setMessageHandler(handler: PluginMessageHandler): void {
    if (this.pluginManager) {
      this.pluginManager.setMessageHandler(handler);
    }
  }

  /**
   * Start all enabled plugins
   */
  async startEnabledPlugins(): Promise<void> {
    if (!this.pluginManager) {
      throw new Error('ChannelManager not initialized');
    }

    console.log('[ChannelManager] Starting enabled plugins...');
    await this.pluginManager.startEnabledPlugins();
    this.startStaleSessionSweep();
  }

  /**
   * Stop all plugins
   */
  async stopAllPlugins(): Promise<void> {
    if (this.staleSweepTimer) {
      clearInterval(this.staleSweepTimer);
      this.staleSweepTimer = null;
    }
    if (this.pluginManager) {
      await this.pluginManager.stopAll();
    }
  }

  /**
   * Periodically drop channel_sessions rows that have gone untouched past the TTL.
   * cleanupStaleSessions() has existed since the SessionManager was written but was
   * never scheduled, so these rows accumulated indefinitely. Routing bookkeeping
   * only — dropping a row does not terminate a runtime session, it just means the
   * next message from that chat starts fresh.
   */
  private startStaleSessionSweep(): void {
    if (this.staleSweepTimer) return;
    this.staleSweepTimer = setInterval(() => {
      try {
        this.cleanupStaleSessions();
      } catch (error) {
        console.warn('[ChannelManager] stale session sweep failed:', error);
      }
    }, ChannelManager.STALE_SWEEP_INTERVAL_MS);
    // Never hold the process open just for the sweep.
    this.staleSweepTimer.unref?.();
  }

  /**
   * Enable a plugin
   */
  async enablePlugin(pluginId: string, credentials: Record<string, any>, config?: Record<string, any>, userId?: string, orgId?: string): Promise<{ success: boolean; error?: string }> {
    if (!this.db || !this.pluginManager) {
      return { success: false, error: 'ChannelManager not initialized' };
    }
    if (!this.nexus) {
      return { success: false, error: '密钥存储服务(Nexus)不可用，无法保存 IM 凭据' };
    }

    try {
      // Get existing plugin config or create new one (scoped by userId)
      const existing = userId ? this.db.getChannelPlugin(pluginId, userId) : this.db.getChannelPlugin(pluginId);

      const pluginType = this.extractPluginType(pluginId);

      // effectiveUserId is needed for the Nexus namespace, so compute it before filling secrets.
      const effectiveUserId = userId || (existing?.user_id ? String(existing.user_id) : '');
      if (!effectiveUserId) {
        return { success: false, error: 'userId is required for enterprise mode' };
      }

      // Build the full plaintext credentials in memory. Sensitive fields live ONLY in Nexus:
      // start from existing NON-sensitive fields (stripping any legacy plaintext residue and
      // internal meta), overlay the incoming values, then fill missing sensitive fields from
      // Nexus only (undefined = not sent, e.g. one-click enable; empty string = user cleared).
      const existingCreds: Record<string, any> = existing?.credentials_json
        ? JSON.parse(String(existing.credentials_json))
        : {};
      const { credentials: existingNonSensitive } = stripChannelSecretsForClient(pluginType, existingCreds);
      let finalCredentials: Record<string, any> = { ...(existingNonSensitive ?? {}), ...(credentials ?? {}) };
      finalCredentials = await fillMissingSecrets(this.nexus, effectiveUserId, pluginId, pluginType, finalCredentials);

      // Reject a bot identity another user already connected. Two connections to one bot
      // make the IM platform deliver every message twice, so the chat sees duplicate replies.
      const identity = channelCredentialIdentity(pluginType as PluginType, finalCredentials);
      if (identity) {
        // Same user, two connections, one bot: also a duplicate-delivery source now that a
        // user can hold several connections of a type.
        const ownDuplicate = this.db.findOwnChannelPluginWithIdentity({
          type: pluginType,
          identity,
          userId: effectiveUserId,
          excludePluginId: pluginId,
        });
        if (ownDuplicate) {
          const label = PLUGIN_TYPE_LABELS[pluginType] || pluginType;
          return {
            success: false,
            error: `该${label}已在您的连接「${ownDuplicate}」中配置。同一个机器人连接两次会导致消息重复回复，请改用其他机器人。`,
          };
        }

        const effectiveOrgId = orgId || (existing?.org_id ? String(existing.org_id) : null);
        const conflict = this.db.findChannelPluginCredentialOwner({
          type: pluginType,
          identity,
          orgId: effectiveOrgId,
          excludeUserId: effectiveUserId,
        });
        if (conflict) {
          const label = PLUGIN_TYPE_LABELS[pluginType] || pluginType;
          return {
            success: false,
            error: `该${label}已被用户「${conflict.name}」配置，无法重复配置。同一个机器人被多个账号连接会导致消息重复回复。请改用其他机器人，或联系「${conflict.name}」取消其配置。`,
          };
        }
      }

      // Persist sensitive fields to Nexus AFTER dedup passes; get the sanitized copy for the DB.
      const sanitized = await persistChannelSecrets(this.nexus, effectiveUserId, pluginId, pluginType, finalCredentials);

      // Build pluginConfig AFTER filling secrets so its credentials reference the completed
      // object used to start the plugin (in-memory plaintext); the DB row stores sanitized only.
      const pluginConfig: IChannelPluginConfig = {
        id: pluginId,
        type: pluginType as PluginType,
        name: existing ? String(existing.name) : pluginId,
        enabled: true,
        status: 'stopped',
        credentials: finalCredentials,
        config: config || (existing?.config_json ? JSON.parse(String(existing.config_json)) : {}),
        createdAt: existing ? Number(existing.created_at) : Date.now(),
        updatedAt: Date.now(),
      };

      this.db.upsertChannelPlugin({
        id: pluginConfig.id,
        type: pluginConfig.type,
        name: pluginConfig.name,
        enabled: 1,
        status: 'stopped',
        credentials_json: JSON.stringify(sanitized),
        config_json: pluginConfig.config ? JSON.stringify(pluginConfig.config) : null,
        user_id: effectiveUserId,
        org_id: orgId || (existing?.org_id ? String(existing.org_id) : null),
      });

      // Start the plugin (use composite key for per-user instances)
      const instanceKey = `${pluginId}:${effectiveUserId}`;
      await this.pluginManager.startPlugin(pluginConfig, instanceKey);

      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[ChannelManager] Failed to enable plugin ${pluginId}:`, error);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Disable a plugin
   */
  async disablePlugin(pluginId: string, userId?: string): Promise<{ success: boolean; error?: string }> {
    if (!this.db || !this.pluginManager) {
      return { success: false, error: 'ChannelManager not initialized' };
    }

    try {
      const effectiveUserId = userId || '';
      const instanceKey = effectiveUserId ? `${pluginId}:${effectiveUserId}` : pluginId;

      // Stop the plugin
      await this.pluginManager.stopPlugin(instanceKey);

      // Update database
      const existing = userId ? this.db.getChannelPlugin(pluginId, userId) : this.db.getChannelPlugin(pluginId);
      if (existing) {
        this.db.upsertChannelPlugin({
          id: pluginId,
          type: String(existing.type),
          name: String(existing.name),
          enabled: 0,
          status: 'stopped',
          credentials_json: existing.credentials_json,
          config_json: existing.config_json,
          user_id: String(existing.user_id),
        });
      }

      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[ChannelManager] Failed to disable plugin ${pluginId}:`, error);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Test a plugin connection
   */
  async testPlugin(pluginId: string, credentials: Record<string, any>): Promise<{ success: boolean; botUsername?: string; error?: string }> {
    return this.provider!.testConnection(pluginId, credentials);
  }

  /**
   * Get a connection's full plaintext credentials for editing: sensitive fields come ONLY
   * from Nexus (any residue in credentials_json is stripped first), internal meta removed.
   * Returns {} when the row is absent (mirrors the API's empty-form behavior).
   */
  async getHydratedCredentials(pluginId: string, userId: string): Promise<Record<string, any>> {
    if (!this.db || !this.nexus) return {};
    const row = this.db.getChannelPlugin(pluginId, userId);
    if (!row) return {};
    const type = pluginTypeFromId(pluginId);
    const base = row.credentials_json ? JSON.parse(String(row.credentials_json)) : {};
    const hydrated = await hydrateChannelSecrets(this.nexus, userId, pluginId, type, base);
    return (stripInternalMeta(hydrated) ?? {}) as Record<string, any>;
  }

  /** Delete a connection's sensitive secrets from Nexus (on connection removal). */
  async deletePluginSecrets(pluginId: string, userId: string): Promise<void> {
    if (!this.nexus) return;
    await deleteChannelSecrets(this.nexus, userId, pluginId, pluginTypeFromId(pluginId));
  }

  /**
   * Get all plugin statuses
   */
  getPluginStatuses(userId?: string): IChannelPluginStatus[] {
    if (!this.pluginManager) {
      return [];
    }
    return this.pluginManager.getPluginStatuses(userId);
  }

  /**
   * Get a plugin by ID
   */
  getPlugin(pluginId: string) {
    return this.pluginManager?.getPlugin(pluginId);
  }

  /**
   * Cleanup stale sessions
   */
  cleanupStaleSessions(maxAgeMs?: number): number {
    if (!this.sessionManager) {
      return 0;
    }
    return this.sessionManager.cleanupStaleSessions(maxAgeMs);
  }

  /**
   * Extract plugin type from plugin ID
   * e.g., "lark_default" -> "lark", "telegram_main" -> "telegram"
   */
  private extractPluginType(pluginId: string): string {
    return pluginTypeFromId(pluginId);
  }
}

export function getChannelManager(): ChannelManager {
  return ChannelManager.getInstance();
}

export { ChannelManager };
