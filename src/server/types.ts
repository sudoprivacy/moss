import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'
import type { SessionRuntimeInfo, SessionRuntimeOptions, SessionRuntimeType } from './sessionManager.js'

export const runtimeInfoSchema = lazySchema(() =>
  z.object({
    type: z.enum(['host', 'docker']),
    dockerImage: z.string().optional(),
    dockerMode: z.enum(['session', 'user']).optional(),
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
      dockerImage: z.string().optional(),
      dockerMode: z.enum(['session', 'user']).default('session'),
      workspace: z.string().optional(),
      idleTimeoutMs: z.number().int().min(0).default(10 * 60 * 1000),
      maxSessions: z.number().int().min(0).default(32),
    }).default({
      type: 'host',
      dockerMode: 'session',
      idleTimeoutMs: 10 * 60 * 1000,
      maxSessions: 32,
    }),
    docker: z.object({
      network: z.string().optional(),
      stopTimeoutSec: z.number().int().min(1).default(10),
      labels: z.record(z.string(), z.string()).default({}),
    }).default({
      stopTimeoutSec: 10,
      labels: {},
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
  }),
)

export type ServerFileConfig = z.infer<ReturnType<typeof serverFileConfigSchema>>

export type ServerConfig = {
  host: string
  port: number
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
  startupPolicy: 'reattach-or-resume'
  heartbeatTimeoutMs: number
  reattachProbeTimeoutMs: number
  resumeOnMissingRuntime: boolean
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  auditFile?: string
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
  createdAt: number
  lastActiveAt: number
  endedAt: number | null
}

export type SessionCreateInput = {
  cwd: string
  dangerouslySkipPermissions: boolean
  userId: string
  orgId: string
  role: string
  scopes: string[]
  runtime?: SessionRuntimeOptions
  assistantName?: string
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
