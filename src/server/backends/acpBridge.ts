import { createInterface } from 'readline'
import { appendFile, mkdir, rm } from 'fs/promises'
import { dirname } from 'path'
import { randomUUID } from 'crypto'
import type { ChildProcess } from 'child_process'
import type { BackendHandle, SessionRuntimeInfo } from '../sessionManager.js'
import { prepareFirstMessageForScode, buildIdentityBlock } from '../../utils/scodeBridge.js'
import {
  appendSharedAgentMemory,
  extractRememberableUserFact,
} from '../sharedAgentMemory.js'

type AcpBridgeOptions = {
  child: ChildProcess
  sessionId: string
  cwd: string
  model: string
  transcriptPath?: string
  runtime: SessionRuntimeInfo
  // 新增参数：首次消息注入
  assistantName?: string
  enabledSkillNames?: string[]
  /**
   * Document Center v2: wikis this assistant is authorized to query.
   * Threaded by RuntimeService.spawnAttempt -> backend -> here, and
   * surfaced in the first user message as an `[Available Wikis]` block
   * so scode learns it can use the `wiki` CLI.
   */
  availableWikis?: Array<{ id: string; name: string; description?: string | null }>
  sharedMemory?: string | null
  // 旧参数（已废弃，保留兼容）
  mcpServers?: any[]
  agents?: any[]
  instructions?: string
}

