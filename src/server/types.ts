import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'
import type { SessionRuntimeInfo, SessionRuntimeOptions, SessionRuntimeType } from './sessionManager.js'

export const runtimeInfoSchema = lazySchema(() =>
  z.object({
    type: z.enum(['host', 'docker']),
    engine: z.enum(['scode']).optional(),
    scodePath: z.string().optional(),
    dockerImage: z.string().optional(),
    dockerMode: z.enum(['session', 'user']).optional(),
    hostMode: z.enum(['session', 'user']).optional(),
    containerName: z.string().optional(),
    configDir: z.string().optional(),
  }),
)

export const connectResponseSchema = lazySchema(() =>
  z.object({
    session_id: z.string(),
    ws_url: z.string(),
    work_dir: z.string().optional(),
    runtime: runtimeInfoSchema().optional(),
  }),
)

export const attachSessionResponseSchema = lazySchema(() =>
  z.object({
    session: z.object({
      sessionId: z.string(),
      transcriptSessionId: z.string(),
      workDir: z.string(),
      userId: z.string(),
      orgId: z.string(),
      role: z.string(),
      scopes: z.array(z.string()),
      runtime: runtimeInfoSchema(),
      status: z.string(),
      desiredState: z.string(),
      createdAt: z.number(),
      lastActiveAt: z.number(),
      endedAt: z.number().nullable().optional(),
    }),
    ws_url: z.string(),
  }),
)

export const serverFileConfigSchema = lazySchema(() =>
  z.object({
    server: z.object({
      host: z.string().default('0.0.0.0'),
      port: z.number().int().min(0).default(43127),
      advertisedHost: z.string().min(1).optional(),
    }).default({
      host: '0.0.0.0',
      port: 43127,
    }),
    auth: z.object({
      mode: z.enum(['local', 'auth-center']).default('local'),
      tokenTtlSec: z.number().int().min(60).default(60 * 60),
      authCenterUrl: z.string().min(1).optional(),
    }).default({
      mode: 'local',
      tokenTtlSec: 60 * 60,
    }),
    bootstrapAdmin: z.object({
      username: z.string().min(1).default('admin'),
      password: z.string().min(1).optional(),
      email: z.string().min(1).optional(),
    }).default({
      username: 'admin',
    }),
    storage: z.object({
      rootDir: z.string().min(1).optional(),
      dbPath: z.string().min(1).optional(),
      transcriptDir: z.string().min(1).optional(),
      runtimeDir: z.string().min(1).optional(),
    }).default({}),
    runtimeDefaults: z.object({
      type: z.enum(['host', 'docker']).default('host'),
      engine: z.enum(['scode']).default('scode'),
      scodePath: z.string().optional(),
      dockerImage: z.string().optional(),
      dockerMode: z.enum(['session', 'user']).default('session'),
      workspace: z.string().optional(),
      idleTimeoutMs: z.number().int().min(0).default(10 * 60 * 1000),
      maxSessions: z.number().int().min(0).default(32),
    }).default({
      type: 'host',
      engine: 'scode',
      dockerMode: 'session',
      idleTimeoutMs: 10 * 60 * 1000,
      maxSessions: 32,
    }),
    docker: z.object({
      network: z.string().optional(),
      stopTimeoutSec: z.number().int().min(1).default(10),
      labels: z.record(z.string(), z.string()).default({}),
      /**
       * Container reuse boundary. 'session' (default) preserves legacy
       * `docker run --rm` per session. 'user' activates per-user long-lived
       * containers with `docker exec` per session.
       */
      containerMode: z.enum(['session', 'user']).default('session'),
      maxSessionsPerUser: z.number().int().min(1).default(5),
      userContainerIdleTimeoutMs: z.number().int().min(60_000).default(20 * 60_000),
      execKillGraceMs: z.number().int().min(0).default(5_000),
      /** Per-user container resource gates (only relevant when containerMode='user'). */
      user: z.object({
        pidsLimit: z.number().int().min(64).default(512),
        memory: z.string().default('4g'),
        cpus: z.string().default('2'),
        nofile: z.number().int().min(256).default(4096),
      }).default({
        pidsLimit: 512,
        memory: '4g',
        cpus: '2',
        nofile: 4096,
      }),
    }).default({
      stopTimeoutSec: 10,
      labels: {},
      containerMode: 'session',
      maxSessionsPerUser: 5,
      userContainerIdleTimeoutMs: 20 * 60_000,
      execKillGraceMs: 5_000,
      user: {
        pidsLimit: 512,
        memory: '4g',
        cpus: '2',
        nofile: 4096,
      },
    }),
    recovery: z.object({
      startupPolicy: z.enum(['reattach-or-resume']).default('reattach-or-resume'),
      heartbeatTimeoutMs: z.number().int().min(1).default(30_000),
      reattachProbeTimeoutMs: z.number().int().min(1).default(3_000),
      resumeOnMissingRuntime: z.boolean().default(true),
    }).default({
      startupPolicy: 'reattach-or-resume',
      heartbeatTimeoutMs: 30_000,
      reattachProbeTimeoutMs: 3_000,
      resumeOnMissingRuntime: true,
    }),
    logging: z.object({
      level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
      auditFile: z.string().optional(),
    }).default({
      level: 'info',
    }),
    hub: z.object({
      apiBaseUrl: z.string().optional(),
      authorization: z.string().optional(),
      cosBaseUrl: z.string().optional(),
    }).default({}),
  }),
)

