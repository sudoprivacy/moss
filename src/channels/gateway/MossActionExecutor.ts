/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

import net from 'net';
import type { RuntimeService } from '../../server/runtimeService.js';
import type { DirectConnectStore } from '../../server/db.js';
import type { PluginManager } from './PluginManager.js';
import type { SessionManager } from '../core/SessionManager.js';
import type { PairingService } from '../pairing/PairingService.js';
import type { PluginMessageHandler, BasePlugin } from '../plugins/BasePlugin.js';
import type { IUnifiedIncomingMessage, IChannelUser, PluginType } from '../types.js';
import { getChannelEventEmitter } from '../core/ChannelEventEmitter.js';

type Platform = 'telegram' | 'lark' | 'dingtalk' | 'wechat' | 'wecom';

interface ChannelSessionState {
  sessionId: string;
  socket: net.Socket | null;
  buffer: string;
  responseText: string;
  lastMsgId: string | null;
  isProcessing: boolean;
}

/**
 * MossActionExecutor - Routes incoming channel messages to AI and sends responses back.
 *
 * Moss Server uses RuntimeService to spawn `direct-connect-session-runner` child processes.
 * Messages are sent to the runner via a TCP socket (stdin/stdout JSON lines protocol):
 *   - Input:  { type: "stdin", data: "text\n" }
 *   - Output: { type: "stdout", line: "<json>" }
 *   - Exit:   { type: "exit" }
 *
 * This is the Moss equivalent of sudowork's ActionExecutor + ChannelMessageService.
 */
export class MossActionExecutor {
  private pluginManager: PluginManager;
  private sessionManager: SessionManager;
  private pairingService: PairingService;
  private runtime: RuntimeService;
  private db: DirectConnectStore;

  /** Cache: channelUserKey -> session state */
  private channelSessions: Map<string, ChannelSessionState> = new Map();

  /** Per-conversation mutex to serialize message processing */
  private conversationLocks: Map<string, Promise<void>> = new Map();

  /** Throttle interval for editMessage (ms) */
  private static readonly EDIT_THROTTLE_MS = 500;

  constructor(
    pluginManager: PluginManager,
    sessionManager: SessionManager,
    pairingService: PairingService,
    runtime: RuntimeService,
    db: DirectConnectStore,
  ) {
    this.pluginManager = pluginManager;
    this.sessionManager = sessionManager;
    this.pairingService = pairingService;
    this.runtime = runtime;
    this.db = db;
  }

  /**
   * Get the message handler for plugins
   */
  getMessageHandler(): PluginMessageHandler {
    return this.handleIncomingMessage.bind(this);
  }

  /**
   * Handle incoming message from a channel plugin
   */
  private async handleIncomingMessage(message: IUnifiedIncomingMessage, sourcePlugin: BasePlugin): Promise<void> {
    const { platform, chatId, user, content } = message;
    console.log(`[MossActionExecutor] Incoming message from ${platform}: userId=${user.id}, chatId=${chatId}, type=${content.type}`);

    // Resolve the moss admin userId from the running plugin instance key (format: "pluginId:userId")
    const instanceKey = this.pluginManager.getInstanceKey(sourcePlugin);
    const mossUserId = instanceKey?.includes(':') ? instanceKey.split(':').pop() : undefined;

    // Use the source plugin directly for sending responses (no lookup needed)
    const sendFn = async (msg: any) => sourcePlugin.sendMessage(chatId, msg);
    const editFn = async (msgId: string, msg: any) => sourcePlugin.editMessage(chatId, msgId, msg);

    try {
      // 1. Check authorization
      const isAuthorized = this.pairingService.isUserAuthorized(user.id, platform);

      // Handle /start command
      if (content.type === 'command' && content.text === '/start') {
        if (platform === 'wechat' || platform === 'wecom') {
          // Auto-authorize and continue
        } else {
          await this.handlePairingFlow(platform, user, sendFn, mossUserId);
          return;
        }
      }

      // If not authorized, handle based on platform
      if (!isAuthorized) {
        if (platform === 'wechat' || platform === 'wecom') {
          // Auto-authorize WeChat/WeCom users
          this.autoAuthorizeUser(user, platform, mossUserId);
        } else {
          // Show pairing flow for other platforms
          await this.handlePairingFlow(platform, user, sendFn, mossUserId);
          return;
        }
      }

      // 2. Only process text messages for now
      if (content.type !== 'text' || !content.text) {
        console.log(`[MossActionExecutor] Skipping non-text message type: ${content.type}`);
        return;
      }

      // 3. Per-conversation mutex
      const lockKey = `${platform}:${user.id}:${chatId}`;
      const existingLock = this.conversationLocks.get(lockKey);
      if (existingLock) {
        console.log(`[MossActionExecutor] Message already being processed for ${lockKey}, queuing`);
        await existingLock;
      }

      const lockPromise = this.processMessage(platform, chatId, user, content.text, sendFn, editFn);
      this.conversationLocks.set(lockKey, lockPromise);

      try {
        await lockPromise;
      } finally {
        this.conversationLocks.delete(lockKey);
      }
    } catch (error) {
      console.error(`[MossActionExecutor] Error handling message:`, error);
      try {
        await sendFn({
          type: 'text',
          text: '❌ An error occurred processing your message. Please try again.',
          parseMode: 'HTML',
        });
      } catch {}
    }
  }

