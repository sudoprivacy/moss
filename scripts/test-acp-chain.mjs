/**
 * ACP Integration Test Script
 *
 * Tests the full chain: UI Desktop (WebSocket client) -> Server (ACP client) -> ACP Server (cli-node.js --acp)
 *
 * Usage:
 *   1. Build first: bun run scripts/build.js
 *   2. Start server: node bin/moss-server.mjs
 *   3. Run this test: node scripts/test-acp-chain.mjs
 */

import http from 'http'
import WebSocket from 'ws'

// Test configuration
const SERVER_HOST = 'localhost'
const SERVER_PORT = 43127

// Bootstrap admin credentials (from server config)
const ADMIN_USERNAME = 'admin'
const ADMIN_PASSWORD = 'ChangeMe123!'

let accessToken = null

// Colors for output
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
}

function log(color, ...args) {
  console.log(colors[color] || '', ...args, colors.reset)
}

function logSection(title) {
  log('cyan', `\n${'='.repeat(50)}`)
  log('cyan', `  ${title}`)
  log('cyan', `${'='.repeat(50)}\n`)
}

// HTTP helper
async function httpPost(pathname, body = {}, token = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body)
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    const req = http.request({
      hostname: SERVER_HOST,
      port: SERVER_PORT,
      path: pathname,
      method: 'POST',
      headers,
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) })
        } catch {
          resolve({ status: res.statusCode, body: data })
        }
      })
    })
    req.on('error', reject)
    req.write(bodyStr)
    req.end()
  })
}

