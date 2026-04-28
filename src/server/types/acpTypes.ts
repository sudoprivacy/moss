/**
 * ACP (Agent Client Protocol) Type Definitions
 *
 * Based on JSON-RPC 2.0 protocol over stdin/stdout
 * Supports various AI agents: Claude Code, Gemini CLI, Qwen, scode, etc.
 */

// ===== ACP JSON-RPC Protocol Types =====

export const JSONRPC_VERSION = '2.0' as const

export interface AcpRequest {
  jsonrpc: typeof JSONRPC_VERSION
  id: number | string
  method: string
  params?: Record<string, unknown> | unknown[]
}

export interface AcpResponse {
  jsonrpc: typeof JSONRPC_VERSION
  id: number | string
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

export interface AcpNotification {
  jsonrpc: typeof JSONRPC_VERSION
  method: string
  params?: Record<string, unknown> | unknown[]
}

// ===== Prompt Content Types =====

export interface AcpTextContentBlock {
  type: 'text'
  text: string
}

export interface AcpImageContentBlock {
  type: 'image'
  data: string // base64-encoded
  mimeType: string // e.g. 'image/png'
}

export type AcpPromptContentBlock = AcpTextContentBlock | AcpImageContentBlock

// ===== Session Update Types =====

/** Base interface for all session updates */
export interface BaseSessionUpdate {
  sessionId: string
}

/** Tool call content item */
export interface ToolCallContentItem {
  type: 'content' | 'diff'
  content?: {
    type: 'text'
    text: string
  }
  path?: string
  oldText?: string | null
  newText?: string
}

/** Tool call location item */
export interface ToolCallLocationItem {
  path: string
}

/** Agent message chunk update */
export interface AgentMessageChunkUpdate extends BaseSessionUpdate {
  update: {
    sessionUpdate: 'agent_message_chunk'
    content: {
      type: 'text' | 'image'
      text?: string
      data?: string
      mimeType?: string
      uri?: string
    }
  }
}

/** Agent thought chunk update */
export interface AgentThoughtChunkUpdate extends BaseSessionUpdate {
  update: {
    sessionUpdate: 'agent_thought_chunk'
    content: {
      type: 'text'
      text: string
    }
  }
}

/** Tool call update */
export interface ToolCallUpdate extends BaseSessionUpdate {
  update: {
    sessionUpdate: 'tool_call'
    toolCallId: string
    status: 'pending' | 'in_progress' | 'completed' | 'failed'
    title: string
    kind: 'read' | 'edit' | 'execute'
    rawInput?: Record<string, unknown>
    content?: ToolCallContentItem[]
    locations?: ToolCallLocationItem[]
  }
}

/** Tool call status update */
export interface ToolCallUpdateStatus extends BaseSessionUpdate {
  update: {
    sessionUpdate: 'tool_call_update'
    toolCallId: string
    status: 'completed' | 'failed'
    rawInput?: Record<string, unknown>
    content?: Array<{
      type: 'content'
      content: {
        type: 'text'
        text: string
      }
    }>
  }
}

/** Plan update */
export interface PlanUpdate extends BaseSessionUpdate {
  update: {
    sessionUpdate: 'plan'
    entries: Array<{
      content: string
      status: 'pending' | 'in_progress' | 'completed'
      priority?: 'low' | 'medium' | 'high'
    }>
  }
}

/** Message stopped notification */
export interface MessageStoppedUpdate extends BaseSessionUpdate {
  update: {
    sessionUpdate: 'message_stopped'
    stopReason?: 'end_turn' | 'tool_use' | 'error'
  }
}

/** Permission request update */
export interface PermissionRequestUpdate extends BaseSessionUpdate {
  update: {
    sessionUpdate: 'permission_request'
    requestId: string
    options: AcpPermissionOption[]
    toolCall: {
      toolCallId: string
      rawInput?: Record<string, unknown>
      status?: string
      title?: string
      kind?: string
      content?: ToolCallContentItem[]
      locations?: ToolCallLocationItem[]
    }
  }
}

/** Config options update */
export interface ConfigOptionsUpdate extends BaseSessionUpdate {
  update: {
    sessionUpdate: 'config_option_update'
    configOptions: AcpSessionConfigOption[]
  }
}

/** Usage update (context window utilization) */
export interface UsageUpdate extends BaseSessionUpdate {
  update: {
    sessionUpdate: 'usage_update'
    used: number
    size: number
    cost?: {
      amount: number
      currency: string
    }
  }
}

/** Error update */
export interface ErrorUpdate extends BaseSessionUpdate {
  update: {
    sessionUpdate: 'error'
    code?: string
    message: string
    retryable?: boolean
  }
}

/** Union type for all session updates */
export type AcpSessionUpdate =
  | AgentMessageChunkUpdate
  | AgentThoughtChunkUpdate
  | ToolCallUpdate
  | ToolCallUpdateStatus
  | PlanUpdate
  | MessageStoppedUpdate
  | PermissionRequestUpdate
  | ConfigOptionsUpdate
  | UsageUpdate
  | ErrorUpdate

// ===== Permission Types =====

export interface AcpPermissionOption {
  optionId: string
  name: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

export interface AcpPermissionRequest {
  sessionId: string
  options: AcpPermissionOption[]
  toolCall: {
    toolCallId: string
    rawInput?: Record<string, unknown>
    status?: string
    title?: string
    kind?: string
    content?: ToolCallContentItem[]
    locations?: ToolCallLocationItem[]
  }
}

export interface AcpPermissionResponse {
  outcome: 'selected'
  optionId: string
}

// ===== Config Option Types =====

export interface AcpConfigSelectOption {
  value: string
  name?: string
  label?: string
}

export interface AcpSessionConfigOption {
  id: string
  name?: string
  label?: string
  description?: string
  category?: string
  type: 'select' | 'boolean' | 'string'
  currentValue?: string
  selectedValue?: string
  options?: AcpConfigSelectOption[]
}

// ===== Model Types =====

export interface AcpAvailableModel {
  id?: string
  modelId?: string
  name?: string
}

export interface AcpSessionModels {
  currentModelId?: string
  availableModels?: AcpAvailableModel[]
}

export interface AcpModelInfo {
  currentModelId: string | null
  currentModelLabel: string | null
  availableModels: Array<{ id: string; label: string }>
  canSwitch: boolean
  source: 'configOption' | 'models'
  configOptionId?: string
}

// ===== Backend Types =====

export type AcpBackendId =
  | 'claude'
  | 'gemini'
  | 'qwen'
  | 'codex'
  | 'nexus'
  | 'goose'
  | 'auggie'
  | 'kimi'
  | 'opencode'
  | 'droid'
  | 'copilot'
  | 'vibe'
  | 'nanobot'
  | 'scode'  // Test backend
  | 'custom'

export interface AcpBackendConfig {
  id: AcpBackendId
  name: string
  cliCommand?: string
  defaultCliPath?: string
  acpArgs?: string[]
  authRequired?: boolean
  enabled?: boolean
  supportsStreaming?: boolean
  env?: Record<string, string>
  apiKeyFields?: Array<{
    key: string
    label: string
    type: 'text' | 'password'
    required?: boolean
  }>
}

/** All ACP backend configurations */
export const ACP_BACKENDS_ALL: Record<AcpBackendId, AcpBackendConfig> = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    cliCommand: 'claude',
    defaultCliPath: 'npx @zed-industries/claude-agent-acp',
    acpArgs: ['--experimental-acp'],
    authRequired: true,
    enabled: true,
    supportsStreaming: false,
    apiKeyFields: [{ key: 'ANTHROPIC_API_KEY', label: 'Anthropic API Key', type: 'password', required: true }],
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini CLI',
    cliCommand: 'gemini',
    acpArgs: ['--experimental-acp'],
    authRequired: true,
    enabled: true,
    supportsStreaming: true,
  },
  qwen: {
    id: 'qwen',
    name: 'Qwen Code',
    cliCommand: 'qwen',
    defaultCliPath: 'npx @qwen-code/qwen-code',
    acpArgs: ['--acp'],
    authRequired: true,
    enabled: false,
    supportsStreaming: true,
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    cliCommand: 'codex',
    defaultCliPath: 'npx @zed-industries/codex-acp',
    acpArgs: [],
    authRequired: true,
    enabled: false,
    supportsStreaming: false,
  },
  nexus: {
    id: 'nexus',
    name: 'Nexus AI',
    cliCommand: 'nexus',
    acpArgs: ['chat', '--acp'],
    authRequired: false,
    enabled: true,
    supportsStreaming: true,
  },
  goose: {
    id: 'goose',
    name: 'Goose',
    cliCommand: 'goose',
    acpArgs: ['acp'],
    authRequired: false,
    enabled: false,
    supportsStreaming: false,
  },
  auggie: {
    id: 'auggie',
    name: 'Augment Code',
    cliCommand: 'auggie',
    acpArgs: ['--acp'],
    authRequired: false,
    enabled: false,
    supportsStreaming: false,
  },
  kimi: {
    id: 'kimi',
    name: 'Kimi CLI',
    cliCommand: 'kimi',
    acpArgs: ['acp'],
    authRequired: false,
    enabled: false,
    supportsStreaming: false,
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    cliCommand: 'opencode',
    acpArgs: ['acp'],
    authRequired: false,
    enabled: false,
    supportsStreaming: false,
  },
  droid: {
    id: 'droid',
    name: 'Factory Droid',
    cliCommand: 'droid',
    acpArgs: ['exec', '--output-format', 'acp'],
    authRequired: false,
    enabled: false,
    supportsStreaming: false,
  },
  copilot: {
    id: 'copilot',
    name: 'GitHub Copilot',
    cliCommand: 'copilot',
    acpArgs: ['--acp', '--stdio'],
    authRequired: false,
    enabled: false,
    supportsStreaming: false,
  },
  vibe: {
    id: 'vibe',
    name: 'Mistral Vibe',
    cliCommand: 'vibe-acp',
    acpArgs: [],
    authRequired: false,
    enabled: false,
    supportsStreaming: false,
  },
  nanobot: {
    id: 'nanobot',
    name: 'Nano Bot',
    cliCommand: 'nanobot',
    acpArgs: [],
    authRequired: false,
    enabled: false,
    supportsStreaming: false,
  },
  scode: {
    id: 'scode',
    name: 'SCode',
    cliCommand: 'scode',
    acpArgs: ['--acp'],
    authRequired: false,
    enabled: true,  // Enabled for testing
    supportsStreaming: true,
  },
  custom: {
    id: 'custom',
    name: 'Custom Agent',
    cliCommand: undefined,
    acpArgs: [],
    authRequired: false,
    enabled: false,
    supportsStreaming: false,
  },
}

