// Moss auth/admin types
export type UserRole = 'admin' | 'dept_admin' | 'user'

export interface AuthUser {
  id: string
  orgId: string
  email: string | null
  name: string
  departmentId: string | null
  role: UserRole
  status: 'active' | 'disabled'
  tokenLimit: number | null
  createdAt: number
  passwordUpdatedAt: number | null
  lastLoginAt: number | null
}

export interface AuthOrg {
  id: string
  name: string
  createdAt: number
}

export interface AuthDepartment {
  id: string
  orgId: string
  parentId: string | null
  name: string
  tokenLimit: number | null
  createdAt: number
  updatedAt: number
  userCount: number
}

export interface RoleDefinition {
  id: UserRole
  name: string
  description: string
  scopes: string[]
}

export interface LoginRequest {
  grant_type: 'password' | 'api_key'
  username?: string
  email?: string
  password?: string
  api_key?: string
}

export interface LoginResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  user: AuthUser
  organization: AuthOrg | null
  scopes: string[]
}

export interface MeResponse {
  user: AuthUser | null
  organization: AuthOrg | null
  scopes: string[]
  role: string
  key_id: string
}

export interface UsersListResponse {
  users: AuthUser[]
}

export interface CreateUserRequest {
  email?: string
  name: string
  department_id?: string | null
  role: UserRole
  password: string
}

export interface CreateUserResponse {
  user: AuthUser
}

export interface UpdateUserRequest {
  name?: string
  department_id?: string | null
  role?: UserRole
  status?: 'active' | 'disabled'
}

export interface DepartmentsListResponse {
  departments: AuthDepartment[]
}

export interface CreateDepartmentRequest {
  name: string
  parent_id?: string | null
}

export interface UpdateDepartmentRequest {
  name?: string
  parent_id?: string | null
}

export interface DepartmentResponse {
  department: AuthDepartment
}

export interface RolesListResponse {
  roles: RoleDefinition[]
}

export interface ApiKey {
  id: string
  orgId: string
  userId: string
  name: string
  prefix: string
  scopes: string[]
  status: 'active' | 'revoked'
  createdAt: number
  lastUsedAt: number | null
}

export interface ApiKeysListResponse {
  api_keys: ApiKey[]
}

export interface CreateApiKeyRequest {
  user_id: string
  name: string
  scopes: string[]
}

export interface CreateApiKeyResponse {
  api_key: ApiKey
  plain_text_key: string
}

export type ThinkingMode = 'adaptive' | 'enabled' | 'disabled'

export interface SystemSettingsImage {
  provider: string
  url: string
  apiKey: string
  model: string
}

export interface SystemSettingsSkillStore {
  tenantId: string
}

export interface SystemSettings {
  bypassPermissions: boolean
  model: string
  maxTurns: number
  thinkingMode: ThinkingMode
  thinkingBudgetTokens: number
  url: string
  apiKey: string
  image: SystemSettingsImage
  skillStore: SystemSettingsSkillStore
  settingsPath: string
  settingsExists: boolean
  settingsLoaded: boolean
  settingsParseError: string
}

export interface UpdateSystemSettingsRequest {
  bypassPermissions?: boolean
  model?: string
  maxTurns?: number
  thinkingMode?: ThinkingMode
  thinkingBudgetTokens?: number
  url?: string
  apiKey?: string
  image?: Partial<SystemSettingsImage>
  skillStore?: Partial<SystemSettingsSkillStore>
}

// Direct Connect Server Types
export type SessionStatus =
  | 'creating'
  | 'active'
  | 'detached'
  | 'ended'
  | 'terminated'
  | 'failed'
  | 'lost'

export type DesiredState = 'active' | 'ended' | 'terminated'

export interface SessionRuntime {
  type: 'host' | 'docker'
  dockerImage?: string
  dockerMode?: 'session' | 'user'
  containerName?: string
  configDir?: string
}

export interface Session {
  sessionId: string
  transcriptSessionId: string
  workDir?: string
  cwd?: string
  userId: string
  orgId: string
  role: string
  scopes: string[]
  runtime: SessionRuntime
  status: SessionStatus
  desiredState: DesiredState
  assistantName?: string | null
  createdAt: number
  lastActiveAt: number
  endedAt: number | null
}

export interface SessionsListResponse {
  sessions: Session[]
}

export interface GetSessionResponse {
  session: Session
  ws_url?: string
}

