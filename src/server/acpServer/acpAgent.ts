/**
 * Claude Code ACP Agent Implementation
 *
 * Implements the ACP Agent interface for Claude Code CLI.
 */

import { randomUUID } from 'crypto'
import type {
  AcpServerOptions,
  AcpSessionState,
  AcpConfigOption,
  AcpModes,
  AcpModels,
  ClientInterface,
  RequestPermissionParams,
  RequestPermissionResponse,
  ReadTextFileParams,
  ReadTextFileResponse,
  WriteTextFileParams,
  WriteTextFileResponse,
  CreateTerminalParams,
  CreateTerminalResponse,
  TerminalOutputParams,
  TerminalOutputResponse,
  KillTerminalParams,
  ReleaseTerminalParams,
  WaitForTerminalExitParams,
  WaitForTerminalExitResponse,
  PermissionOption,
} from './types.js'
import { sendSessionUpdate } from './messageConverter.js'
import { runAgent } from '../../tools/AgentTool/runAgent.js'
import { assembleToolPool } from '../../tools.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext, ToolPermissionContext } from '../../Tool.js'
import { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } from '../../utils/fileStateCache.js'
import { createUserMessage } from '../../utils/messages.js'
import type { Message } from '../../types/message.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { PermissionDecision } from '../../types/permissions.js'
import { createAbortController } from '../../utils/abortController.js'
import { DEFAULT_AGENT_PROMPT } from '../../constants/prompts.js'
import { getMainLoopModel } from '../../utils/model/model.js'

// Import MACRO for version
const VERSION = '2.1.88'

/**
 * Extended ACP session state with runtime data
 */
interface AcpSessionRuntime extends AcpSessionState {
  abortController: AbortController
  messages: Message[]
  appState: AppState
}

/**
 * Read session context from environment variables
 */
function readSessionContextFromEnv(): {
  userId?: string
  orgId?: string
  role?: string
  scopes?: string[]
  assistantName?: string
} {
  return {
    userId: process.env.MOSS_SESSION_USER_ID,
    orgId: process.env.MOSS_SESSION_ORG_ID,
    role: process.env.MOSS_SESSION_ROLE,
    scopes: process.env.MOSS_SESSION_SCOPES?.split(','),
    assistantName: process.env.MOSS_ASSISTANT_NAME,
  }
}

/**
 * Create minimal AppState for ACP session
 */
function createAcpAppState(
  permissionMode: string,
  cwd: string,
  model: string,
): AppState {
  const baseState = getDefaultAppState()

  // Build ToolPermissionContext based on permission mode
  const toolPermissionContext: ToolPermissionContext = {
    mode: permissionMode as ToolPermissionContext['mode'],
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: permissionMode === 'bypassPermissions',
  }

  return {
    ...baseState,
    toolPermissionContext,
    mainLoopModel: model,
    mainLoopModelForSession: model,
  }
}

/**
 * Claude Code ACP Agent - implements ACP protocol methods
 */
export class ClaudeCodeAcpAgent {
  private options: AcpServerOptions
  private client: ClientInterface
  private sessions: Map<string, AcpSessionRuntime> = new Map()
  private terminals: Map<string, { sessionId: string }> = new Map()

  constructor(options: AcpServerOptions, client: ClientInterface) {
    this.options = options
    this.client = client
  }

  /**
   * Create canUseTool function for ACP session
   * Handles permission requests by sending them to the client via ACP
   */
  private createAcpCanUseTool(sessionId: string): CanUseToolFn {
    return async (
      tool,
      input,
      _toolUseContext,
      _assistantMessage,
      toolUseID,
      forceDecision,
    ): Promise<PermissionDecision> => {
      // If we have a forced decision, use it
      if (forceDecision) {
        return forceDecision
      }

      // Check bypass permissions mode
      const session = this.sessions.get(sessionId)
      if (!session) {
        return {
          behavior: 'deny',
          message: 'Session not found',
          decisionReason: { type: 'other', reason: 'Session not found' },
        }
      }

      if (session.modes.currentModeId === 'bypassPermissions') {
        return {
          behavior: 'allow',
          updatedInput: input as Record<string, unknown>,
        }
      }

      // Request permission from client via ACP
      const result = await this.requestPermission(
        sessionId,
        toolUseID,
        tool.name,
        input as Record<string, unknown>,
      )

      if (result.behavior === 'allow') {
        return {
          behavior: 'allow',
          updatedInput: input as Record<string, unknown>,
        }
      }

      return {
        behavior: 'deny',
        message: 'Permission denied by user',
        decisionReason: { type: 'other', reason: 'Permission denied by user' },
      }
    }
  }

