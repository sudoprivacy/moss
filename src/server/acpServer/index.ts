/**
 * ACP Server Entry Point
 *
 * Starts Claude Code as an ACP Agent Server using JSON-RPC 2.0 over stdin/stdout.
 * Compatible with clients like Zed IDE.
 *
 * Supports bidirectional communication:
 * - Client → Agent: requests (initialize, session/new, etc.) and notifications
 * - Agent → Client: requests (requestPermission, readTextFile, etc.) and notifications
 */

import { createInterface } from 'readline'
import { ClaudeCodeAcpAgent } from './acpAgent.js'
import type { AcpServerOptions, PendingRequest } from './types.js'

// Global pending requests map for Agent → Client requests
const pendingClientRequests = new Map<string, PendingRequest>()

// Request ID counter for Agent → Client requests
let clientRequestIdCounter = 0

export async function runAcpServer(options: AcpServerOptions): Promise<void> {
  const agent = new ClaudeCodeAcpAgent(options, {
    sendClientRequest,
    sendClientNotification,
  })

  // Setup stdin/stdout for ndjson stream
  const rl = createInterface({
    input: process.stdin,
    terminal: false,
  })

  // Handle incoming JSON-RPC messages
  rl.on('line', async (line: string) => {
    try {
      const message = JSON.parse(line)

      // Validate JSON-RPC structure
      if (message.jsonrpc !== '2.0') {
        sendError(null, -32600, 'Invalid Request: jsonrpc must be "2.0"')
        return
      }

      // Response to Agent request (Agent → Client request, Client → Agent response)
      if ('id' in message && !('method' in message)) {
        const { id, result, error } = message
        const pending = pendingClientRequests.get(String(id))
        if (pending) {
          pendingClientRequests.delete(String(id))
          if (error) {
            pending.reject(new Error(error.message || 'Client request failed'))
          } else {
            pending.resolve(result)
          }
        }
        return
      }

      // Request from Client (Client → Agent request)
      if ('id' in message && 'method' in message) {
        const { id, method, params } = message
        try {
          const result = await handleClientRequest(agent, method, params || {})
          sendResponse(id, result)
        } catch (error) {
          const err = error as Error
          if (err.message.includes('Method not found')) {
            sendError(id, -32601, err.message)
          } else if (err.message.includes('Invalid params')) {
            sendError(id, -32602, err.message)
          } else {
            sendError(id, -32603, err.message)
          }
        }
        return
      }

      // Notification from Client (no id)
      if (!('id' in message) && 'method' in message) {
        const { method, params } = message
        await handleClientNotification(agent, method, params || {})
      }
    } catch {
      sendError(null, -32700, 'Parse error: invalid JSON')
    }
  })

  // Keep process alive until stdin closes
  rl.on('close', () => {
    // Reject all pending requests
    for (const [id, { reject }] of pendingClientRequests) {
      reject(new Error('Connection closed'))
    }
    pendingClientRequests.clear()
    process.exit(0)
  })

  // Handle process signals
  process.on('SIGTERM', () => {
    rl.close()
    process.exit(0)
  })

  process.on('SIGINT', () => {
    rl.close()
    process.exit(0)
  })
}

/**
 * Send request to Client and wait for response
 */
function sendClientRequest<T = unknown>(method: string, params: unknown): Promise<T> {
  const id = ++clientRequestIdCounter
  const request = {
    jsonrpc: '2.0',
    id,
    method,
    params,
  }

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingClientRequests.delete(String(id))
      reject(new Error(`Client request ${id} timed out after 60s`))
    }, 60_000)

    pendingClientRequests.set(String(id), {
      resolve: (result: unknown) => {
        clearTimeout(timeout)
        resolve(result as T)
      },
      reject,
    })

    process.stdout.write(`${JSON.stringify(request)}\n`)
  })
}

/**
 * Send notification to Client (no response expected)
 */
function sendClientNotification(method: string, params: unknown): void {
  const notification = {
    jsonrpc: '2.0',
    method,
    params,
  }
  process.stdout.write(`${JSON.stringify(notification)}\n`)
}

/**
 * Send response to Client request
 */
function sendResponse(id: number | string, result: unknown): void {
  const response = {
    jsonrpc: '2.0',
    id,
    result,
  }
  process.stdout.write(`${JSON.stringify(response)}\n`)
}

/**
 * Send error response to Client request
 */
function sendError(id: number | string | null, code: number, message: string): void {
  const response = {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  }
  process.stdout.write(`${JSON.stringify(response)}\n`)
}

/**
 * Handle request from Client
 */
async function handleClientRequest(
  agent: ClaudeCodeAcpAgent,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return agent.initialize(params)

    case 'session/new':
      return agent.newSession(params)

    case 'session/prompt':
      return agent.prompt(params)

    case 'session/cancel':
      return agent.cancel(params)

    case 'session/set_mode':
      return agent.setSessionMode(params)

    case 'session/set_model':
      return agent.setSessionModel(params)

    case 'session/set_config_option':
      return agent.setSessionConfigOption(params)

    case 'session/load':
      return agent.loadSession(params)

    case 'session/list':
      return agent.listSessions(params)

    case 'session/close':
      return agent.closeSession(params)

    case 'session/fork':
      return agent.forkSession(params)

    case 'session/resume':
      return agent.resumeSession(params)

    default:
      throw new Error(`Method not found: ${method}`)
  }
}

/**
 * Handle notification from Client
 */
async function handleClientNotification(
  agent: ClaudeCodeAcpAgent,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  switch (method) {
    case 'session/cancel':
      await agent.cancel(params)
      break

    case 'session/interrupt':
      // Interrupt is similar to cancel but doesn't wait for confirmation
      await agent.cancel(params)
      break

    case 'textDocument/didOpen':
      await agent.textDocumentDidOpen(params)
      break

    case 'textDocument/didChange':
      await agent.textDocumentDidChange(params)
      break

    case 'textDocument/didClose':
      await agent.textDocumentDidClose(params)
      break

    case 'textDocument/didSave':
      await agent.textDocumentDidSave(params)
      break

    case 'textDocument/didFocus':
      await agent.textDocumentDidFocus(params)
      break

    // Ignore other notifications
    default:
      break
  }
}