/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DirectConnectStore } from '../../server/db.js';
import type { SessionManager } from './SessionManager.js';
import type { BasePlugin, PluginMessageHandler, PluginConfirmHandler } from '../plugins/BasePlugin.js';
import type { IChannelPluginConfig, IChannelPluginStatus, IUnifiedIncomingMessage, PluginType } from '../types.js';
import { hasPluginCredentials } from '../types.js';
import { LarkPlugin } from '../plugins/lark/LarkPlugin.js';
import { TelegramPlugin } from '../plugins/telegram/TelegramPlugin.js';
import { DingTalkPlugin } from '../plugins/dingtalk/DingTalkPlugin.js';
import { WeChatPlugin } from '../plugins/wechat/WeChatPlugin.js';
import { WeComPlugin } from '../plugins/wecom/WeComPlugin.js';

// Plugin registry - maps plugin IDs to their constructors
// Key is the full pluginId (e.g., 'lark_default', 'telegram_default')
type PluginConstructor = new () => BasePlugin;
const pluginRegistry: Map<string, PluginConstructor> = new Map();

// Register built-in plugins with their default IDs
pluginRegistry.set('lark_default', LarkPlugin as PluginConstructor);
pluginRegistry.set('lark', LarkPlugin as PluginConstructor);
pluginRegistry.set('telegram_default', TelegramPlugin as PluginConstructor);
pluginRegistry.set('telegram', TelegramPlugin as PluginConstructor);
pluginRegistry.set('dingtalk_default', DingTalkPlugin as PluginConstructor);
pluginRegistry.set('dingtalk', DingTalkPlugin as PluginConstructor);
pluginRegistry.set('wechat_default', WeChatPlugin as PluginConstructor);
pluginRegistry.set('wechat', WeChatPlugin as PluginConstructor);
pluginRegistry.set('wecom_default', WeComPlugin as PluginConstructor);
pluginRegistry.set('wecom', WeComPlugin as PluginConstructor);

// Register placeholder plugins for platforms not yet implemented
const PLACEHOLDER_TYPES = [] as const;
for (const type of PLACEHOLDER_TYPES) {
  const PlaceholderPlugin = class extends LarkPlugin {
    readonly type: PluginType = type;
    protected async onInitialize(): Promise<void> {
      throw new Error(`${type} plugin not yet implemented.`);
    }
  };
  pluginRegistry.set(`${type}_default`, PlaceholderPlugin as unknown as PluginConstructor);
  pluginRegistry.set(type, PlaceholderPlugin as unknown as PluginConstructor);
}

/**
 * Register a plugin
 */
export function registerPlugin(pluginId: string, constructor: PluginConstructor): void {
  pluginRegistry.set(pluginId, constructor);
}

/**
 * PluginManager - Manages lifecycle of all platform plugins in Moss Server
 */
export class PluginManager {
  // Active plugin instances
  private plugins: Map<string, BasePlugin> = new Map();

  // Reference to session manager
  private sessionManager: SessionManager;

  // Database reference
  private db: DirectConnectStore;

  // Message handler for incoming messages
  private messageHandler: PluginMessageHandler | null = null;

  // Confirm handler for tool confirmations
  private confirmHandler: PluginConfirmHandler | null = null;

  // Runtime error cache: pluginId -> error message
  private pluginErrors: Map<string, string> = new Map();

  constructor(sessionManager: SessionManager, db: DirectConnectStore) {
    this.sessionManager = sessionManager;
    this.db = db;
  }

  /**
   * Get error message for a plugin
   */
  getPluginError(pluginId: string): string | undefined {
    return this.pluginErrors.get(pluginId);
  }

  /**
   * Clear error message for a plugin
   */
  clearPluginError(pluginId: string): void {
    this.pluginErrors.delete(pluginId);
  }

  /**
   * Set the message handler for incoming messages
   */
  setMessageHandler(handler: PluginMessageHandler): void {
    this.messageHandler = handler;

    for (const plugin of this.plugins.values()) {
      plugin.onMessage(handler);
    }
  }