export type ServerFileConfig = z.infer<ReturnType<typeof serverFileConfigSchema>>

export type ServerConfig = {
  host: string
  port: number
  /**
   * 企业应用管理: optional dedicated port for the PUBLIC corp-app callback
   * listener (WeCom etc.). Runs a separate http.Server that ONLY serves the
   * callback route, isolating external traffic from the admin/API server.
   * Resolved from MOSS_CALLBACK_PORT when unset. Disabled if 0/undefined.
   */
  callbackPort?: number
  advertisedHost?: string
  authMode: 'local'
  tokenTtlSec: number
  bootstrapAdmin: {
    username: string
    password?: string
    email?: string
  }
  workspace?: string
  defaultRuntime: SessionRuntimeType
  engine: 'scode'
  scodePath?: string
  dockerImage?: string
  dockerMode?: 'session' | 'user'
  idleTimeoutMs: number
  maxSessions: number
  rootDir: string
  dbPath: string
  transcriptDir: string
  runtimeDir: string
  dockerNetwork?: string
  dockerStopTimeoutSec: number
  dockerLabels: Record<string, string>
  /**
   * Per-user docker container settings. `containerMode='session'` is the
   * default and preserves legacy `docker run --rm` per-session behavior. Set
   * `containerMode='user'` to activate long-lived per-user containers + per-
   * session `docker exec`. `session.maxDetachedBusyMs` controls the upper
   * bound on detached + busy sessions before persistInProgressTurn + force
   * destroy.
   */
  docker?: {
    containerMode: 'session' | 'user'
    maxSessionsPerUser: number
    userContainerIdleTimeoutMs: number
    execKillGraceMs: number
    user: {
      pidsLimit: number
      memory: string
      cpus: string
      nofile: number
    }
  }
  session?: {
    maxDetachedBusyMs: number
  }
  startupPolicy: 'reattach-or-resume'
  heartbeatTimeoutMs: number
  reattachProbeTimeoutMs: number
  resumeOnMissingRuntime: boolean
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  auditFile?: string
  hubApiBaseUrl?: string
  hubAuthorization?: string
  cosBaseUrl?: string
}

export type SessionStatus =
  | 'creating'
  | 'active'
  | 'detached'
  | 'ended'
  | 'terminated'
  | 'failed'
  | 'lost'

export type DesiredSessionState = 'active' | 'ended' | 'terminated'

export type AttemptRuntimeState =
  | 'starting'
  | 'running'
  | 'detached'
  | 'stopped'
  | 'failed'
  | 'lost'

export type SessionRecord = {
  sessionId: string
  transcriptSessionId: string
  orgId: string
  userId: string
  role: string
  scopes: string[]
  cwd: string
  runtime: SessionRuntimeInfo
  status: SessionStatus
  desiredState: DesiredSessionState
  currentAttemptId: string | null
  transcriptPath: string
  title: string | null
  summary: string | null
  assistantName: string | null
  source?: string
  channelChatId?: string
  createdAt: number
  lastActiveAt: number
  endedAt: number | null
  deletedAt: number | null
}

export type AttemptRecord = {
  attemptId: string
  sessionId: string
  generation: number
  backendType: SessionRuntimeType
  runtimeState: AttemptRuntimeState
  serverInstanceId: string | null
  runnerPid: number | null
  containerName: string | null
  attachPath: string | null
  resumeTranscriptSessionId: string
  startedAt: number
  lastHeartbeatAt: number | null
  stoppedAt: number | null
  exitCode: number | null
  exitSignal: string | null
  stopReason: string | null
  errorText: string | null
}

