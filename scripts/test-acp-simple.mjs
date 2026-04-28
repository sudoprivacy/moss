#!/usr/bin/env node
/**
 * Simple ACP Protocol Test - Check notifications are sent correctly
 */

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cliPath = join(__dirname, '..', 'bin', 'cli-node.js')

console.log('Starting ACP server with --dangerously-skip-permissions...')

const proc = spawn('node', [cliPath, '-acp', '--dangerously-skip-permissions'], {
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buffer = ''
let requestId = 1
const pendingRequests = new Map()
const notifications = []

proc.stdout.on('data', (chunk) => {
  const data = chunk.toString()
  console.log('[STDOUT chunk length:', data.length, ']')

  buffer += data
  const lines = buffer.split('\n')
  buffer = lines.pop() || ''

  for (const line of lines) {
    if (!line.trim()) continue
    console.log('[RAW line]:', line.substring(0, 200))

    try {
      const parsed = JSON.parse(line)
      if (parsed.id !== undefined) {
        console.log('[RESPONSE id=' + parsed.id + ']:', JSON.stringify(parsed).substring(0, 200))
        const pending = pendingRequests.get(parsed.id)
        if (pending) {
          pendingRequests.delete(parsed.id)
          pending.resolve(parsed)
        }
      } else if (parsed.method) {
        console.log('[NOTIFICATION method=' + parsed.method + ']:', JSON.stringify(parsed.params || {}).substring(0, 200))
        notifications.push(parsed)
      }
    } catch (e) {
      console.log('[NON-JSON]:', line.substring(0, 100))
    }
  }
})

if (proc.stderr) {
  proc.stderr.on('data', (chunk) => {
    console.error('[STDERR]:', chunk.toString())
  })
}

proc.on('close', (code) => {
  console.log('[PROCESS closed with code:', code, ']')
})

proc.on('error', (err) => {
  console.error('[PROCESS error]:', err)
})

function sendRequest(method, params) {
  const id = requestId++
  const request = { jsonrpc: '2.0', id, method, params }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id)
      reject(new Error(`Timeout for request ${id}`))
    }, 30000)

    pendingRequests.set(id, { resolve, reject, timeout })

    console.log('[SENDING]:', JSON.stringify(request))
    proc.stdin.write(JSON.stringify(request) + '\n')
  })
}

async function runTests() {
  console.log('\n=== Test 1: initialize ===')
  try {
    const result = await sendRequest('initialize', {})
    console.log('Result:', JSON.stringify(result, null, 2))
  } catch (err) {
    console.log('Error:', err.message)
  }

  console.log('\n=== Test 2: session/new ===')
  let sessionId
  try {
    const result = await sendRequest('session/new', { cwd: '/tmp' })
    sessionId = result.result?.sessionId
    console.log('sessionId:', sessionId)
  } catch (err) {
    console.log('Error:', err.message)
  }

  if (sessionId) {
    console.log('\n=== Test 3: session/prompt ===')
    console.log('Sending prompt...')

    // Collect notifications for 30 seconds
    const notificationCollector = []
    const startTime = Date.now()

    try {
      // Send prompt request
      const promptResult = await sendRequest('session/prompt', {
        sessionId,
        prompt: {
          content: [{ type: 'text', text: 'Say hello world' }]
        }
      })

      console.log('Prompt result:', JSON.stringify(promptResult, null, 2))

      // Print collected notifications
      console.log('\nNotifications collected during prompt:')
      for (const n of notifications) {
        const update = n.params?.update
        if (update) {
          console.log('  -', update.sessionUpdate, update.content?.text?.substring(0, 50) || '')
        }
      }

      console.log('\nTotal notifications:', notifications.length)

    } catch (err) {
      console.log('Error:', err.message)
    }
  }

  console.log('\n=== Closing ===')
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'exit' }) + '\n')
  proc.kill()

  // Wait a bit for output
  await new Promise(r => setTimeout(r, 1000))
}

runTests().catch(console.error)