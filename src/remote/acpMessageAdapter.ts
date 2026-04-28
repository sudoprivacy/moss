import { randomUUID } from 'crypto'

/**
 * ACP Client Message Types
 *
 * These are the messages the client receives from server.ts WebSocket
 * after server converts ACP JSON-RPC notifications to client-friendly format.
 */
export type AcpClientMessage =
  | { type: 'start'; msg_id: string }
  | { type: 'content'; msg_id: string; data: string }
  | { type: 'thought'; msg_id: string; data: string }
  | {
      type: 'tool_call'
      msg_id: string
      data: {
        tool_name: string
        tool_use_id: string
        input: unknown
        kind?: string
        status?: string
      }
    }
  | {
      type: 'tool_call_update'
      msg_id: string
      data: {
        tool_use_id: string
        status: 'pending' | 'running' | 'completed' | 'failed'
        output?: string
      }
    }
  | {
      type: 'plan'
      msg_id: string
      data: {
        steps?: string[]
        entries?: string[]
        current_step?: number
      }
    }
  | {
      type: 'permission_request'
      request_id: string
      data: {
        tool_name: string
        tool_use_id: string
        description?: string
        input: unknown
        options?: Array<{ id: string; name: string; description?: string }>
      }
    }
  | { type: 'finish'; msg_id: string; stop_reason?: string }
  | { type: 'error'; msg_id?: string; data: { message: string; code?: string } }
  | {
      type: 'model_info'
      msg_id?: string
      data: {
        model_id?: string
        current_model_id?: string
        model_name?: string
        can_switch?: boolean
        available_models?: Array<{ id: string; label?: string }>
        configOptions?: unknown[]
      }
    }
  | { type: 'context_usage'; msg_id?: string; data: { used: number; limit?: number; size?: number } }

/**
 * ACP Client Send Message Types
 *
 * Messages the client sends to the server for ACP protocol.
 */
export type AcpClientSendMessage =
  | { type: 'user_message'; content: string; images?: unknown[] }
  | { type: 'permission_response'; request_id: string; option_id: string }
  | { type: 'cancel' }

/**
 * Type guard for AcpClientMessage
 */
export function isAcpClientMessage(msg: unknown): msg is AcpClientMessage {
  if (typeof msg !== 'object' || msg === null || !('type' in msg)) {
    return false
  }
  const type = (msg as { type: unknown }).type
  return typeof type === 'string' && [
    'start',
    'content',
    'thought',
    'tool_call',
    'tool_call_update',
    'plan',
    'permission_request',
    'finish',
    'error',
    'model_info',
    'context_usage',
  ].includes(type)
}

/**
 * Type guard for AcpClientSendMessage
 */
export function isAcpClientSendMessage(msg: unknown): msg is AcpClientSendMessage {
  if (typeof msg !== 'object' || msg === null || !('type' in msg)) {
    return false
  }
  const type = (msg as { type: unknown }).type
  return typeof type === 'string' && [
    'user_message',
    'permission_response',
    'cancel',
  ].includes(type)
}

/**
 * Converted SDK Message for internal use
 *
 * Simplified SDKMessage format for upper layer callbacks
 */
export type ConvertedSdkMessage = {
  type: string
  uuid: string
  message?: {
    role: string
    content: unknown
  }
  event?: unknown
  subtype?: string
  errors?: string[]
  steps?: string[]
  current_step?: number
}

/**
 * Convert AcpClientMessage to simplified SDKMessage format
 *
 * This allows the upper layers (useDirectConnect) to work with
 * a consistent message format regardless of protocol.
 */
export function convertAcpToSdkMessage(msg: AcpClientMessage): ConvertedSdkMessage | null {
  switch (msg.type) {
    case 'start': {
      // Start of a new assistant message - create empty assistant message
      return {
        type: 'assistant',
        uuid: msg.msg_id,
        message: {
          role: 'assistant',
          content: [],
        },
      }
    }

    case 'content': {
      // Streaming text content
      return {
        type: 'stream_event',
        uuid: msg.msg_id,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: msg.data,
          },
        },
      }
    }

    case 'thought': {
      // Thinking/reasoning content
      return {
        type: 'stream_event',
        uuid: msg.msg_id,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'thinking_delta',
            thinking: msg.data,
          },
        },
      }
    }

    case 'tool_call': {
      // Tool invocation
      return {
        type: 'assistant',
        uuid: msg.msg_id,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: msg.data.tool_use_id,
              name: msg.data.tool_name,
              input: msg.data.input as Record<string, unknown>,
            },
          ],
        },
      }
    }

    case 'tool_call_update': {
      // Tool status update
      // Convert to a stream event for tool_result delta
      // Standard ACP status: 'completed' or 'failed'
      if (msg.data.status === 'completed' && msg.data.output) {
        return {
          type: 'stream_event',
          uuid: msg.msg_id,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'tool_result_delta',
              tool_use_id: msg.data.tool_use_id || '',
              content: msg.data.output,
            },
          },
        }
      }
      return null
    }

    case 'plan': {
      // Plan steps - convert to system message
      // Note: ACP sends 'entries', client expects 'steps'
      const steps = msg.data.steps || msg.data.entries || []
      return {
        type: 'system',
        subtype: 'plan',
        uuid: msg.msg_id,
        steps: steps as string[],
        current_step: msg.data.current_step,
      }
    }

    case 'finish': {
      // Message completed
      return {
        type: 'result',
        subtype: 'success',
        uuid: msg.msg_id,
      }
    }

    case 'error': {
      // Error occurred
      return {
        type: 'result',
        subtype: 'error',
        uuid: msg.msg_id || randomUUID(),
        errors: [msg.data.message],
      }
    }

    case 'model_info':
    case 'context_usage': {
      // Status information - not converted to SDKMessage
      // Could be handled separately for UI display
      return null
    }

    case 'permission_request': {
      // Permission request - handled separately in callbacks
      // Not converted to SDKMessage, will be handled by onPermissionRequest callback
      return null
    }

    default:
      return null
  }
}

/**
 * Extract text content from RemoteMessageContent for ACP user_message
 */
export function extractTextFromContent(
  content: unknown,
): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    const textParts: string[] = []
    for (const block of content) {
      if (typeof block === 'string') {
        textParts.push(block)
      } else if (
        typeof block === 'object' &&
        block !== null &&
        'type' in block
      ) {
        if (block.type === 'text' && 'text' in block) {
          textParts.push(String(block.text))
        }
      }
    }
    return textParts.join('\n')
  }
  return ''
}

/**
 * Extract images from RemoteMessageContent for ACP user_message
 */
export function extractImagesFromContent(
  content: unknown,
): unknown[] {
  if (!Array.isArray(content)) {
    return []
  }
  const images: unknown[] = []
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      'type' in block
    ) {
      if (
        block.type === 'image' ||
        block.type === 'image_source' ||
        (block.type === 'image_url' && 'url' in block)
      ) {
        images.push(block)
      }
    }
  }
  return images
}