export function createAcpBridgeHandle(options: AcpBridgeOptions): BackendHandle {
  const { child, sessionId, cwd, model, runtime } = options
  const transcriptPath = options.transcriptPath

  if (!child.stdin || !child.stdout) {
    throw new Error('Failed to start scode process pipes')
  }

  const stdoutListeners = new Set<(line: string) => void>()
  const stderrListeners = new Set<(line: string) => void>()
  const exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>()

  let rpcId = 1
  let acpSessionId: string | null = null
  const pendingStdin: string[] = []
  const pendingStdout: string[] = []
  let currentAssistantText = ''
  let lastPersistedUuid: string | null = null
  let isHandshakeComplete = false
  let currentTurnAssistantUuid: string | null = null
  let currentModel = model  // Track current model for dynamic switching

  // Pending RPC requests waiting for response
  const pendingRpcRequests = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timeoutId: NodeJS.Timeout }>()

  // 新增：首次消息标记
  let isFirstMessage = true

  const writeTranscript = async (event: any) => {
    if (!transcriptPath) return
    try {
      await mkdir(dirname(transcriptPath), { recursive: true })
      await appendFile(transcriptPath, JSON.stringify(event) + '\n', 'utf8')
    } catch (e: any) {
      process.stderr.write(`[AcpBridge] TRANSCRIPT WRITE ERROR: ${e.message}\n`)
    }
  }

  const sendRpc = (method: string, params: any, customId?: string) => {
    const id = customId || `m-${rpcId++}`
    const msg = { jsonrpc: '2.0', id, method, params }
    const raw = JSON.stringify(msg) + '\n'
    process.stderr.write(`[AcpBridge] Sending RPC: ${raw}`)
    child.stdin!.write(raw)
  }

  // Send RPC and wait for response (for model switching)
  const sendRpcAndWait = (method: string, params: any, customId?: string, timeoutMs = 30000): Promise<any> => {
    const id = customId || `m-${rpcId++}`
    const msg = { jsonrpc: '2.0', id, method, params }
    const raw = JSON.stringify(msg) + '\n'
    process.stderr.write(`[AcpBridge] Sending RPC (wait): ${raw}`)
    child.stdin!.write(raw)

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingRpcRequests.delete(id)
        reject(new Error(`RPC ${method} timed out after ${timeoutMs / 1000}s`))
      }, timeoutMs)

      pendingRpcRequests.set(id, { resolve, reject, timeoutId })
    })
  }

  const emitStdout = (line: string) => {
    if (!isHandshakeComplete) {
      pendingStdout.push(line)
      return
    }
    for (const l of stdoutListeners) l(line)
  }

  const flushStdout = () => {
    while (pendingStdout.length > 0) {
      const line = pendingStdout.shift()!
      for (const l of stdoutListeners) l(line)
    }
  }

  const processUserMessage = async (data: string) => {
    let cleanText = data
    let userUuid = randomUUID()
    let structuredContent: any[] | null = null
    try {
      const parsed = JSON.parse(data)
      if (parsed.type === 'user') {
        const content = parsed.message?.content || data
        if (Array.isArray(content)) {
          structuredContent = content
        }
        if (Array.isArray(content)) {
          cleanText = content.map((c: any) => c.text || '').join('\n')
        } else {
          cleanText = typeof content === 'string' ? content : (content?.text || JSON.stringify(content))
        }
        userUuid = parsed.uuid || userUuid
      }
    } catch {
      cleanText = data
    }

    const trimmedText = typeof cleanText === 'string' ? cleanText.trim() : String(cleanText)

    const hasToolResult =
      Array.isArray(structuredContent)
      && structuredContent.some(block => block?.type === 'tool_result')

    if (hasToolResult) {
      sendRpc('session/prompt', {
        sessionId: acpSessionId,
        prompt: structuredContent,
      })
      return
    }

    if (
      options.assistantName &&
      runtime.configDir &&
      (runtime.hostMode === 'user' || runtime.dockerMode === 'user')
    ) {
      const memoryFact = extractRememberableUserFact(trimmedText)
      if (memoryFact) {
        void appendSharedAgentMemory({
          configDir: runtime.configDir,
          assistantName: options.assistantName,
          content: memoryFact.content,
          source: memoryFact.source,
        }).catch(err => {
          process.stderr.write(
            `[AcpBridge] Failed to persist shared memory: ${String(err)}\n`,
          )
        })
      }
    }

    // 首次消息注入：注入技能和智能体信息
    let finalText = trimmedText
    if (isFirstMessage) {
      try {
        finalText = await prepareFirstMessageForScode(trimmedText, {
          assistantName: options.assistantName,
          workspace: cwd,
          enabledSkillNames: options.enabledSkillNames,
          sharedMemory: options.sharedMemory,
          availableWikis: options.availableWikis,
        })
        process.stderr.write(`[AcpBridge] First message prepared with skills/assistant injection\n`)
      } catch (err) {
        process.stderr.write(`[AcpBridge] Failed to prepare first message: ${err}\n`)
      }
      isFirstMessage = false
    } else if (options.assistantName) {
      // 后续消息：只注入身份声明
      const identityBlock = buildIdentityBlock(options.assistantName)
      finalText = `${identityBlock}[User Request]\n${trimmedText}`
    }

    // 写入 transcript 时只保存原始用户消息（trimmedText），不包含系统提示词
    // 系统提示词是给 agent 的，不应该出现在用户可见的历史记录中
    const userEvent = {
      type: 'user',
      sessionId,
      uuid: userUuid,
      parentUuid: lastPersistedUuid,
      isSidechain: false,
      timestamp: new Date().toISOString(),
      cwd,
      userType: 'external',
      version: 'unknown',
      message: {
        role: 'user',
        content: trimmedText, // 保存原始用户消息，不包含注入的系统提示词
      },
    }
    void writeTranscript(userEvent)
    lastPersistedUuid = userUuid

    // 发送给 agent 的是包含系统提示词的 finalText
    sendRpc('session/prompt', {
      sessionId: acpSessionId,
      prompt: [{ type: 'text', text: finalText }],
    })
  }

  const flushPending = () => {
    if (!acpSessionId || !isHandshakeComplete) {
      process.stderr.write(`[AcpBridge] flushPending skipped: sessionId=${!!acpSessionId}, ready=${isHandshakeComplete}\n`)
      return
    }

    if (pendingStdin.length === 0) return

    process.stderr.write(`[AcpBridge] Flushing ${pendingStdin.length} pending user messages...\n`)

    // Use setImmediate to ensure the engine has finished processing the session/new response
    setImmediate(() => {
      while (pendingStdin.length > 0) {
        const data = pendingStdin.shift()!
        try {
          process.stderr.write(`[AcpBridge] Flushing message: ${data.slice(0, 50)}...\n`)
          processUserMessage(data)
        } catch (e: any) {
          process.stderr.write(`[AcpBridge] Error flushing message: ${e.message}\n`)
        }
      }
    })
  }

  let stdoutBuffer = ''
  child.stdout.on('data', (data: Buffer) => {
    const chunk = data.toString('utf8')
    // Silencing the very verbose RAW STDOUT unless needed for deep debugging
    // process.stderr.write(`[AcpBridge] RAW STDOUT: ${chunk}\n`)
    stdoutBuffer += chunk

    while (true) {
      const newlineIdx = stdoutBuffer.indexOf('\n')
      if (newlineIdx === -1) break

      const line = stdoutBuffer.slice(0, newlineIdx).trim()
      stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1)

      if (!line) continue

      try {
        const parsed = JSON.parse(line)

        if (parsed.id === 'm-init') {
          process.stderr.write(`[AcpBridge] Initialization complete, creating session...\n`)
          const sessionParams: any = {
            cwd,
            // Scode ACP 要求 mcpServers 字段，即使为空数组
            mcpServers: [],
          }
          // 技能和智能体信息通过首次消息注入
          process.stderr.write(`[AcpBridge] session/new params: cwd=${cwd}, mcpServers=[]\n`)
          sendRpc('session/new', sessionParams, 'm-session-new')
          continue
        }

        if (parsed.id === 'm-session-new') {
          process.stderr.write(`[AcpBridge] session/new response: ${JSON.stringify(parsed)}\n`)
          acpSessionId = parsed.result?.sessionId || parsed.result?.id || parsed.result?.session_id
          process.stderr.write(`[AcpBridge] ACP Session Ready: ${acpSessionId}\n`)
          isHandshakeComplete = true
          process.stderr.write(`[AcpBridge] Handshake complete, flushing buffers (Stdout: ${pendingStdout.length}, Stdin: ${pendingStdin.length})\n`)
          flushStdout()
          flushPending()
          continue
        }

        // Handle session/setModel response
        if (parsed.id === 'm-set-model') {
          process.stderr.write(`[AcpBridge] session/setModel response: ${JSON.stringify(parsed)}\n`)
          const pending = pendingRpcRequests.get('m-set-model')
          if (pending) {
            clearTimeout(pending.timeoutId)
            pendingRpcRequests.delete('m-set-model')
            if (parsed.error) {
              process.stderr.write(`[AcpBridge] Model switch failed: ${JSON.stringify(parsed.error)}\n`)
              pending.reject(new Error(parsed.error.message || JSON.stringify(parsed.error)))
            } else {
              process.stderr.write(`[AcpBridge] Model switch succeeded\n`)
              pending.resolve(parsed.result)
            }
          }
          continue
        }

        // ... (rest of the stdout processing logic)

        if (parsed.result?.stopReason) {
          process.stderr.write(`[AcpBridge] Turn Ended. Unblocking UI...\n`)
          currentTurnAssistantUuid = null // Reset UUID for the next turn

          const rawUsage = parsed.result.usage || {}
          const usage = {
            input_tokens: rawUsage.inputTokens || 0,
            output_tokens: rawUsage.outputTokens || 0,
            cache_read_input_tokens: rawUsage.cachedReadTokens || 0,
            cache_creation_input_tokens: rawUsage.cachedWriteTokens || 0,
          }
          const assistantUuid = randomUUID()

          if (currentAssistantText) {
            const assistantEvent = {
              type: 'assistant',
              sessionId,
              uuid: assistantUuid,
              parentUuid: lastPersistedUuid,
              isSidechain: false,
              timestamp: new Date().toISOString(),
              cwd,
              userType: 'external',
              version: 'unknown',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: currentAssistantText }],
                usage,
                model,
              },
            }
            void writeTranscript(assistantEvent)
            lastPersistedUuid = assistantUuid
          }

          const resultEvent = JSON.stringify({
            type: 'result',
            session_id: sessionId,
            status: 'success',
            usage,
          })
          process.stderr.write(`[AcpBridge] EMITTING RESULT EVENT: ${resultEvent}\n`)
          emitStdout(resultEvent + '\n')

          currentAssistantText = ''
        }

        if (parsed.method === 'session/update' && parsed.params) {
          const { update } = parsed.params
          const sessionUpdate = parsed.params.sessionUpdate || update?.sessionUpdate

          if (sessionUpdate === 'agent_message_chunk' && update) {
            const content = update.content || update.message?.content
            let text = ''
            if (typeof content === 'string') {
              text = content
            } else if (content && typeof content === 'object') {
              text = content.text || (Array.isArray(content) ? content[0]?.text : content?.text) || ''
            }

            if (text) {
              process.stderr.write(`[AcpBridge] Received chunk: ${text.slice(0, 20)}...\n`)
              currentAssistantText += text

              if (!currentTurnAssistantUuid) {
                currentTurnAssistantUuid = randomUUID()
              }

              const messagePayload = {
                role: 'assistant',
                content: [{ type: 'text', text: text }], // Send only the current chunk/delta
              }
              const mossEvent = JSON.stringify({
                type: 'assistant',
                session_id: sessionId,
                message: messagePayload,
                uuid: currentTurnAssistantUuid,
                timestamp: new Date().toISOString(),
                delta: true, // Mark as delta for the frontend to handle correctly
              })
              process.stderr.write(`[AcpBridge] EMITTING ASSISTANT EVENT: ${mossEvent}\n`)
              emitStdout(mossEvent + '\n')
              // Removed raw text emission to prevent duplicate display in UI
            }
          }

          if (sessionUpdate === 'tool_call' && update) {
            const toolUuid = randomUUID()
            const toolEvent = {
              type: 'tool_use',
              sessionId,
              uuid: toolUuid,
              parentUuid: lastPersistedUuid,
              isSidechain: false,
              name: update.title || update.rawInput?.path || 'tool',
              tool_use_id: update.toolCallId,
              input: JSON.stringify(update.rawInput || {}),
              timestamp: new Date().toISOString(),
              cwd,
              userType: 'external',
              version: 'unknown',
            }
            process.stderr.write(`[AcpBridge] EMITTING TOOL_USE EVENT: ${JSON.stringify(toolEvent)}\n`)
            emitStdout(JSON.stringify(toolEvent) + '\n')
            void writeTranscript(toolEvent)
            lastPersistedUuid = toolUuid
          }
        }
      } catch {
        // Ignore parse errors
      }
    }
  })

  // Initial hello and start handshake
  process.nextTick(() => {
    process.stderr.write(`[AcpBridge] Emitting initial hello and starting handshake...\n`)
    const hello = JSON.stringify({
      type: 'hello',
      session_id: sessionId,
      runtimeType: runtime.type,
      state: 'running',
    }) + '\n'
    // We don't use emitStdout here because we want hello to be first and we know
    // it will be buffered if listeners aren't ready yet, or sent immediately if they are.
    // However, during the very first tick, they might not be ready.
    // So we use the same buffering logic.
    emitStdout(hello)

    sendRpc('initialize', {
      protocolVersion: '1.0',
      clientInfo: { name: 'moss-bridge', version: '1.0' },
    }, 'm-init')
  })

  if (child.stderr) {
    const stderrRl = createInterface({ input: child.stderr })
    stderrRl.on('line', line => {
      for (const l of stderrListeners) l(line + '\n')
      process.stderr.write(`[AcpBridge stderr] ${line}\n`)
    })
  }

  child.on('close', (code, signal) => {
    for (const l of exitListeners) l(code, signal)
  })

  return {
    workDir: cwd,
    runtime,
    writeStdin(data: string) {
      process.stderr.write(`[AcpBridge] writeStdin called: ${data?.slice(0, 100)}...\n`)
      if (child.stdin?.destroyed) {
        process.stderr.write(`[AcpBridge] writeStdin: stdin destroyed, ignoring\n`)
        return
      }

      // Handle control_request for model switching (async)
      try {
        const parsed = JSON.parse(data)
        process.stderr.write(`[AcpBridge] Received control_request: ${JSON.stringify(parsed)}\n`)
        if (parsed.type === 'control_request' && parsed.request?.subtype === 'set_model') {
          const modelId = parsed.request.model_id
          if (!modelId) {
            process.stderr.write(`[AcpBridge] set_model request missing model_id\n`)
            return
          }

          // Build scode model name with proxy/ prefix if needed
          let scodeModelName = modelId
          if (!scodeModelName.includes('/') && !['opus', 'sonnet', 'haiku', 'claude-opus', 'claude-sonnet', 'claude-haiku'].includes(scodeModelName)) {
            scodeModelName = `proxy/${scodeModelName}`
          }

          process.stderr.write(`[AcpBridge] Model switch requested: ${scodeModelName}, acpSessionId: ${acpSessionId}\n`)

          // Send ACP SetSessionModelRequest and wait for response
          // Use async handling to ensure model switch completes before next message
          // Note: method name is "session/set_model" (underscore), not "session/setModel" (camelCase)
          sendRpcAndWait('session/set_model', {
            sessionId: acpSessionId,
            modelId: scodeModelName,
          }, 'm-set-model', 30000)
            .then((result) => {
              process.stderr.write(`[AcpBridge] Model switch completed: ${JSON.stringify(result)}\n`)
              // Update current model tracking
              currentModel = scodeModelName

              // Emit model_changed event to notify frontend
              const modelChangedEvent = JSON.stringify({
                type: 'system',
                subtype: 'model_changed',
                session_id: sessionId,
                model: scodeModelName,
              })
              process.stderr.write(`[AcpBridge] Emitting model_changed event: ${modelChangedEvent}\n`)
              emitStdout(modelChangedEvent + '\n')
            })
            .catch((error) => {
              process.stderr.write(`[AcpBridge] Model switch failed: ${error.message}\n`)
              // Still emit model_changed event for UI consistency (model preference is saved)
              const modelChangedEvent = JSON.stringify({
                type: 'system',
                subtype: 'model_changed',
                session_id: sessionId,
                model: scodeModelName,
              })
              emitStdout(modelChangedEvent + '\n')
            })

          return
        }
      } catch {
        // Not a JSON message or not a control_request, continue with normal processing
      }

      if (!acpSessionId) {
        process.stderr.write(`[AcpBridge] Session not ready, buffering message...\n`)
        pendingStdin.push(data)
        return
      }

      process.stderr.write(`[AcpBridge] Calling processUserMessage...\n`)
      processUserMessage(data)
    },
    onStdoutLine(l) { stdoutListeners.add(l); return () => stdoutListeners.delete(l) },
    onStderrLine(l) { stderrListeners.add(l); return () => stderrListeners.delete(l) },
    onExit(l) { exitListeners.add(l); return () => exitListeners.delete(l) },
    destroy(force = false) {
      if (child.killed) return
      child.kill(force ? 'SIGKILL' : 'SIGTERM')

      // Host 模式 Session 模式清理 configDir
      if (runtime.type === 'host' && runtime.hostMode === 'session' && runtime.configDir) {
        rm(runtime.configDir, { recursive: true, force: true }).catch(() => {
          // 忽略清理错误
        })
      }
    },
  }
}
