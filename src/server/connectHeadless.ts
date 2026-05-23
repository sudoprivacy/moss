import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import {
  type DirectConnectConfig,
  DirectConnectSessionManager,
} from './directConnectManager.js'

function extractAssistantText(message: SDKMessage): string {
  if (message.type !== 'assistant' || !Array.isArray(message.message?.content)) {
    return ''
  }
  return message.message.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

async function readPromptFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return ''
  }

  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8').trim()
}

export async function runConnectHeadless(
  config: DirectConnectConfig,
  prompt: string,
  outputFormat: string,
  interactive: boolean,
): Promise<void> {
  const resolvedPrompt = prompt || (interactive ? await readPromptFromStdin() : '')
  if (!resolvedPrompt) {
    throw new Error(
      'A prompt is required for headless direct-connect mode. Pass -p "..." or pipe stdin.',
    )
  }

  await new Promise<void>((resolve, reject) => {
    let finished = false
    let promptSent = false
    let lastError: Error | null = null

    const manager = new DirectConnectSessionManager(config, {
      onConnected: () => {
        if (!promptSent) {
          promptSent = true
          manager.sendMessage(resolvedPrompt)
        }
      },
      onMessage: (message) => {
        if (outputFormat === 'stream-json') {
          process.stdout.write(JSON.stringify(message) + '\n')
        } else {
          const text = extractAssistantText(message)
          if (text) {
            process.stdout.write(text + '\n')
          }
        }

        if (message.type === 'result') {
          finished = true
          manager.disconnect()
          if (message.subtype === 'success') {
            resolve()
          } else {
            reject(
              new Error(
                message.errors?.join(', ') || 'Remote session failed',
              ),
            )
          }
        }
      },
      onPermissionRequest: (_request, requestId) => {
        manager.respondToPermissionRequest(requestId, {
          behavior: 'deny',
          message: 'Headless direct-connect does not support permission prompts',
        })
      },
      onReconnecting: (attempt, maxAttempts) => {
        process.stderr.write(
          `Reattaching session ${config.sessionId} (${attempt}/${maxAttempts})...\n`,
        )
      },
      onDisconnected: () => {
        if (!finished) {
          reject(
            lastError ??
              new Error('Remote server disconnected before completion'),
          )
        }
      },
      onError: error => {
        lastError = error
      },
    })

    manager.connect()
  })
}