  /**
   * Process a text message: get/create session, send to AI, stream response back
   */
  private async processMessage(
    platform: string,
    chatId: string,
    user: { id: string; displayName?: string },
    text: string,
    sendFn: (msg: any) => Promise<string | null>,
    editFn: (msgId: string, msg: any) => Promise<boolean>,
  ): Promise<void> {
    const channelUserKey = `${platform}:${user.id}:${chatId}`;

    // Get/create channel user
    let channelUser = this.getChannelUser(user.id, platform);
    if (!channelUser) {
      // Should have been created by auto-authorize or pairing, but create as fallback
      channelUser = this.autoAuthorizeUser(user, platform, mossUserId);
      if (!channelUser) {
        await sendFn({ type: 'text', text: '❌ Authorization failed. Please try again.', parseMode: 'HTML' });
        return;
      }
    }

    // Get/create channel session
    let session = this.sessionManager.getSession(channelUser.id, chatId);
    if (!session || !session.conversationId) {
      // Create a new channel session with conversationId = channelUserKey (used as Moss session ID)
      session = this.sessionManager.createSession(
        channelUser,
        'acp',
        undefined,
        chatId,
      );
    }

    // Get or create Moss runtime session
    let channelState = this.channelSessions.get(channelUserKey);
    if (!channelState || !channelState.socket || channelState.socket.destroyed) {
      // Create new Moss runtime session
      try {
        channelState = await this.createRuntimeSession(channelUserKey, channelUser, platform, chatId);
      } catch (error) {
        console.error(`[MossActionExecutor] Failed to create runtime session:`, error);
        await sendFn({ type: 'text', text: '❌ Failed to create AI session. Please try again.', parseMode: 'HTML' });
        return;
      }
    }

    // Send "thinking" indicator
    const thinkingMsgId = await sendFn({
      type: 'text',
      text: '⏳ Thinking...',
      parseMode: 'HTML',
    });

    // Send text to the session runner
    const socket = channelState.socket;
    if (!socket || socket.destroyed) {
      // Reconnect
      try {
        channelState = await this.reconnectRuntimeSession(channelUserKey, channelState.sessionId);
      } catch (error) {
        console.error(`[MossActionExecutor] Failed to reconnect runtime session:`, error);
        await sendFn({ type: 'text', text: '❌ Session disconnected. Please try again.', parseMode: 'HTML' });
        return;
      }
    }

    // Reset response state
    channelState.responseText = '';
    channelState.lastMsgId = thinkingMsgId;
    channelState.isProcessing = true;

    // Send message to runner
    const payload = JSON.stringify({ type: 'stdin', data: `${text}\n` });
    channelState.socket!.write(`${payload}\n`);

    // Update session activity timestamp
    this.db.touchSessionActivity(channelState.sessionId);

    console.log(`[MossActionExecutor] Sent message to runner for ${channelUserKey}`);

    // Wait for response with timeout (5 min)
    const responsePromise = new Promise<string>((resolve) => {
      const timeout = setTimeout(() => {
        channelState!.isProcessing = false;
        resolve(channelState!.responseText || 'Response timed out. Please try again.');
      }, 5 * 60 * 1000);

      const checkInterval = setInterval(() => {
        if (!channelState!.isProcessing) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          resolve(channelState!.responseText || '');
        }
      }, 200);
    });

