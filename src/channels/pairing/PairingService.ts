/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DirectConnectStore } from '../../server/db.js';
import { getChannelEventEmitter } from '../core/ChannelEventEmitter.js';

/**
 * PairingService - Minimal implementation for Moss Server
 *
 * Handles pairing code generation and validation for channel users.
 */
class PairingService {
  private static instance: PairingService | null = null;
  private db: DirectConnectStore | null = null;

  private constructor() {}

  static getInstance(): PairingService {
    if (!PairingService.instance) {
      PairingService.instance = new PairingService();
    }
    return PairingService.instance;
  }

  /**
   * Initialize with database reference
   */
  initialize(db: DirectConnectStore): void {
    this.db = db;
  }

  /**
   * Get pending pairing requests
   */
  getPendingRequests(): Array<{
    code: string;
    platform_user_id: string;
    platform_type: string;
    display_name: string | null;
    requested_at: number;
    expires_at: number;
    status: string;
  }> {
    if (!this.db) return [];
    return this.db.listPendingPairingRequests();
  }

  /**
   * Check if user is already authorized
   */
  isUserAuthorized(platformUserId: string, platformType: string): boolean {
    if (!this.db) return false;
    const user = this.db.getChannelUserByPlatform(platformUserId, platformType);
    return !!user;
  }

  /**
   * Get pending request for user
   */
  getPendingRequestForUser(platformUserId: string, platformType: string): any {
    if (!this.db) return null;
    const requests = this.db.listPendingPairingRequests();
    const request = requests.find(
      (r) => String(r.platform_user_id) === platformUserId && String(r.platform_type) === platformType
    );
    if (!request) return null;
    return {
      code: String(request.code),
      platformUserId: String(request.platform_user_id),
      platformType: String(request.platform_type),
      displayName: request.display_name ? String(request.display_name) : undefined,
      requestedAt: Number(request.requested_at),
      expiresAt: Number(request.expires_at),
      status: String(request.status),
    };
  }

  /**
   * Refresh pairing code (invalidates old, generates new)
   */
  async refreshPairingCode(
    platformUserId: string,
    platformType: string,
    displayName?: string,
    userId?: string
  ): Promise<{ code: string; expiresAt: number }> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    // Invalidate existing pending requests for this user
    const existing = this.getPendingRequestForUser(platformUserId, platformType);
    if (existing) {
      this.db.updatePairingRequestStatus(existing.code, 'expired');
    }

    const ttlMs = 10 * 60 * 1000;
    const code = this.generatePairingCode(platformUserId, platformType, displayName, ttlMs, userId);
    return { code, expiresAt: Date.now() + ttlMs };
  }

  /**
   * Approve a pairing request
   */
  async approvePairing(code: string): Promise<{ success: boolean; error?: string; user?: any }> {
    if (!this.db) {
      return { success: false, error: 'Database not initialized' };
    }

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
    const user = {
      id: userId,
      platformUserId: String(row.platform_user_id),
      platformType: String(row.platform_type),
      displayName: row.display_name ? String(row.display_name) : undefined,
      authorizedAt: Date.now(),
    };

    // Update pairing status first
    this.db.updatePairingRequestStatus(code, 'approved');

    // Emit user authorized event
    getChannelEventEmitter().emitUserAuthorized(user);

    return { success: true, user };
  }

  /**
   * Reject a pairing request
   */
  async rejectPairing(code: string): Promise<{ success: boolean; error?: string }> {
    if (!this.db) {
      return { success: false, error: 'Database not initialized' };
    }

    const row = this.db.getPairingRequest(code);
    if (!row) {
      return { success: false, error: 'Invalid pairing code' };
    }

    this.db.updatePairingRequestStatus(code, 'rejected');

    // Emit pairing rejected event
    getChannelEventEmitter().emitPairingRejected(code);

    return { success: true };
  }

  /**
   * Generate a new pairing code
   */
  generatePairingCode(
    platformUserId: string,
    platformType: string,
    displayName?: string,
    ttlMs: number = 10 * 60 * 1000, // 10 minutes default
    userId?: string
  ): string {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const now = Date.now();

    this.db.upsertPairingRequest({
      code,
      platform_user_id: platformUserId,
      platform_type: platformType,
      display_name: displayName ?? null,
      requested_at: now,
      expires_at: now + ttlMs,
      status: 'pending',
      user_id: userId ?? null,
    });

    // Emit pairing requested event
    getChannelEventEmitter().emitPairingRequested({
      code,
      platformUserId,
      platformType: platformType as any,
      displayName,
      requestedAt: now,
      expiresAt: now + ttlMs,
      status: 'pending',
    });

    return code;
  }
}

export function getPairingService(): PairingService {
  return PairingService.getInstance();
}

export { PairingService };
