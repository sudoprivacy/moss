/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DirectConnectStore } from '../../server/db.js';
import type { IChannelPluginConfig, PluginStatus, IChannelUser, PluginType, IChannelPairingRequest } from '../types.js';

/**
 * IChannelProvider - Interface for channel data operations
 */
export interface IChannelProvider {
  // Plugin management
  getPlugins(): Promise<IChannelPluginConfig[]>;
  getPlugin(pluginId: string): Promise<IChannelPluginConfig | null>;
  upsertPlugin(plugin: IChannelPluginConfig): Promise<boolean>;
  updatePluginStatus(pluginId: string, status: PluginStatus, lastConnected?: number): Promise<boolean>;
  updatePluginEnabled(pluginId: string, enabled: boolean, status: PluginStatus): Promise<boolean>;
  deletePlugin(pluginId: string): Promise<boolean>;

  // User management
  getUsers(): Promise<IChannelUser[]>;
  getUserByPlatform(platformUserId: string, platformType: PluginType): Promise<IChannelUser | null>;
  deleteUser(userId: string): Promise<boolean>;
  deleteUsersByPlatform(platformType: string): Promise<number>;

  // Pairing management
  getPendingPairingRequests(): Promise<IChannelPairingRequest[]>;
  approvePairing(code: string): Promise<{ success: boolean; error?: string; user?: IChannelUser }>;
  rejectPairing(code: string): Promise<{ success: boolean; error?: string }>;

  // Connection testing
  testConnection(pluginId: string, credentials: Record<string, any>): Promise<{ success: boolean; botUsername?: string; error?: string }>;
}

/**
 * LocalChannelProvider - Implementation using Moss's DirectConnectStore
 */
export class LocalChannelProvider implements IChannelProvider {
  constructor(private db: DirectConnectStore) {}

  async getPlugins(): Promise<IChannelPluginConfig[]> {
    const rows = this.db.listChannelPlugins();
    return rows.map((row) => this.mapPluginRow(row));
  }

  async getPlugin(pluginId: string): Promise<IChannelPluginConfig | null> {
    const row = this.db.getChannelPlugin(pluginId);
    return row ? this.mapPluginRow(row) : null;
  }

  async upsertPlugin(plugin: IChannelPluginConfig): Promise<boolean> {
    try {
      this.db.upsertChannelPlugin({
        id: plugin.id,
        type: plugin.type,
        name: plugin.name,
        enabled: plugin.enabled ? 1 : 0,
        status: plugin.status,
        credentials_json: plugin.credentials ? JSON.stringify(plugin.credentials) : null,
        config_json: plugin.config ? JSON.stringify(plugin.config) : null,
        last_connected: plugin.lastConnected ?? null,
      });
      return true;
    } catch {
      return false;
    }
  }

  async updatePluginStatus(pluginId: string, status: PluginStatus, lastConnected?: number): Promise<boolean> {
    try {
      this.db.updateChannelPluginStatus(pluginId, status, lastConnected);
      return true;
    } catch {
      return false;
    }
  }

