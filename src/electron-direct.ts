/**
 * Claude Code 直接嵌入 SDK（无子进程）
 *
 * 直接在当前 Node.js 进程中运行 QueryEngine，无 IPC/序列化开销。
 */

// Enable interview phase for plan mode by default
process.env.CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE = 'true'

import { randomUUID } from 'crypto'
import { enableConfigs } from './utils/config.js'
import { getEmptyToolPermissionContext, setGlobalAppEventBridge, type MossAppEvent, type MossAppEventResult } from './Tool.js'
import { getDefaultAppState } from './state/AppStateStore.js'
import { createStore } from './state/store.js'
import { QueryEngine } from './QueryEngine.js'
import { getTools } from './tools.js'
import { getCommands } from './commands.js'
import { createFileStateCacheWithSizeLimit } from './utils/fileStateCache.js'
import { getGlobalConfig } from './utils/config.js'
import { getAccountInformation, getAnthropicApiKeyWithSource, getAuthTokenSource } from './utils/auth.js'
import { getSettings_DEPRECATED } from './utils/settings/settings.js'
import type { SDKMessage } from './entrypoints/agentSdkTypes.js'
import type { CanUseToolFn } from './utils/permissions/permissions.js'
import { dequeue, peek } from './utils/messageQueueManager.js'
import type { ThinkingConfig } from './utils/thinking.js'
import { runWithCwdOverride, runWithCwdOverrideGenerator } from './utils/cwd.js'
import type { Message } from './types/message.js'

import { bootstrapHeadless } from './bootstrap/headless.js'
import { switchSession } from './bootstrap/state.js'
import { runWithCoordinatorMode } from './utils/sessionCoordinatorContext.js'
import { getCoordinatorSystemPrompt } from './coordinator/coordinatorMode.js'
import { restoreCostStateForSession } from './cost-tracker.js'
import { asSessionId, type SessionId } from './types/ids.js'
import { runWithSessionIdContext, runWithSessionIdContextGenerator } from './utils/sessionIdContext.js'
import { updateSessionName } from './utils/concurrentSessions.js'
import { getRunningTasks } from './utils/task/framework.js'
import { isBackgroundTask } from './tasks/types.js'
import { sleep } from './utils/sleep.js'
import { renameRecordingForSession } from './utils/asciicast.js'
import {
  prepareSessionResume,
  type PreparedSessionResume,
} from './utils/sessionResumeCore.js'
import {
  exitRestoredWorktree,
  restoreSessionStateFromLog,
  restoreWorktreeForResume,
} from './utils/sessionRestore.js'
import {
  adoptResumedSessionFile,
  clearSessionMetadata,
  recordContentReplacement,
  resetSessionFilePointer,
  restoreSessionMetadata,
  saveMode,
} from './utils/sessionStorage.js'
import { resolveSessionFilePath } from './utils/sessionStoragePortable.js'
import { initBundledSkills } from './skills/bundled/index.js'
import { initBuiltinPlugins } from './plugins/bundled/index.js'

// Bundled skills 必须在模块初始化阶段注册，不能等到 bootstrapHeadless()，
// 因为 loadAllCommands 是 memoized 的，如果在 initBundledSkills() 执行之前
// 调用 getCommands()，会缓存空的 bundledSkills 数组。
// 参考 main.tsx:2004 的注释：
// "Previously ran inside setup() after ~20ms of await points,
//  so the parallel getCommands() memoized an empty list."
initBundledSkills()
initBuiltinPlugins()

export { startServer } from './server/server.js'
export { SessionManager } from './server/sessionManager.js'
export { DangerousBackend } from './server/backends/dangerousBackend.js'
export {
  startStandaloneDirectConnectServer,
  type StandaloneServerOptions,
} from './server/startStandaloneServer.js'
export {
  createDirectConnectSession,
  attachDirectConnectSession,
  DirectConnectError,
} from './server/createDirectConnectSession.js'
export {
  DirectConnectSessionManager,
  type DirectConnectConfig,
} from './server/directConnectManager.js'
export {
  buildConnectUrl,
  parseConnectUrl,
} from './server/parseConnectUrl.js'
export { runConnectHeadless } from './server/connectHeadless.js'

