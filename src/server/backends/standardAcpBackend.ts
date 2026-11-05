import { randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DirectConnectStore } from '../db.js'
import type { BackendHandle, BackendSpawnOptions, SessionBackend } from '../sessionManager.js'
import type { StandardAcpProfileBinding } from '../runtime/standardAcpSessionRepository.js'
import { StandardAcpDriver } from './standardAcpDriver.js'
import type { AcpMessageTransport } from './acpTransport.js'

type ObjectValue = Record<string, unknown>
export interface StandardAcpLaunchPlan {
  binding: StandardAcpProfileBinding
  /** Must recheck native account/pool/workspace authorization; no credentials in the plan. */
  authorize(): Promise<void>
  /** Starts only the already-approved deployment; a task cannot choose commands/env. */
  start(signal?: AbortSignal): Promise<{
    transport: AcpMessageTransport
    managedProcessId?: string
    checkReady?(): Promise<boolean>
    /** Actual process/Pod writer termination, not merely sending SIGTERM. */
    confirmStopped(): Promise<void>
  }>
  mcpServers?: unknown[]
  permission?(request: ObjectValue): Promise<string | null>
}
export interface StandardAcpLauncher {
  /** Read-only deployment resolution, before reserving an execution writer. */
  prepare(options: BackendSpawnOptions): Promise<StandardAcpLaunchPlan>
}
const object = (value: unknown): value is ObjectValue => Boolean(value && typeof value === 'object' && !Array.isArray(value))

/** Native BackendHandle adapter. Task/Attempt, transcript and events retain Moss ownership.
 * Opt-in trusted host composition only: no executable or credential is accepted from input.
 */
export class StandardAcpBackend implements SessionBackend {
  constructor(private readonly store: DirectConnectStore, private readonly launcher: StandardAcpLauncher) {}

