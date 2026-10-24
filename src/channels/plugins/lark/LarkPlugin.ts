/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as lark from '@larksuiteoapi/node-sdk';
import * as fs from 'fs';
import * as path from 'path';

import type { BotInfo, IChannelPluginConfig, IUnifiedIncomingMessage, IUnifiedOutgoingMessage, PluginType } from '../../types.js';
import { BasePlugin } from '../BasePlugin.js';
import { convertHtmlToLarkMarkdown, extractCardAction, LARK_MESSAGE_LIMIT, toLarkSendParams, toUnifiedIncomingMessage } from './LarkAdapter.js';

// Event deduplication settings
const EVENT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const EVENT_CACHE_CLEANUP_INTERVAL = 60 * 1000; // 1 minute
const CONNECTION_START_TIMEOUT_MS = 10_000;

/**
 * LarkPlugin - Lark/Feishu Bot integration for Moss Server
 *
 * Uses official Lark Node SDK
 * Supports WebSocket long connection mode (no public URL required)
 */
export class LarkPlugin extends BasePlugin {
  readonly type: PluginType = 'lark';

  private client: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;
  private eventDispatcher: lark.EventDispatcher | null = null;
  private botInfo: { appId: string; name?: string } | null = null;

  // Track active users for status reporting
  private activeUsers: Set<string> = new Set();

  // Event deduplication - track processed event IDs with timestamps
  private processedEvents: Map<string, number> = new Map();
  private eventCleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Media directory for downloaded files
  private mediaDir: string = '';

  override get isConnectionReady(): boolean {
    return this.status === 'running' && this.wsClient?.getConnectionStatus().state === 'connected';
  }

  /**
   * Initialize the Lark client instance
   */
  protected async onInitialize(config: IChannelPluginConfig): Promise<void> {
    const appId = config.credentials?.appId;
    const appSecret = config.credentials?.appSecret;

    if (!appId || !appSecret) {
      throw new Error('Lark App ID and App Secret are required');
    }
    if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) {
      throw new Error('Invalid Lark App ID');
    }

    // Create Lark client
    this.client = new lark.Client({
      appId,
      appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    });

    this.botInfo = { appId };

