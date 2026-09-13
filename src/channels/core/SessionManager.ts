/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DirectConnectStore } from '../../server/db.js';
import type { IChannelSession, IChannelUser, PluginType } from '../types.js';

/**
 * Generate a unique ID
 */
function uuid(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * SessionManager - Manages user sessions for Moss Server
 *
 * Sessions are keyed by composite key `${userId}:${chatId}` to support
 * per-chat isolation.
 */
export class SessionManager {
  // In-memory cache of active sessions keyed by composite key (userId:chatId)
  private activeSessions: Map<string, IChannelSession> = new Map();

  private db: DirectConnectStore;

  // Tracks the initial (and latest reload) load so consumers can await it.
  private readyPromise: Promise<void>;

  /**
   * E-3: serializes map-rebuilding mutations (reload) with row-creating
   * mutations (createSessionWithConversation). Their async interleaving could
   * double-insert the same (user_id, chat_id) — createSession's delete+insert
   * completes, then reload's earlier snapshot (taken before the insert) swaps
   * in and hides the new row, so the next getSession miss creates a SECOND
   * row (the table has no UNIQUE on that pair). A promise chain keeps the
   * critical sections ordered without blocking reads.
   */
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(db: DirectConnectStore) {
    this.db = db;
    // Store the load promise (previously fire-and-forget). Under PG the first
    // load is a network round-trip; a message arriving in that window would
    // otherwise miss the cache and take the "new session" branch, creating a
    // duplicate channel_sessions row. Consumers await whenReady() first.
    this.readyPromise = this.loadActiveSessions();
  }

  /** Resolves once the initial load (or latest reload) has completed. */
  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Rebuild the in-memory cache from the DB and re-arm whenReady(). Called
   * after a channel-plugin lease transfers to this instance (B8 failover): the
   * new holder's startup snapshot predates the sessions the previous holder
   * created, so without a reload getSession would miss them and create
   * duplicate channel_sessions rows. loadActiveSessions swaps a freshly-built
   * map in atomically, so a concurrent read never observes a half-empty cache.
   */
  reload(): Promise<void> {
    const run = this.mutationQueue.then(
      () => this.loadActiveSessions(),
      () => this.loadActiveSessions(),
    )
    this.readyPromise = run
    this.mutationQueue = run
    return run
  }

  /**
   * Build composite key for session lookup
   */
  private buildKey(userId: string, chatId?: string): string {
    return chatId ? `${userId}:${chatId}` : userId;
  }

  /**
   * Load active sessions from database into memory
   */
  private async loadActiveSessions(): Promise<void> {
    const rows = await this.db.listChannelSessions();

    // Build into a fresh map and swap it in atomically at the end, so a reload
    // never exposes a partially-populated cache to a concurrent reader.
    const next = new Map<string, IChannelSession>();
    for (const session of rows) {
      const key = this.buildKey(String(session.user_id), session.chat_id ? String(session.chat_id) : undefined);
      next.set(key, {
        id: String(session.id),
        userId: String(session.user_id),
        agentType: String(session.agent_type) as IChannelSession['agentType'],
        conversationId: session.conversation_id ? String(session.conversation_id) : undefined,
        workspace: session.workspace ? String(session.workspace) : undefined,
        chatId: session.chat_id ? String(session.chat_id) : undefined,
        createdAt: Number(session.created_at),
        lastActivity: Number(session.last_activity),
      });
    }
    this.activeSessions = next;
  }

  /**
   * Get session for a user (optionally scoped to a specific chat)
   */
  getSession(userId: string, chatId?: string): IChannelSession | null {
    return this.activeSessions.get(this.buildKey(userId, chatId)) ?? null;
  }

  /**
   * Get session by platform user
   */
  /**
   * `platformType` is the connection scope (see pluginScope) — the bare platform for a
   * type's first connection, the plugin id for additional ones.
   */
  async getSessionByPlatformUser(platformUserId: string, platformType: PluginType, chatId?: string): Promise<IChannelSession | null> {
    const row = await this.db.getChannelUserByPlatform(platformUserId, platformType);

    if (!row) {
      return null;
    }

    return this.getSession(String(row.id), chatId);
  }

  /**
   * Create a new session for a user
   */
  async createSession(user: IChannelUser, agentType: IChannelSession['agentType'] = 'acp', workspace?: string, chatId?: string): Promise<IChannelSession> {
    return this.createSessionWithConversation(user, uuid(), agentType, workspace, chatId);
  }

  /**
   * Create a new session with a specific conversation ID
   */
  async createSessionWithConversation(user: IChannelUser, conversationId: string, agentType: IChannelSession['agentType'] = 'acp', workspace?: string, chatId?: string): Promise<IChannelSession> {
    // E-3: run inside the same mutation queue as reload() — see the field's
    // note. The awaited DB round-trips below are exactly the windows across
    // which a concurrent reload's stale snapshot would hide this row.
    const run = this.mutationQueue.then(
      () => this.createSessionWithConversationLocked(user, conversationId, agentType, workspace, chatId),
      () => this.createSessionWithConversationLocked(user, conversationId, agentType, workspace, chatId),
    )
    this.mutationQueue = run.catch(() => {})
    return run
  }

  private async createSessionWithConversationLocked(user: IChannelUser, conversationId: string, agentType: IChannelSession['agentType'], workspace: string | undefined, chatId: string | undefined): Promise<IChannelSession> {
    const key = this.buildKey(user.id, chatId);

    // Clear existing session if any. Carry the chat's conversation depth across
    // the rebuild: the row is deleted and re-inserted under a new uuid, and the
    // IM turn cap measures cumulative depth per CHAT, not per row. Losing it here
    // would silently disarm the cap.
    const existingSession = this.activeSessions.get(key);
    let carriedTurnCount = 0;
    if (existingSession) {
      carriedTurnCount = await this.db.getChannelSessionTurnCount(user.id, chatId);
      await this.db.deleteChannelSession(existingSession.id);
    }

    // Create new session
    const now = Date.now();
    const session: IChannelSession = {
      id: uuid(),
      userId: user.id,
      agentType,
      workspace,
      conversationId,
      chatId,
      createdAt: now,
      lastActivity: now,
    };

    // Save to database
    await this.db.upsertChannelSession({
      id: session.id,
      user_id: session.userId,
      agent_type: session.agentType,
      conversation_id: session.conversationId ?? null,
      workspace: session.workspace ?? null,
      chat_id: session.chatId ?? null,
      created_at: session.createdAt,
      last_activity: session.lastActivity,
    });

    // Update in-memory cache
    this.activeSessions.set(key, session);

    if (carriedTurnCount > 0) {
      await this.db.setChannelSessionTurnCount(session.id, carriedTurnCount);
    }

    return session;
  }

  /**
   * Update session's conversation ID
   */
  async updateSessionConversation(sessionId: string, conversationId: string): Promise<boolean> {
    let foundKey: string | null = null;
    let foundSession: IChannelSession | null = null;
    for (const [key, s] of this.activeSessions.entries()) {
      if (s.id === sessionId) {
        foundKey = key;
        foundSession = s;
        break;
      }
    }

    if (!foundSession || !foundKey) {
      console.warn(`[SessionManager] Session ${sessionId} not found`);
      return false;
    }

    const updated: IChannelSession = {
      ...foundSession,
      conversationId,
      lastActivity: Date.now(),
    };

    await this.db.upsertChannelSession({
      id: updated.id,
      user_id: updated.userId,
      agent_type: updated.agentType,
      conversation_id: updated.conversationId ?? null,
      workspace: updated.workspace ?? null,
      chat_id: updated.chatId ?? null,
      created_at: updated.createdAt,
      last_activity: updated.lastActivity,
    });
    this.activeSessions.set(foundKey, updated);

    return true;
  }

  /**
   * Update session's last activity timestamp
   */
  async updateSessionActivity(userId: string, chatId?: string): Promise<void> {
    const key = this.buildKey(userId, chatId);
    const session = this.activeSessions.get(key);
    if (!session) return;

    const updated: IChannelSession = { ...session, lastActivity: Date.now() };
    this.activeSessions.set(key, updated);

    await this.db.upsertChannelSession({
      id: updated.id,
      user_id: updated.userId,
      agent_type: updated.agentType,
      conversation_id: updated.conversationId ?? null,
      workspace: updated.workspace ?? null,
      chat_id: updated.chatId ?? null,
      created_at: updated.createdAt,
      last_activity: updated.lastActivity,
    });
  }

  /**
   * Clear session for a user
   */
  async clearSession(userId: string, chatId?: string): Promise<boolean> {
    const key = this.buildKey(userId, chatId);
    const session = this.activeSessions.get(key);
    if (!session) {
      return false;
    }

    await this.db.deleteChannelSession(session.id);
    this.activeSessions.delete(key);

    return true;
  }

  /**
   * Clear all sessions
   */
  async clearAllSessions(): Promise<number> {
    let cleared = 0;
    for (const [key, session] of this.activeSessions.entries()) {
      await this.db.deleteChannelSession(session.id);
      this.activeSessions.delete(key);
      cleared++;
    }
    return cleared;
  }

  /**
   * Clear session by conversation ID
   */
  async clearSessionByConversationId(conversationId: string): Promise<IChannelSession | null> {
    let foundSession: IChannelSession | null = null;
    let foundKey: string | null = null;

    for (const [key, session] of this.activeSessions.entries()) {
      if (session.conversationId === conversationId) {
        foundSession = session;
        foundKey = key;
        break;
      }
    }

    if (!foundSession || !foundKey) {
      return null;
    }

    await this.db.deleteChannelSession(foundSession.id);
    this.activeSessions.delete(foundKey);

    return foundSession;
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): IChannelSession[] {
    return Array.from(this.activeSessions.values());
  }

  /**
   * Get session count
   */
  getSessionCount(): number {
    return this.activeSessions.size;
  }

  /**
   * Cleanup stale sessions.
   *
   * E-1: the freshness judgement comes from the SHARED DB, never from this
   * instance's in-memory copy. In multi-instance deployments only the
   * lease-holding instance exchanges messages for a plugin, so any OTHER
   * instance's in-memory lastActivity for that chat is frozen at load time —
   * judging by it (the old code) deleted rows that were actively exchanging
   * messages on the peer (their IM turn cap then reset on row revival).
   * Deleting by DB predicate is safe from every instance; the deleted ids
   * sync the local map.
   */
  async cleanupStaleSessions(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    const deletedIds = await this.db.deleteStaleChannelSessions(maxAgeMs);
    if (deletedIds.length > 0) {
      const deleted = new Set(deletedIds);
      for (const [key, session] of this.activeSessions.entries()) {
        if (deleted.has(session.id)) {
          this.activeSessions.delete(key);
        }
      }
      console.log(`[SessionManager] Cleaned up ${deletedIds.length} stale session(s)`);
    }
    return deletedIds.length;
  }
}