  /**
   * Create ToolUseContext for ACP session
   */
  private createAcpToolUseContext(
    session: AcpSessionRuntime,
  ): ToolUseContext {
    const tools = assembleToolPool(session.appState.toolPermissionContext, [])

    return {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: session.models.currentModelId,
        tools,
        verbose: false,
        thinkingConfig: { type: 'disabled' },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: true,
        agentDefinitions: { activeAgents: [], allAgents: [] },
      },
      abortController: session.abortController,
      readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
      getAppState: () => session.appState,
      setAppState: (f) => {
        session.appState = f(session.appState)
      },
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: () => {},
      updateAttributionState: () => {},
      messages: session.messages,
    }
  }

  /**
   * Initialize - protocol handshake
   */
  async initialize(params: Record<string, unknown>): Promise<{
    protocolVersion: number
    agentCapabilities: Record<string, unknown>
    agentInfo: Record<string, unknown>
    authMethods: Array<Record<string, unknown>>
  }> {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: true,
          sse: true,
        },
        loadSession: true,
        sessionCapabilities: {
          fork: {},
          list: {},
          resume: {},
          close: {},
        },
      },
      agentInfo: {
        name: 'claude-code',
        title: 'Claude Code',
        version: VERSION,
      },
      authMethods: [],
    }
  }

  /**
   * Create new session
   */
  async newSession(params: Record<string, unknown>): Promise<{
    sessionId: string
    modes?: Record<string, unknown>
    models?: Record<string, unknown>
    configOptions?: AcpConfigOption[]
  }> {
    // Use resumeSessionId if provided (from options or params)
    const sessionId = (params.sessionId as string) ||
      this.options.resumeSessionId ||
      randomUUID()
    const cwd = (params.cwd as string) || this.options.cwd || process.cwd()

    // Determine permission mode - use dangerouslySkipPermissions to set bypassPermissions
    const permissionMode = this.options.dangerouslySkipPermissions
      ? 'bypassPermissions'
      : (this.options.permissionMode || 'default')
    const modes = {
      currentModeId: permissionMode,
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan Mode' },
        { id: 'acceptEdits', name: 'Accept Edits' },
        { id: 'bypassPermissions', name: 'Bypass Permissions' },
      ],
    }

    // Build models - use configured model from settings or fallback to default
    const currentModel = this.options.model || getMainLoopModel()
    const models = {
      currentModelId: currentModel,
      availableModels: [
        { id: currentModel, name: currentModel },
      ],
    }

    // Build config options
    const configOptions = this.buildConfigOptions(modes, models)

    // Create runtime state
    const appState = createAcpAppState(permissionMode, cwd, currentModel)
    const abortController = createAbortController()

    // Store session state with runtime data
    this.sessions.set(sessionId, {
      sessionId,
      cwd,
      modes,
      models,
      configOptions,
      cancelled: false,
      abortController,
      messages: [],
      appState,
    })

    return {
      sessionId,
      modes,
      models,
      configOptions,
    }
  }

  /**
   * Handle user prompt
   */
  async prompt(params: Record<string, unknown>): Promise<{
    stopReason: string
    usage?: Record<string, number>
    error?: string
  }> {
    const sessionId = params.sessionId as string
    const session = this.sessions.get(sessionId)

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    session.cancelled = false

    // Convert ACP prompt to internal message format
    const promptContent = params.prompt as Record<string, unknown>
    const contentBlocks = (promptContent?.content as Array<Record<string, unknown>>) || []

    // Extract text content
    const textContent = contentBlocks
      .filter(block => block.type === 'text')
      .map(block => (block.text as string) || '')
      .join('\n')

    if (!textContent) {
      throw new Error('Invalid params: prompt must include at least one text content block')
    }

    // Check for slash commands (like /model, /status)
    if (textContent.startsWith('/')) {
      return this.handleSlashCommand(sessionId, textContent)
    }

    // Create user message from the prompt
    const userMessage = createUserMessage({ content: textContent })
    session.messages.push(userMessage)

    // Create ToolUseContext for this session
    const toolUseContext = this.createAcpToolUseContext(session)

    // Create canUseTool function for permissions
    const canUseTool = this.createAcpCanUseTool(sessionId)

    // Build agent definition with proper system prompt
    // Note: getSystemPrompt can accept { toolUseContext } parameter
    // runAgent will call getAgentSystemPrompt which enhances this prompt
    const agentDefinition = {
      agentType: 'claude-code',
      whenToUse: 'Claude Code ACP Agent',
      getSystemPrompt: () => DEFAULT_AGENT_PROMPT,
      tools: ['*'],
      source: 'projectSettings' as const,
    }

    // Run the agent and stream responses
    let totalInputTokens = 0
    let totalOutputTokens = 0

    try {
      for await (const message of runAgent({
        agentDefinition,
        promptMessages: [userMessage],
        toolUseContext,
        canUseTool,
        isAsync: false,
        querySource: 'acp' as const,
        availableTools: toolUseContext.options.tools,
      })) {
        // Check for cancellation
        if (session.cancelled || session.abortController.signal.aborted) {
          await sendSessionUpdate(sessionId, {
            sessionUpdate: 'message_stopped',
            stopReason: 'cancelled',
          })
          return { stopReason: 'cancelled' }
        }

        // Record messages
        session.messages.push(message)

        // Convert message to ACP notifications
        if (message.type === 'assistant') {
          // Send agent_message_chunk for each content block
          for (const block of message.message.content) {
            if (block.type === 'text') {
              await sendSessionUpdate(sessionId, {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: block.text },
              })
            } else if (block.type === 'tool_use') {
              // Send tool_call notification
              await sendSessionUpdate(sessionId, {
                sessionUpdate: 'tool_call',
                toolCallId: block.id,
                title: this.getToolTitle(block.name, block.input as Record<string, unknown>),
                kind: this.getToolKind(block.name),
                status: 'pending',
                rawInput: block.input,
              })
            }
          }
        } else if (message.type === 'user') {
          // Tool results - send tool_call_update
          const content = message.message.content
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                // Ensure rawOutput is always a string
                const rawOutput = typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.map(c => typeof c === 'string' ? c : JSON.stringify(c)).join('\n')
                    : JSON.stringify(block.content)
                await sendSessionUpdate(sessionId, {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: block.tool_use_id,
                  status: block.is_error ? 'failed' : 'completed',
                  rawOutput,
                })
              }
            }
          }
        }

        // Track usage if available
        if (message.type === 'assistant' && message.usage) {
          totalInputTokens += message.usage.input_tokens || 0
          totalOutputTokens += message.usage.output_tokens || 0
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      await sendSessionUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `Error: ${errorMessage}` },
      })
      await sendSessionUpdate(sessionId, {
        sessionUpdate: 'message_stopped',
        stopReason: 'error',
      })
      return {
        stopReason: 'error',
        error: errorMessage,
      }
    }

    // Send message_stopped notification before returning
    await sendSessionUpdate(sessionId, {
      sessionUpdate: 'message_stopped',
      stopReason: 'end_turn',
    })

    // Return completion response
    return {
      stopReason: 'end_turn',
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      },
    }
  }

  /**
   * Handle slash commands locally
   */
  private async handleSlashCommand(sessionId: string, command: string): Promise<{
    stopReason: string
    usage?: Record<string, number>
  }> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    // Parse command
    const parts = command.trim().split(/\s+/)
    const cmd = parts[0]?.toLowerCase()
    const args = parts.slice(1)

    let responseText = ''

    switch (cmd) {
      case '/model':
        if (args[0]) {
          session.models.currentModelId = args[0]
          responseText = `Model switched to ${args[0]}`
          await sendSessionUpdate(sessionId, {
            sessionUpdate: 'config_option_update',
            configOptions: this.buildConfigOptions(session.modes, session.models),
          })
        } else {
          responseText = `Current model: ${session.models.currentModelId}`
        }
        break

      case '/status':
        responseText = `Session: ${sessionId}\nModel: ${session.models.currentModelId}\nMode: ${session.modes.currentModeId}`
        break

      case '/help':
        responseText = 'Available commands: /model, /status, /help'
        break

      default:
        responseText = `Unknown command: ${cmd}`
    }

    await sendSessionUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: responseText },
    })

    return { stopReason: 'end_turn' }
  }

  /**
   * Cancel current operation
   */
  async cancel(params: Record<string, unknown>): Promise<void> {
    const sessionId = params.sessionId as string
    const session = this.sessions.get(sessionId)

    if (session) {
      session.cancelled = true
      // Abort the current operation
      session.abortController.abort()
      // Create a new abortController for future operations
      session.abortController = createAbortController()
    }
  }

  /**
   * Set session mode
   */
  async setSessionMode(params: Record<string, unknown>): Promise<void> {
    const sessionId = params.sessionId as string
    const modeId = params.modeId as string
    const session = this.sessions.get(sessionId)

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    session.modes.currentModeId = modeId

    await sendSessionUpdate(sessionId, {
      sessionUpdate: 'current_mode_update',
      currentModeId: modeId,
    })
  }

  /**
   * Set session model
   */
  async setSessionModel(params: Record<string, unknown>): Promise<void> {
    const sessionId = params.sessionId as string
    const modelId = params.modelId as string
    const session = this.sessions.get(sessionId)

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    session.models.currentModelId = modelId
  }

  /**
   * Set config option
   */
  async setSessionConfigOption(params: Record<string, unknown>): Promise<{
    configOptions: AcpConfigOption[]
  }> {
    const sessionId = params.sessionId as string
    const configId = params.configId as string
    const value = params.value as string | boolean
    const session = this.sessions.get(sessionId)

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    // Update mode if configId is 'mode'
    if (configId === 'mode' && typeof value === 'string') {
      session.modes.currentModeId = value
    }

    // Update model if configId is 'model'
    if (configId === 'model' && typeof value === 'string') {
      session.models.currentModelId = value
    }

    session.configOptions = this.buildConfigOptions(session.modes, session.models)

    return { configOptions: session.configOptions }
  }

  /**
   * Load existing session
   */
  async loadSession(params: Record<string, unknown>): Promise<{
    sessionId: string
    modes?: Record<string, unknown>
    models?: Record<string, unknown>
    configOptions?: AcpConfigOption[]
  }> {
    const sessionId = params.sessionId as string
    // For now, just create a new session with the provided ID
    return this.newSession({ ...params, sessionId })
  }

  /**
   * List sessions
   */
  async listSessions(params: Record<string, unknown>): Promise<{
    sessions: Array<{ sessionId: string; cwd: string }>
    nextCursor?: string
  }> {
    const cwd = (params.cwd as string) || this.options.cwd || process.cwd()

    // Return sessions for this cwd
    const sessions = Array.from(this.sessions.values())
      .filter(s => s.cwd === cwd)
      .map(s => ({ sessionId: s.sessionId, cwd: s.cwd }))

    return { sessions }
  }

  /**
   * Close session
   */
  async closeSession(params: Record<string, unknown>): Promise<void> {
    const sessionId = params.sessionId as string
    this.sessions.delete(sessionId)
  }

  /**
   * Fork session
   */
  async forkSession(params: Record<string, unknown>): Promise<{
    sessionId: string
    modes?: Record<string, unknown>
    models?: Record<string, unknown>
  }> {
    const parentSessionId = params.sessionId as string
    const parentSession = this.sessions.get(parentSessionId)

    if (!parentSession) {
      throw new Error(`Session not found: ${parentSessionId}`)
    }

    const newSessionId = randomUUID()
    const cwd = (params.cwd as string) || parentSession.cwd

    // Clone session state with runtime data
    const newSession: AcpSessionRuntime = {
      sessionId: newSessionId,
      cwd,
      modes: { ...parentSession.modes },
      models: { ...parentSession.models },
      configOptions: [...parentSession.configOptions],
      cancelled: false,
      abortController: createAbortController(),
      messages: [],
      appState: createAcpAppState(
        parentSession.modes.currentModeId,
        cwd,
        parentSession.models.currentModelId,
      ),
    }

    this.sessions.set(newSessionId, newSession)

    return {
      sessionId: newSessionId,
      modes: newSession.modes as unknown as Record<string, unknown>,
      models: newSession.models as unknown as Record<string, unknown>,
    }
  }

  /**
   * Resume session
   */
  async resumeSession(params: Record<string, unknown>): Promise<{
    sessionId: string
    modes?: Record<string, unknown>
    models?: Record<string, unknown>
  }> {
    const sessionId = params.sessionId as string
    const session = this.sessions.get(sessionId)

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    return {
      sessionId,
      modes: session.modes as unknown as Record<string, unknown>,
      models: session.models as unknown as Record<string, unknown>,
    }
  }

  /**
   * Build config options from modes and models
   */
  private buildConfigOptions(
    modes: AcpModes,
    models: AcpModels,
  ): AcpConfigOption[] {
    // Build dynamic model options - include current model and standard Claude models
    const currentModelId = models.currentModelId || 'claude-sonnet-4-6'
    const standardModels = [
      { value: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { value: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
    ]
    // Add current model to options if not already present
    const modelOptions = standardModels.some(m => m.value === currentModelId)
      ? standardModels
      : [...standardModels, { value: currentModelId, name: currentModelId }]

    return [
      {
        id: 'mode',
        name: 'Permission Mode',
        description: 'Set the permission mode for tool execution',
        category: 'mode',
        type: 'select',
        currentValue: modes.currentModeId || 'default',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'plan', name: 'Plan Mode' },
          { value: 'acceptEdits', name: 'Accept Edits' },
          { value: 'bypassPermissions', name: 'Bypass Permissions' },
        ],
      },
      {
        id: 'model',
        name: 'Model',
        description: 'Set the model for this session',
        category: 'model',
        type: 'select',
        currentValue: currentModelId,
        options: modelOptions,
      },
    ]
  }

  // ===== Agent → Client Request Methods =====

  /**
   * Request permission from Client for tool execution
   */
  async requestPermission(
    sessionId: string,
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>,
    options?: PermissionOption[],
  ): Promise<{ behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown> }> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    // bypassPermissions mode - auto allow
    if (session.modes.currentModeId === 'bypassPermissions') {
      return { behavior: 'allow', updatedInput: input }
    }

    const defaultOptions: PermissionOption[] = options || [
      { kind: 'allow_always', name: 'Always Allow', optionId: 'allow_always' },
      { kind: 'allow_once', name: 'Allow', optionId: 'allow_once' },
      { kind: 'reject_once', name: 'Reject', optionId: 'reject_once' },
    ]

    const params: RequestPermissionParams = {
      sessionId,
      toolCall: {
        toolCallId,
        rawInput: input,
        title: this.getToolTitle(toolName, input),
        kind: this.getToolKind(toolName),
      },
      options: defaultOptions,
    }

    const response: RequestPermissionResponse = await this.client.sendClientRequest<RequestPermissionResponse>(
      'session/request_permission',
      params,
    )

    if (response.outcome?.outcome === 'cancelled') {
      return { behavior: 'deny' }
    }

    const optionId = response.outcome?.optionId || ''
    if (optionId.startsWith('allow')) {
      return { behavior: 'allow', updatedInput: input }
    }

    return { behavior: 'deny' }
  }

  /**
   * Read text file via Client
   */
  async readTextFile(uri: string): Promise<string> {
    const params: ReadTextFileParams = { uri }
    const response: ReadTextFileResponse = await this.client.sendClientRequest<ReadTextFileResponse>(
      'fs/read_text_file',
      params,
    )
    return response.content
  }

  /**
   * Write text file via Client
   */
  async writeTextFile(uri: string, content: string): Promise<void> {
    const params: WriteTextFileParams = { uri, content }
    await this.client.sendClientRequest<WriteTextFileResponse>(
      'fs/write_text_file',
      params,
    )
  }

  /**
   * Create terminal via Client
   */
  async createTerminal(
    sessionId: string,
    command: string,
    args?: string[],
    cwd?: string,
    env?: Array<{ name: string; value: string }>,
    outputByteLimit?: number,
  ): Promise<string> {
    const params: CreateTerminalParams = {
      sessionId,
      command,
      args,
      cwd,
      env,
      outputByteLimit,
    }
    const response: CreateTerminalResponse = await this.client.sendClientRequest<CreateTerminalResponse>(
      'terminal/create',
      params,
    )

    // Track terminal
    this.terminals.set(response.terminalId, { sessionId })

    return response.terminalId
  }

  /**
   * Get terminal output via Client
   */
  async getTerminalOutput(sessionId: string, terminalId: string): Promise<{
    output: string
    exitCode?: number
    signal?: string
  }> {
    const params: TerminalOutputParams = { sessionId, terminalId }
    const response: TerminalOutputResponse = await this.client.sendClientRequest<TerminalOutputResponse>(
      'terminal/output',
      params,
    )
    return {
      output: response.output,
      exitCode: response.exitCode,
      signal: response.signal,
    }
  }

  /**
   * Kill terminal via Client
   */
  async killTerminal(sessionId: string, terminalId: string): Promise<void> {
    const params: KillTerminalParams = { sessionId, terminalId }
    await this.client.sendClientRequest(
      'terminal/kill',
      params,
    )
  }

  /**
   * Release terminal via Client
   */
  async releaseTerminal(sessionId: string, terminalId: string): Promise<void> {
    const params: ReleaseTerminalParams = { sessionId, terminalId }
    await this.client.sendClientRequest(
      'terminal/release',
      params,
    )
    this.terminals.delete(terminalId)
  }

  /**
   * Wait for terminal exit via Client
   */
  async waitForTerminalExit(sessionId: string, terminalId: string): Promise<{
    exitCode: number
    signal?: string
  }> {
    const params: WaitForTerminalExitParams = { sessionId, terminalId }
    const response: WaitForTerminalExitResponse = await this.client.sendClientRequest<WaitForTerminalExitResponse>(
      'terminal/wait_for_exit',
      params,
    )
    return {
      exitCode: response.exitCode,
      signal: response.signal,
    }
  }

  // ===== TextDocument Notification Handlers =====

  /**
   * Handle textDocument/didOpen notification
   */
  async textDocumentDidOpen(params: Record<string, unknown>): Promise<void> {
    const sessionId = params.sessionId as string
    const uri = params.uri as string
    const languageId = params.languageId as string
    const text = params.text as string
    const version = params.version as number

    // Store document state for future reference
    // This could be used for context tracking, etc.
    const session = this.sessions.get(sessionId)
    if (session) {
      // Document opened - can be used for context
      // Implementation depends on specific use case
    }
  }

  /**
   * Handle textDocument/didChange notification
   */
  async textDocumentDidChange(params: Record<string, unknown>): Promise<void> {
    const sessionId = params.sessionId as string
    const uri = params.uri as string
    const version = params.version as number
    const contentChanges = params.contentChanges as Array<{
      range?: { start: { line: number; character: number }; end: { line: number; character: number } }
      text: string
    }>

    // Document changed - can be used for context updates
    const session = this.sessions.get(sessionId)
    if (session) {
      // Document changed - implementation depends on use case
    }
  }

  /**
   * Handle textDocument/didClose notification
   */
  async textDocumentDidClose(params: Record<string, unknown>): Promise<void> {
    const sessionId = params.sessionId as string
    const uri = params.uri as string

    // Document closed - cleanup if needed
  }

  /**
   * Handle textDocument/didSave notification
   */
  async textDocumentDidSave(params: Record<string, unknown>): Promise<void> {
    const sessionId = params.sessionId as string
    const uri = params.uri as string

    // Document saved - can trigger actions
  }

  /**
   * Handle textDocument/didFocus notification
   */
  async textDocumentDidFocus(params: Record<string, unknown>): Promise<void> {
    const sessionId = params.sessionId as string
    const uri = params.uri as string
    const version = params.version as number
    const position = params.position as { line: number; character: number }
    const visibleRange = params.visibleRange as { start: { line: number }; end: { line: number } }

    // Document focused - useful for context awareness
  }

  // ===== Utility Methods =====

  private getToolTitle(name: string, input: Record<string, unknown>): string {
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

  private getToolKind(name: string): 'read' | 'edit' | 'execute' | 'think' | 'search' | 'fetch' | 'switch_mode' | 'other' {
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
}