    // Set media directory
    this.mediaDir = path.join(process.cwd(), 'data', 'channel-media', 'lark');
    fs.mkdirSync(this.mediaDir, { recursive: true });
  }

  /**
   * Start WebSocket connection for receiving events
   */
  protected async onStart(): Promise<void> {
    if (!this.client) {
      throw new Error('Client not initialized');
    }

    const appId = this.config?.credentials?.appId;
    const appSecret = this.config?.credentials?.appSecret;

    if (!appId || !appSecret) {
      throw new Error('Credentials not available');
    }

    try {
      const encryptKey = this.config?.credentials?.encryptKey;
      const verificationToken = this.config?.credentials?.verificationToken;

      this.eventDispatcher = new lark.EventDispatcher({
        encryptKey: encryptKey || '',
        verificationToken: verificationToken || '',
      });

      this.setupEventHandlers();

      const dispatcher = this.eventDispatcher;
      await new Promise<void>((resolve, reject) => {
        let isSettled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: Error): void => {
          if (isSettled) return;
          isSettled = true;
          if (timer) clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        const wsClient = new lark.WSClient({
          appId,
          appSecret,
          domain: lark.Domain.Feishu,
          loggerLevel: lark.LoggerLevel.info,
          handshakeTimeoutMs: CONNECTION_START_TIMEOUT_MS,
          onReady: () => {
            if (this.wsClient === wsClient) finish();
          },
          onError: (error: Error) => {
            if (this.wsClient !== wsClient) return;
            if (!isSettled) finish(error);
            else {
              this.closeConnection();
              this.stopEventCleanup();
              this.setStatus('error', error.message);
            }
          },
        });
        this.wsClient = wsClient;
        timer = setTimeout(() => {
          finish(new Error('Lark WebSocket connection timed out'));
        }, CONNECTION_START_TIMEOUT_MS);
        // SDK start() resolves before its first handshake. Only onReady proves
        // that the long connection can receive events.
        void Promise.resolve().then(() => wsClient.start({ eventDispatcher: dispatcher })).catch(finish);
      });
      if (this.status === 'error') throw new Error(this.error ?? 'Lark connection failed');

      this.startEventCleanup();

      console.log(`[LarkPlugin] Started`);
    } catch (error) {
      this.closeConnection();
      console.error('[LarkPlugin] Failed to start:', error);
      throw error;
    }
  }

  /**
   * Stop WebSocket connection and cleanup
   */
  protected async onStop(): Promise<void> {
    this.stopEventCleanup();

    this.closeConnection();
    this.client = null;
    this.botInfo = null;
    this.activeUsers.clear();
    this.processedEvents.clear();

    console.log('[LarkPlugin] Stopped and cleaned up');
  }

  private closeConnection(): void {
    const client = this.wsClient;
    this.wsClient = null;
    this.eventDispatcher = null;
    client?.close({ force: true });
  }

  /**
   * Get active user count
   */
  getActiveUserCount(): number {
    return this.activeUsers.size;
  }

  /**
   * Get bot information
   */
  getBotInfo(): BotInfo | null {
    if (!this.botInfo) return null;
    return {
      id: this.botInfo.appId,
      displayName: this.botInfo.name || 'Aion Assistant',
    };
  }

  /**
   * Get receive_id_type based on the ID prefix
   */
  private getReceiveIdType(receiveId: string): 'open_id' | 'chat_id' | 'union_id' | 'user_id' {
    if (receiveId.startsWith('ou_')) return 'open_id';
    if (receiveId.startsWith('oc_')) return 'chat_id';
    if (receiveId.startsWith('on_')) return 'union_id';
    return 'user_id';
  }

  /**
   * Send a message to a chat
   */
  async sendMessage(chatId: string, message: IUnifiedOutgoingMessage): Promise<string> {
    if (!this.client) {
      const appId = this.config?.credentials?.appId;
      const appSecret = this.config?.credentials?.appSecret;
      if (appId && appSecret) {
        this.client = new lark.Client({
          appId,
          appSecret,
          appType: lark.AppType.SelfBuild,
          domain: lark.Domain.Feishu,
        });
      } else {
        throw new Error('Client not initialized');
      }
    }

    const receiveIdType = this.getReceiveIdType(chatId);

    // Handle image messages
    if (message.type === 'image' && message.imageUrl) {
      try {
        const imageKey = await this.uploadImage(message.imageUrl);
        const response = await this.client.im.message.create({
          params: { receive_id_type: receiveIdType },
          data: {
            receive_id: chatId,
            msg_type: 'image',
            content: JSON.stringify({ image_key: imageKey }),
          },
        });
        return response.data?.message_id || '';
      } catch (error) {
        console.error('[LarkPlugin] Failed to send image:', error);
        throw error;
      }
    }

    // Handle file messages
    if (message.type === 'file' && message.fileUrl && message.fileName) {
      try {
        const fileKey = await this.uploadFile(message.fileUrl, message.fileName);
        const response = await this.client.im.message.create({
          params: { receive_id_type: receiveIdType },
          data: {
            receive_id: chatId,
            msg_type: 'file',
            content: JSON.stringify({ file_key: fileKey }),
          },
        });
        return response.data?.message_id || '';
      } catch (error) {
        console.error('[LarkPlugin] Failed to send file:', error);
        throw error;
      }
    }

    const { contentType, content, rawText } = toLarkSendParams(message);

    // Handle text messages - send as card for streaming support
    if (contentType === 'text' && rawText !== undefined) {
      const card = this.buildTextCard(rawText);

      try {
        const response = await this.client.im.message.create({
          params: {
            receive_id_type: receiveIdType,
          },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: JSON.stringify(card),
          },
        });

        return response.data?.message_id || '';
      } catch (error) {
        console.error('[LarkPlugin] Failed to send card message:', error);
        throw error;
      }
    }

    try {
      const response = await this.client.im.message.create({
        params: {
          receive_id_type: receiveIdType,
        },
        data: {
          receive_id: chatId,
          msg_type: contentType,
          content: JSON.stringify(content),
        },
      });

      return response.data?.message_id || '';
    } catch (error) {
      console.error('[LarkPlugin] Failed to send message:', error);
      throw error;
    }
  }

  /**
   * Build a simple card for text content
   */
  private buildTextCard(text: string): Record<string, unknown> {
    return {
      config: {
        wide_screen_mode: true,
      },
      elements: [
        {
          tag: 'markdown',
          content: convertHtmlToLarkMarkdown(text),
        },
      ],
    };
  }

  /**
   * Edit an existing message
   */
  async editMessage(chatId: string, messageId: string, message: IUnifiedOutgoingMessage): Promise<void> {
    if (!this.client) {
      const appId = this.config?.credentials?.appId;
      const appSecret = this.config?.credentials?.appSecret;
      if (appId && appSecret) {
        this.client = new lark.Client({
          appId,
          appSecret,
          appType: lark.AppType.SelfBuild,
          domain: lark.Domain.Feishu,
        });
      } else {
        throw new Error('Client not initialized');
      }
    }

    const { contentType, content, rawText } = toLarkSendParams(message);

    try {
      let cardContent: Record<string, unknown>;

      if (contentType === 'text' && rawText !== undefined) {
        const truncatedText = rawText.length > LARK_MESSAGE_LIMIT ? rawText.slice(0, LARK_MESSAGE_LIMIT - 3) + '...' : rawText;
        cardContent = this.buildTextCard(truncatedText);
      } else if (contentType === 'interactive') {
        cardContent = content as Record<string, unknown>;
      } else {
        cardContent = this.buildTextCard(rawText || JSON.stringify(content));
      }

      await this.client.im.message.patch({
        path: {
          message_id: messageId,
        },
        data: {
          content: JSON.stringify(cardContent),
        },
      });
    } catch (error: any) {
      const errorCode = error?.response?.data?.code || error?.code;
      const errorMsg = error?.response?.data?.msg || error?.message || '';

      if (errorCode === 230002 || errorMsg.includes('not modified')) {
        return;
      }

      if (errorMsg.includes('NOT a card')) {
        console.warn(`[LarkPlugin] Cannot edit non-card message: ${messageId}, skipping`);
        return;
      }

      console.error('[LarkPlugin] Failed to edit message:', error);
      throw error;
    }
  }

  /**
   * Setup event handlers for incoming messages and card actions
   */
  private setupEventHandlers(): void {
    if (!this.eventDispatcher) return;
    const dispatcher = this.eventDispatcher;

    dispatcher.register({
      'im.message.receive_v1': async (data: Record<string, unknown>) => {
        if (!this.isCurrentDispatcher(dispatcher)) return;
        void this.handleMessageEvent({ event: data }, dispatcher);
      },

      'card.action.trigger': async (data: Record<string, unknown>) => {
        if (!this.isCurrentDispatcher(dispatcher)) return {};
        void this.handleCardAction({ event: data });
        return {};
      },

      'application.bot.menu_v6': async (data: Record<string, unknown>) => {
        if (!this.isCurrentDispatcher(dispatcher)) return;
        void this.handleBotMenuEvent({ event: data });
      },
    });
  }

  private isCurrentDispatcher(dispatcher: lark.EventDispatcher): boolean {
    return this.eventDispatcher === dispatcher && (this.status === 'starting' || this.status === 'running');
  }

  /**
   * Handle incoming message events
   */
  private async handleMessageEvent(event: any, dispatcher: lark.EventDispatcher): Promise<void> {
    try {
      const message = event?.event?.message;
      const sender = event?.event?.sender;

      if (!message || !sender) {
        console.warn('[LarkPlugin] Invalid message event:', event);
        return;
      }

      const eventId = message.message_id;
      if (eventId && this.isEventProcessed(eventId)) {
        return;
      }
      if (eventId) {
        this.markEventProcessed(eventId);
      }

      const userId = sender.sender_id?.user_id || sender.sender_id?.open_id;
      if (!userId) return;

      this.activeUsers.add(userId);

      const unifiedMessage = toUnifiedIncomingMessage(event);
      if (unifiedMessage && this.messageHandler) {
        if (unifiedMessage.content.attachments?.length) {
          await this.downloadMediaAttachments(unifiedMessage, eventId || '');
        }
        if (!this.isCurrentDispatcher(dispatcher)) return;

        if (unifiedMessage.content.type === 'text' && unifiedMessage.content.text) {
          const buttonAction = this.getMenuButtonAction(unifiedMessage.content.text);
          if (buttonAction) {
            unifiedMessage.content.type = 'action';
            unifiedMessage.content.text = buttonAction.action;
            unifiedMessage.action = {
              type: buttonAction.type as 'system' | 'platform' | 'chat',
              name: buttonAction.action,
            };
          }
        }

        void this.messageHandler(unifiedMessage, this).catch((error) => console.error(`[LarkPlugin] Error handling message:`, error));
      }
    } catch (error) {
      console.error('[LarkPlugin] Error processing message event:', error);
    }
  }

  /**
   * Download media attachments from Feishu to local files
   */
  private async downloadMediaAttachments(unifiedMessage: IUnifiedIncomingMessage, messageId: string): Promise<void> {
    if (!this.client || !unifiedMessage.content.attachments?.length) {
      return;
    }

    for (const attachment of unifiedMessage.content.attachments) {
      if (!attachment.fileId) continue;

      const resourceType = attachment.type === 'photo' ? 'image'
        : attachment.type === 'audio' ? 'audio'
        : attachment.type === 'video' ? 'video'
        : 'file';

      try {
        const response = await this.client.im.messageResource.get({
          params: { type: resourceType },
          path: { message_id: messageId, file_key: attachment.fileId },
        });

        if (!response) {
          console.warn(`[LarkPlugin] Failed to download resource: ${attachment.fileId}, no response`);
          continue;
        }

        const ext = attachment.type === 'photo' ? '.png'
          : attachment.fileName ? path.extname(attachment.fileName)
          : attachment.type === 'audio' ? '.ogg'
          : attachment.type === 'video' ? '.mp4'
          : '.bin';

        const localPath = path.join(this.mediaDir, `${attachment.fileId}${ext}`);
        await response.writeFile(localPath);
        attachment.fileId = localPath;
      } catch (error) {
        console.warn(`[LarkPlugin] Failed to download media ${attachment.fileId}:`, error);
      }
    }
  }

  /**
   * Upload an image file to Lark
   */
  private async uploadImage(filePath: string): Promise<string> {
    if (!this.client) throw new Error('Client not initialized');
    if (!fs.existsSync(filePath)) throw new Error(`Image file not found: ${filePath}`);

    const imageBuffer = fs.readFileSync(filePath);
    const response = await this.client.im.image.create({
      data: {
        image_type: 'message',
        image: imageBuffer,
      },
    });

    if (!response?.image_key) {
      throw new Error('Failed to upload image: no image_key returned');
    }
    return response.image_key;
  }

  /**
   * Upload a file to Lark
   */
  private async uploadFile(filePath: string, fileName: string): Promise<string> {
    if (!this.client) throw new Error('Client not initialized');
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

    const fileBuffer = fs.readFileSync(filePath);
    const file_type = this.toLarkFileType(fileName);

    const response = await this.client.im.file.create({
      data: {
        file_type,
        file_name: fileName,
        file: fileBuffer,
      },
    });

    if (!response?.file_key) {
      throw new Error('Failed to upload file: no file_key returned');
    }
    return response.file_key;
  }

  /**
   * Map file extension to Lark file_type
   */
  private toLarkFileType(fileName: string): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
    const ext = path.extname(fileName).toLowerCase();
    const map: Record<string, 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt'> = {
      '.pdf': 'pdf',
      '.doc': 'doc', '.docx': 'doc',
      '.xls': 'xls', '.xlsx': 'xls', '.csv': 'xls',
      '.ppt': 'ppt', '.pptx': 'ppt',
      '.mp3': 'opus', '.opus': 'opus', '.ogg': 'opus',
      '.mp4': 'mp4',
    };
    return map[ext] || 'stream';
  }

  /**
   * Get menu button action
   */
  private getMenuButtonAction(text: string): { type: string; action: string } | null {
    const menuActions: Record<string, { type: string; action: string }> = {
      'session.new': { type: 'system', action: 'session.new' },
      'session.status': { type: 'system', action: 'session.status' },
      'help.show': { type: 'system', action: 'help.show' },
      'agent.show': { type: 'system', action: 'agent.show' },
      'pairing.check': { type: 'platform', action: 'pairing.check' },
    };
    return menuActions[text] || null;
  }

  /**
   * Handle bot menu click events
   */
  private async handleBotMenuEvent(event: any): Promise<void> {
    try {
      const operator = event?.event?.operator;
      const eventKey = event?.event?.event_key;
      const timestamp = event?.event?.timestamp;

      if (!operator || !eventKey) {
        console.warn('[LarkPlugin] Invalid bot menu event:', event);
        return;
      }

      const eventId = `menu_${eventKey}_${timestamp}`;
      if (this.isEventProcessed(eventId)) {
        return;
      }
      this.markEventProcessed(eventId);

      const userId = operator.operator_id?.user_id || operator.operator_id?.open_id;
      if (!userId) {
        console.warn('[LarkPlugin] No user ID in bot menu event');
        return;
      }

      this.activeUsers.add(userId);

      const chatId = event?.event?.chat_id || userId;

      const buttonAction = this.getMenuButtonAction(eventKey);
      if (!buttonAction) {
        console.warn(`[LarkPlugin] Unknown menu event_key: ${eventKey}`);
        return;
      }

      const unifiedMessage = {
        id: eventId,
        platform: 'lark' as const,
        chatId,
        user: {
          id: userId,
          displayName: `User ${userId.slice(-6)}`,
        },
        content: {
          type: 'action' as const,
          text: buttonAction.action,
        },
        action: {
          type: buttonAction.type as 'system' | 'platform' | 'chat',
          name: buttonAction.action,
        },
        timestamp: timestamp ? parseInt(timestamp, 10) : Date.now(),
        raw: event,
      };

      if (this.messageHandler) {
        void this.messageHandler(unifiedMessage, this).catch((error) => console.error(`[LarkPlugin] Error handling bot menu action:`, error));
      }
    } catch (error) {
      console.error('[LarkPlugin] Error processing bot menu event:', error);
    }
  }

  /**
   * Handle card action callbacks
   */
  private async handleCardAction(event: any): Promise<void> {
    try {
      const action = event?.event?.action;
      const operator = event?.event?.operator;
      const eventToken = event?.event?.token;

      if (!action || !operator) {
        console.warn('[LarkPlugin] Invalid card action event:', event);
        return;
      }

      if (eventToken && this.isEventProcessed(eventToken)) {
        return;
      }
      if (eventToken) {
        this.markEventProcessed(eventToken);
      }

      const userId = operator.user_id || operator.open_id;
      if (!userId) return;

      this.activeUsers.add(userId);

      const actionInfo = extractCardAction(action);
      if (!actionInfo) return;

      const unifiedMessage = toUnifiedIncomingMessage(event, actionInfo);
      if (unifiedMessage && this.messageHandler) {
        void this.messageHandler(unifiedMessage, this).catch((error) => console.error(`[LarkPlugin] Error handling card action:`, error));
      }
    } catch (error) {
      console.error('[LarkPlugin] Error processing card action:', error);
    }
  }

  // ==================== Event Deduplication ====================

  private isEventProcessed(eventId: string): boolean {
    return this.processedEvents.has(eventId);
  }

  private markEventProcessed(eventId: string): void {
    this.processedEvents.set(eventId, Date.now());
  }

  private startEventCleanup(): void {
    if (this.eventCleanupTimer) return;

    this.eventCleanupTimer = setInterval(() => {
      this.cleanupOldEvents();
    }, EVENT_CACHE_CLEANUP_INTERVAL);
  }

  private stopEventCleanup(): void {
    if (this.eventCleanupTimer) {
      clearInterval(this.eventCleanupTimer);
      this.eventCleanupTimer = null;
    }
  }

  private cleanupOldEvents(): void {
    const now = Date.now();

    for (const [eventId, timestamp] of this.processedEvents.entries()) {
      if (now - timestamp > EVENT_CACHE_TTL) {
        this.processedEvents.delete(eventId);
      }
    }
  }

  /**
   * Test connection with the given credentials
   */
  static async testConnection(appId: string, appSecret?: string): Promise<{ success: boolean; botUsername?: string; error?: string }> {
    if (!appSecret) {
      return { success: false, error: 'App Secret is required for Lark' };
    }

    try {
      const client = new lark.Client({
        appId,
        appSecret,
        appType: lark.AppType.SelfBuild,
        domain: lark.Domain.Feishu,
      });

      const response = await client.auth.tenantAccessToken.internal({
        data: {
          app_id: appId,
          app_secret: appSecret,
        },
      });

      if (response?.code !== undefined && response.code !== 0) {
        return {
          success: false,
          error: response.msg || `Lark API error (code: ${response.code})`,
        };
      }

      return { success: true, botUsername: 'Lark Bot' };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to connect to Lark API',
      };
    }
  }
}
