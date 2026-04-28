#!/usr/bin/env node
/**
 * ACP Protocol Test Script
 * Tests all standard ACP interfaces by spawning cli-node.js -acp
 */

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cliPath = join(__dirname, '..', 'bin', 'cli-node.js')

class AcpClient {
  constructor(process) {
    this.process = process
    this.buffer = ''
    this.requestId = 0
    this.pendingRequests = new Map()
    this.notifications = []

    this.process.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString()
      this.processBuffer()
    })

    this.process.stderr.on('data', (chunk) => {
      console.error('[ACP stderr]', chunk.toString())
    })
  }

  processBuffer() {
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line)
        // Response has id
        if (parsed.id !== undefined) {
          const pending = this.pendingRequests.get(parsed.id)
          if (pending) {
            this.pendingRequests.delete(parsed.id)
            if (parsed.error) {
              pending.reject(new Error(parsed.error.message))
            } else {
              pending.resolve(parsed.result)
            }
          }
        } else if (parsed.method) {
          // Notification
          this.notifications.push(parsed)
        }
      } catch (e) {
        console.log('[ACP raw]', line)
      }
    }
  }

  async sendRequest(method, params, timeoutMs = 30000) {
    const id = ++this.requestId
    const request = { jsonrpc: '2.0', id, method, params: params || {} }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Request ${id} timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pendingRequests.set(id, { resolve, reject, timeout })

      this.process.stdin.write(JSON.stringify(request) + '\n')
    })
  }

  async waitForNotification(predicate, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Notification timeout'))
      }, timeoutMs)

      const check = () => {
        for (let i = 0; i < this.notifications.length; i++) {
          if (predicate(this.notifications[i])) {
            clearTimeout(timeout)
            resolve(this.notifications[i])
            this.notifications.splice(i, 1)
            return
          }
        }
      }

      check()

      // Poll for new notifications
      const interval = setInterval(() => {
        check()
        if (this.notifications.length === 0) {
          clearInterval(interval)
        }
      }, 100)
    })
  }

  close() {
    this.process.kill()
  }
}

