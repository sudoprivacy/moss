/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

import net from 'net';
import type { RuntimeService } from '../../server/runtimeService.js';
import type { DirectConnectStore } from '../../server/db.js';
import type { ChannelAgentResolver, IChannelAgentOption } from './ChannelAgentResolver.js';
import type { PluginManager } from './PluginManager.js';
import type { SessionManager } from '../core/SessionManager.js';
import type { PairingService } from '../pairing/PairingService.js';
import type { PluginMessageHandler, BasePlugin } from '../plugins/BasePlugin.js';
import type { IUnifiedIncomingMessage, IChannelUser, PluginType } from '../types.js';
import { pluginScope, scopedChatId, defaultPluginId, pluginTypeFromId } from '../types.js';
import { getChannelEventEmitter } from '../core/ChannelEventEmitter.js';
import { classifyMossSession } from '../../server/sessionRecovery.js';
import { buildTranscriptSeed } from './transcriptSeed.js';
import { getSystemSettings } from '../../server/systemSettings.js';

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

  /** `platform:chatId` -> context seed awaiting the next session spawn. Written by a
   *  history-preserving reset (a wedged session the user asked to rescue), consumed by
   *  the next createRuntimeSession for that chat. In-memory only: a seed that does not
   *  survive a server restart is an acceptable loss, and persisting it would mean
   *  another table. */
  private pendingSeeds: Map<string, string> = new Map();

  /** Throttle interval for editMessage (ms) */
  private static readonly EDIT_THROTTLE_MS = 500;

  /** Resolves which agent (智能体) each chat runs as; undefined disables agent switching. */
  private agentResolver?: ChannelAgentResolver;

  constructor(
    pluginManager: PluginManager,
    sessionManager: SessionManager,
    pairingService: PairingService,
    runtime: RuntimeService,
    db: DirectConnectStore,
    agentResolver?: ChannelAgentResolver,
  ) {
    this.pluginManager = pluginManager;
    this.sessionManager = sessionManager;
    this.pairingService = pairingService;
    this.runtime = runtime;
    this.db = db;
    this.agentResolver = agentResolver;
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
    // Which CONNECTION received this. A user may have several bots of one type connected;
    // everything keyed below (session, authorization, agent binding) must stay per-bot, or
    // one bot answers with another's conversation.
    const pluginId = instanceKey ? instanceKey.split(':')[0] : defaultPluginId(platform);

    // Use the source plugin directly for sending responses (no lookup needed)
    const sendFn = async (msg: any) => sourcePlugin.sendMessage(chatId, msg);
    const editFn = async (msgId: string, msg: any) => sourcePlugin.editMessage(chatId, msgId, msg);

    try {
      // 1. Check authorization
      const isAuthorized = this.pairingService.isUserAuthorized(user.id, pluginScope(pluginId, platform), mossUserId);

      // Handle /start command
      if (content.type === 'command' && content.text === '/start') {
        if (platform === 'wechat' || platform === 'wecom') {
          // Auto-authorize and continue
        } else {
          await this.handlePairingFlow(platform, pluginId, user, sendFn, mossUserId);
          return;
        }
      }

      // If not authorized, handle based on platform
      if (!isAuthorized) {
        if (platform === 'wechat' || platform === 'wecom') {
          // Auto-authorize WeChat/WeCom users
          this.autoAuthorizeUser(user, platform, pluginId, mossUserId);
        } else {
          // Show pairing flow for other platforms
          await this.handlePairingFlow(platform, pluginId, user, sendFn, mossUserId);
          return;
        }
      }

      // 2. Agent (智能体) switching. Handled before the text gate because some platforms
      //    deliver "/agent ..." as type 'command' rather than 'text'.
      const commandText = (content.text || '').trim();
      if (
        (content.type === 'text' || content.type === 'command') &&
        /^\/agents?(\s|$)/i.test(commandText)
      ) {
        await this.handleAgentCommand(platform, pluginId, chatId, commandText, sendFn, mossUserId);
        return;
      }

      // 2b. "/restart" — rebuild a wedged session WITHOUT losing the thread.
      //     Distinct from the agent-switch reset, which intentionally discards
      //     context: here the user wants the same conversation, just unstuck, so
      //     we summarize the transcript before terminating and seed the successor.
      if (
        (content.type === 'text' || content.type === 'command') &&
        /^\/(restart|重启|恢复)(\s|$)/i.test(commandText)
      ) {
        if (!mossUserId) {
          await sendFn({ type: 'text', text: '无法确定该渠道的归属用户，暂时无法重启会话。', parseMode: 'HTML' });
          return;
        }
        await this.resetChatSession(platform, pluginId, chatId, mossUserId, { preserveHistory: true });
        const rescued = this.pendingSeeds.has(`${platform}:${scopedChatId(pluginId, platform, chatId)}`);
        await sendFn({
          type: 'text',
          text: rescued
            ? '🔄 会话已重启，并保留了最近的对话摘要。工具调用等中间状态无法恢复。'
            : '🔄 会话已重启。未找到可保留的历史记录，将从空白开始。',
          parseMode: 'HTML',
        });
        return;
      }

      // 3. Only process text messages for now
      if (content.type !== 'text' || !content.text) {
        console.log(`[MossActionExecutor] Skipping non-text message type: ${content.type}`);
        return;
      }

      // 3. Per-conversation mutex
      const lockKey = `${pluginScope(pluginId, platform)}:${user.id}:${chatId}`;
      const existingLock = this.conversationLocks.get(lockKey);
      if (existingLock) {
        console.log(`[MossActionExecutor] Message already being processed for ${lockKey}, queuing`);
        await existingLock;
      }

      const lockPromise = this.processMessage(platform, pluginId, chatId, user, content.text, sendFn, editFn, mossUserId);
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
    pluginId: string,
    chatId: string,
    user: { id: string; displayName?: string },
    text: string,
    sendFn: (msg: any) => Promise<string | null>,
    editFn: (msgId: string, msg: any) => Promise<boolean>,
    mossUserId: string | undefined,
  ): Promise<void> {
    // Scope every key below to the receiving connection: two bots of one type must not
    // share a session, a turn counter or an agent binding.
    const scope = pluginScope(pluginId, platform);
    const sChatId = scopedChatId(pluginId, platform, chatId);
    const channelUserKey = `${scope}:${user.id}:${chatId}`;

    // Get/create channel user
    let channelUser = this.getChannelUser(user.id, scope, mossUserId);
    if (!channelUser) {
      // Should have been created by auto-authorize or pairing, but create as fallback
      channelUser = this.autoAuthorizeUser(user, platform, pluginId, mossUserId);
      if (!channelUser) {
        await sendFn({ type: 'text', text: '❌ Authorization failed. Please try again.', parseMode: 'HTML' });
        return;
      }
    }

    // Get/create channel session
    let session = this.sessionManager.getSession(channelUser.id, sChatId);
    if (!session || !session.conversationId) {
      // Create a new channel session with conversationId = channelUserKey (used as Moss session ID)
      session = this.sessionManager.createSession(
        channelUser,
        'acp',
        undefined,
        sChatId,
      );
    }

    // Conversation depth drives turn-cap rotation. Counted per CHAT (on the
    // channel_sessions row), so it accumulates across idle revives and survives
    // rotation — counting per runtime session would reset on every idle recycle,
    // which is the most common IM path, and the cap would never fire.
    const turnCount = this.db.incrementChannelSessionTurnCount(channelUser.id, sChatId);
    const rotation = await this.planRotation(turnCount, mossUserId, platform, pluginId, chatId);

    // Get or create Moss runtime session
    let channelState = this.channelSessions.get(channelUserKey);
    if (rotation.rotate || !channelState || !channelState.socket || channelState.socket.destroyed) {
      // A cold start here is a full `docker run`; before this change only brand-new
      // chats paid it, now every post-idle message does. Tell the user something is
      // happening rather than leaving "⏳ Thinking..." to sit silently.
      if (rotation.notice) {
        try {
          await sendFn({ type: 'text', text: rotation.notice, parseMode: 'HTML' });
        } catch { /* notice is best-effort */ }
      }
      try {
        channelState = await this.createRuntimeSession(
          channelUserKey,
          channelUser,
          platform,
          pluginId,
          chatId,
          mossUserId,
          { forceReplace: rotation.rotate, seedText: rotation.seedText },
        );
        if (rotation.rotate) {
          // Only after a rotation actually produced a new runtime session.
          this.db.resetChannelSessionTurnCount(channelUser.id, sChatId);
        }
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
      if (platform === 'wechat') {
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
          // replyMarkup signals stream/card finalization for DingTalk AI cards and for the
          // WeCom stream that carried the "thinking" placeholder; omit for other platforms.
          ...(platform === 'dingtalk' || platform === 'wecom' ? { replyMarkup: {} } : {}),
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
   * Decide whether this chat has accumulated enough turns to warrant retiring its
   * runtime session, and build the seed that carries context into the successor.
   *
   * Why a cap at all: the runtime re-compacts its own transcript every turn,
   * nesting each prior summary inside a new "Previously compacted context"
   * wrapper (~+12KB/cycle), so a session reused forever eventually overflows the
   * model context with [single_request_too_large] — the same growth cron bounds
   * with cronReuseMaxRuns. Before the revive fix above, IM never hit this because
   * idle recycling reset the depth every 10 minutes; now that sessions genuinely
   * persist, the ceiling is real and rotation is what keeps it bounded.
   */
  private async planRotation(
    turnCount: number,
    mossUserId: string | undefined,
    platform: string,
    pluginId: string,
    chatId: string,
  ): Promise<{ rotate: boolean; seedText?: string; notice?: string }> {
    const sChatId = scopedChatId(pluginId, platform, chatId);
    let cap = 0;
    try {
      cap = Number(getSystemSettings().imReuseMaxTurns ?? 0);
    } catch {
      return { rotate: false };
    }
    // 0 or negative disables rotation (reuse forever), same as cronReuseMaxRuns.
    if (!Number.isFinite(cap) || cap <= 0 || turnCount <= cap) return { rotate: false };

    const previous = mossUserId ? this.db.findChannelSession(platform, sChatId, mossUserId) : null;
    const seedText = await this.buildSeedForSession(previous?.sessionId);

    console.log(
      `[MossActionExecutor] [session-rotate] chat ${platform}:${sChatId} hit turn cap ` +
      `(${turnCount} > ${cap}); retiring ${previous?.sessionId ?? 'n/a'}` +
      `${seedText ? ` with ${seedText.length} chars of seed` : ' without seed'}`,
    );

    // Retire the old runtime session so the fresh one does not inherit its depth.
    // Best-effort: a failed terminate must not block the user's message.
    if (previous?.sessionId) {
      try {
        await this.runtime.terminateSession(previous.sessionId);
      } catch (error) {
        console.warn(`[MossActionExecutor] failed to retire session ${previous.sessionId}:`, error);
      }
    }

    return {
      rotate: true,
      seedText,
      // Be honest that this is lossy: the seed keeps the thread of the
      // conversation, not tool state or file context.
      notice: seedText
        ? '♻️ 对话较长，已重建会话并保留最近对话摘要。'
        : '♻️ 对话较长，已重建会话。',
    };
  }

  /**
   * Summarize a session's transcript for seeding its successor. Returns '' when
   * there is nothing to carry over. Never throws — a failed seed degrades to a
   * plain fresh session rather than breaking the user's message.
   */
  private async buildSeedForSession(sessionId?: string): Promise<string | undefined> {
    if (!sessionId) return undefined;
    try {
      const snapshot = this.runtime.getSession(sessionId);
      const transcriptPath = snapshot?.transcriptPath;
      if (!transcriptPath) return undefined;
      const seed = await buildTranscriptSeed(transcriptPath);
      return seed || undefined;
    } catch (error) {
      console.warn(`[MossActionExecutor] failed to build seed from ${sessionId}:`, error);
      return undefined;
    }
  }

  /**
   * Create a new Moss runtime session and connect to its runner
   */
  private async createRuntimeSession(
    channelUserKey: string,
    channelUser: IChannelUser,
    platform: string,
    pluginId: string,
    chatId: string,
    ownerUserId: string | undefined,
    options: { forceReplace?: boolean; seedText?: string } = {},
  ): Promise<ChannelSessionState> {
    const sChatId = scopedChatId(pluginId, platform, chatId);
    console.log(`[MossActionExecutor] Creating runtime session for ${channelUserKey}`);

    // A rescue reset may have stashed context for this chat; it applies to whichever
    // session spawns next. Consume it either way so a stale seed cannot leak into a
    // later, unrelated session.
    const seedKey = `${platform}:${sChatId}`;
    const stashedSeed = this.pendingSeeds.get(seedKey);
    if (stashedSeed) this.pendingSeeds.delete(seedKey);
    const seedText = options.seedText ?? stashedSeed;

    // Clean up any existing in-memory session
    const existing = this.channelSessions.get(channelUserKey);
    if (existing?.socket) {
      existing.socket.destroy();
    }

    // Resolve the Moss platform user (channel plugin owner) so sessions are visible in the
    // management UI. The owner comes from the receiving plugin instance: channel_plugins is
    // keyed (id, user_id), so looking up an id without a user_id returns an arbitrary row
    // and would attribute the session to the wrong user whenever more than one user has
    // connected this platform.
    const plugin = ownerUserId ? this.db.getChannelPlugin(pluginId, ownerUserId) : null;
    const mossUserId = ownerUserId || (plugin ? String(plugin.user_id) : 'channel');
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
    const existingSession = this.db.findChannelSession(platform, sChatId, mossUserId);
    const displayName = channelUser.displayName || chatId;

    // Recovery classification is shared with cabin/cron (see sessionRecovery.ts).
    // The status allowlist this used to hard-code excluded 'ended', which is what
    // the runner daemon writes when it recycles an idle session while leaving
    // desired_state='active' ("user still wants this, respawn it"). Dropping that
    // signal is why IM chats silently lost their history after idleTimeoutMs:
    // ensureSessionReady() would have respawned the runtime and replayed the
    // transcript via ACP session/load, but we never called it.
    //
    // 'reuse' and 'recover' both proceed to ensureSessionReady — it reconnects a
    // live attach socket or respawns a dead one. 'replace' falls through to a
    // fresh session below, seeded from the old transcript when possible.
    const recovery = existingSession && !options.forceReplace
      ? classifyMossSession(this.runtime.getSessionSnapshot(existingSession.sessionId))
      : 'replace';

    // A session that died on its own (crashed runtime, lost container) still has its
    // transcript on disk — terminateSession only kills the process and flips status, and
    // nothing ever deletes transcripts. Rotation and /restart already carry that history
    // into the successor; a crash used to be the one replace path that silently dropped it,
    // which reads to the user as "the bot forgot everything because it fell over".
    //
    // Deliberate terminations are excluded on purpose: 'terminated' is what /agent writes
    // when the user switches agent, and that flow means to start clean. Seeding it would
    // undo the reset the user just asked for.
    let recoveredSeed: string | undefined;
    if (
      existingSession &&
      recovery === 'replace' &&
      !options.forceReplace &&
      !seedText
    ) {
      const status = this.runtime.getSessionSnapshot(existingSession.sessionId)?.status;
      if (status === 'lost' || status === 'failed') {
        recoveredSeed = await this.buildSeedForSession(existingSession.sessionId);
        console.log(
          `[MossActionExecutor] [session-rescue] ${status} session ${existingSession.sessionId} ` +
          `for ${channelUserKey}` +
          `${recoveredSeed ? ` — carrying ${recoveredSeed.length} chars of history` : ' — no history to carry'}`,
        );
      }
    }
    const effectiveSeed = seedText ?? recoveredSeed;

    if (existingSession && recovery !== 'replace') {
      console.log(
        `[MossActionExecutor] [session-revive] ${recovery} session ${existingSession.sessionId} ` +
        `(status=${existingSession.status}) for ${channelUserKey}`,
      );
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

    // Bind the agent (智能体) this chat is set to. `assistantName` is what RuntimeService
    // resolves memory_mode / enabledSkills from and signs into the session token, so it must
    // be the agent's name — not the chat user's display name, which never matches an agent
    // and silently degrades to a generic session with every skill enabled.
    let activeAgent: IChannelAgentOption | null = null;
    if (this.agentResolver) {
      try {
        activeAgent = await this.agentResolver.resolveActiveAgent({
          platform,
          pluginId,
          chatId,
          ownerUserId: ownerUserId,
        });
      } catch (error) {
        console.warn('[MossActionExecutor] failed to resolve active agent:', error);
      }
    }
    if (activeAgent) {
      console.log(`[MossActionExecutor] Session for ${channelUserKey} bound to agent ${activeAgent.name}`);
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
      channelChatId: sChatId,
      ...(activeAgent
        ? { assistantName: activeAgent.name, assistantDisplayName: activeAgent.displayName }
        : { assistantName: displayName }),
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

    // Seed the fresh session with a summary of the conversation it replaces, so a
    // rotation (turn cap), a stuck-session reset, or a crashed runtime does not read
    // to the user as total amnesia. Sent as a plain turn before the user's message; the runtime
    // answers it, but processMessage is not waiting on this write, so the reply is
    // absorbed as context rather than delivered to the chat.
    if (effectiveSeed) {
      try {
        socket.write(`${JSON.stringify({ type: 'stdin', data: `${effectiveSeed}\n` })}\n`);
        console.log(
          `[MossActionExecutor] [session-seed] seeded ${sessionId} with ${effectiveSeed.length} chars of prior context`,
        );
      } catch (error) {
        // A failed seed costs continuity, not correctness — the session still works.
        console.warn(`[MossActionExecutor] failed to seed session ${sessionId}:`, error);
      }
    }

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
  private getChannelUser(platformUserId: string, scope: string, mossUserId?: string): IChannelUser | null {
    const row = this.db.getChannelUserByPlatform(platformUserId, scope, mossUserId);
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
    pluginId: string,
    mossUserId?: string,
  ): IChannelUser | null {
    const scope = pluginScope(pluginId, platform);
    const existing = this.getChannelUser(user.id, scope, mossUserId);
    if (existing) return existing;

    const now = Date.now();
    const newUserId = `${scope}_${user.id}_${now}`;
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
      plugin_scope: scope,
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
  /**
   * Handle "/agents" (list) and "/agent <name>" (switch).
   *
   * Switching cannot be applied to a live session: RuntimeService binds the agent at spawn
   * time (it is baked into the pre-signed session token as `assistant_id`). So a switch
   * terminates the current session and lets the next message spawn a fresh one bound to the
   * chosen agent — which means conversation context is lost, and we say so explicitly.
   */
  private async handleAgentCommand(
    platform: string,
    pluginId: string,
    chatId: string,
    commandText: string,
    sendFn: (msg: any) => Promise<string | null>,
    mossUserId: string | undefined,
  ): Promise<void> {
    const send = (text: string) => sendFn({ type: 'text', text, parseMode: 'HTML' });

    if (!this.agentResolver) {
      await send('当前部署未启用智能体切换。');
      return;
    }
    if (!mossUserId) {
      await send('无法确定该渠道的归属用户，暂时无法切换智能体。');
      return;
    }

    const agents = await this.agentResolver.listAgents(mossUserId);
    const active = await this.agentResolver.resolveActiveAgent({ platform, pluginId, chatId, ownerUserId: mossUserId });

    // Everything after the command word is the requested agent name (may contain spaces).
    const argument = commandText.replace(/^\/agents?/i, '').trim();

    if (!argument) {
      if (agents.length === 0) {
        await send('当前没有可用的智能体。');
        return;
      }
      const lines = agents.map((a, i) => {
        const marker = active && a.name === active.name ? ' ✅' : '';
        return `${i + 1}. ${a.displayName}${marker}`;
      });
      await send(
        `当前智能体：${active ? active.displayName : '默认（未指定）'}\n\n可用智能体：\n${lines.join('\n')}\n\n发送 /agent <名称> 切换。`,
      );
      return;
    }

    if (argument === 'default' || argument === '默认') {
      await this.agentResolver.setChatAgent({ platform, pluginId, chatId, ownerUserId: mossUserId, agentName: null });
      await this.resetChatSession(platform, pluginId, chatId, mossUserId);
      await send('已恢复为默认智能体。⚠️ 新会话已开始，之前的对话上下文不会保留。');
      return;
    }

    const matched = this.agentResolver.matchAgent(argument, agents);
    if (!matched) {
      const names = agents.map((a) => a.displayName).join('、') || '（无）';
      await send(`未找到智能体「${argument}」。\n可用：${names}`);
      return;
    }
    if (active && matched.name === active.name) {
      await send(`当前已经是「${matched.displayName}」，无需切换。`);
      return;
    }

    const result = await this.agentResolver.setChatAgent({
      platform,
      pluginId,
      chatId,
      ownerUserId: mossUserId,
      agentName: matched.name,
    });
    if (!result.ok) {
      await send(`切换失败：${result.error}`);
      return;
    }

    await this.resetChatSession(platform, pluginId, chatId, mossUserId);
    await send(`已切换到「${matched.displayName}」。⚠️ 新会话已开始，之前的对话上下文不会保留。`);
  }

  /**
   * Tear down this chat's runtime session so the next message spawns a fresh one bound to
   * the newly selected agent. Only this chat is affected — other chats on the same
   * connection keep their own sessions.
   */
  private async resetChatSession(
    platform: string,
    pluginId: string,
    chatId: string,
    mossUserId: string,
    options: { preserveHistory?: boolean } = {},
  ): Promise<void> {
    const scope = pluginScope(pluginId, platform);
    const sChatId = scopedChatId(pluginId, platform, chatId);
    // When the user is recovering a WEDGED session (rather than deliberately
    // starting over), capture a seed before tearing anything down — terminate
    // makes the session unrecoverable, and the transcript is the only record.
    // Stashed for the next createRuntimeSession call on this chat.
    if (options.preserveHistory) {
      const existing = this.db.findChannelSession(platform, sChatId, mossUserId);
      const seed = await this.buildSeedForSession(existing?.sessionId);
      if (seed) {
        this.pendingSeeds.set(`${platform}:${sChatId}`, seed);
        console.log(
          `[MossActionExecutor] [session-rescue] stashed ${seed.length} chars of context for ${platform}:${sChatId}`,
        );
      }
    }
    // The in-memory key is built from the IM user, which we do not have here, so drop every
    // cached entry pointing at this chat on this CONNECTION (scope, not platform — a
    // sibling bot's chat with the same raw chatId must keep its session).
    for (const [key, state] of [...this.channelSessions.entries()]) {
      if (!key.startsWith(`${scope}:`) || !key.endsWith(`:${chatId}`)) continue;
      try {
        state.socket?.destroy();
      } catch { /* already gone */ }
      this.channelSessions.delete(key);
      try {
        await this.runtime.terminateSession(state.sessionId);
      } catch (error) {
        console.warn(`[MossActionExecutor] failed to terminate session ${state.sessionId}:`, error);
      }
    }

    // Also end any DB session recorded for this chat, so createRuntimeSession does not
    // resume it instead of creating one under the new agent.
    try {
      const existing = this.db.findChannelSession(platform, sChatId, mossUserId);
      // Terminate anything not already terminated. The old allowlist stopped at
      // 'detached', which was harmless while 'ended' sessions were never revived
      // — now that they are, leaving one alive would let the next message resume
      // the very session the user just asked to reset.
      if (existing && existing.status !== 'terminated') {
        await this.runtime.terminateSession(existing.sessionId);
      }
    } catch (error) {
      console.warn('[MossActionExecutor] failed to end stored channel session:', error);
    }
  }

  private async handlePairingFlow(
    platform: string,
    pluginId: string,
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
        pluginScope(pluginId, platform),
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