// 全局初始化，只执行一次
export function getAuthDebugSnapshot() {
  enableConfigs()

  const settings = getSettings_DEPRECATED() || {}
  const globalConfig = getGlobalConfig()
  const apiKeyInfo = getAnthropicApiKeyWithSource({
    skipRetrievingKeyFromApiKeyHelper: true,
  })
  const authTokenInfo = getAuthTokenSource()

  return {
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
    localSettingsAuthOnly: process.env.CLAUDE_CODE_LOCAL_SETTINGS_AUTH_ONLY === 'true',
    hasAnthropicApiKeyEnv: Boolean(process.env.ANTHROPIC_API_KEY),
    hasOauthTokenEnv: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
    hasAnthropicAuthTokenEnv: Boolean(process.env.ANTHROPIC_AUTH_TOKEN),
    hasApiKeyHelper: typeof settings.apiKeyHelper === 'string' && settings.apiKeyHelper.length > 0,
    apiKeySource: apiKeyInfo.source,
    hasApiKeyCandidate: Boolean(apiKeyInfo.key),
    authTokenSource: authTokenInfo.source,
    hasAuthTokenCandidate: authTokenInfo.hasToken,
    hasStoredOauthAccount: Boolean(globalConfig.oauthAccount),
    hasPrimaryApiKey: Boolean(globalConfig.primaryApiKey),
    accountInfo: getAccountInformation(),
  }
}

export type PermissionMode = 'allow-all' | 'default'

export interface ClaudeSessionOptions {
  /** 工作目录 */
  cwd?: string
  /** 模型名，如 'claude-sonnet-4-6' */
  model?: string
  /** 系统提示词（追加到默认之后） */
  appendSystemPrompt?: string
  /** 权限模式：'allow-all' 跳过所有确认，'default' 遵循 settings */
  permissionMode?: PermissionMode
  /** 自定义权限回调，permissionMode='default' 时生效 */
  onPermissionRequest?: (tool: string, input: unknown) => Promise<boolean>
  /** 最大轮次 */
  maxTurns?: number
  /** 思考配置 */
  thinkingConfig?: ThinkingConfig
  /** 是否启用 Coordinator 模式（多 worker 并行编排）*/
  coordinatorMode?: boolean
  /** App 事件回调，用于 MossTool 保存/打开 app */
  onAppEvent?: (event: MossAppEvent) => Promise<MossAppEventResult>
  /** 恢复后的 transcript session ID */
  sessionId?: string
  /** resume 后直接喂给 QueryEngine 的消息 */
  initialMessages?: Message[]
  /** transcript 所在项目目录；用于跨项目继续写回 */
  projectDir?: string | null
  /** 共享恢复核心产出的附加状态 */
  resumeState?: PreparedSessionResume
}

type ResolvedClaudeSessionOptions = {
  cwd: string
  model: string
  appendSystemPrompt: string
  permissionMode: PermissionMode
  onPermissionRequest: (tool: string, input: unknown) => Promise<boolean>
  maxTurns: number
  thinkingConfig: ThinkingConfig
  coordinatorMode: boolean
  onAppEvent?: (event: MossAppEvent) => Promise<MossAppEventResult>
  sessionId?: string
  initialMessages?: Message[]
  projectDir?: string | null
  resumeState?: PreparedSessionResume
}

let activeSessionStorageKey: string | null = null