    // Stream response back to user with throttled edits
    let lastEditTime = 0;
    const editInterval = setInterval(() => {
      if (channelState!.isProcessing && channelState!.lastMsgId && channelState!.responseText) {
        const now = Date.now();
        if (now - lastEditTime >= MossActionExecutor.EDIT_THROTTLE_MS) {
          lastEditTime = now;
          editFn(channelState!.lastMsgId, {
            type: 'text',
            text: channelState!.responseText,
            parseMode: 'HTML',
          }).catch(() => {});
        }
      }
    }, MossActionExecutor.EDIT_THROTTLE_MS);

    const finalText = await responsePromise;
    clearInterval(editInterval);

    // Send final response
    // For platforms that support editMessage (Telegram, Lark, DingTalk, WeCom):
    //   edit the "thinking" message in-place to show the final answer.
    // For platforms that don't (WeChat): send a new message instead.
    if (finalText) {
      if (platform === 'wechat' || platform === 'wecom') {
        await sendFn({
          type: 'text',
          text: finalText,
          parseMode: 'HTML',
        });
      } else if (channelState.lastMsgId) {
        await editFn(channelState.lastMsgId, {
          type: 'text',
          text: finalText,
          parseMode: 'HTML',
          // replyMarkup signals DingTalk AI card finalization; omit for other platforms
          ...(platform === 'dingtalk' ? { replyMarkup: {} } : {}),
        }).catch(() => {
          // Edit failed, send as new message
          void sendFn({ type: 'text', text: finalText, parseMode: 'HTML' });
        });
      } else {
        await sendFn({
          type: 'text',
          text: finalText,
          parseMode: 'HTML',
        });
      }
    }

