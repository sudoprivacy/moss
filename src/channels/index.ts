/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Channel Module for Moss Server
 *
 * Full implementation that runs channel plugins and handles messages.
 */

// Export types
export * from './types.js';

// Core exports
export { getChannelManager, ChannelManager } from './core/ChannelManager.js';
export { getPairingService, PairingService } from './pairing/PairingService.js';
export { LocalChannelProvider } from './core/IChannelProvider.js';
export type { IChannelProvider } from './core/IChannelProvider.js';
export { SessionManager } from './core/SessionManager.js';
export { PluginManager, registerPlugin } from './gateway/PluginManager.js';

// Plugin exports
export { BasePlugin } from './plugins/BasePlugin.js';
export type { PluginMessageHandler, PluginConfirmHandler } from './plugins/BasePlugin.js';

// Lark plugin exports
export { LarkPlugin } from './plugins/lark/LarkPlugin.js';
export * from './plugins/lark/LarkAdapter.js';
export * from './plugins/lark/LarkCards.js';

// Utils exports
export * from './utils/index.js';
