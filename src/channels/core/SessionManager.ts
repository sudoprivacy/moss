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

  constructor(db: DirectConnectStore) {
    this.db = db;
    this.loadActiveSessions();
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
  private loadActiveSessions(): void {
    const rows = this.db.listChannelSessions();

    for (const session of rows) {
      const key = this.buildKey(String(session.user_id), session.chat_id ? String(session.chat_id) : undefined);
      this.activeSessions.set(key, {
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
  getSessionByPlatformUser(platformUserId: string, platformType: PluginType, chatId?: string): IChannelSession | null {
    const row = this.db.getChannelUserByPlatform(platformUserId, platformType);

    if (!row) {
      return null;
    }

    return this.getSession(String(row.id), chatId);
  }

  /**
   * Create a new session for a user
   */
  createSession(user: IChannelUser, agentType: IChannelSession['agentType'] = 'acp', workspace?: string, chatId?: string): IChannelSession {
    return this.createSessionWithConversation(user, uuid(), agentType, workspace, chatId);
  }

  /**
   * Create a new session with a specific conversation ID
   */
  createSessionWithConversation(user: IChannelUser, conversationId: string, agentType: IChannelSession['agentType'] = 'acp', workspace?: string, chatId?: string): IChannelSession {
    const key = this.buildKey(user.id, chatId);

    // Clear existing session if any
    const existingSession = this.activeSessions.get(key);
    if (existingSession) {
      this.db.deleteChannelSession(existingSession.id);
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
    this.db.upsertChannelSession({
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

    return session;
  }

  /**
   * Update session's conversation ID
   */
  updateSessionConversation(sessionId: string, conversationId: string): boolean {
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

    this.db.upsertChannelSession({
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
  updateSessionActivity(userId: string, chatId?: string): void {
    const key = this.buildKey(userId, chatId);
    const session = this.activeSessions.get(key);
    if (!session) return;

    const updated: IChannelSession = { ...session, lastActivity: Date.now() };
    this.activeSessions.set(key, updated);

    this.db.upsertChannelSession({
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
  clearSession(userId: string, chatId?: string): boolean {
    const key = this.buildKey(userId, chatId);
    const session = this.activeSessions.get(key);
    if (!session) {
      return false;
    }

    this.db.deleteChannelSession(session.id);
    this.activeSessions.delete(key);

    return true;
  }

  /**
   * Clear all sessions
   */
  clearAllSessions(): number {
    let cleared = 0;
    for (const [key, session] of this.activeSessions.entries()) {
      this.db.deleteChannelSession(session.id);
      this.activeSessions.delete(key);
      cleared++;
    }
    return cleared;
  }

  /**
   * Clear session by conversation ID
   */
  clearSessionByConversationId(conversationId: string): IChannelSession | null {
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

    this.db.deleteChannelSession(foundSession.id);
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
   * Cleanup stale sessions
   */
  cleanupStaleSessions(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, session] of this.activeSessions.entries()) {
      if (now - session.lastActivity > maxAgeMs) {
        this.db.deleteChannelSession(session.id);
        this.activeSessions.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[SessionManager] Cleaned up ${cleaned} stale session(s)`);
    }

    return cleaned;
  }
}
