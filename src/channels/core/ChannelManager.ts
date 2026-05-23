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
import type { IChannelPluginConfig, IChannelPluginStatus, PluginType } from '../types.js';
import type { PluginMessageHandler } from '../plugins/BasePlugin.js';

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
  private initialized: boolean = false;

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
  initialize(db: DirectConnectStore): void {
    if (this.initialized) {
      console.log('[ChannelManager] Already initialized');
      return;
    }

    this.db = db;
    this.provider = new LocalChannelProvider(db);
    this.sessionManager = new SessionManager(db);
    this.pluginManager = new PluginManager(this.sessionManager, db);

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
  }

  /**
   * Stop all plugins
   */
  async stopAllPlugins(): Promise<void> {
    if (this.pluginManager) {
      await this.pluginManager.stopAll();
    }
  }

  /**
   * Enable a plugin
   */
  async enablePlugin(pluginId: string, credentials: Record<string, any>, config?: Record<string, any>, userId?: string, orgId?: string): Promise<{ success: boolean; error?: string }> {
    if (!this.db || !this.pluginManager) {
      return { success: false, error: 'ChannelManager not initialized' };
    }

    try {
      // Get existing plugin config or create new one (scoped by userId)
      const existing = userId ? this.db.getChannelPlugin(pluginId, userId) : this.db.getChannelPlugin(pluginId);

      const pluginType = this.extractPluginType(pluginId);

      // Preserve existing credentials if incoming credentials are empty
      let finalCredentials = credentials;
      if (!credentials || Object.values(credentials).every(v => v === undefined || v === '')) {
        if (existing?.credentials_json) {
          try {
            const parsed = JSON.parse(String(existing.credentials_json));
            if (parsed && Object.keys(parsed).length > 0) {
              finalCredentials = parsed;
            }
          } catch { /* keep incoming credentials */ }
        }
      }

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

      // Save to database with user_id for isolation
      const effectiveUserId = userId || (existing?.user_id ? String(existing.user_id) : '');
      if (!effectiveUserId) {
        return { success: false, error: 'userId is required for enterprise mode' };
      }
      this.db.upsertChannelPlugin({
        id: pluginConfig.id,
        type: pluginConfig.type,
        name: pluginConfig.name,
        enabled: 1,
        status: 'stopped',
        credentials_json: JSON.stringify(finalCredentials),
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
    const knownTypes = ['telegram', 'lark', 'dingtalk', 'wechat', 'wecom'];
    for (const type of knownTypes) {
      if (pluginId.startsWith(type)) {
        return type;
      }
    }
    return pluginId;
  }
}

export function getChannelManager(): ChannelManager {
  return ChannelManager.getInstance();
}

export { ChannelManager };