  async updatePluginEnabled(pluginId: string, enabled: boolean, status: PluginStatus): Promise<boolean> {
    try {
      // Update the plugin with enabled status
      const existing = this.db.getChannelPlugin(pluginId);
      if (existing) {
        this.db.upsertChannelPlugin({
          id: pluginId,
          type: String(existing.type),
          name: String(existing.name),
          enabled: enabled ? 1 : 0,
          status: status,
          credentials_json: typeof existing.credentials_json === 'string' ? existing.credentials_json : null,
          config_json: typeof existing.config_json === 'string' ? existing.config_json : null,
          last_connected: typeof existing.last_connected === 'number' ? existing.last_connected : null,
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  async deletePlugin(pluginId: string): Promise<boolean> {
    try {
      // Disable the plugin first (mark as disabled)
      const existing = this.db.getChannelPlugin(pluginId);
      if (existing) {
        this.db.upsertChannelPlugin({
          id: pluginId,
          type: String(existing.type),
          name: String(existing.name),
          enabled: 0,
          status: 'stopped',
          credentials_json: null,
          config_json: null,
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  async getUsers(): Promise<IChannelUser[]> {
    const rows = this.db.listChannelUsers();
    return rows.map((row) => this.mapUserRow(row));
  }

  async getUserByPlatform(platformUserId: string, platformType: PluginType): Promise<IChannelUser | null> {
    const row = this.db.getChannelUserByPlatform(platformUserId, platformType);
    return row ? this.mapUserRow(row) : null;
  }

  async deleteUser(userId: string): Promise<boolean> {
    try {
      this.db.deleteChannelUser(userId);
      return true;
    } catch {
      return false;
    }
  }

  async deleteUsersByPlatform(platformType: string): Promise<number> {
    try {
      return this.db.deleteChannelUsersByPlatform(platformType);
    } catch {
      return 0;
    }
  }

  async getPendingPairingRequests(): Promise<IChannelPairingRequest[]> {
    const rows = this.db.listPendingPairingRequests();
    return rows.map((row) => this.mapPairingRow(row));
  }

  async approvePairing(code: string): Promise<{ success: boolean; error?: string; user?: IChannelUser }> {
    const row = this.db.getPairingRequest(code);
    if (!row) {
      return { success: false, error: 'Invalid pairing code' };
    }

    if (String(row.status) !== 'pending') {
      return { success: false, error: 'Pairing code already used' };
    }

    if (Number(row.expires_at) < Date.now()) {
      return { success: false, error: 'Pairing code expired' };
    }

    // Create user
    const userId = `cu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const user: IChannelUser = {
      id: userId,
      platformUserId: String(row.platform_user_id),
      platformType: String(row.platform_type) as PluginType,
      displayName: row.display_name ? String(row.display_name) : undefined,
      authorizedAt: Date.now(),
    };

    this.db.upsertChannelUser({
      id: user.id,
      platform_user_id: user.platformUserId,
      platform_type: user.platformType,
      display_name: user.displayName ?? null,
      authorized_at: user.authorizedAt,
      last_active: null,
      session_id: null,
      org_id: null,
      user_id: null,
    });

    // Update pairing status
    this.db.updatePairingRequestStatus(code, 'approved');

    return { success: true, user };
  }

  async rejectPairing(code: string): Promise<{ success: boolean; error?: string }> {
    const row = this.db.getPairingRequest(code);
    if (!row) {
      return { success: false, error: 'Invalid pairing code' };
    }

    this.db.updatePairingRequestStatus(code, 'rejected');
    return { success: true };
  }

  async testConnection(pluginId: string, credentials: Record<string, any>): Promise<{ success: boolean; botUsername?: string; error?: string }> {
    const type = this.getPluginTypeFromId(pluginId);

    // Lark: use actual testConnection from LarkPlugin
    if (type === 'lark') {
      const { LarkPlugin } = await import('../plugins/lark/LarkPlugin.js');
      const result = await LarkPlugin.testConnection(credentials.appId, credentials.appSecret);
      return { success: result.success, botUsername: result.botUsername, error: result.error };
    }

    // Telegram: use actual testConnection from TelegramPlugin
    if (type === 'telegram') {
      const { TelegramPlugin } = await import('../plugins/telegram/TelegramPlugin.js');
      const token = credentials.botToken || credentials.token;
      if (!token) return { success: false, error: 'Bot token required' };
      const result = await TelegramPlugin.testConnection(token);
      return { success: result.success, botUsername: result.botInfo?.username, error: result.error };
    }

    // DingTalk: use actual testConnection from DingTalkPlugin
    if (type === 'dingtalk') {
      const { DingTalkPlugin } = await import('../plugins/dingtalk/DingTalkPlugin.js');
      const result = await DingTalkPlugin.testConnection(credentials.clientId, credentials.clientSecret);
      return { success: result.success, botUsername: result.botInfo?.name, error: result.error };
    }

    // WeChat: use actual testConnection from WeChatPlugin
    if (type === 'wechat') {
      const { WeChatPlugin } = await import('../plugins/wechat/WeChatPlugin.js');
      const result = await WeChatPlugin.testConnection(credentials.token, credentials.botApiBaseUrl);
      return { success: result.success, botUsername: result.botInfo?.username, error: result.error };
    }

    // WeCom: use actual testConnection from WeComPlugin
    if (type === 'wecom') {
      const { WeComPlugin } = await import('../plugins/wecom/WeComPlugin.js');
      const result = await WeComPlugin.testConnection(credentials.botId, credentials.secret);
      return { success: result.success, botUsername: result.botInfo?.name, error: result.error };
    }

    return { success: true };
  }

  private getPluginTypeFromId(pluginId: string): string {
    if (pluginId.startsWith('telegram')) return 'telegram';
    if (pluginId.startsWith('lark')) return 'lark';
    if (pluginId.startsWith('dingtalk')) return 'dingtalk';
    if (pluginId.startsWith('wechat')) return 'wechat';
    if (pluginId.startsWith('wecom')) return 'wecom';
    return pluginId;
    return pluginId;
  }

  private mapPluginRow(row: Record<string, unknown>): IChannelPluginConfig {
    return {
      id: String(row.id),
      type: String(row.type) as PluginType,
      name: String(row.name),
      enabled: Boolean(row.enabled),
      status: String(row.status) as PluginStatus,
      credentials: row.credentials_json ? JSON.parse(String(row.credentials_json)) : undefined,
      config: row.config_json ? JSON.parse(String(row.config_json)) : undefined,
      lastConnected: row.last_connected ? Number(row.last_connected) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private mapUserRow(row: Record<string, unknown>): IChannelUser {
    return {
      id: String(row.id),
      platformUserId: String(row.platform_user_id),
      platformType: String(row.platform_type) as PluginType,
      displayName: row.display_name ? String(row.display_name) : undefined,
      authorizedAt: Number(row.authorized_at),
      lastActive: row.last_active ? Number(row.last_active) : undefined,
      sessionId: row.session_id ? String(row.session_id) : undefined,
    };
  }

  private mapPairingRow(row: Record<string, unknown>): IChannelPairingRequest {
    return {
      code: String(row.code),
      platformUserId: String(row.platform_user_id),
      platformType: String(row.platform_type) as PluginType,
      displayName: row.display_name ? String(row.display_name) : undefined,
      requestedAt: Number(row.requested_at),
      expiresAt: Number(row.expires_at),
      status: String(row.status) as any,
    };
  }
}
