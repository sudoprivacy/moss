/**
 * ACP Server Types
 */

export interface AcpServerOptions {
  cwd?: string
  model?: string
  permissionMode?: string
  resumeSessionId?: string
  dangerouslySkipPermissions?: boolean
}

/**
 * Pending request for Agent → Client requests
 */
export interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

/**
 * Client interface for Agent → Client communication
 */
export interface ClientInterface {
  /** Send request to Client and wait for response */
  sendClientRequest<T = unknown>(method: string, params: unknown): Promise<T>
  /** Send notification to Client (no response expected) */
  sendClientNotification(method: string, params: unknown): void
}

/**
 * Permission request options
 */
export interface PermissionOption {
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
  name: string
  optionId: string
}

/**
 * Permission request sent to Client
 */
export interface RequestPermissionParams {
  sessionId: string
  toolCall: {
    toolCallId: string
    rawInput?: Record<string, unknown>
    title: string
    kind: 'read' | 'edit' | 'execute' | 'think' | 'search' | 'fetch' | 'switch_mode' | 'other'
    content?: Array<{
      type: 'content' | 'diff' | 'terminal'
      content?: { type: 'text'; text: string }
      path?: string
      oldText?: string | null
      newText?: string
      terminalId?: string
    }>
    locations?: Array<{ path: string; line?: number }>
  }
  options: PermissionOption[]
}

/**
 * Permission response from Client
 */
export interface RequestPermissionResponse {
  outcome: {
    outcome: 'selected' | 'cancelled'
    optionId?: string
  }
}

/**
 * File read request sent to Client
 */
export interface ReadTextFileParams {
  uri: string
}

/**
 * File read response from Client
 */
export interface ReadTextFileResponse {
  content: string
}

/**
 * File write request sent to Client
 */
export interface WriteTextFileParams {
  uri: string
  content: string
}

/**
 * File write response from Client
 */
export interface WriteTextFileResponse {}

/**
 * Terminal create request sent to Client
 */
export interface CreateTerminalParams {
  sessionId: string
  command: string
  args?: string[]
  cwd?: string
  env?: Array<{ name: string; value: string }>
  outputByteLimit?: number
}

/**
 * Terminal create response from Client
 */
export interface CreateTerminalResponse {
  terminalId: string
}

/**
 * Terminal output request sent to Client
 */
export interface TerminalOutputParams {
  sessionId: string
  terminalId: string
}

/**
 * Terminal output response from Client
 */
export interface TerminalOutputResponse {
  output: string
  exitCode?: number
  signal?: string
}

/**
 * Terminal kill request sent to Client
 */
export interface KillTerminalParams {
  sessionId: string
  terminalId: string
}

/**
 * Terminal release request sent to Client
 */
export interface ReleaseTerminalParams {
  sessionId: string
  terminalId: string
}

/**
 * Wait for terminal exit request sent to Client
 */
export interface WaitForTerminalExitParams {
  sessionId: string
  terminalId: string
}

/**
 * Wait for terminal exit response from Client
 */
export interface WaitForTerminalExitResponse {
  exitCode: number
  signal?: string
}

export interface AcpSessionState {
  sessionId: string
  cwd: string
  modes: AcpModes
  models: AcpModels
  configOptions: AcpConfigOption[]
  cancelled: boolean
}

export interface AcpModes {
  currentModeId: string
  availableModes: Array<{
    id: string
    name: string
    description?: string
  }>
}

export interface AcpModels {
  currentModelId: string
  availableModels: Array<{
    id: string
    name?: string
  }>
}

export interface AcpConfigOption {
  id: string
  name: string
  description?: string
  category: string
  type: 'select' | 'boolean' | 'string'
  currentValue?: string | boolean
  options?: Array<{
    value: string
    name: string
    description?: string
  }>
}

export interface AcpInitializeResponse {
  protocolVersion: number
  agentCapabilities: {
    promptCapabilities: {
      image: boolean
      embeddedContext: boolean
    }
    mcpCapabilities: {
      http: boolean
      sse: boolean
    }
    loadSession: boolean
    sessionCapabilities: {
      fork?: object
      list?: object
      resume?: object
      close?: object
    }
  }
  agentInfo: {
    name: string
    title: string
    version: string
  }
  authMethods: Array<{
    id: string
    name?: string
    type?: string
  }>
}

export interface AcpNewSessionResponse {
  sessionId: string
  modes?: AcpModes
  models?: AcpModels
  configOptions?: AcpConfigOption[]
}

export interface AcpPromptResponse {
  stopReason: 'end_turn' | 'cancelled' | 'error'
  usage?: {
    inputTokens: number
    outputTokens: number
  }
  error?: string
}

export interface AcpSessionUpdateNotification {
  sessionId: string
  update: {
    sessionUpdate: string
    [key: string]: unknown
  }
}