export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  totalTokens: number
  costUSD: number
  webSearchRequests: number
  assistantMessageCount: number
  filesRead: number
  truncatedFiles: string[]
  includesSubagents: boolean
  subagentTranscriptCount: number
  modelUsage: Record<string, number>
}

// Content block types from Anthropic SDK
export interface TextContentBlock {
  type: 'text'
  text: string
}

export interface ToolUseContentBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultContentBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | unknown[]
  is_error?: boolean
}

export interface ThinkingContentBlock {
  type: 'thinking' | 'redacted_thinking'
  thinking?: string
}

export type ContentBlock = TextContentBlock | ToolUseContentBlock | ToolResultContentBlock | ThinkingContentBlock | Record<string, unknown>

// Message types matching server-side Message structure
export interface UserMessage {
  type: 'user'
  role: 'user'
  content: string | ContentBlock[]
  timestamp?: string
  uuid?: string
  images?: string[]
  files?: string[]
}

export interface AssistantMessage {
  type: 'assistant'
  role: 'assistant'
  content: string | ContentBlock[]
  timestamp?: string
  uuid?: string
}

export interface ToolUseMessage {
  type: 'tool_use'
  role: 'assistant'
  tool_use_id: string
  tool_name: string
  content?: string
  input?: Record<string, unknown>
  timestamp?: string
  uuid?: string
}

export interface ToolResultMessage {
  type: 'tool_result'
  role: 'user'
  tool_use_id: string
  tool_name?: string
  content: string | unknown
  is_error?: boolean
  timestamp?: string
  uuid?: string
}

export type SessionMessage = UserMessage | AssistantMessage | ToolUseMessage | ToolResultMessage | Record<string, unknown>

export interface SessionContext {
  customTitle?: string
  tag?: string
  summary?: string
  messages: SessionMessage[]
}

export interface GetSessionContextResponse {
  session: Session
  usage: SessionUsage
  context: SessionContext
}

export interface UserSessionsResponse {
  user: AuthUser
  sessions: Session[]
}

export interface DashboardStatsResponse {
  sessions: {
    total: number
    active: number
  }
  agents: {
    total: number
    active: number
  }
  assistants: {
    name: string | null
    displayName: string
    totalSessions: number
    activeSessions: number
  }[]
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    totalTokens: number
  }
}

export interface BudgetUsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  totalTokens: number
  costUSD: number
}

export interface BudgetUserStats extends BudgetUsageTotals {
  userId: string
  sessionCount: number
  lastActiveAt: number
}

export interface BudgetAgentStats extends BudgetUsageTotals {
  assistantName: string
  sessionCount: number
  lastActiveAt: number
}

export interface BudgetTrendBucketAgent extends BudgetUsageTotals {
  assistantName: string
}

export interface BudgetTrendBucketUser extends BudgetUsageTotals {
  userId: string
}

export interface BudgetTrendBucket extends BudgetUsageTotals {
  start: number
  end: number
  users: BudgetTrendBucketUser[]
  agents: BudgetTrendBucketAgent[]
}

export interface BudgetStatsResponse {
  summary: BudgetUsageTotals & {
    sessionCount: number
    userCount: number
    lastActivityAt: number | null
  }
  users: BudgetUserStats[]
  agents: BudgetAgentStats[]
  trends: {
    day: BudgetTrendBucket[]
    week: BudgetTrendBucket[]
    month: BudgetTrendBucket[]
  }
}

// Health Check
export interface HealthResponse {
  ok: boolean
  sessions: number
  auth_mode: string
}

// IM Adapter Types
export interface PairedUser {
  userId: string | number
  displayName: string
  pairedAt: number
}

export interface AdapterPlatformConfig {
  enabled?: boolean
  // Telegram
  botToken?: string
  allowedUsers?: Array<number | string>
  pairedUsers?: PairedUser[]
  defaultWorkDir?: string
  // Feishu
  appId?: string
  appSecret?: string
  encryptKey?: string
  verificationToken?: string
  // Feishu-only
  streamingCard?: boolean
}

export interface AdapterConfigsResponse {
  telegram?: AdapterPlatformConfig
  feishu?: AdapterPlatformConfig
}

export interface AdapterProcessStatus {
  status: 'running' | 'stopped' | 'error'
  pid: number | null
  error: string | null
  startedAt: number | null
  orgId: string
  userId: string
  platform: string
}

export interface AdapterConfigRow {
  id: string
  orgId: string
  userId: string
  platform: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}
