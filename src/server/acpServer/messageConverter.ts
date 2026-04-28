/**
 * Message Converter Utilities
 *
 * Converts between ACP protocol format and Claude Code internal format.
 */

/**
 * Send session update notification to client
 */
export function sendSessionUpdate(
  sessionId: string,
  update: Record<string, unknown>,
): void {
  const notification = {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update,
    },
  }
  process.stdout.write(`${JSON.stringify(notification)}\n`)
}

/**
 * Convert ACP prompt content blocks to Claude message format
 */
export function convertAcpPromptToMessage(
  contentBlocks: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = []
  const context: Array<Record<string, unknown>> = []

  for (const block of contentBlocks) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text as string })
        break

      case 'image':
        if (block.data) {
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              data: block.data as string,
              media_type: (block.mimeType as string) || 'image/png',
            },
          })
        } else if (block.uri) {
          content.push({
            type: 'image',
            source: {
              type: 'url',
              url: block.uri as string,
            },
          })
        }
        break

      case 'resource_link':
        content.push({
          type: 'text',
          text: formatUriAsLink(block.uri as string),
        })
        break

      case 'resource':
        if (block.resource && typeof block.resource === 'object') {
          const resource = block.resource as Record<string, unknown>
          content.push({
            type: 'text',
            text: formatUriAsLink(resource.uri as string),
          })
          if ('text' in resource) {
            context.push({
              type: 'text',
              text: `<context ref="${resource.uri}">\n${resource.text}\n</context>`,
            })
          }
        }
        break

      default:
        // Skip unknown block types
        break
    }
  }

  // Append context blocks after content
  content.push(...context)
  return content
}

/**
 * Format URI as markdown link
 */
function formatUriAsLink(uri: string): string {
  try {
    const url = new URL(uri)
    if (url.protocol === 'file:') {
      return `[${url.pathname}](${uri})`
    }
    return `[${uri}](${uri})`
  } catch {
    return uri
  }
}

/**
 * Get tool title for display
 */
export function getToolTitle(name: string, input?: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return (input?.command as string) || 'Terminal'
    case 'Read':
      return `Read ${(input?.file_path as string) || 'File'}`
    case 'Edit':
      return `Edit ${(input?.file_path as string) || 'File'}`
    case 'Write':
      return `Write ${(input?.file_path as string) || 'File'}`
    case 'Glob':
      return `Find ${(input?.pattern as string) || ''}`
    case 'Grep':
      return `grep "${(input?.pattern as string) || ''}"`
    case 'WebFetch':
      return `Fetch ${(input?.url as string) || ''}`
    case 'WebSearch':
      return `"${(input?.query as string) || ''}"`
    case 'TodoWrite':
      return 'Update TODOs'
    case 'ExitPlanMode':
      return 'Ready to code?'
    default:
      return name
  }
}

/**
 * Get tool kind for display classification
 */
export function getToolKind(name: string): string {
  switch (name) {
    case 'Read':
      return 'read'
    case 'Edit':
    case 'Write':
      return 'edit'
    case 'Bash':
      return 'execute'
    case 'Glob':
    case 'Grep':
      return 'search'
    case 'WebFetch':
    case 'WebSearch':
      return 'fetch'
    case 'TodoWrite':
      return 'think'
    case 'ExitPlanMode':
      return 'switch_mode'
    default:
      return 'other'
  }
}

/**
 * Convert Claude tool use event to ACP tool_call update
 */
export function convertToolUseToAcpUpdate(
  sessionId: string,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: toolUseId,
      title: getToolTitle(toolName, input),
      kind: getToolKind(toolName),
      status: 'pending',
      rawInput: input,
    },
  }
}

/**
 * Convert Claude tool result to ACP tool_call_update
 */
export function convertToolResultToAcpUpdate(
  sessionId: string,
  toolUseId: string,
  isError: boolean,
  output: unknown,
): Record<string, unknown> {
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: toolUseId,
      status: isError ? 'failed' : 'completed',
      rawOutput: output,
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: typeof output === 'string' ? output : JSON.stringify(output),
          },
        },
      ],
    },
  }
}

/**
 * Convert text chunk to ACP agent_message_chunk
 */
export function convertTextChunkToAcpUpdate(
  sessionId: string,
  text: string,
  role: 'assistant' | 'user',
): Record<string, unknown> {
  return {
    sessionId,
    update: {
      sessionUpdate: role === 'assistant' ? 'agent_message_chunk' : 'user_message_chunk',
      content: { type: 'text', text },
    },
  }
}

/**
 * Convert thinking chunk to ACP agent_thought_chunk
 */
export function convertThinkingToAcpUpdate(
  sessionId: string,
  thinking: string,
): Record<string, unknown> {
  return {
    sessionId,
    update: {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: thinking },
    },
  }
}