async function spawnAcpServer(cwd = '/tmp/acp-test') {
  const proc = spawn('node', [cliPath, '-acp', '--cwd', cwd, '--dangerously-skip-permissions'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  return new AcpClient(proc)
}

// Test suite
const tests = {
  async testInitialize(client) {
    console.log('\n=== Test: initialize ===')
    const result = await client.sendRequest('initialize', {})
    console.log('Response:', JSON.stringify(result, null, 2))

    if (result.protocolVersion === 1) {
      console.log('✓ protocolVersion: 1')
    } else {
      console.log('✗ Missing protocolVersion')
    }

    if (result.agentCapabilities?.promptCapabilities?.image) {
      console.log('✓ Supports image prompts')
    }

    if (result.agentCapabilities?.loadSession) {
      console.log('✓ Supports session loading')
    }

    if (result.agentInfo?.name === 'claude-code') {
      console.log('✓ Agent name: claude-code')
    }

    return result
  },

  async testSessionNew(client) {
    console.log('\n=== Test: session/new ===')
    const result = await client.sendRequest('session/new', { cwd: '/tmp/acp-test' })
    console.log('Response:', JSON.stringify(result, null, 2))

    if (result.sessionId) {
      console.log('✓ sessionId:', result.sessionId)
      return result.sessionId
    } else {
      console.log('✗ Missing sessionId')
      return null
    }
  },

  async testSessionPrompt(client, sessionId) {
    console.log('\n=== Test: session/prompt ===')
    console.log('Sending prompt to session:', sessionId)

    // Send a simple prompt
    const promptPromise = client.sendRequest('session/prompt', {
      sessionId,
      prompt: {
        content: [{ type: 'text', text: 'Say "Hello from ACP test" and nothing else.' }]
      }
    }, 120000)

    // Wait for notifications
    const notifications = []
    const timeout = setTimeout(() => {
      console.log('Timeout waiting for notifications')
    }, 60000)

    try {
      // Collect notifications
      while (true) {
        const notification = await client.waitForNotification(
          n => n.method === 'session/update',
          10000
        ).catch(() => null)

        if (!notification) break

        notifications.push(notification)
        const update = notification.params?.update
        console.log('  Notification:', update?.sessionUpdate)

        if (update?.sessionUpdate === 'finish' || update?.sessionUpdate === 'message_stopped') {
          break
        }
      }
    } finally {
      clearTimeout(timeout)
    }

    console.log('Notifications received:', notifications.length)

    // Wait for response
    const result = await promptPromise
    console.log('Response:', JSON.stringify(result, null, 2))

    if (result.stopReason) {
      console.log('✓ stopReason:', result.stopReason)
    }

    // Check for agent_message_chunk notifications
    const messageChunks = notifications.filter(n =>
      n.params?.update?.sessionUpdate === 'agent_message_chunk'
    )
    console.log('✓ Received', messageChunks.length, 'agent_message_chunk notifications')

    // Check message content
    for (const chunk of messageChunks) {
      const text = chunk.params?.update?.content?.text
      if (text) {
        console.log('  Message chunk:', text.substring(0, 100))
      }
    }

    return result
  },

  async testSessionSetMode(client, sessionId) {
    console.log('\n=== Test: session/set_mode ===')
    try {
      const result = await client.sendRequest('session/set_mode', {
        sessionId,
        modeId: 'plan'
      })
      console.log('Response:', JSON.stringify(result, null, 2))
      console.log('✓ Mode set successfully')
      return result
    } catch (err) {
      console.log('Response error:', err.message)
    }
  },

  async testSessionSetModel(client, sessionId) {
    console.log('\n=== Test: session/set_model ===')
    try {
      const result = await client.sendRequest('session/set_model', {
        sessionId,
        modelId: 'claude-sonnet-4-6'
      })
      console.log('Response:', JSON.stringify(result, null, 2))
      console.log('✓ Model set successfully')
      return result
    } catch (err) {
      console.log('Response error:', err.message)
    }
  },

  async testSessionSetConfigOption(client, sessionId) {
    console.log('\n=== Test: session/set_config_option ===')
    try {
      const result = await client.sendRequest('session/set_config_option', {
        sessionId,
        configId: 'mode',
        value: 'default'
      })
      console.log('Response:', JSON.stringify(result, null, 2))

      if (result.configOptions) {
        console.log('✓ configOptions returned')
      }
      return result
    } catch (err) {
      console.log('Response error:', err.message)
    }
  },

  async testSessionList(client) {
    console.log('\n=== Test: session/list ===')
    const result = await client.sendRequest('session/list', { cwd: '/tmp/acp-test' })
    console.log('Response:', JSON.stringify(result, null, 2))

    if (result.sessions) {
      console.log('✓ sessions:', result.sessions.length)
    }
    return result
  },

  async testSessionFork(client, sessionId) {
    console.log('\n=== Test: session/fork ===')
    try {
      const result = await client.sendRequest('session/fork', { sessionId })
      console.log('Response:', JSON.stringify(result, null, 2))

      if (result.sessionId) {
        console.log('✓ New sessionId:', result.sessionId)
      }
      return result
    } catch (err) {
      console.log('Response error:', err.message)
    }
  },

  async testSessionResume(client, sessionId) {
    console.log('\n=== Test: session/resume ===')
    try {
      const result = await client.sendRequest('session/resume', { sessionId })
      console.log('Response:', JSON.stringify(result, null, 2))

      if (result.sessionId) {
        console.log('d sessionId:', result.sessionId)
      }
      return result
    } catch (err) {
      console.log('Response error:', err.message)
    }
  },

  async testSessionClose(client, sessionId) {
    console.log('\n=== Test: session/close ===')
    try {
      const result = await client.sendRequest('session/close', { sessionId })
      console.log('Response:', JSON.stringify(result, null, 2))
      console.log('✓ Session closed')
      return result
    } catch (err) {
      console.log('Response error:', err.message)
    }
  },

  async testToolCall(client, sessionId) {
    console.log('\n=== Test: Tool Call (Read) ===')
    console.log('Sending prompt that will trigger a tool...')

    const promptPromise = client.sendRequest('session/prompt', {
      sessionId,
      prompt: {
        content: [{ type: 'text', text: 'Read the file /tmp/acp-test/test.txt' }]
      }
    }, 120000)

    // Wait for tool_call notification
    const toolCallNotification = await client.waitForNotification(
      n => n.params?.update?.sessionUpdate === 'tool_call',
      60000
    ).catch(() => null)

    if (toolCallNotification) {
      const update = toolCallNotification.params?.update
      console.log('d tool_call notification:')
      console.log('  toolCallId:', update?.toolCallId)
      console.log('  title:', update?.title)
      console.log('  kind:', update?.kind)
      console.log('  status:', update?.status)
    } else {
      console.log('✗ No tool_call notification received')
    }

    // Wait for tool_call_update
    const toolUpdateNotification = await client.waitForNotification(
      n => n.params?.update?.sessionUpdate === 'tool_call_update',
      60000
    ).catch(() => null)

    if (toolUpdateNotification) {
      const update = toolUpdateNotification.params?.update
      console.log('d tool_call_update notification:')
      console.log('  toolCallId:', update?.toolCallId)
      console.log('  status:', update?.status)
      console.log('  rawOutput length:', typeof update?.rawOutput === 'string' ? update.rawOutput.length : 'not string')
    }

    // Wait for response
    const result = await promptPromise
    console.log('Response:', JSON.stringify(result, null, 2))

    return result
  },
}

async function main() {
  console.log('ACP Protocol Test Suite')
  console.log('Starting ACP server...')
  console.log('========================================')

  const client = await spawnAcpServer('/tmp/acp-test')

  try {
    // Initialize
    await tests.testInitialize(client)

    // Create new session
    const sessionId = await tests.testSessionNew(client)
    if (!sessionId) {
      console.log('✗ Cannot proceed without session')
      return
    }

    process.env.TEST_SESSION_ID = sessionId

    // Test basic prompt
    await tests.testSessionPrompt(client, sessionId)

    // Test config operations
    await tests.testSessionSetMode(client, sessionId)
    await tests.testSessionSetModel(client, sessionId)
    await tests.testSessionSetConfigOption(client, sessionId)

    // Test session operations
    await tests.testSessionList(client)
    await tests.testSessionFork(client, sessionId)
    await tests.testSessionResume(client, sessionId)

    // Test tool call
    await tests.testToolCall(client, sessionId)

    // Clean up
    await tests.testSessionClose(client, sessionId)

    console.log('\n========================================')
    console.log('All tests completed!')

  } catch (err) {
    console.error('Test failed:', err)
  } finally {
    client.close()
  }
}

main().catch(console.error)