    console.log(`[MossActionExecutor] Response sent for ${channelUserKey} (${finalText.length} chars)`);
  }

  /**
   * Create a new Moss runtime session and connect to its runner
   */
  private async createRuntimeSession(
    channelUserKey: string,
    channelUser: IChannelUser,
    platform: string,
    chatId: string,
  ): Promise<ChannelSessionState> {
    console.log(`[MossActionExecutor] Creating runtime session for ${channelUserKey}`);

    // Clean up any existing in-memory session
    const existing = this.channelSessions.get(channelUserKey);
    if (existing?.socket) {
      existing.socket.destroy();
    }

    // Resolve the Moss platform user (channel plugin owner) so sessions are visible in the management UI
    const pluginId = `${platform}_default`;
    const plugin = this.db.getChannelPlugin(pluginId);
    const mossUserId = plugin ? String(plugin.user_id) : 'channel';
    // org_id from plugin, fall back to users table lookup
    let mossOrgId: string | null = plugin?.org_id ? String(plugin.org_id) : null;
    if (!mossOrgId && mossUserId !== 'channel') {
      mossOrgId = this.db.getUserOrgId(mossUserId);
    }
    if (!mossOrgId) {
      mossOrgId = 'channel';
      console.warn(`[MossActionExecutor] Cannot determine org_id for plugin owner ${mossUserId}. Session may not appear in management UI.`);
    }

    // Try to reuse an existing DB session for this channel user
    const existingSession = this.db.findChannelSession(platform, chatId, mossUserId);
    const displayName = channelUser.displayName || chatId;

    if (existingSession && ['creating', 'active', 'detached'].includes(existingSession.status)) {
      // Reuse existing session — try to reconnect
      console.log(`[MossActionExecutor] Reusing existing session ${existingSession.sessionId} for ${channelUserKey}`);
      try {
        const ready = await this.runtime.ensureSessionReady(existingSession.sessionId);
        const socket = await this.runtime.connectToAttempt(ready.attempt);

        const state: ChannelSessionState = {
          sessionId: existingSession.sessionId,
          socket,
          buffer: '',
          responseText: '',
          lastMsgId: null,
          isProcessing: false,
        };

        socket.on('data', (chunk: Buffer) => {
          state.buffer += chunk.toString('utf8');
          this.processSocketBuffer(state);
        });

        socket.on('close', () => {
          console.log(`[MossActionExecutor] Runner socket closed for ${channelUserKey}`);
          state.socket = null;
        });

        socket.on('error', (err) => {
          console.error(`[MossActionExecutor] Runner socket error for ${channelUserKey}:`, err);
          state.socket = null;
        });

        this.channelSessions.set(channelUserKey, state);
        this.db.touchSessionActivity(existingSession.sessionId);
        return state;
      } catch (error) {
        console.log(`[MossActionExecutor] Failed to reconnect session ${existingSession.sessionId}, creating new one:`, error);
      }
    }

    // Create new Moss runtime session
    const created = await this.runtime.createSession({
      cwd: process.cwd(),
      dangerouslySkipPermissions: true,
      userId: mossUserId,
      orgId: mossOrgId,
      role: 'user',
      scopes: ['sessions:create', 'sessions:attach:any'],
      source: platform,
      channelChatId: chatId,
      assistantName: displayName,
    });

    const sessionId = created.sessionId;
    console.log(`[MossActionExecutor] Created runtime session ${sessionId} for ${channelUserKey}`);

    // Connect to the runner's attach socket
    const ready = await this.runtime.ensureSessionReady(sessionId);
    const socket = await this.runtime.connectToAttempt(ready.attempt);

    // Set up response listener
    const state: ChannelSessionState = {
      sessionId,
      socket,
      buffer: '',
      responseText: '',
      lastMsgId: null,
      isProcessing: false,
    };

    socket.on('data', (chunk: Buffer) => {
      state.buffer += chunk.toString('utf8');
      this.processSocketBuffer(state);
    });

    socket.on('close', () => {
      console.log(`[MossActionExecutor] Runner socket closed for ${channelUserKey}`);
      state.socket = null;
    });

    socket.on('error', (err) => {
      console.error(`[MossActionExecutor] Runner socket error for ${channelUserKey}:`, err);
      state.socket = null;
    });

    this.channelSessions.set(channelUserKey, state);

    // Update channel session with Moss session ID as conversationId
    this.sessionManager.updateSessionConversation(
      this.sessionManager.getSession(channelUser.id, chatId)?.id || '',
      sessionId,
    );

    return state;
  }

  /**
   * Reconnect to an existing runtime session
   */
  private async reconnectRuntimeSession(
    channelUserKey: string,
    sessionId: string,
  ): Promise<ChannelSessionState> {
    console.log(`[MossActionExecutor] Reconnecting to runtime session ${sessionId}`);

    const ready = await this.runtime.ensureSessionReady(sessionId);
    const socket = await this.runtime.connectToAttempt(ready.attempt);

    const state: ChannelSessionState = {
      sessionId,
      socket,
      buffer: '',
      responseText: '',
      lastMsgId: null,
      isProcessing: false,
    };

    socket.on('data', (chunk: Buffer) => {
      state.buffer += chunk.toString('utf8');
      this.processSocketBuffer(state);
    });

    socket.on('close', () => {
      state.socket = null;
    });

    socket.on('error', (err) => {
      console.error(`[MossActionExecutor] Reconnect socket error:`, err);
      state.socket = null;
    });

    this.channelSessions.set(channelUserKey, state);
    return state;
  }

  /**
   * Process buffered data from the runner socket
   */
  private processSocketBuffer(state: ChannelSessionState): void {
    while (true) {
      const idx = state.buffer.indexOf('\n');
      if (idx < 0) break;

      const line = state.buffer.slice(0, idx);
      state.buffer = state.buffer.slice(idx + 1);

      if (!line.trim()) continue;

      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'stdout' && typeof parsed.line === 'string') {
          this.handleRunnerMessage(state, parsed.line);
        } else if (parsed.type === 'exit') {
          state.isProcessing = false;
          state.socket = null;
        }
      } catch {
        // Not valid JSON, try as raw text
        this.handleRunnerMessage(state, line);
      }
    }
  }

  /**
   * Handle a single message from the session runner
   */
  private handleRunnerMessage(state: ChannelSessionState, line: string): void {
    try {
      const msg = JSON.parse(line);

      let text = '';

      if (msg.type === 'assistant') {
        // Handle both msg.content and msg.message.content formats
        const content = msg.content ?? msg.message?.content;
        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              text += block.text;
            }
          }
        }
      } else if (msg.type === 'text' && msg.text) {
        text = msg.text;
      } else if (msg.type === 'content_block_delta' && msg.delta?.text) {
        text = msg.delta.text;
      } else if (msg.type === 'tips' && msg.content?.content) {
        text = msg.content.content;
      } else if (msg.type === 'finish' || msg.type === 'result') {
        state.isProcessing = false;
        return;
      } else if (msg.type === 'error') {
        state.responseText = `❌ Error: ${msg.message || msg.error || 'Unknown error'}`;
        state.isProcessing = false;
        return;
      }

      if (text) {
        state.responseText += text;
      }
    } catch {
      // If not parseable JSON, treat as raw text
      if (line.trim()) {
        state.responseText += line;
      }
    }
  }

  /**
   * Get channel user from database
   */
  private getChannelUser(platformUserId: string, platformType: string): IChannelUser | null {
    const row = this.db.getChannelUserByPlatform(platformUserId, platformType);
    if (!row) return null;
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

  /**
   * Auto-authorize a user (for WeChat/WeCom)
   */
  private autoAuthorizeUser(
    user: { id: string; displayName?: string },
    platform: string,
    mossUserId?: string,
  ): IChannelUser | null {
    const existing = this.getChannelUser(user.id, platform);
    if (existing) return existing;

    const now = Date.now();
    const newUserId = `${platform}_${user.id}_${now}`;
    const channelUser: IChannelUser = {
      id: newUserId,
      platformUserId: user.id,
      platformType: platform as PluginType,
      displayName: user.displayName || user.id,
      authorizedAt: now,
    };

    this.db.upsertChannelUser({
      id: channelUser.id,
      platform_user_id: channelUser.platformUserId,
      platform_type: channelUser.platformType,
      display_name: channelUser.displayName ?? null,
      authorized_at: channelUser.authorizedAt,
      last_active: null,
      session_id: null,
      org_id: null,
      user_id: mossUserId ?? null,
    });

    getChannelEventEmitter().emitUserAuthorized(channelUser);

    console.log(`[MossActionExecutor] Auto-authorized ${platform} user: ${user.id}`);
    return channelUser;
  }

  /**
   * Handle pairing flow for unauthorized users
   */
  private async handlePairingFlow(
    platform: string,
    user: { id: string; displayName?: string },
    sendFn: (msg: any) => Promise<string | null>,
    mossUserId?: string,
  ): Promise<void> {
    try {
      const { code, expiresAt } = await this.pairingService.refreshPairingCode(
        user.id,
        platform,
        user.displayName,
        mossUserId,
      );

      const ttlMin = Math.max(1, Math.ceil((expiresAt - Date.now()) / 60000));
      await sendFn({
        type: 'text',
        text: `🔐 <b>Authorization Required</b>\n\nPlease enter this pairing code in SudoWork to connect:\n\n<b>${code}</b>\n\n⏱️ Expires in ${ttlMin} minutes`,
        parseMode: 'HTML',
        noStreaming: true,
      });

      console.log(`[MossActionExecutor] Pairing code ${code} sent to ${platform} user ${user.id}`);
    } catch (error) {
      console.error(`[MossActionExecutor] Failed to generate pairing code:`, error);
      await sendFn({
        type: 'text',
        text: '❌ Failed to generate pairing code. Please try again later.',
        parseMode: 'HTML',
        noStreaming: true,
      });
    }
  }
}
