/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ActionHandler, IRegisteredAction } from './types.js';
import { PlatformActionNames, createSuccessResponse, createErrorResponse } from './types.js';
import { getPairingService } from '../pairing/PairingService.js';
import { createPairingCodeKeyboard, createPairingStatusKeyboard, createMainMenuKeyboard } from '../plugins/telegram/TelegramKeyboards.js';
import { createPairingCard, createPairingStatusCard, createMainMenuCard, createPairingHelpCard } from '../plugins/lark/LarkCards.js';

/**
 * PlatformActions - Handlers for platform-specific actions
 *
 * Supports both Telegram and Lark platforms.
 */

/**
 * Get main menu markup based on platform
 */
function getMainMenuMarkup(platform: string) {
  if (platform === 'lark') {
    return createMainMenuCard();
  }
  return createMainMenuKeyboard();
}

/**
 * Get pairing code markup based on platform
 */
function getPairingCodeMarkup(platform: string, code: string) {
  if (platform === 'lark') {
    return createPairingCard(code);
  }
  return createPairingCodeKeyboard();
}

/**
 * Get pairing status markup based on platform
 */
function getPairingStatusMarkup(platform: string, code: string) {
  if (platform === 'lark') {
    return createPairingStatusCard(code);
  }
  return createPairingStatusKeyboard();
}

/**
 * Get pairing help markup based on platform
 */
function getPairingHelpMarkup(platform: string) {
  if (platform === 'lark') {
    return createPairingHelpCard();
  }
  return createPairingCodeKeyboard();
}

/**
 * Handle pairing.show - Show pairing code to user
 */
export const handlePairingShow: ActionHandler = async (context) => {
  const pairingService = getPairingService();
  const platform = context.platform;

  // Check if user is already authorized
  if (pairingService.isUserAuthorized(context.userId, platform)) {
    return createSuccessResponse({
      type: 'text',
      text: ['✅ <b>Authorized</b>', '', 'Your account is already paired and ready to use.', '', 'Send a message to start chatting, or use the buttons below.'].join('\n'),
      parseMode: 'HTML',
      replyMarkup: getMainMenuMarkup(platform),
    });
  }

  // Generate pairing code
  try {
    const ttlMs = 10 * 60 * 1000;
    const code = pairingService.generatePairingCode(context.userId, platform, context.displayName, ttlMs);
    const expiresAt = Date.now() + ttlMs;

    const expiresInMinutes = Math.ceil((expiresAt - Date.now()) / 1000 / 60);

    return createSuccessResponse({
      type: 'text',
      text: ['🔗 <b>Device Pairing</b>', '', 'Please approve this pairing request in the Moss Admin UI:', '', `<code>${code}</code>`, '', `⏱ Valid for: ${expiresInMinutes} minutes`, '', '<b>Steps:</b>', '1. Open Moss Admin Panel', '2. Go to Channels', '3. Click "Approve" in pending pairing requests'].join('\n'),
      parseMode: 'HTML',
      replyMarkup: getPairingCodeMarkup(platform, code),
    });
  } catch (error: any) {
    return createErrorResponse(`Failed to generate pairing code: ${error.message}`);
  }
};

/**
 * Handle pairing.refresh - Refresh pairing code
 */
export const handlePairingRefresh: ActionHandler = async (context) => {
  const pairingService = getPairingService();
  const platform = context.platform;

  // Check if user is already authorized
  if (pairingService.isUserAuthorized(context.userId, platform)) {
    return createSuccessResponse({
      type: 'text',
      text: '✅ You are already paired. No need to refresh the pairing code.',
      parseMode: 'HTML',
      replyMarkup: getMainMenuMarkup(platform),
    });
  }

  // Generate new pairing code
  try {
    const { code, expiresAt } = await pairingService.refreshPairingCode(context.userId, platform, context.displayName);

    const expiresInMinutes = Math.ceil((expiresAt - Date.now()) / 1000 / 60);

    return createSuccessResponse({
      type: 'text',
      text: ['🔄 <b>New Pairing Code</b>', '', `<code>${code}</code>`, '', `⏱ Valid for: ${expiresInMinutes} minutes`, '', 'Please approve this pairing request in Moss Admin UI.'].join('\n'),
      parseMode: 'HTML',
      replyMarkup: getPairingCodeMarkup(platform, code),
    });
  } catch (error: any) {
    return createErrorResponse(`Failed to refresh pairing code: ${error.message}`);
  }
};

/**
 * Handle pairing.check - Check pairing status
 */
export const handlePairingCheck: ActionHandler = async (context) => {
  const pairingService = getPairingService();
  const platform = context.platform;

  // Check if user is already authorized
  if (pairingService.isUserAuthorized(context.userId, platform)) {
    return createSuccessResponse({
      type: 'text',
      text: ['✅ <b>Pairing Successful!</b>', '', 'Your account is now paired and ready to use.', '', 'Send a message to chat with the AI assistant.'].join('\n'),
      parseMode: 'HTML',
      replyMarkup: getMainMenuMarkup(platform),
    });
  }

  // Check for pending request
  const pendingRequest = pairingService.getPendingRequestForUser(context.userId, platform);

  if (pendingRequest) {
    const expiresInMinutes = Math.ceil((pendingRequest.expiresAt - Date.now()) / 1000 / 60);

    return createSuccessResponse({
      type: 'text',
      text: ['⏳ <b>Waiting for Approval</b>', '', `Pairing code: <code>${pendingRequest.code}</code>`, `Time remaining: ${expiresInMinutes} minutes`, '', 'Please approve the pairing request in Moss Admin UI.'].join('\n'),
      parseMode: 'HTML',
      replyMarkup: getPairingStatusMarkup(platform, pendingRequest.code),
    });
  }

  // No pending request - need to generate new code
  return handlePairingShow(context);
};

/**
 * Handle pairing.help - Show pairing help
 */
export const handlePairingHelp: ActionHandler = async (context) => {
  const platform = context.platform;
  const platformName = platform === 'lark' ? 'Lark/Feishu' : 'Telegram';

  return createSuccessResponse({
    type: 'text',
    text: ['❓ <b>Pairing Help</b>', '', '<b>What is pairing?</b>', `Pairing links your ${platformName} account with the Moss server.`, 'You need to pair before using the AI assistant.', '', '<b>Pairing steps:</b>', '1. Get pairing code (send any message)', '2. Open Moss Admin UI', '3. Go to Channels', '4. Click "Approve" in pending requests', '', '<b>FAQ:</b>', '• Pairing code valid for 10 minutes', '• One account can only pair once'].join('\n'),
    parseMode: 'HTML',
    replyMarkup: getPairingHelpMarkup(platform),
  });
};

/**
 * All platform actions
 */
export const platformActions: IRegisteredAction[] = [
  {
    name: PlatformActionNames.PAIRING_SHOW,
    category: 'platform',
    description: 'Show pairing code',
    handler: handlePairingShow,
  },
  {
    name: PlatformActionNames.PAIRING_REFRESH,
    category: 'platform',
    description: 'Refresh pairing code',
    handler: handlePairingRefresh,
  },
  {
    name: PlatformActionNames.PAIRING_CHECK,
    category: 'platform',
    description: 'Check pairing status',
    handler: handlePairingCheck,
  },
  {
    name: PlatformActionNames.PAIRING_HELP,
    category: 'platform',
    description: 'Show pairing help',
    handler: handlePairingHelp,
  },
];