  async spawn(options: BackendSpawnOptions): Promise<BackendHandle> {
    const { sessionId, userId, orgId, attemptFence } = options
    if (options.runtime?.engine !== 'standard_acp' || !options.runtime.standardAcpProfileId || !userId || !orgId || !attemptFence) {
      throw new Error('Standard ACP requires an approved native profile and canonical owner/Attempt fence')
    }
    // These are scode-specific capabilities, not strings to silently inject into CC.
    if (options.resolveHostContext || options.agentInstructions?.trim() || options.sharedMemory?.trim() ||
      options.enabledSkillNames?.length || options.availableWikis?.length || options.availableCorpApps?.length ||
      options.dangerouslySkipPermissions || options.mcpSettings) throw new Error('This standard ACP profile cannot satisfy the requested scode-specific capabilities')
    options.signal?.throwIfAborted()
    const session = await this.store.getSession(sessionId)
    if (!session || session.userId !== userId || session.orgId !== orgId || session.currentAttemptId !== attemptFence.attemptId ||
      session.runtime.engine !== 'standard_acp' || session.runtime.standardAcpProfileId !== options.runtime.standardAcpProfileId) {
      throw new Error('Standard ACP session is not owned by this execution')
    }
    const plan = await this.launcher.prepare(options)
    if (plan.binding.ownerId !== userId || plan.binding.orgId !== orgId || plan.binding.profileId !== options.runtime.standardAcpProfileId) {
      throw new Error('Standard ACP deployment binding does not match the admitted session')
    }
    await plan.authorize(); options.signal?.throwIfAborted()
    const repo = this.store.standardAcpSessions
    const claim = await repo.claim(sessionId, attemptFence.attemptId, plan.binding, attemptFence.ownerInstanceId)
    let execution: Awaited<ReturnType<StandardAcpLaunchPlan['start']>> | undefined
    let driver: StandardAcpDriver | undefined
    let nativeId: string | undefined = claim.nativeSessionId
    let active = false, busy = false
    let turn: Promise<void> | undefined
    let shutdown: Promise<void> | undefined
    let terminal: Error | null | undefined
    let assistant = '', thought = '', assistantId = randomUUID()
    const stdout = new Set<(line: string) => void>(), stderr = new Set<(line: string) => void>()
    const exits = new Set<Parameters<BackendHandle['onExit']>[0]>()
    const busyListeners = new Set<(value: boolean) => void>()
    const buffered: string[] = []
    let bufferBytes = 0
    let writes = Promise.resolve()
    const event = (payload: ObjectValue) => ({ session_id: session.transcriptSessionId, sessionId, cwd: options.cwd,
      timestamp: new Date().toISOString(), ...payload })
    const persist = (payload: ObjectValue): Promise<void> => {
      if (!options.transcriptPath) return Promise.resolve()
      const value = JSON.stringify(event(payload)) + '\n'
      writes = writes.then(async () => { await mkdir(dirname(options.transcriptPath!), { recursive: true }); await appendFile(options.transcriptPath!, value, 'utf8') })
      return writes
    }
    const emit = (payload: ObjectValue): void => {
      const line = JSON.stringify(event(payload)) + '\n'
      if (!stdout.size) {
        bufferBytes += Buffer.byteLength(line)
        if (bufferBytes > 1024 * 1024) throw new Error('ACP runner output buffer exceeded before attachment')
        buffered.push(line)
      } else for (const sink of stdout) sink(line)
    }
    const setBusy = (value: boolean): void => {
      if (busy === value) return
      busy = value
      for (const sink of busyListeners) sink(value)
    }
    const savePartial = async (partial: boolean): Promise<void> => {
      if (thought) await persist({ type: 'thinking', uuid: randomUUID(), partial, message: { role: 'assistant', content: [{ type: 'thinking', thinking: thought }] } })
      if (assistant) await persist({ type: 'assistant', uuid: assistantId, partial, message: { role: 'assistant', content: [{ type: 'text', text: assistant }], model: 'unknown' } })
      assistant = ''; thought = ''
    }
    const stop = (failure?: Error): Promise<void> => {
      if (shutdown) return shutdown
      active = false
      shutdown = (async () => {
        let error = failure
        try {
          if (driver) await driver.close()
          else await execution?.transport.close(true)
        } catch (cause) { error ??= cause instanceof Error ? cause : new Error(String(cause)) }
        try { await turn } catch (cause) { error ??= cause instanceof Error ? cause : new Error(String(cause)) }
        try {
          if (execution) { await execution.confirmStopped(); await repo.release(claim) }
        } catch (cause) { error ??= cause instanceof Error ? cause : new Error(String(cause)) }
        try { await writes } catch (cause) { error ??= cause instanceof Error ? cause : new Error(String(cause)) }
        terminal = error ?? null
        setBusy(false)
        for (const sink of exits) sink(error ? 1 : 0, null, error)
        if (error) throw error
      })()
      return shutdown
    }
    const run = async (inputId: string, text: string): Promise<void> => {
      try {
        await plan.authorize(); options.signal?.throwIfAborted()
        await repo.recordInput(claim, inputId, text, attemptFence.ownerInstanceId)
        await persist({ type: 'user', uuid: inputId, message: { role: 'user', content: [{ type: 'text', text }] } })
        assistant = ''; thought = ''; assistantId = randomUUID()
        const result = await driver!.prompt(nativeId!, text)
        await savePartial(result.stopReason === 'cancelled')
        await this.store.addEvent(sessionId, attemptFence.attemptId, 'standard_acp_turn_result', { inputId, nativeSessionId: nativeId, result })
        const status = result.stopReason === 'cancelled' ? 'cancelled' : result.stopReason === 'end_turn' ? 'success' : 'error'
        emit({ type: 'result', status, stopReason: result.stopReason, is_error: status === 'error', usage: result.usage })
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause))
        await savePartial(true)
        await this.store.addEvent(sessionId, attemptFence.attemptId, 'standard_acp_turn_unconfirmed', { inputId, message: error.message })
        emit({ type: 'result', status: 'error', is_error: true, errors: [error.message], outcome: 'unconfirmed' })
        if (!driver?.status(nativeId!).connected) void stop(error).catch(() => {})
      } finally { setBusy(false) }
    }
    try {
      execution = await plan.start(options.signal)
      options.signal?.throwIfAborted()
      driver = new StandardAcpDriver(execution.transport, {
        onStderr: line => { for (const sink of stderr) sink(line) },
        onDisconnect: cause => {
          if (active && !shutdown) queueMicrotask(() => { void stop(cause instanceof Error ? cause : new Error('ACP execution disconnected')).catch(() => {}) })
        },
        requestPermission: async request => {
          await plan.authorize(); await repo.assertCurrent(claim, attemptFence.ownerInstanceId)
          const decision = await plan.permission?.(request) ?? null
          await plan.authorize(); await repo.assertCurrent(claim, attemptFence.ownerInstanceId)
          return decision
        },
        onNotification: message => {
          if (!active || message.method !== 'session/update' || !object(message.params) || message.params.sessionId !== nativeId) return
          const update = message.params.update
          if (!object(update)) return
          const content = update.content
          if ((update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') && object(content) && content.type === 'text' && typeof content.text === 'string') {
            const thinking = update.sessionUpdate === 'agent_thought_chunk'
            if (thinking) thought += content.text; else assistant += content.text
            if (Buffer.byteLength(assistant) + Buffer.byteLength(thought) > 8 * 1024 * 1024) throw new Error('ACP projected turn exceeds the configured output budget')
            emit({ type: 'assistant', uuid: assistantId, delta: true, message: { role: 'assistant', content: [thinking
              ? { type: 'thinking', thinking: content.text } : { type: 'text', text: content.text }] } })
          } else {
            const value = { type: 'standard_acp_update', native_session_id: nativeId, update }
            emit(value)
            if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
              void persist(value).catch(error => { void stop(error).catch(() => {}) })
            }
          }
        },
      })
      nativeId = await driver.open({ cwd: plan.binding.workspacePath, mcpServers: plan.mcpServers, resumeSessionId: claim.nativeSessionId })
      if (!await repo.bind(claim, nativeId, attemptFence.ownerInstanceId)) throw new Error('ACP native history binding lost its Attempt fence')
      claim.nativeSessionId = nativeId
      await plan.authorize(); await repo.assertCurrent(claim, attemptFence.ownerInstanceId)
      options.signal?.throwIfAborted()
      active = true
      emit({ type: 'hello', runtimeType: options.runtime.type, engine: 'standard_acp', nativeSessionId: nativeId })
      emit({ type: 'system', subtype: 'init', native_session_id: nativeId, engine: 'standard_acp', model: 'unknown' })
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      try { await stop(error) } catch { /* Preserve the startup failure; writer stays held if cleanup is unconfirmed. */ }
      throw error
    }
    const handle: BackendHandle = {
      workDir: options.cwd, runtime: { ...session.runtime }, managedProcessId: execution.managedProcessId,
      checkReady: async () => {
        if (!active || terminal !== undefined) return false
        try { await repo.assertCurrent(claim, attemptFence.ownerInstanceId); await plan.authorize(); return execution.checkReady ? await execution.checkReady() : driver!.status(nativeId!).connected }
        catch { return false }
      },
      writeStdin: data => {
        if (!active) throw new Error('ACP execution is not accepting input')
        let value: unknown
        try { value = JSON.parse(data) } catch { value = { type: 'user', message: { content: data } } }
        if (object(value) && value.type === 'control_request' && object(value.request) && value.request.subtype === 'interrupt') {
          void driver!.cancel(nativeId!).catch(error => { void stop(error).catch(() => {}) }); return
        }
        if (!object(value) || value.type !== 'user' || !object(value.message)) throw new Error('Unsupported standard ACP input/control capability')
        const content = value.message.content
        const text = typeof content === 'string' ? content : Array.isArray(content) && content.length === 1 &&
          object(content[0]) && content[0].type === 'text' && typeof content[0].text === 'string' ? content[0].text : undefined
        if (text === undefined) throw new Error('Standard ACP profile accepts text only')
        if (busy) throw new Error('Prior ACP input is still pending; do not resend it')
        setBusy(true)
        turn = run(typeof value.uuid === 'string' ? value.uuid : randomUUID(), text)
        void turn.catch(error => { void stop(error).catch(() => {}) })
      },
      onStdoutLine: sink => { stdout.add(sink); for (const line of buffered.splice(0)) sink(line); bufferBytes = 0; return () => stdout.delete(sink) },
      onStderrLine: sink => { stderr.add(sink); return () => stderr.delete(sink) },
      onExit: sink => { exits.add(sink); if (terminal !== undefined) queueMicrotask(() => sink(terminal ? 1 : 0, null, terminal ?? undefined)); return () => exits.delete(sink) },
      isBusy: () => busy,
      onBusyChange: sink => { busyListeners.add(sink); return () => busyListeners.delete(sink) },
      persistInProgressTurn: () => savePartial(true),
      destroy: async () => {
        if (busy) {
          try { await driver!.cancel(nativeId!) } catch { /* Closing still requires positive writer cleanup. */ }
          if (turn) {
            let timer: NodeJS.Timeout | undefined
            try { await Promise.race([turn, new Promise<void>(resolve => { timer = setTimeout(resolve, 5000) })]) }
            finally { clearTimeout(timer) }
          }
        }
        await stop()
        await turn
      },
    }
    return handle
  }
}