  /**
   * Set the confirm handler for tool confirmations
   */
  setConfirmHandler(handler: PluginConfirmHandler): void {
    this.confirmHandler = handler;

    for (const plugin of this.plugins.values()) {
      plugin.onConfirm(handler);
    }
  }

  /**
   * Get a plugin by ID
   */
  getPlugin(pluginId: string): BasePlugin | undefined {
    return this.plugins.get(pluginId);
  }

  /**
   * Get all active plugin entries (key + plugin instance)
   */
  getAllPluginEntries(): IterableIterator<[string, BasePlugin]> {
    return this.plugins.entries();
  }

  /**
   * Get the instance key (e.g. "pluginId:userId") for a running plugin instance
   */
  getInstanceKey(plugin: BasePlugin): string | undefined {
    for (const [key, instance] of this.plugins.entries()) {
      if (instance === plugin) return key;
    }
    return undefined;
  }

  /**
   * Get all active plugins
   */
  getAllPlugins(): BasePlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Start a plugin with the given configuration
   * instanceKey: unique key for this plugin instance (defaults to config.id).
   * In enterprise mode, use "pluginId:userId" to support per-user plugin instances.
   */
  async startPlugin(config: IChannelPluginConfig, instanceKey?: string): Promise<void> {
    const { type } = config;
    const key = instanceKey || config.id;

    this.pluginErrors.delete(key);

    if (this.plugins.has(key)) {
      return;
    }

    const Constructor = pluginRegistry.get(type);
    if (!Constructor) {
      const errorMsg = `Unknown plugin type: ${type}`;
      this.pluginErrors.set(key, errorMsg);
      throw new Error(errorMsg);
    }

    const plugin = new Constructor();
    const userId = instanceKey ? instanceKey.split(':').pop() : undefined;

    try {
      await plugin.initialize(config);
    } catch (error) {
      const errorMsg = `Plugin initialization failed: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[PluginManager] ${errorMsg}`, error);
      this.pluginErrors.set(key, errorMsg);

      this.db.updateChannelPluginStatus(config.id, 'error', undefined, userId);

      throw error;
    }

    if (this.messageHandler) {
      plugin.onMessage(this.messageHandler);
    }

    if (this.confirmHandler) {
      plugin.onConfirm(this.confirmHandler);
    }

    try {
      await plugin.start();
    } catch (error) {
      const errorMsg = `Plugin start failed: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[PluginManager] ${errorMsg}`, error);
      this.pluginErrors.set(key, errorMsg);

      this.db.updateChannelPluginStatus(config.id, 'error', undefined, userId);