export type SessionEventRecord = {
  eventId: string
  sessionId: string
  attemptId: string | null
  eventType: string
  payload: Record<string, unknown>
  createdAt: number
}

export type ServerInstanceRecord = {
  instanceId: string
  host: string
  pid: number | null
  startedAt: number
  heartbeatAt: number
  stoppedAt: number | null
  status: 'running' | 'stopped'
}

export type SessionListFilter = {
  orgId: string
  userId?: string
  activeOnly?: boolean
  includeDeleted?: boolean
}

export type SessionSummary = {
  sessionId: string
  transcriptSessionId: string
  workDir: string
  userId: string
  orgId: string
  role: string
  scopes: string[]
  runtime: SessionRuntimeInfo
  status: SessionStatus
  desiredState: DesiredSessionState
  assistantName: string | null
  source?: string
  channelChatId?: string
  createdAt: number
  lastActiveAt: number
  endedAt: number | null
}

export type SessionCreateInput = {
  cwd?: string
  dangerouslySkipPermissions: boolean
  userId: string
  orgId: string
  role: string
  scopes: string[]
  runtime?: SessionRuntimeOptions
  assistantName?: string
  source?: string
  channelChatId?: string
  /** Enabled skill names (optional, for non-assistant sessions) */
  enabledSkills?: string[]
}

export type EnterpriseRecord = {
  id: string
  logo: string | null
  app_name: string | null
  top_name: string | null
  about_name: string | null
  app_company_name: string | null
  login_desp: string | null
  /**
   * Whether the client-side cron (scheduled task) feature is available to
   * enterprise users. Stored as 0/1 in SQLite; null on rows predating the
   * column is treated as enabled (default on). Managed by admin/super_admin
   * only and surfaced to the client via GET /api/v1/tenant/config.
   */
  client_cron_enabled: boolean | null
  created_at: number
  updated_at: number
}

export type RunnerManifest = {
  config: ServerConfig
  session: {
    sessionId: string
    transcriptSessionId: string
    resumeFromTranscript: boolean
    cwd: string
    transcriptPath: string
    userId: string
    orgId: string
    role: string
    scopes: string[]
    dangerouslySkipPermissions: boolean
    runtime: SessionRuntimeInfo
    assistantName?: string
    /**
     * Document Center v2: pre-signed JWT for the in-container `wiki` CLI
     * to call /api/v1/agent/wikis*. Carries `assistant_id` so server-side
     * filtering by enabledWikis works. RuntimeService signs it via
     * `authService.issueWikiSession` before spawning the runner; runner
     * threads it into `SESSION_TOKEN` env via `buildSessionEnv` overrides.
     */
    sessionToken?: string
    /**
     * Document Center v2: wikis this assistant is authorized to query.
     * Resolved by RuntimeService.spawnAttempt from assistant meta +
     * DocumentStore; surfaced to agent via acpBridge first-message
     * `[Available Wikis]` block so scode actually knows to use `wiki` CLI.
     */
    availableWikis?: Array<{ id: string; name: string; description?: string | null }>
    /**
     * Corp app instances this assistant may use via the `corpapp` CLI.
     * acpBridge injects an `[Available Corp Apps]` block so the agent knows
     * the CLI + instance names exist.
     */
    availableCorpApps?: Array<{ id: string; name: string; type: string; key: string }>
    sharedMemory?: string | null
    /** Enabled skill names (from client or assistant config) */
    enabledSkills?: string[]
    /**
     * 可见性过滤上下文，用于过滤用户有权访问的技能
     */
    visibilityFilter?: {
      isAdmin: boolean
      userId: string
      departmentId: string | null
      visibleDepartmentIds: string[] | null // Set 序列化为数组
    } | null
    /**
     * 用户可见 MCP 服务的 scode settings.json 内容（主进程解析后下发）。
     * 形如 { mcpServers: { name: {...} } }，由 backend 写入
     * `${configDir}/.nexus/sudocode/settings.json` 供 scode 启动时加载。
     */
    mcpSettings?: { mcpServers: Record<string, unknown> }
  }
  attempt: {
    attemptId: string
    generation: number
    runtimeDir: string
    attachPath: string
    stdoutLogPath: string
    stderrLogPath: string
    statusPath: string
  }
}