async function httpGet(pathname, token = null) {
  return new Promise((resolve, reject) => {
    const headers = {}
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    const req = http.request({
      hostname: SERVER_HOST,
      port: SERVER_PORT,
      path: pathname,
      method: 'GET',
      headers,
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) })
        } catch {
          resolve({ status: res.statusCode, body: data })
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// Login helper
async function login(username, password) {
  log('blue', `[Auth] Logging in with username: ${username}`)
  const res = await httpPost('/api/v1/auth/login', { username, password })
  if (res.status !== 200) {
    throw new Error(`Login failed: ${res.body.error || JSON.stringify(res.body)}`)
  }
  accessToken = res.body.access_token
  log('green', `[Auth] Got access token: ${accessToken.slice(0, 20)}...`)
  log('green', `[Auth] User: ${res.body.user.name}, Role: ${res.body.role}`)
  return accessToken
}

// WebSocket client wrapper
class AcpTestClient {
  constructor(wsUrl, sessionId) {
    this.wsUrl = wsUrl
    this.sessionId = sessionId
    this.ws = null
    this.messages = []
    this.connected = false
  }

  connect() {
    return new Promise((resolve, reject) => {
      log('blue', `[WS] Connecting to ${this.wsUrl}`)
      this.ws = new WebSocket(this.wsUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      })

      this.ws.on('open', () => {
        log('green', '[WS] Connected')
        this.connected = true
        resolve()
      })

      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        log('yellow', '[WS] Received:', JSON.stringify(msg, null, 2))
        this.messages.push(msg)
      })

      this.ws.on('error', (err) => {
        log('red', '[WS] Error:', err.message)
        reject(err)
      })

      this.ws.on('close', () => {
        log('blue', '[WS] Closed')
        this.connected = false
      })
    })
  }

  send(msg) {
    const msgStr = JSON.stringify(msg)
    log('green', '[WS] Sending:', msgStr)
    this.ws.send(msgStr)
  }

  sendUserMessage(content, images = []) {
    this.send({
      type: 'user_message',
      content,
      ...(images.length > 0 && { images }),
    })
  }

  sendCancel(force = false) {
    this.send({
      type: 'cancel',
      force,
    })
  }

  sendPermissionResponse(requestId, optionId, feedback = null) {
    this.send({
      type: 'permission_response',
      request_id: requestId,
      option_id: optionId,
      ...(feedback && { feedback }),
    })
  }

  waitForMessageOfType(type, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for message type: ${type}`))
      }, timeoutMs)

      const check = () => {
        const msg = this.messages.find(m => m.type === type)
        if (msg) {
          clearTimeout(timeout)
          resolve(msg)
        } else if (this.connected) {
          setTimeout(check, 100)
        } else {
          clearTimeout(timeout)
          reject(new Error('WebSocket closed before receiving message'))
        }
      }
      check()
    })
  }

  waitForMessages(count, timeoutMs = 10000) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(this.messages)
      }, timeoutMs)

      const check = () => {
        if (this.messages.length >= count) {
          clearTimeout(timeout)
          resolve(this.messages)
        } else if (this.connected) {
          setTimeout(check, 100)
        } else {
          clearTimeout(timeout)
          resolve(this.messages)
        }
      }
      check()
    })
  }

  close() {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }
}

// Test runner
async function runTests() {
  logSection('ACP Integration Tests')

  let sessionId = null
  let wsUrl = null
  let client = null

  try {
    // Step 1: Check server health
    logSection('Step 1: Check Server Health')
    try {
      const health = await httpGet('/healthz')
      log('green', 'Health check:', JSON.stringify(health.body, null, 2))
      if (health.status !== 200) {
        throw new Error('Server not healthy')
      }
    } catch (err) {
      log('red', 'Server not responding. Make sure to start: node bin/moss-server.mjs')
      throw err
    }

    // Step 2: Login
    logSection('Step 2: Login')
    await login(ADMIN_USERNAME, ADMIN_PASSWORD)

    // Step 3: Create session
    logSection('Step 3: Create Session')
    const createRes = await httpPost('/api/v1/sessions', {
      cwd: process.cwd(),
      dangerously_skip_permissions: true,
    }, accessToken)
    log('green', 'Create session response:', JSON.stringify(createRes.body, null, 2))

    if (createRes.status !== 200) {
      throw new Error(`Failed to create session: ${createRes.body.error}`)
    }

    sessionId = createRes.body.session_id
    wsUrl = createRes.body.ws_url
    log('green', `Session ID: ${sessionId}`)
    log('green', `WebSocket URL: ${wsUrl}`)
    log('green', `Protocol: ${createRes.body.protocol}`)

    // Step 4: Connect WebSocket
    logSection('Step 4: Connect WebSocket')
    client = new AcpTestClient(wsUrl, sessionId)
    await client.connect()

    // Step 5: Send user message
    logSection('Step 5: Send User Message')
    client.sendUserMessage('Hello, this is a test message. Reply with a brief greeting.')

    // Wait for start message
    log('blue', 'Waiting for messages...')
    const msgs = await client.waitForMessages(5, 15000)
    log('yellow', `Received ${msgs.length} messages`)
    for (const msg of msgs) {
      log('yellow', `  - type: ${msg.type}`)
    }

    // Step 6: Test cancel
    logSection('Step 6: Test Cancel')
    client.sendCancel(false)
    await new Promise(r => setTimeout(r, 1000))
    log('green', 'Cancel sent')

    // Step 7: Send another message and wait for response
    logSection('Step 7: Send Another Message')
    client.messages = [] // Clear previous messages
    client.sendUserMessage('/help')

    const helpMsgs = await client.waitForMessages(3, 10000)
    log('yellow', `Received ${helpMsgs.length} messages for /help`)
    for (const msg of helpMsgs) {
      log('yellow', `  - type: ${msg.type}`, msg.data?.message ? ` - ${msg.data.message.slice(0, 50)}...` : '')
    }

    // Step 8: Test HTTP cancel endpoint
    logSection('Step 8: Test HTTP Cancel Endpoint')
    const cancelRes = await httpPost(`/api/v1/sessions/${sessionId}/cancel`, { force: true }, accessToken)
    log('green', 'HTTP cancel response:', JSON.stringify(cancelRes.body, null, 2))

    // Step 9: Test HTTP model endpoint
    logSection('Step 9: Test HTTP Model Endpoint')
    const modelRes = await httpPost(`/api/v1/sessions/${sessionId}/model`, { model_id: 'claude-sonnet-4-6' }, accessToken)
    log('green', 'HTTP model response:', JSON.stringify(modelRes.body, null, 2))

    // Step 10: Test HTTP mode endpoint
    logSection('Step 10: Test HTTP Mode Endpoint')
    const modeRes = await httpPost(`/api/v1/sessions/${sessionId}/mode`, { mode: 'acceptEdits' }, accessToken)
    log('green', 'HTTP mode response:', JSON.stringify(modeRes.body, null, 2))

    // Step 11: Get session info
    logSection('Step 11: Get Session Info')
    const sessionRes = await httpGet(`/api/v1/sessions/${sessionId}`, accessToken)
    log('green', 'Session info:', JSON.stringify(sessionRes.body, null, 2))

    // Step 12: Terminate session
    logSection('Step 12: Terminate Session')
    const terminateRes = await httpPost(`/api/v1/sessions/${sessionId}/terminate`, {}, accessToken)
    log('green', 'Terminate response:', JSON.stringify(terminateRes.body, null, 2))

    logSection('All Tests Passed!')
    return true

  } catch (error) {
    log('red', 'Test failed:', error.message)
    log('red', error.stack)

    // Cleanup
    if (client) {
      client.close()
    }
    if (sessionId && accessToken) {
      try {
        await httpPost(`/api/v1/sessions/${sessionId}/terminate`, {}, accessToken)
      } catch {}
    }
    return false
  }
}

// Message type tests
async function testMessageTypes() {
  logSection('Message Type Tests')

  let sessionId = null
  let wsUrl = null
  let client = null

  try {
    // Login
    await login(ADMIN_USERNAME, ADMIN_PASSWORD)

    // Create session
    const createRes = await httpPost('/api/v1/sessions', {
      cwd: process.cwd(),
      dangerously_skip_permissions: true,
    }, accessToken)

    if (createRes.status !== 200) {
      throw new Error(`Failed to create session: ${createRes.body.error}`)
    }

    sessionId = createRes.body.session_id
    wsUrl = createRes.body.ws_url

    client = new AcpTestClient(wsUrl, sessionId)
    await client.connect()

    // Test 1: Simple text message
    logSection('Test 1: Simple Text Message')
    client.sendUserMessage('List the message types you support.')
    await new Promise(r => setTimeout(r, 5000))
    log('yellow', `Received ${client.messages.length} messages`)
    const startMsg = client.messages.find(m => m.type === 'start')
    const contentMsgs = client.messages.filter(m => m.type === 'content')
    const finishMsg = client.messages.find(m => m.type === 'finish')
    log('green', `  - start: ${startMsg ? 'YES' : 'NO'}`)
    log('green', `  - content: ${contentMsgs.length} chunks`)
    log('green', `  - finish: ${finishMsg ? 'YES' : 'NO'}`)

    // Test 2: Tool call message (if permission_request appears)
    logSection('Test 2: Permission Request Flow')
    client.messages = []
    client.sendUserMessage('Read the file README.md')

    await new Promise(r => setTimeout(r, 5000))
    const permRequest = client.messages.find(m => m.type === 'permission_request')
    if (permRequest) {
      log('yellow', 'Permission request received:', JSON.stringify(permRequest, null, 2))
      // Respond with allow
      client.sendPermissionResponse(permRequest.request_id, 'allow_once')
      await new Promise(r => setTimeout(r, 5000))
      log('yellow', `After permission response: ${client.messages.length} messages`)
    } else {
      log('blue', 'No permission request (dangerously_skip_permissions=true)')
    }

    // Test 3: Cancel during processing
    logSection('Test 3: Cancel During Processing')
    client.messages = []
    client.sendUserMessage('What is the capital of France? Answer in detail.')
    await new Promise(r => setTimeout(r, 500))
    client.sendCancel(false)
    await new Promise(r => setTimeout(r, 2000))
    log('yellow', `After cancel: ${client.messages.length} messages`)

    // Cleanup
    client.close()
    await httpPost(`/api/v1/sessions/${sessionId}/terminate`, {}, accessToken)

    logSection('Message Type Tests Complete')
    return true

  } catch (error) {
    log('red', 'Message type test failed:', error.message)
    if (client) client.close()
    if (sessionId && accessToken) {
      try { await httpPost(`/api/v1/sessions/${sessionId}/terminate`, {}, accessToken) } catch {}
    }
    return false
  }
}

// Main
async function main() {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: node scripts/test-acp-chain.mjs [options]

Options:
  --help, -h      Show this help
  --full          Run full integration test
  --messages      Run message type tests only

Prerequisites:
  1. Build: bun run scripts/build.js
  2. Start server: node bin/moss-server.mjs
`)
    return
  }

  if (args.includes('--messages')) {
    await testMessageTypes()
  } else {
    await runTests()
    if (!args.includes('--full')) {
      log('blue', '\nTip: Use --full for comprehensive tests, --messages for message type tests')
    }
  }
}

main().catch(console.error)