/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IRegisteredAction, ActionHandler } from './types.js';
import { ChatActionNames, createSuccessResponse, createErrorResponse } from './types.js';
import { createResponseActionsKeyboard, createErrorRecoveryKeyboard } from '../plugins/telegram/TelegramKeyboards.js';

/**
 * ChatActions - Handlers for chat/AI-related actions
 *
 * These actions involve AI processing.
 * They handle message sending, regeneration, and continuation.
 */

/**
 * Handle chat.send - Send a message to AI and get response
 * Note: The actual AI processing is handled by ActionExecutor
 */
export const handleChatSend: ActionHandler = async (context) => {
  return createSuccessResponse({
    type: 'text',
    text: '⏳ Thinking...',
    parseMode: 'HTML',
  });
};

/**
 * Handle chat.regenerate - Regenerate the last AI response
 */
export const handleChatRegenerate: ActionHandler = async (context, params) => {
  const originalMessageId = params?.originalMessageId;

  if (!originalMessageId) {
    return createErrorResponse('Cannot find original message');
  }

  return createSuccessResponse({
    type: 'text',
    text: '🔄 Regenerating...',
    parseMode: 'HTML',
  });
};

/**
 * Handle chat.continue - Continue the AI response
 */
export const handleChatContinue: ActionHandler = async (context, params) => {
  return createSuccessResponse({
    type: 'text',
    text: '💬 Continuing...',
    parseMode: 'HTML',
  });
};

/**
 * Handle action.copy - Copy response content
 */
export const handleCopy: ActionHandler = async (context, params) => {
  return {
    success: true,
    message: {
      type: 'text',
      text: '💡 Long press the message text to copy',
      parseMode: 'HTML',
    },
  };
};

/**
 * Handle tool confirmation
 */
export const handleToolConfirm: ActionHandler = async (context, params) => {
  const callId = params?.callId;
  const value = params?.value;
  const conversationId = context.conversationId;

  if (!callId || !value || !conversationId) {
    return createErrorResponse('Missing confirmation parameters');
  }

  try {
    // Note: ChannelMessageService will be ported later
    // For now we just return success, the actual logic will be wired up in Step 3
    return { success: true };
  } catch (error: any) {
    return createErrorResponse(`Confirmation failed: ${error.message}`);
  }
};

/**
 * All chat actions
 */
export const chatActions: IRegisteredAction[] = [
  {
    name: ChatActionNames.SEND,
    category: 'chat',
    description: 'Send a message to AI',
    handler: handleChatSend,
  },
  {
    name: ChatActionNames.REGENERATE,
    category: 'chat',
    description: 'Regenerate the last AI response',
    handler: handleChatRegenerate,
  },
  {
    name: ChatActionNames.CONTINUE,
    category: 'chat',
    description: 'Continue the AI response',
    handler: handleChatContinue,
  },
  {
    name: ChatActionNames.COPY,
    category: 'chat',
    description: 'Copy response content',
    handler: handleCopy,
  },
  {
    name: ChatActionNames.TOOL_CONFIRM,
    category: 'chat',
    description: 'Confirm tool execution',
    handler: handleToolConfirm,
  },
];

/**
 * Build a chat response with action buttons
 */
export function buildChatResponse(
  text: string,
  isComplete: boolean = true
): {
  text: string;
  parseMode: 'HTML' | 'MarkdownV2' | 'Markdown';
  replyMarkup?: unknown;
} {
  return {
    text,
    parseMode: 'HTML',
    replyMarkup: isComplete ? createResponseActionsKeyboard() : undefined,
  };
}

/**
 * Build an error response for chat failures
 */
export function buildChatErrorResponse(error: string): {
  type: 'text';
  text: string;
  parseMode: 'HTML' | 'MarkdownV2' | 'Markdown';
  replyMarkup?: unknown;
} {
  return {
    type: 'text',
    text: `❌ <b>Processing Failed</b>\n\n${error}\n\nPlease retry or start a new conversation.`,
    parseMode: 'HTML',
    replyMarkup: createErrorRecoveryKeyboard(),
  };
}

/**
 * Build a streaming indicator
 */
export function buildStreamingIndicator(partialText: string): {
  text: string;
  parseMode: 'HTML' | 'MarkdownV2' | 'Markdown';
} {
  return {
    text: partialText + ' ⏳',
    parseMode: 'HTML',
  };
}