async function resolveResumeSourceJsonlFile(
  sessionId: string | undefined,
  options: {
    sourceJsonlFile?: string
    cwdHint?: string
  } = {},
): Promise<string | undefined> {
  if (options.sourceJsonlFile) {
    return options.sourceJsonlFile
  }
  if (!sessionId) {
    return undefined
  }

  const cwdHint =
    typeof options.cwdHint === 'string' && options.cwdHint.trim().length > 0
      ? options.cwdHint.trim()
      : undefined

  const resolved =
    (cwdHint
      ? await resolveSessionFilePath(sessionId, cwdHint)
      : undefined) ?? (await resolveSessionFilePath(sessionId))

  return resolved?.filePath
}

export class ClaudeSession {
  readonly sessionId: string

  #engine: QueryEngine | null = null
  #store: ReturnType<typeof createStore> | null = null
  #pendingListeners: Array<() => void> = []
  #opts: ResolvedClaudeSessionOptions
  #queue: Array<() => void> = []
  #processing = false
  #disposed = false
  #forkContentReplacementsSeeded = false

  get coordinatorMode(): boolean {
    return this.#opts.coordinatorMode
  }

  constructor(opts: ClaudeSessionOptions = {}) {
    if (opts.onAppEvent) {
      setGlobalAppEventBridge(opts.onAppEvent)
    }
    this.sessionId = opts.sessionId ?? randomUUID()
    this.#opts = {
      cwd: opts.cwd ?? process.cwd(),
      model: opts.model ?? 'claude-sonnet-4-6',
      appendSystemPrompt: opts.appendSystemPrompt ?? '',
      permissionMode: opts.permissionMode ?? 'allow-all',
      onPermissionRequest: opts.onPermissionRequest ?? (() => Promise.resolve(true)),
      maxTurns: opts.maxTurns ?? 100,
      thinkingConfig: opts.thinkingConfig ?? { type: 'adaptive' },
      coordinatorMode: opts.coordinatorMode ?? false,
      onAppEvent: opts.onAppEvent,
      sessionId: opts.sessionId,
      initialMessages: opts.initialMessages,
      projectDir: opts.projectDir,
      resumeState: opts.resumeState,
    }
  }

  async #activateSessionStorage(): Promise<void> {
    const activationKey = `${this.sessionId}:${this.#opts.projectDir ?? ''}`
    if (activeSessionStorageKey === activationKey) {
      return
    }

    const { projectDir, resumeState, coordinatorMode } = this.#opts

    switchSession(asSessionId(this.sessionId), projectDir ?? null)

    if (resumeState && !resumeState.forkSession) {
      await renameRecordingForSession()
    }

    await resetSessionFilePointer()
    clearSessionMetadata()

    if (!resumeState || !resumeState.forkSession) {
      exitRestoredWorktree()
    }

    if (resumeState) {
      restoreCostStateForSession(this.sessionId)
      restoreSessionMetadata(
        resumeState.forkSession
          ? { ...resumeState, worktreeSession: undefined }
          : resumeState,
      )

      if (resumeState.forkSession) {
        if (
          !this.#forkContentReplacementsSeeded &&
          resumeState.contentReplacements?.length
        ) {
          await recordContentReplacement(resumeState.contentReplacements)
          this.#forkContentReplacementsSeeded = true
        }
      } else {
        restoreWorktreeForResume(resumeState.worktreeSession)
        adoptResumedSessionFile()
      }

      void updateSessionName(resumeState.agentName)
    }

    saveMode(coordinatorMode ? 'coordinator' : 'normal')
    activeSessionStorageKey = activationKey
  }

  /** 懒初始化：第一次 send() 时构建 QueryEngine */
  async #getEngine(): Promise<QueryEngine> {
    if (this.#engine) return this.#engine

    const {
      cwd,
      model,
      appendSystemPrompt,
      permissionMode,
      onPermissionRequest,
      maxTurns,
      thinkingConfig,
      onAppEvent,
      initialMessages: resumedMessages,
      resumeState,
    } = this.#opts

    // 统一 Headless 初始化 (包含 Skills, Plugins, CLAUDE.md, MCP)
    const bootstrapResult = await bootstrapHeadless(cwd)
    const { initialMessages: bootstrapMessages, mcp, agents: customAgents } =
      bootstrapResult

    // 权限上下文
    const permissionContext = {
      ...getEmptyToolPermissionContext(),
      mode: permissionMode === 'allow-all' ? ('bypassPermissions' as const) : ('default' as const),
    }

    // 权限回调
    const canUseTool: CanUseToolFn = async (tool, input, _ctx, _msg, _id, forceDecision) => {
      if (forceDecision) return forceDecision
      if (permissionMode === 'allow-all') return { behavior: 'allow' as const }
      const allowed = await onPermissionRequest(tool.name, input)
      return allowed ? { behavior: 'allow' as const } : { behavior: 'deny' as const, message: 'Denied by user' }
    }

    // AppState store（每个 session 独立）
    this.#store = createStore(
      {
        ...getDefaultAppState(),
        mcp: {
          ...getDefaultAppState().mcp,
          clients: mcp.clients,
          commands: mcp.commands,
          tools: mcp.tools,
        },
        toolPermissionContext: permissionContext,
      },
      () => {},
    )
    const store = this.#store

    if (resumeState) {
      restoreSessionStateFromLog(resumeState, f => store.setState(f))
    }

    // Attach all pending listeners to the newly created store
    for (const listener of this.#pendingListeners) {
      store.subscribe(listener)
    }
    this.#pendingListeners = []

    // 工具列表
    const tools = getTools(permissionContext)

    // 斜线命令（加载失败时降级为空列表）
    let commands: Awaited<ReturnType<typeof getCommands>> = []
    try { commands = await getCommands(cwd) } catch {}

    // 文件状态缓存（100MB 上限）
    const fileCache = createFileStateCacheWithSizeLimit(1000, 100 * 1024 * 1024)

    // Coordinator mode: use coordinator system prompt (replaces default)
    const coordinatorSystemPrompt = this.#opts.coordinatorMode
      ? getCoordinatorSystemPrompt()
      : undefined

    this.#engine = new QueryEngine({
      cwd,
      tools,
      commands,
      mcpClients: mcp.clients,
      agents: customAgents,
      canUseTool,
      getAppState: () => store.getState(),
      setAppState: f => store.setState(f),
      readFileCache: fileCache,
      userSpecifiedModel: model,
      customSystemPrompt: coordinatorSystemPrompt,
      appendSystemPrompt: appendSystemPrompt || undefined,
      thinkingConfig,
      maxTurns,
      initialMessages: resumedMessages ?? bootstrapMessages,
      emitAppEvent: onAppEvent,
    })

    return this.#engine
  }

  /**
   * 发送消息，返回 AsyncGenerator，按顺序 yield 每条 SDKMessage。
   * 最后一条是 { type: 'result', ... }。
   *
   * @param text    用户消息文本，或 Anthropic content block 数组
   * @param signal  可选 AbortSignal
   */
  async *send(text: string | Array<{ type: string; [k: string]: unknown }>, signal?: AbortSignal): AsyncGenerator<SDKMessage> {
    if (this.#disposed) throw new Error('Session has been disposed')

    // 串行队列
    await new Promise<void>(resolve => {
      this.#queue.push(resolve)
      if (!this.#processing) this.#flush()
    })

    try {
      const sessionId = asSessionId(this.sessionId)
      const projectDir = this.#opts.projectDir
      const runInSessionContext = <T>(fn: () => T): T =>
        runWithSessionIdContext(sessionId, projectDir, () =>
          runWithCoordinatorMode(this.#opts.coordinatorMode, fn),
        )

      await runWithCwdOverride(this.#opts.cwd, () =>
        runInSessionContext(() => this.#activateSessionStorage()),
      )

      const engine = await runWithCwdOverride(this.#opts.cwd, () =>
        runInSessionContext(() => this.#getEngine()),
      )

      const prompt = typeof text === 'string' ? text : text as any
      const abortController = signal
        ? (() => { const ac = new AbortController(); signal.addEventListener('abort', () => ac.abort()); return ac })()
        : undefined
      const waitSignal = abortController?.signal ?? signal
      let finalResult: SDKMessage | undefined

      const isCurrentSessionMainThreadCommand = (
        cmd: {
          agentId?: unknown
          mode: string
          sessionId?: SessionId
        },
      ) =>
        cmd.agentId === undefined &&
        (cmd.mode === 'task-notification' || cmd.mode === 'orphaned-permission') &&
        (cmd.sessionId === undefined || cmd.sessionId === sessionId)

      const dequeueMainThreadTaskNotification = () =>
        this.#opts.coordinatorMode
          ? dequeue(isCurrentSessionMainThreadCommand)
          : undefined

      const hasQueuedMainThreadTaskNotification = () =>
        this.#opts.coordinatorMode &&
        peek(isCurrentSessionMainThreadCommand) !== undefined

      const hasRunningBackgroundTasks = () => {
        if (!this.#opts.coordinatorMode) return false
        const state = this.#store?.getState()
        if (!state) return false
        return getRunningTasks(state).some(
          task => isBackgroundTask(task) && task.type !== 'in_process_teammate',
        )
      }

      // QueryEngine.submitMessage 是 AsyncGenerator
      yield* runWithCwdOverrideGenerator(this.#opts.cwd, () =>
        runWithSessionIdContextGenerator(sessionId, projectDir, () =>
          (async function* () {
            const runTurn = async function* (
              turnPrompt: string | Array<{ type: string; [k: string]: unknown }>,
              mode: 'prompt' | 'task-notification' | 'orphaned-permission',
              uuid?: string,
            ): AsyncGenerator<SDKMessage> {
              const iterator = engine.submitMessage(turnPrompt, { uuid, mode })

              try {
                while (true) {
                  const result = await iterator.next()
                  if (result.done) {
                    return
                  }
                  if (result.value.type === 'result') {
                    finalResult = result.value
                    continue
                  }
                  yield result.value
                }
              } finally {
                if (typeof iterator.return === 'function') {
                  await iterator.return()
                }
              }
            }

            let nextTurn:
              | {
                  value: string | Array<{ type: string; [k: string]: unknown }>
                  mode: 'prompt' | 'task-notification' | 'orphaned-permission'
                  uuid?: string
                }
              | undefined = {
              value: prompt,
              mode: 'prompt',
            }

            // Mirror CLI coordinator semantics: keep the foreground send alive
            // while background tasks are still running so task notifications
            // can trigger follow-up turns without waiting for new user input.
            do {
              if (waitSignal?.aborted) {
                break
              }

              if (nextTurn) {
                yield* runTurn(nextTurn.value, nextTurn.mode, nextTurn.uuid)
                nextTurn = undefined
              }

              const queuedCmd = dequeueMainThreadTaskNotification()
              if (queuedCmd) {
                nextTurn = {
                  value: queuedCmd.value as
                    | string
                    | Array<{ type: string; [k: string]: unknown }>,
                  mode: queuedCmd.mode as 'task-notification' | 'orphaned-permission',
                  uuid: queuedCmd.uuid,
                }
                continue
              }

              if (!hasRunningBackgroundTasks()) {
                break
              }

              await sleep(100, waitSignal, { unref: true })
            } while (
              nextTurn !== undefined ||
              hasQueuedMainThreadTaskNotification() ||
              hasRunningBackgroundTasks()
            )

            if (finalResult) {
              yield finalResult
            }
          })(),
        ),
      )
    } finally {
      this.#processing = false
      this.#flush()
    }
  }

  #flush() {
    if (this.#queue.length === 0) return
    this.#processing = true
    this.#queue.shift()!()
  }

  /** 销毁 session，释放资源（后续 send() 会抛错） */
  dispose() {
    this.#disposed = true
    this.#engine = null
    this.#pendingListeners = []
    const activationKey = `${this.sessionId}:${this.#opts.projectDir ?? ''}`
    if (activeSessionStorageKey === activationKey) {
      activeSessionStorageKey = null
    }
  }

  /** 订阅 app state 变化（用于通知前端新 teammate task 等） */
  subscribe(listener: () => void): () => void {
    if (this.#store) {
      return this.#store.subscribe(listener)
    }
    // Store not ready yet - queue the listener to be attached when store is created
    this.#pendingListeners.push(listener)
    return () => {
      const idx = this.#pendingListeners.indexOf(listener)
      if (idx !== -1) this.#pendingListeners.splice(idx, 1)
    }
  }

  /** 获取当前 app state */
  getAppState() {
    return this.#store?.getState() ?? null
  }
}

export interface ResumeClaudeSessionResult {
  session: ClaudeSession
  messages: Message[]
  metadata: {
    sessionId: string
    sourceSessionId: string
    customTitle?: string
    projectDir: string | null
    cwd: string | null
    fullPath?: string
    mode?: 'coordinator' | 'normal'
  }
}

export interface ClaudeSessionSnapshot {
  messages: Message[]
  metadata: {
    sessionId: string
    sourceSessionId: string
    customTitle?: string
    projectDir: string | null
    cwd: string | null
    fullPath?: string
    mode?: 'coordinator' | 'normal'
  }
}

export async function loadClaudeSessionSnapshot(
  sessionId: string | undefined,
  options: {
    sourceJsonlFile?: string
    cwdHint?: string
  } = {},
): Promise<ClaudeSessionSnapshot | null> {
  const sourceJsonlFile = await resolveResumeSourceJsonlFile(sessionId, options)
  const prepared = await prepareSessionResume(sessionId, {
    sourceJsonlFile,
  })
  if (!prepared) {
    return null
  }

  return {
    messages: prepared.messages,
    metadata: {
      sessionId: prepared.sessionId,
      sourceSessionId: prepared.sourceSessionId,
      customTitle: prepared.customTitle,
      projectDir: prepared.projectDir,
      cwd: prepared.cwd,
      fullPath: prepared.fullPath,
      mode: prepared.mode,
    },
  }
}

export async function resumeClaudeSession(
  sessionId: string,
  options: Omit<ClaudeSessionOptions, 'sessionId' | 'initialMessages' | 'projectDir'> & {
    forkSession?: boolean
    sourceJsonlFile?: string
  } = {},
): Promise<ResumeClaudeSessionResult | null> {
  const { forkSession, sourceJsonlFile, ...sessionOptions } = options
  const resolvedSourceJsonlFile = await resolveResumeSourceJsonlFile(sessionId, {
    sourceJsonlFile,
    cwdHint: sessionOptions.cwd,
  })
  const prepared = await prepareSessionResume(sessionId, {
    forkSession,
    sourceJsonlFile: resolvedSourceJsonlFile,
  })
  if (!prepared) {
    return null
  }

  const session = new ClaudeSession({
    ...sessionOptions,
    cwd: prepared.cwd ?? sessionOptions.cwd,
    coordinatorMode: prepared.mode
      ? prepared.mode === 'coordinator'
      : (sessionOptions.coordinatorMode ?? false),
    sessionId: prepared.sessionId,
    initialMessages: prepared.messages,
    projectDir: prepared.projectDir,
    resumeState: prepared,
  })

  return {
    session,
    messages: prepared.messages,
    metadata: {
      sessionId: prepared.sessionId,
      sourceSessionId: prepared.sourceSessionId,
      customTitle: prepared.customTitle,
      projectDir: prepared.projectDir,
      cwd: prepared.cwd,
      fullPath: prepared.fullPath,
      mode: prepared.mode,
    },
  }
}
