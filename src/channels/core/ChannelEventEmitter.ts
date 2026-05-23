/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IChannelPairingRequest, IChannelUser, IChannelPluginStatus } from '../types.js';

/**
 * Channel event types
 */
export type ChannelEventType =
  | 'pairingRequested'
  | 'userAuthorized'
  | 'userDeleted'
  | 'pluginStatusChanged'
  | 'pairingRejected';

/**
 * Channel event payload types
 */
export interface ChannelEventPayloads {
  pairingRequested: IChannelPairingRequest;
  userAuthorized: IChannelUser;
  userDeleted: { userId: string; platformType: string };
  pluginStatusChanged: IChannelPluginStatus;
  pairingRejected: { code: string };
}

/**
 * Channel event structure
 */
export interface ChannelEvent<T extends ChannelEventType> {
  type: T;
  payload: ChannelEventPayloads[T];
  timestamp: number;
}

/**
 * Event handler type
 */
export type ChannelEventHandler<T extends ChannelEventType> = (
  event: ChannelEvent<T>
) => void;

/**
 * ChannelEventEmitter - Singleton for emitting channel events to WebSocket clients
 *
 * In Moss Server, this is used to push events to connected admin clients.
 */
class ChannelEventEmitter {
  private static instance: ChannelEventEmitter | null = null;
  private handlers: Map<ChannelEventType, Set<ChannelEventHandler<any>>> = new Map();
  private broadcastCallback: ((event: ChannelEvent<any>) => void) | null = null;

  private constructor() {}

  static getInstance(): ChannelEventEmitter {
    if (!ChannelEventEmitter.instance) {
      ChannelEventEmitter.instance = new ChannelEventEmitter();
    }
    return ChannelEventEmitter.instance;
  }

  /**
   * Set the broadcast callback for WebSocket clients
   * Called by server.ts to connect WebSocket broadcasting
   */
  setBroadcastCallback(callback: (event: ChannelEvent<any>) => void): void {
    this.broadcastCallback = callback;
  }

  /**
   * Subscribe to a specific event type
   */
  on<T extends ChannelEventType>(
    eventType: T,
    handler: ChannelEventHandler<T>
  ): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(eventType)?.delete(handler);
    };
  }

  /**
   * Emit an event to all subscribers and broadcast to WebSocket clients
   */
  emit<T extends ChannelEventType>(
    eventType: T,
    payload: ChannelEventPayloads[T]
  ): void {
    const event: ChannelEvent<T> = {
      type: eventType,
      payload,
      timestamp: Date.now(),
    };

    // Notify local handlers
    const handlers = this.handlers.get(eventType);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (error) {
          console.error(`[ChannelEventEmitter] Handler error for ${eventType}:`, error);
        }
      }
    }

    // Broadcast to WebSocket clients
    if (this.broadcastCallback) {
      try {
        this.broadcastCallback(event);
      } catch (error) {
        console.error(`[ChannelEventEmitter] Broadcast error for ${eventType}:`, error);
      }
    }
  }

  /**
   * Emit pairing requested event
   */
  emitPairingRequested(request: IChannelPairingRequest): void {
    this.emit('pairingRequested', request);
  }

  /**
   * Emit user authorized event
   */
  emitUserAuthorized(user: IChannelUser): void {
    this.emit('userAuthorized', user);
  }

  /**
   * Emit user deleted event
   */
  emitUserDeleted(userId: string, platformType: string): void {
    this.emit('userDeleted', { userId, platformType });
  }

  /**
   * Emit plugin status changed event
   */
  emitPluginStatusChanged(status: IChannelPluginStatus): void {
    this.emit('pluginStatusChanged', status);
  }

  /**
   * Emit pairing rejected event
   */
  emitPairingRejected(code: string): void {
    this.emit('pairingRejected', { code });
  }
}

export function getChannelEventEmitter(): ChannelEventEmitter {
  return ChannelEventEmitter.getInstance();
}

export { ChannelEventEmitter };