      throw error;
    }

    this.plugins.set(key, plugin);

    this.db.updateChannelPluginStatus(config.id, 'running', Date.now(), userId);

    console.log(`[PluginManager] Plugin ${key} started successfully`);
  }

  /**
   * Stop a plugin
   */
  async stopPlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      return;
    }

    await plugin.stop();

    this.plugins.delete(pluginId);

    // Extract userId from composite key if present (format: "pluginId:userId")
    const userId = pluginId.includes(':') ? pluginId.split(':').pop() : undefined;
    // Extract bare pluginId from composite key
    const barePluginId = pluginId.includes(':') ? pluginId.split(':')[0] : pluginId;
    this.db.updateChannelPluginStatus(barePluginId, 'stopped', undefined, userId);

    console.log(`[PluginManager] Plugin ${pluginId} stopped`);
  }

  /**
   * Stop all plugins
   */
  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.plugins.keys()).map((id) => this.stopPlugin(id));
    await Promise.allSettled(stopPromises);
    console.log('[PluginManager] All plugins stopped');
  }

  /**
   * Get status for all plugins
   */
  getPluginStatuses(userId?: string): IChannelPluginStatus[] {
    const rows = this.db.listChannelPlugins(userId);

    return rows.map((row) => this.buildPluginStatus({
      id: String(row.id),
      type: String(row.type) as PluginType,
      name: String(row.name),
      enabled: Boolean(row.enabled),
      status: String(row.status) as IChannelPluginStatus['status'],
      credentials: row.credentials_json ? JSON.parse(String(row.credentials_json)) : undefined,
      config: row.config_json ? JSON.parse(String(row.config_json)) : undefined,
      lastConnected: row.last_connected ? Number(row.last_connected) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }, userId ? String(row.user_id) : undefined));
  }

  /**
   * Build plugin status object
   */
  private buildPluginStatus(config: IChannelPluginConfig, userId?: string): IChannelPluginStatus {
    const BUILTIN_TYPES = new Set(['telegram', 'lark', 'dingtalk', 'wechat']);
    // In enterprise mode, look up plugin instance by composite key
    const instanceKey = userId ? `${config.id}:${userId}` : config.id;
    const plugin = this.plugins.get(instanceKey);
    const botInfo = plugin?.getBotInfo();

    const errorMessage = plugin?.error ?? this.pluginErrors.get(instanceKey);

    return {
      id: config.id,
      type: config.type,
      name: config.name,
      enabled: config.enabled,
      connected: plugin?.status === 'running',
      status: plugin?.status ?? config.status,
      lastConnected: config.lastConnected,
      error: errorMessage,
      activeUsers: plugin?.getActiveUserCount() ?? 0,
      botUsername: botInfo?.username,
      hasToken: hasPluginCredentials(config.type, config.credentials),
      isExtension: !BUILTIN_TYPES.has(config.type),
    };
  }

  /**
   * Handle incoming message from a plugin
   */
  private async handleIncomingMessage(message: IUnifiedIncomingMessage): Promise<void> {
    this.sessionManager.updateSessionActivity(message.user.id);

    if (this.messageHandler) {
      await this.messageHandler(message);
    }
  }

  /**
   * Send a message through a plugin
   */
  async sendMessage(pluginId: string, chatId: string, message: IUnifiedIncomingMessage): Promise<string | null> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      console.error(`[PluginManager] Plugin ${pluginId} not found`);
      return null;
    }

    try {
      return await plugin.sendMessage(chatId, message as any);
    } catch (error) {
      console.error(`[PluginManager] Failed to send message through ${pluginId}:`, error);
      return null;
    }
  }

  /**
   * Edit a message through a plugin
   */
  async editMessage(pluginId: string, chatId: string, messageId: string, message: IUnifiedIncomingMessage): Promise<boolean> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      console.error(`[PluginManager] Plugin ${pluginId} not found`);
      return false;
    }

    try {
      await plugin.editMessage(chatId, messageId, message as any);
      return true;
    } catch (error) {
      console.error(`[PluginManager] Failed to edit message through ${pluginId}:`, error);
      return false;
    }
  }

  /**
   * Start all enabled plugins from database
   */
  async startEnabledPlugins(): Promise<void> {
    const rows = this.db.listChannelPlugins();
    console.log(`[PluginManager] Starting enabled plugins, found ${rows.length} rows`);

    for (const row of rows) {
      if (Boolean(row.enabled)) {
        const userId = row.user_id ? String(row.user_id) : undefined;
        const config: IChannelPluginConfig = {
          id: String(row.id),
          type: String(row.type) as PluginType,
          name: String(row.name),
          enabled: true,
          status: String(row.status) as IChannelPluginStatus['status'],
          credentials: row.credentials_json ? JSON.parse(String(row.credentials_json)) : undefined,
          config: row.config_json ? JSON.parse(String(row.config_json)) : undefined,
          lastConnected: row.last_connected ? Number(row.last_connected) : undefined,
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
        };

        try {
          const instanceKey = userId ? `${config.id}:${userId}` : config.id;
          console.log(`[PluginManager] Starting plugin ${config.id} with instanceKey=${instanceKey}`);
          await this.startPlugin(config, instanceKey);
        } catch (error) {
          console.error(`[PluginManager] Failed to start plugin ${config.id}:`, error);
        }
      }
    }
  }
}