/** Enabled backends only */
export const ACP_ENABLED_BACKENDS: Record<string, AcpBackendConfig> = Object.fromEntries(
  Object.entries(ACP_BACKENDS_ALL).filter(([_, config]) => config.enabled),
)

/** Check if backend ID is valid and enabled */
export function isValidAcpBackend(backend: string): boolean {
  return backend in ACP_ENABLED_BACKENDS
}

/** Get backend config by ID */
export function getAcpBackendConfig(backend: AcpBackendId): AcpBackendConfig {
  return ACP_BACKENDS_ALL[backend]
}

/** Get all enabled backend configs */
export function getEnabledAcpBackends(): AcpBackendConfig[] {
  return Object.values(ACP_ENABLED_BACKENDS)
}

// ===== Error Types =====

export enum AcpErrorType {
  CONNECTION_NOT_READY = 'CONNECTION_NOT_READY',
  AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  MODEL_NOT_FOUND = 'MODEL_NOT_FOUND',
  MODE_NOT_SUPPORTED = 'MODE_NOT_SUPPORTED',
  BACKEND_NOT_AVAILABLE = 'BACKEND_NOT_AVAILABLE',
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT = 'TIMEOUT',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

export interface AcpError {
  type: AcpErrorType
  code: string
  message: string
  retryable: boolean
  details?: unknown
}

export function createAcpError(
  type: AcpErrorType,
  message: string,
  retryable: boolean = false,
  details?: unknown,
): AcpError {
  return {
    type,
    code: type.toString(),
    message,
    retryable,
    details,
  }
}

// ===== ACP Methods =====

export const ACP_METHODS = {
  // Session lifecycle
  INITIALIZE: 'initialize',
  SESSION_NEW: 'session/new',
  SESSION_PROMPT: 'session/prompt',
  SESSION_CANCEL: 'session/cancel',
  SESSION_REQUEST_PERMISSION: 'session/request_permission',

  // Configuration
  CONFIGOPTION_SET: 'configOption/set',

  // Updates (notifications)
  SESSION_UPDATE: 'session/update',
} as const