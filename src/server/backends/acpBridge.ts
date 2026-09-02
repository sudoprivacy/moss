import { createInterface } from 'readline'
import { appendFile, mkdir, rm, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { randomUUID } from 'crypto'
import type { ChildProcess } from 'child_process'
import type { BackendHandle, SessionRuntimeInfo } from '../sessionManager.js'
import { prepareFirstMessageForScode } from '../../utils/scodeBridge.js'
import {
  appendSharedAgentMemory,
  extractRememberableUserFact,
} from '../sharedAgentMemory.js'
import { cleanupIntermediateFiles, ensureDraftsDirectory } from '../draftsCleanup.js'

type AcpBridgeOptions = {
  child: ChildProcess
  sessionId: string
  cwd: string
  model: string
  transcriptPath?: string
  runtime: SessionRuntimeInfo
  resumeSessionId?: string
  scodeSessionIdPath?: string
  /**
   * Per-user container mode. 'session' (default) sends signals to the child
   * docker run process on destroy. 'user' only closes stdin on destroy — the
   * real kill is performed by DockerBackend invoking moss-session-reap inside
   * the long-lived user container.
   */
  containerMode?: 'session' | 'user'
  // 新增参数：首次消息注入
  assistantName?: string
  assistantDisplayName?: string
  enabledSkillNames?: string[]
  /**
   * Document Center v2: wikis this agent is authorized to query.
   * Threaded by RuntimeService.spawnAttempt -> backend -> here, and
   * surfaced in the first user message as an `[Available Wikis]` block
   * so scode learns it can use the `wiki` CLI.
   */
  availableWikis?: Array<{ id: string; name: string; description?: string | null }>
  /** 企业应用管理: corp app instances surfaced as an `[Available Corp Apps]` block. */
  availableCorpApps?: Array<{ id: string; name: string; type: string; key: string }>
  sharedMemory?: string | null
  // 旧参数（已废弃，保留兼容）
  mcpServers?: any[]
  agents?: any[]
  instructions?: string
}

export function createAcpBridgeHandle(options: AcpBridgeOptions): BackendHandle {
  const { child, sessionId, cwd, model, runtime } = options
  const containerMode = options.containerMode ?? runtime.containerMode ?? 'session'
  const transcriptPath = options.transcriptPath

  // A2: busy state machine
  let busy = false
  const busyListeners = new Set<(b: boolean) => void>()
  const setBusy = (next: boolean): void => {
    if (next === busy) return
    busy = next
    for (const l of busyListeners) {
      try { l(next) } catch (err) {
        process.stderr.write(`[AcpBridge] busy listener error: ${err}\n`)
      }
    }
  }
  const reevaluateBusy = (): void => {
    // Busy = false only when stopReason arrived AND no buffered stdin AND no
    // pending AskUserQuestion. Anything pending keeps busy=true.
    if (pendingAskUserQuestions.size > 0) {
      setBusy(true)
      return
    }
    if (pendingStdin.length > 0) {
      // Stdin still queued -> the engine has a turn coming. Treat as busy.
      setBusy(true)
      return
    }
    setBusy(false)
  }

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
  // Accumulates AgentThoughtChunk text for the current turn (mirrors
  // currentAssistantText). Flushed as a `thinking` transcript record on
  // stopReason, then reset. Without this, scode's reasoning is dropped.
  let currentThoughtText = ''
  let lastPersistedUuid: string | null = null
  let isHandshakeComplete = false
  let currentTurnAssistantUuid: string | null = null
  let currentTurnUsedSendUserMessage = false
  let currentModel = model  // Track current model for dynamic switching
  const toolResultIdByToolCallId = new Map<string, string>()
  // Track tool calls in current turn for completion status
  const currentTurnToolCalls = new Map<string, { toolCallId: string; name: string }>()
  // Latest ACP tool_call_update content per toolCallId, captured so a
  // `tool_result` record (with the tool's actual output) can be persisted on
  // stopReason. Without this the transcript records the call but never its
  // output.
  const currentTurnToolOutput = new Map<string, { content: unknown; isError: boolean }>()

  // Pending RPC requests waiting for response
  const pendingRpcRequests = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timeoutId: NodeJS.Timeout }>()

  // Pending AskUserQuestion requests waiting for user answer
  // Maps tool_call_id -> { requestId, questionData, resolve, reject }
  const pendingAskUserQuestions = new Map<string, {
    requestId: string
    toolCallId: string
    questionData: any
    resolve: (value: any) => void
    reject: (error: Error) => void
  }>()

  // Map from session/update tool_use uuid to _scode/ask_user_question requestId
  // This is needed because scode sends AskUserQuestion twice:
  // 1. Via session/update (tool_call) - frontend uses this uuid as parent_tool_use_id
  // 2. Via _scode/ask_user_question RPC - needs RPC response with this requestId
  const askUserQuestionUuidToRequestId = new Map<string, string>()

  // 新增：首次消息标记
  let isFirstMessage = true

  const getSendUserMessageText = (rawInput: unknown): string | null => {
    let input = rawInput
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input)
      } catch {
        return null
      }
    }
    if (!input || typeof input !== 'object') return null
    const message = (input as { message?: unknown }).message
    return typeof message === 'string' && message.trim() ? message : null
  }

  // ACP image content block, as expected by scode's `extract_content_from_blocks`
  // (bare `data` base64 + camelCase `mimeType`, not the Anthropic `source: {}`
  // nesting the client sends us).
  type AcpImageBlock = { type: 'image'; data: string; mimeType: string }

  // Extract Anthropic-style image blocks from a client content array and map
  // them to the ACP shape. The client sends images as
  //   { type: 'image', source: { type: 'base64', media_type, data } }
  // (iOS may send `mediaType` instead of `media_type` — mobile-apps#5825).
  // These have no `.text`, so the text-flatten below drops them; without this
  // they never reach scode and image analysis silently fails in remote mode.
  const extractAcpImageBlocks = (content: unknown): AcpImageBlock[] => {
    if (!Array.isArray(content)) return []
    const blocks: AcpImageBlock[] = []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, any>
      if (b.type !== 'image') continue
      const source = b.source
      if (!source || typeof source !== 'object') continue
      const data = source.data
      if (typeof data !== 'string' || data.length === 0) continue
      const mimeType =
        (typeof source.media_type === 'string' && source.media_type) ||
        (typeof source.mediaType === 'string' && source.mediaType) ||
        'image/png'
      blocks.push({ type: 'image', data, mimeType })
    }
    return blocks
  }

  // Flatten an ACP ToolCallUpdate `content` array into the text output a
  // Claude-Code-style `tool_result` record expects. ACP wraps each block as
  // `{ type: 'content', content: { type: 'text', text } }`, but tolerate bare
  // `{ type: 'text', text }` too. Returns undefined when there is nothing to
  // record (so callers can avoid clobbering earlier output with an empty
  // in-progress update).
  const extractToolResultContent = (content: unknown): string | undefined => {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return undefined
    const parts: string[] = []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, any>
      const inner = b.type === 'content' && b.content && typeof b.content === 'object' ? b.content : b
      const text = typeof inner.text === 'string' ? inner.text : ''
      if (text) parts.push(text)
    }
    return parts.length > 0 ? parts.join('\n') : undefined
  }

  // The text moss receives from the Sudowork client still carries the
  // client-injected preambles: an `[Assistant Rules …]` block and/or a cron
  // skill instruction, each terminated by a `[User Request]\n` header (see the
  // Sudowork client's RemoteAgent/agentUtils). Everything the human actually
  // typed is the last `[User Request]` segment. This mirrors the client's own
  // `extractDisplayUserContent` so a transcript rendered here reads the same as
  // in the desktop app. The raw text is still stored in `content` for resume
  // fidelity; this only feeds the additive `displayText` field.
  const extractDisplayUserText = (text: string): string => {
    if (typeof text !== 'string' || !text.includes('[User Request]')) return text
    const parts = text.split('[User Request]')
    return parts[parts.length - 1]?.trim() || text
  }

  const writeTranscript = async (event: any) => {
    if (!transcriptPath) return
    try {
      await mkdir(dirname(transcriptPath), { recursive: true })
      await appendFile(transcriptPath, JSON.stringify(event) + '\n', 'utf8')
    } catch (e: any) {
      process.stderr.write(`[AcpBridge] TRANSCRIPT WRITE ERROR: ${e.message}\n`)
    }
  }

  const persistScodeSessionId = (id: string | null | undefined): void => {
    if (!id || !options.scodeSessionIdPath) return
    void mkdir(dirname(options.scodeSessionIdPath), { recursive: true })
      .then(() => writeFile(options.scodeSessionIdPath!, id, 'utf8'))
      .catch(err => {
        process.stderr.write(`[AcpBridge] Failed to persist scode session id: ${String(err)}\n`)
      })
  }

  const sendRpc = (method: string, params: any, customId?: string) => {
    const id = customId || `m-${rpcId++}`
    const msg = { jsonrpc: '2.0', id, method, params }
    const raw = JSON.stringify(msg) + '\n'
    process.stderr.write(`[AcpBridge] Sending RPC: ${raw}`)
    if (!child.stdin?.destroyed && !child.stdin?.writableEnded) {
      child.stdin.write(raw)
    }
  }

  const sendNewSession = (): void => {
    const sessionParams: any = {
      cwd,
      // Scode ACP requires mcpServers even when no MCP servers are configured.
      mcpServers: [],
    }
    process.stderr.write(`[AcpBridge] session/new params: cwd=${cwd}, mcpServers=[]\n`)
    sendRpc('session/new', sessionParams, 'm-session-new')
  }

  const completeHandshake = (): void => {
    isHandshakeComplete = true
    process.stderr.write(`[AcpBridge] Handshake complete, flushing buffers (Stdout: ${pendingStdout.length}, Stdin: ${pendingStdin.length})\n`)
    flushStdout()
    flushPending()
  }

  // Send RPC and wait for response (for model switching)
  const sendRpcAndWait = (method: string, params: any, customId?: string, timeoutMs = 30000): Promise<any> => {
    const id = customId || `m-${rpcId++}`
    const msg = { jsonrpc: '2.0', id, method, params }
    const raw = JSON.stringify(msg) + '\n'
    process.stderr.write(`[AcpBridge] Sending RPC (wait): ${raw}`)
    if (!child.stdin?.destroyed && !child.stdin?.writableEnded) {
      child.stdin.write(raw)
    }

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
    let parentToolUseId: string | null = null
    let imageBlocks: AcpImageBlock[] = []
    try {
      const parsed = JSON.parse(data)
      if (parsed.type === 'user') {
        const content = parsed.message?.content || data
        if (typeof parsed.parent_tool_use_id === 'string' && parsed.parent_tool_use_id.trim()) {
          parentToolUseId = parsed.parent_tool_use_id.trim()
        }
        if (Array.isArray(content)) {
          structuredContent = content
          imageBlocks = extractAcpImageBlocks(content)
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
    const acpToolUseId = parentToolUseId ? (toolResultIdByToolCallId.get(parentToolUseId) || parentToolUseId) : null

    // Check if this is a response to an AskUserQuestion
    // If so, we need to send RPC response instead of session/prompt
    // First, check if parentToolUseId is directly in pendingAskUserQuestions
    // If not, check if it's in the uuid->requestId mapping (for session/update -> _scode/ask_user_question linking)
    let pendingQuestionKey = parentToolUseId
    if (parentToolUseId && !pendingAskUserQuestions.has(parentToolUseId)) {
      // Check if this uuid maps to a requestId
      const mappedRequestId = askUserQuestionUuidToRequestId.get(parentToolUseId)
      if (mappedRequestId) {
        process.stderr.write(`[AcpBridge] Found AskUserQuestion mapping: uuid=${parentToolUseId} -> requestId=${mappedRequestId}\n`)
        pendingQuestionKey = mappedRequestId
      }
    }

    if (pendingQuestionKey && pendingAskUserQuestions.has(pendingQuestionKey)) {
      const pendingQuestion = pendingAskUserQuestions.get(pendingQuestionKey)!
      pendingAskUserQuestions.delete(pendingQuestionKey)
      // Also clean up the mapping
      askUserQuestionUuidToRequestId.delete(parentToolUseId!)
      // A2: user answered -> question no longer pending. Busy is still true
      // because the engine will run another turn from this answer; the next
      // stopReason will flip it back to false.

      process.stderr.write(`[AcpBridge] Processing AskUserQuestion response for toolCallId=${pendingQuestionKey}, answer=${trimmedText}\n`)

      // Build the answer payload for scode
      // The answer format expected by scode: { answers: [{ id, value, label }] }
      const answerPayload = {
        answers: [{
          id: pendingQuestion.questionData.questions?.[0]?.id || 'answer',
          value: trimmedText,
          label: trimmedText,
        }]
      }

      // Send RPC response to scode
      const responseMsg = {
        jsonrpc: '2.0',
        id: pendingQuestion.requestId,
        result: answerPayload,
      }
      const raw = JSON.stringify(responseMsg) + '\n'
      process.stderr.write(`[AcpBridge] Sending AskUserQuestion RPC response: ${raw}\n`)
      if (!child.stdin?.destroyed && !child.stdin?.writableEnded) {
      child.stdin.write(raw)
    }

      // Also emit user message to transcript for record
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
          content: [{ type: 'text', text: trimmedText }],
        },
      }
      void writeTranscript(userEvent)
      lastPersistedUuid = userUuid
      return
    }

    if (parentToolUseId && !structuredContent?.some(block => block?.type === 'tool_result')) {
      structuredContent = [{
        type: 'tool_result',
        tool_use_id: acpToolUseId,
        content: trimmedText,
      }]
    }

    const hasToolResult =
      Array.isArray(structuredContent)
      && structuredContent.some(block => block?.type === 'tool_result')

    if (hasToolResult) {
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
          content: structuredContent,
        },
        parent_tool_use_id: acpToolUseId,
      }
      void writeTranscript(userEvent)
      lastPersistedUuid = userUuid

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
    try {
      await ensureDraftsDirectory(cwd)
    } catch (err) {
      process.stderr.write(`[AcpBridge] Failed to ensure drafts directory: ${String(err)}\n`)
    }
    if (isFirstMessage) {
      try {
        finalText = await prepareFirstMessageForScode(trimmedText, {
          assistantName: options.assistantName,
          identityName: options.assistantDisplayName || options.assistantName,
          workspace: cwd,
          enabledSkillNames: options.enabledSkillNames,
          sharedMemory: options.sharedMemory,
          availableWikis: options.availableWikis,
          availableCorpApps: options.availableCorpApps,
        })
        process.stderr.write(`[AcpBridge] First message prepared with skills/assistant injection\n`)
      } catch (err) {
        process.stderr.write(`[AcpBridge] Failed to prepare first message: ${err}\n`)
      }
      isFirstMessage = false
    }
    // 后续消息不再注入身份声明。身份由 configDir/.nexus/sudocode/AGENTS.md 承载
    // （可信的 runtime 配置），在用户消息里重复一份 "[Identity Override - 最高优先级]"
    // 反而会被模型判定为提示注入攻击并拒绝，连带否定合法的身份声明。

    // 写入 transcript 时只保存原始用户消息（trimmedText），不包含系统提示词
    // 系统提示词是给 agent 的，不应该出现在用户可见的历史记录中
    // displayText is written only when it differs from the original after stripping the client-injected
    // [User Request]/cron preamble (for the render layer); raw content keeps the full text for resume fidelity.
    const displayText = extractDisplayUserText(trimmedText)
    const userEvent: Record<string, unknown> = {
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
    if (displayText !== trimmedText) {
      userEvent.displayText = displayText
    }
    void writeTranscript(userEvent)
    lastPersistedUuid = userUuid

    // 发送给 agent 的是包含系统提示词的 finalText。若用户消息附带图片，
    // 将图片块与文本一起发送，scode 会把它们作为 vision 输入交给模型。
    sendRpc('session/prompt', {
      sessionId: acpSessionId,
      prompt: [...imageBlocks, { type: 'text', text: finalText }],
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
          if (options.resumeSessionId) {
            process.stderr.write(`[AcpBridge] Initialization complete, loading session ${options.resumeSessionId}...\n`)
            sendRpc('session/load', {
              sessionId: options.resumeSessionId,
              cwd,
              // Scode ACP LoadSessionRequest also requires mcpServers.
              mcpServers: [],
            }, 'm-session-load')
          } else {
            process.stderr.write(`[AcpBridge] Initialization complete, creating session...\n`)
            sendNewSession()
          }
          continue
        }

        if (parsed.id === 'm-session-new') {
          process.stderr.write(`[AcpBridge] session/new response: ${JSON.stringify(parsed)}\n`)
          acpSessionId = parsed.result?.sessionId || parsed.result?.id || parsed.result?.session_id
          persistScodeSessionId(acpSessionId)
          process.stderr.write(`[AcpBridge] ACP Session Ready: ${acpSessionId}\n`)
          completeHandshake()
          continue
        }

        if (parsed.id === 'm-session-load') {
          process.stderr.write(`[AcpBridge] session/load response: ${JSON.stringify(parsed)}\n`)
          if (parsed.error) {
            // Loud on purpose. This is the silent-amnesia path: the session is
            // revived and looks healthy, but starts with an EMPTY context. The
            // usual cause is the workspace losing `.moss/scode-session-id`
            // (which is where resumeSessionId is read from) while the session
            // row still points at a transcript — so nothing else in the stack
            // reports a problem, and the only symptom is a user saying the bot
            // forgot everything.
            process.stderr.write(
              `[AcpBridge] session/load FAILED for ${options.resumeSessionId} — falling back to session/new. ` +
              `CONVERSATION HISTORY WILL NOT BE RESTORED for this session. ` +
              `error=${JSON.stringify(parsed.error)}\n`,
            )
            sendNewSession()
            continue
          }
          acpSessionId = parsed.result?.sessionId || parsed.result?.id || parsed.result?.session_id || options.resumeSessionId || null
          persistScodeSessionId(acpSessionId)
          process.stderr.write(`[AcpBridge] ACP Session Loaded: ${acpSessionId}\n`)
          completeHandshake()
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

          // Emit tool completion status for all tools in current turn
          // This is needed because scode doesn't send individual tool completion events
          for (const [toolCallId, toolInfo] of currentTurnToolCalls) {
            const toolCompleteEvent = {
              type: 'tool_use',
              sessionId,
              uuid: toolCallId,
              parentUuid: lastPersistedUuid,
              isSidechain: false,
              name: toolInfo.name,
              tool_use_id: toolCallId,
              status: 'completed',
              timestamp: new Date().toISOString(),
              cwd,
              userType: 'external',
              version: 'unknown',
            }
            process.stderr.write(`[AcpBridge] EMITTING TOOL_COMPLETE EVENT for ${toolCallId}\n`)
            emitStdout(JSON.stringify(toolCompleteEvent) + '\n')

            // Persist a durable tool_result record carrying the captured output
            // so a rendered transcript shows what each tool returned. Chained via
            // lastPersistedUuid so it parents onto the tool_use event.
            const output = currentTurnToolOutput.get(toolCallId)
            const toolResultUuid = randomUUID()
            const toolResultEvent = {
              type: 'tool_result',
              sessionId,
              uuid: toolResultUuid,
              parentUuid: lastPersistedUuid,
              isSidechain: false,
              tool_use_id: toolCallId,
              content: output?.content ?? '',
              is_error: output?.isError ?? false,
              timestamp: new Date().toISOString(),
              cwd,
              userType: 'external',
              version: 'unknown',
            }
            void writeTranscript(toolResultEvent)
            lastPersistedUuid = toolResultUuid
          }
          // Clear tracked tool calls / captured output for next turn
          currentTurnToolCalls.clear()
          currentTurnToolOutput.clear()

          const rawUsage = parsed.result.usage || {}
          const usage = {
            input_tokens: rawUsage.inputTokens || 0,
            output_tokens: rawUsage.outputTokens || 0,
            cache_read_input_tokens: rawUsage.cachedReadTokens || 0,
            cache_creation_input_tokens: rawUsage.cachedWriteTokens || 0,
          }
          const usageHasTokens =
            usage.input_tokens > 0 ||
            usage.output_tokens > 0 ||
            usage.cache_read_input_tokens > 0 ||
            usage.cache_creation_input_tokens > 0
          // Persist the accumulated reasoning as a durable `thinking` record
          // BEFORE the assistant text event, so the transcript reads
          // thinking -> answer. Chained via lastPersistedUuid so the assistant
          // event that follows parents onto it.
          if (currentThoughtText && !currentTurnUsedSendUserMessage) {
            const thinkingUuid = randomUUID()
            const thinkingEvent = {
              type: 'thinking',
              sessionId,
              uuid: thinkingUuid,
              parentUuid: lastPersistedUuid,
              isSidechain: false,
              timestamp: new Date().toISOString(),
              cwd,
              userType: 'external',
              version: 'unknown',
              message: {
                role: 'assistant',
                content: [{ type: 'thinking', thinking: currentThoughtText }],
              },
            }
            void writeTranscript(thinkingEvent)
            lastPersistedUuid = thinkingUuid
          }

          const assistantUuid = randomUUID()

          if (currentAssistantText && !currentTurnUsedSendUserMessage) {
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
          } else if (usageHasTokens) {
            // The turn reported token usage but produced no assistant text event
            // to attach it to (e.g. a turn that ended via SendUserMessage, whose
            // assistant event was already emitted without usage). Persist a
            // usage-only assistant event so these tokens are not dropped from
            // budget stats. It carries no visible text, so it does not affect
            // the rendered transcript.
            const usageEvent = {
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
                content: [],
                usage,
                model,
              },
            }
            void writeTranscript(usageEvent)
            lastPersistedUuid = assistantUuid
          }

          const resultEvent = JSON.stringify({
            type: 'result',
            session_id: sessionId,
            status: 'success',
            usage,
          })
          void cleanupIntermediateFiles(cwd)
            .catch(err => {
              process.stderr.write(`[AcpBridge] Draft cleanup failed: ${String(err)}\n`)
            })
            .finally(() => {
              process.stderr.write(`[AcpBridge] EMITTING RESULT EVENT: ${resultEvent}\n`)
              emitStdout(resultEvent + '\n')
            })

          currentAssistantText = ''
          currentThoughtText = ''
          currentTurnUsedSendUserMessage = false
          // A2: stopReason is the authoritative "turn done" signal from scode.
          // Re-evaluate busy here; setBusy(false) only if no question / stdin
          // is pending.
          reevaluateBusy()
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

            if (text && !currentTurnUsedSendUserMessage) {
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

          // scode streams its reasoning as AgentThoughtChunk over ACP. Accumulate
          // it for the current turn and stream a live `thinking` block so the UI
          // can render the model's reasoning; the durable transcript record is
          // written on stopReason (before the assistant text event).
          if (sessionUpdate === 'agent_thought_chunk' && update) {
            const content = update.content || update.message?.content
            let text = ''
            if (typeof content === 'string') {
              text = content
            } else if (content && typeof content === 'object') {
              text = content.text || (Array.isArray(content) ? content[0]?.text : content?.text) || ''
            }

            if (text && !currentTurnUsedSendUserMessage) {
              currentThoughtText += text

              if (!currentTurnAssistantUuid) {
                currentTurnAssistantUuid = randomUUID()
              }

              const mossEvent = JSON.stringify({
                type: 'assistant',
                session_id: sessionId,
                message: {
                  role: 'assistant',
                  content: [{ type: 'thinking', thinking: text }], // current delta only
                },
                uuid: currentTurnAssistantUuid,
                timestamp: new Date().toISOString(),
                delta: true,
              })
              emitStdout(mossEvent + '\n')
            }
          }

          if (sessionUpdate === 'tool_call' && update) {
            const toolUuid = randomUUID()
            const toolCallId = update.toolCallId
            const toolName = update.title || update.rawInput?.path || 'tool'
            const sendUserMessageText = toolName === 'SendUserMessage'
              ? getSendUserMessageText(update.rawInput)
              : null

            if (sendUserMessageText) {
              currentTurnUsedSendUserMessage = true
              currentAssistantText = ''
              const assistantUuid = randomUUID()
              const assistantEvent = {
                type: 'assistant',
                session_id: sessionId,
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
                  content: [{ type: 'text', text: sendUserMessageText }],
                  model,
                },
              }
              process.stderr.write(`[AcpBridge] EMITTING SendUserMessage AS ASSISTANT EVENT: ${JSON.stringify(assistantEvent)}\n`)
              emitStdout(JSON.stringify(assistantEvent) + '\n')
              void writeTranscript(assistantEvent)
              lastPersistedUuid = assistantUuid
              continue
            }

            if (toolCallId) {
              toolResultIdByToolCallId.set(toolCallId, toolUuid)
              // Track this tool call for completion status
              currentTurnToolCalls.set(toolCallId, {
                toolCallId,
                name: toolName,
              })
            }
            const toolEvent = {
              type: 'tool_use',
              sessionId,
              uuid: toolUuid,
              parentUuid: lastPersistedUuid,
              isSidechain: false,
              name: toolName,
              tool_use_id: toolCallId,
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

            // If this is an AskUserQuestion via session/update, store the uuid
            // so we can link it to the _scode/ask_user_question RPC request that follows
            // The frontend uses this uuid as parent_tool_use_id when responding
            if (toolName === 'AskUserQuestion') {
              process.stderr.write(`[AcpBridge] AskUserQuestion via session/update, uuid=${toolUuid}, toolCallId=${toolCallId}\n`)
              // Store the uuid temporarily - when _scode/ask_user_question arrives,
              // we'll create a mapping: uuid -> requestId
              askUserQuestionUuidToRequestId.set(toolUuid, '')
            }
          }

          // scode reports a tool's output via ToolCallUpdate. Capture the latest
          // content/status per toolCallId so the durable `tool_result` record
          // written on stopReason carries the actual output (and error flag).
          if (sessionUpdate === 'tool_call_update' && update) {
            const toolCallId = update.toolCallId
            if (toolCallId) {
              const status = typeof update.status === 'string' ? update.status : undefined
              const isError = status === 'failed' || status === 'error'
              const captured = extractToolResultContent(update.content)
              // Only overwrite once we actually have content (or a terminal
              // status), so an early in_progress update does not clobber output.
              if (captured !== undefined || isError) {
                currentTurnToolOutput.set(toolCallId, {
                  content: captured ?? '',
                  isError,
                })
              }
            }
          }
        }

        // Handle _scode/ask_user_question RPC request from scode
        // This is sent when scode needs user input for AskUserQuestion tool
        if (parsed.method === '_scode/ask_user_question' && parsed.params && parsed.id) {
          const requestId = parsed.id
          const params = parsed.params
          const toolCallId = params.tool_call_id || params.toolCallId

          process.stderr.write(`[AcpBridge] Received _scode/ask_user_question request: requestId=${requestId}, toolCallId=${toolCallId}\n`)

          // Emit tool_use event to frontend for UI display
          // Use toolCallId directly as uuid so frontend can match it correctly
          if (toolCallId) {
            toolResultIdByToolCallId.set(toolCallId, toolCallId)
          }

          // Build question data from params
          const questionData = {
            title: params.title || params.description || 'Question',
            description: params.description,
            questions: params.questions || [],
          }

          // Check if there's a pending AskUserQuestion uuid from session/update
          // If so, link the requestId to that uuid
          // The frontend uses the uuid from session/update as parent_tool_use_id when responding
          let linkedUuid: string | null = null
          for (const [uuid, existingRequestId] of askUserQuestionUuidToRequestId) {
            if (existingRequestId === '') {
              // This uuid from session/update needs to be linked to this requestId
              linkedUuid = uuid
              askUserQuestionUuidToRequestId.set(uuid, requestId)
              process.stderr.write(`[AcpBridge] Linking session/update uuid=${uuid} to _scode/ask_user_question requestId=${requestId}\n`)
              break
            }
          }

          // Store pending question for later response
          // Key by requestId since that's what we need to respond with
          pendingAskUserQuestions.set(requestId, {
            requestId,
            toolCallId: toolCallId || requestId,
            questionData,
            resolve: () => {}, // Will be set when user responds
            reject: () => {},
          })
          // A2: AskUserQuestion in flight => busy until user replies.
          setBusy(true)

          // If we found a linked uuid, also store under that key for easier lookup
          if (linkedUuid) {
            pendingAskUserQuestions.set(linkedUuid, {
              requestId,
              toolCallId: toolCallId || requestId,
              questionData,
              resolve: () => {},
              reject: () => {},
            })
          }

          // Only emit tool_use event if we didn't find a linked uuid from session/update
          // If session/update already emitted one, we don't want to duplicate
          if (!linkedUuid) {
            const toolEvent = {
              type: 'tool_use',
              sessionId,
              uuid: toolCallId || requestId, // Use toolCallId as uuid for consistent matching
              parentUuid: lastPersistedUuid,
              isSidechain: false,
              name: 'AskUserQuestion',
              tool_use_id: toolCallId,
              input: JSON.stringify(questionData),
              timestamp: new Date().toISOString(),
              cwd,
              userType: 'external',
              version: 'unknown',
              // Add requestId so frontend can send response back
              _request_id: requestId,
            }
            process.stderr.write(`[AcpBridge] EMITTING AskUserQuestion EVENT (no prior session/update): ${JSON.stringify(toolEvent)}\n`)
            emitStdout(JSON.stringify(toolEvent) + '\n')
            void writeTranscript(toolEvent)
            lastPersistedUuid = toolCallId || requestId
          } else {
            process.stderr.write(`[AcpBridge] Skipping duplicate AskUserQuestion event - session/update already emitted one with uuid=${linkedUuid}\n`)
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
    setBusy(false)
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

      // Interrupt: cancel the current turn via ACP session/cancel (scode replies
      // to the pending prompt with stopReason:'cancelled', which flows through
      // the normal turn-end path). Record a durable cancelled marker so a
      // resumed transcript shows the turn was interrupted. Handled before
      // setBusy(true) so an idle interrupt does not falsely mark the session
      // busy.
      try {
        const parsed = JSON.parse(data)
        if (parsed?.type === 'control_request' && parsed.request?.subtype === 'interrupt') {
          process.stderr.write(`[AcpBridge] Received interrupt control_request\n`)
          if (acpSessionId && child.stdin && !child.stdin.writableEnded) {
            const cancelMsg = JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/cancel',
              params: { sessionId: acpSessionId },
            }) + '\n'
            child.stdin.write(cancelMsg)
          }
          // Durable marker (result_type:'user'): a `result` row is ignored by the
          // /context reader (no blank bubble) yet stays in the JSONL for resume.
          void writeTranscript({
            type: 'result',
            result_type: 'user',
            subtype: 'cancelled',
            sessionId,
            session_id: sessionId,
            uuid: randomUUID(),
            parentUuid: lastPersistedUuid,
            isSidechain: false,
            timestamp: new Date().toISOString(),
          })
          return
        }
      } catch {
        // Not JSON or not an interrupt — fall through to normal handling.
      }

      // A2: user kicked off a turn. Stays busy until stopReason or destroy.
      setBusy(true)

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
    onExit(l) {
      exitListeners.add(l)
      return () => exitListeners.delete(l)
    },
    isBusy: () => busy,
    onBusyChange: (listener: (b: boolean) => void) => {
      busyListeners.add(listener)
      return () => { busyListeners.delete(listener) }
    },
    persistInProgressTurn: async () => {
      // Called by the runner just before a force kill when (detached && busy)
      // exceeds maxDetachedBusyMs. Flush whatever assistant text is buffered
      // so the user sees the partial answer on next reattach.
      if (!transcriptPath) return
      try {
        if (currentAssistantText) {
          const assistantUuid = randomUUID()
          await writeTranscript({
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
              partial: true,
            },
          })
          lastPersistedUuid = assistantUuid
          currentAssistantText = ''
        }
        await writeTranscript({
          type: 'system',
          subtype: 'killed_by_idle_busy_timeout',
          sessionId,
          timestamp: new Date().toISOString(),
        })
      } catch (err) {
        process.stderr.write(`[AcpBridge] persistInProgressTurn error: ${err}\n`)
      }
    },
    destroy(force = false) {
      if (child.killed) return

      if (containerMode === 'user') {
        // User container mode: don't signal the docker exec CLI — that won't
        // propagate to scode inside the container. The real kill is performed
        // by DockerBackend.cleanupSessionArtifactsForUserContainer via the
        // moss-session-reap script. Just close stdin so scode's read loop
        // sees EOF if it polls.
        try { child.stdin?.end() } catch {}
        setBusy(false)
        return
      }

      // Legacy session mode: signal the docker run / host child directly.
      child.kill(force ? 'SIGKILL' : 'SIGTERM')

      // Host mode session mode cleans configDir.
      if (runtime.type === 'host' && runtime.hostMode === 'session' && runtime.configDir) {
        rm(runtime.configDir, { recursive: true, force: true }).catch(() => {
          // ignore cleanup error
        })
      }
      setBusy(false)
    },
  }
}
