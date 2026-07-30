/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path'
import type net from 'net'
import type { DatabaseSync } from 'node:sqlite'
import { EventTriggerStore, type EventTrigger, type EventTriggerRun } from './EventTriggerStore.js'
import type { RuntimeService } from '../../runtimeService.js'
import { MOSS_HOME } from '../../../utils/skills/localSkillDirectories.js'
import { isVisibleInUserContainer } from '../cron/CronService.js'

/** Per-run wall-clock ceiling. A trigger may lower this via timeout_ms. */
const DEFAULT_RUN_TIMEOUT_MS = Number(process.env.MOSS_EVENT_RUN_TIMEOUT_MS) || 15 * 60 * 1000

/**
 * Drain cadence. This is the number that makes the feature "near real-time":
 * cron's 60s poll is a scheduling floor we explicitly do not inherit. 2s is
 * comfortably below human-perceptible latency for a report while keeping the
 * idle query cost trivial (one indexed COUNT + one UPDATE per tick).
 */
const TICK_INTERVAL_MS = Number(process.env.MOSS_EVENT_TICK_MS) || 2000

/** Global ceiling on concurrent agent sessions started by event triggers. */
const MAX_CONCURRENT_RUNS = Number(process.env.MOSS_EVENT_MAX_CONCURRENT) || 3

/**
 * How long the agent may produce no output at all before we nudge it, and how
 * many *consecutive unproductive* nudges we tolerate before giving up. Any
 * real agent output resets the streak, so a slow-but-alive run is never
 * killed, while a wedged one is abandoned in ~3 windows. Ported from
 * WikiJobExecutor, whose rationale comment explains this in more depth.
 */
const IDLE_NUDGE_MS = Number(process.env.MOSS_EVENT_IDLE_NUDGE_MS) || 3 * 60 * 1000
const MAX_UNPRODUCTIVE_NUDGES = 3

export interface EventTriggerServiceConfig {
  runtimeService: RuntimeService
  runtimeDir: string
  defaultRuntime: 'host' | 'docker'
  dockerContainerMode: 'session' | 'user'
  workspace?: string
  getUserAuth: (userId: string, orgId: string) => Promise<{ role: string; scopes: string[] } | null>
}

/**
 * Resolve the cwd for a trigger run. Mirrors resolveCronWorkspace, including
 * the docker user-container visibility guard: a path the container cannot see
 * would otherwise fail deep inside the runtime with an opaque error.
 */
export function resolveTriggerWorkspace(input: {
  triggerId: string
  triggerWorkspace?: string | null
  serviceWorkspace?: string
  runtimeDir: string
  defaultRuntime: 'host' | 'docker'
  dockerContainerMode: 'session' | 'user'
  mossHome?: string
}): string {
  const configured = input.triggerWorkspace?.trim() || input.serviceWorkspace?.trim()
  const workspace = configured
    ? path.resolve(configured)
    : path.join(input.runtimeDir, 'event-triggers', input.triggerId, 'workspace')

  const isUserContainerMode =
    input.defaultRuntime === 'docker' && input.dockerContainerMode === 'user'
  if (
    configured &&
    isUserContainerMode &&
    !isVisibleInUserContainer(workspace, input.runtimeDir, input.mossHome)
  ) {
    throw new Error(
      `Event trigger workspace "${workspace}" is not mounted in docker user-container mode. ` +
      `Use a path under "${input.runtimeDir}" or "${input.mossHome ?? MOSS_HOME}".`,
    )
  }

  return workspace
}

/**
 * Compose the agent prompt: the trigger's stored instructions followed by the
 * raw event payload in a fenced block.
 *
 * The template stays server-side so the calling system supplies data, not
 * instructions. Note this is still untrusted input reaching an agent — a
 * trigger should be pointed at a narrowly-permissioned assistant, and its
 * template should tell the agent to treat the payload as data.
 */
export function buildPrompt(promptTemplate: string, payloadJson: string | null): string {
  if (!payloadJson || !payloadJson.trim()) return promptTemplate
  let pretty = payloadJson
  try {
    pretty = JSON.stringify(JSON.parse(payloadJson), null, 2)
  } catch {
    // Non-JSON or malformed: pass through verbatim rather than dropping it.
  }
  return `${promptTemplate}\n\n## Event payload\n\n\`\`\`json\n${pretty}\n\`\`\`\n`
}

/**
 * EventTriggerService — drains queued external events into agent sessions.
 *
 * Design notes:
 * - Queue + global slot cap (from WikiJobExecutor) rather than cron's
 *   one-run-per-job rejection, because external systems legitimately burst.
 * - Runs are claimed atomically in the store, so concurrent ticks (or a
 *   tick overlapping a slow previous one) can never double-run an event.
 * - driveSession treats "socket closed having produced no agent output" as a
 *   FAILURE. CronService.sendCronMessage resolves successfully in that case,
 *   which masks real runner crashes as spurious downstream errors.
 */
export class EventTriggerService {
  private store: EventTriggerStore
  private config: EventTriggerServiceConfig
  private timer?: ReturnType<typeof setTimeout>
  private stopped = true
  /** Runs in flight in THIS process, used for the slot calculation. */
  private inFlight = new Set<string>()

  constructor(db: DatabaseSync, config: EventTriggerServiceConfig) {
    // Fail loud on missing config: the project has no type-check step (the
    // build only strips types), so an omitted required field would otherwise
    // surface much later as a cryptic path.join(undefined, ...) error.
    if (!config.runtimeDir) {
      throw new Error('EventTriggerService misconfigured: runtimeDir is required')
    }
    if (!config.runtimeService) {
      throw new Error('EventTriggerService misconfigured: runtimeService is required')
    }
    this.store = new EventTriggerStore(db)
    this.config = config
  }

  getStore(): EventTriggerStore {
    return this.store
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false

    // Any run still 'running' at boot was orphaned by a restart — it can
    // never complete, and would otherwise hold a slot forever.
    const reaped = this.store.reapStaleRuns(Date.now(), 'Server restarted while run was in progress')
    if (reaped > 0) {
      console.log(`[EventTriggerService] reaped ${reaped} orphaned run(s) at startup`)
    }

    const tick = () => {
      if (this.stopped) return
      this.tickOnce()
        .catch(err => console.error('[EventTriggerService] tick error:', err))
        .finally(() => {
          if (!this.stopped) this.timer = setTimeout(tick, TICK_INTERVAL_MS)
        })
    }
    this.timer = setTimeout(tick, 100)
    this.timer.unref?.()
    console.log(`[EventTriggerService] started (tick=${TICK_INTERVAL_MS}ms, maxConcurrent=${MAX_CONCURRENT_RUNS})`)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    console.log('[EventTriggerService] stopped')
  }

  /** Exposed for tests: run a single drain pass synchronously. */
  async tickOnce(): Promise<void> {
    const slots = MAX_CONCURRENT_RUNS - this.inFlight.size
    if (slots <= 0) return

    const claimed = this.store.claimQueuedRuns(slots)
    for (const run of claimed) {
      this.inFlight.add(run.id)
      // Fire-and-forget: executeRun owns its own status transitions.
      void this.executeRun(run).finally(() => this.inFlight.delete(run.id))
    }
  }

  private async executeRun(run: EventTriggerRun): Promise<void> {
    const trigger = this.store.getById(run.triggerId)
    if (!trigger) {
      this.store.updateRunStatus(run.id, { status: 'skipped', summary: 'Trigger no longer exists' })
      return
    }
    if (!trigger.enabled) {
      this.store.updateRunStatus(run.id, { status: 'skipped', summary: 'Trigger is disabled' })
      return
    }

    let sessionId: string | null = null
    // Whether this run created its own session (and therefore owns tearing it
    // down). Reused sessions are left alive for the next event.
    let sessionIsDisposable = false
    try {
      const userAuth = await this.config.getUserAuth(run.userId, run.orgId)
      if (!userAuth) throw new Error(`User auth not found for ${run.userId}`)

      const resolved = await this.resolveSession(trigger, run, userAuth)
      sessionId = resolved.sessionId
      sessionIsDisposable = resolved.created
      this.store.updateRunStatus(run.id, { status: 'running', sessionId })
      this.store.updateLastSession(trigger.id, sessionId)

      const prompt = buildPrompt(trigger.promptTemplate, run.payloadJson)
      await this.driveSession(sessionId, prompt, trigger.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS)

      this.store.updateRunStatus(run.id, {
        status: 'ok',
        sessionId,
        summary: `Event trigger "${trigger.name}" completed`,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.store.updateRunStatus(run.id, { status: 'error', sessionId, error: message })
      console.error(`[EventTriggerService] run ${run.id} failed: ${message}`)
    } finally {
      // Release a single-use session as soon as the run settles. Without this
      // every event permanently consumes one of the runtime's
      // maxSessionsPerUser slots (sessions linger as active/detached), so a
      // trigger firing repeatedly bricks itself once the budget is exhausted.
      // Cron avoids this only because it fires on a slow schedule.
      if (sessionId && sessionIsDisposable) {
        await this.retireSession(sessionId)
      }
    }
  }

  /**
   * Best-effort teardown. A failure here must not change the run's recorded
   * outcome — the agent's work is already done — so we swallow and log.
   */
  private async retireSession(sessionId: string): Promise<void> {
    try {
      await this.config.runtimeService.terminateSession(sessionId)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.warn(`[EventTriggerService] Failed to retire session ${sessionId}: ${msg}`)
    }
  }

  /**
   * Pick the session for a run. 'reuse' chains onto the trigger's last
   * session when it is still alive; anything else (or a dead session) gets a
   * fresh one. Unlike cron's bound-session mode we never hard-fail on a
   * missing session — an external event should still run.
   *
   * `created` tells the caller whether it owns tearing the session down: a
   * reused session must survive for the next event, a fresh one must not leak.
   */
  private async resolveSession(
    trigger: EventTrigger,
    run: EventTriggerRun,
    userAuth: { role: string; scopes: string[] },
  ): Promise<{ sessionId: string; created: boolean }> {
    if (trigger.conversationMode === 'reuse') {
      const candidate = trigger.boundSessionId ?? trigger.lastSessionId
      if (candidate) {
        // getSession is synchronous (returns SessionRecord | null). Allowlist
        // the live states rather than denylisting 'terminated' — 'ended' is
        // equally unusable and would otherwise be treated as reusable.
        const existing = this.config.runtimeService.getSession(candidate)
        const isLive =
          existing != null &&
          !existing.deletedAt &&
          (existing.status === 'active' || existing.status === 'detached' || existing.status === 'creating')
        if (isLive) {
          return { sessionId: candidate, created: false }
        }
        console.warn(
          `[EventTriggerService] session ${candidate} for trigger ${trigger.id} is not reusable; creating a new one`,
        )
      }
    }
    return { sessionId: await this.createSession(trigger, run, userAuth), created: true }
  }

  private async createSession(
    trigger: EventTrigger,
    run: EventTriggerRun,
    userAuth: { role: string; scopes: string[] },
  ): Promise<string> {
    const metadata = {
      source: 'event_trigger',
      triggerId: trigger.id,
      triggerName: trigger.name,
      runId: run.id,
      agentMode: 'remote',
    }

    // assistant_name may be stored as a UUID, dir name, or display name —
    // resolution is fuzzy, so normalize exactly as POST /sessions and cron do.
    const { resolveAssistantDisplayName } = await import('../../agentStore.js')
    const assistantName = trigger.assistantName
      ? await resolveAssistantDisplayName(trigger.assistantName)
      : undefined

    const cwd = resolveTriggerWorkspace({
      triggerId: trigger.id,
      triggerWorkspace: trigger.workspace,
      serviceWorkspace: this.config.workspace,
      runtimeDir: this.config.runtimeDir,
      defaultRuntime: this.config.defaultRuntime,
      dockerContainerMode: this.config.dockerContainerMode,
    })

    const session = await this.config.runtimeService.createSession({
      cwd,
      dangerouslySkipPermissions: false,
      // Run identity comes from the trigger record (stamped onto the run at
      // enqueue time), never from the request — this is the org-isolation
      // boundary for an externally-initiated run.
      userId: run.userId,
      orgId: run.orgId,
      role: userAuth.role,
      scopes: userAuth.scopes,
      assistantName,
      source: JSON.stringify(metadata),
    })

    return session.sessionId
  }

  /**
   * Send the prompt and wait for the agent to finish.
   *
   * Hardened relative to CronService.sendCronMessage in two ways:
   *  1. `sawAgentActivity` — a socket that closes without the agent ever
   *     emitting output is reported as a failure, not a success.
   *  2. an idle-nudge watchdog that revives a quiet-but-live agent and
   *     abandons a wedged one after MAX_UNPRODUCTIVE_NUDGES.
   */
  private async driveSession(sessionId: string, prompt: string, timeoutMs: number): Promise<void> {
    const ready = await this.config.runtimeService.ensureSessionReady(sessionId)
    const socket: net.Socket = await this.config.runtimeService.connectToAttempt(ready.attempt)

    await new Promise<void>((resolve, reject) => {
      let buffer = ''
      let settled = false
      let acknowledged = false
      let sawAgentActivity = false
      let unproductiveNudges = 0
      let lastActivityAt = Date.now()

      const hardTimeout = setTimeout(() => {
        finish(new Error(`Timed out after ${timeoutMs}ms waiting for the agent run to complete`))
      }, timeoutMs)

      const idleTimer = setInterval(() => {
        if (settled) return
        if (Date.now() - lastActivityAt < IDLE_NUDGE_MS) return
        if (unproductiveNudges >= MAX_UNPRODUCTIVE_NUDGES) {
          finish(new Error('Agent stopped responding (exceeded idle nudge limit)'))
          return
        }
        unproductiveNudges += 1
        lastActivityAt = Date.now()
        try {
          socket.write(`${JSON.stringify({ type: 'stdin', data: 'continue\n' })}\n`)
        } catch {
          // Write failure surfaces via the socket 'error' handler.
        }
      }, Math.max(1000, Math.floor(IDLE_NUDGE_MS / 2)))

      const cleanup = () => {
        clearTimeout(hardTimeout)
        clearInterval(idleTimer)
        socket.off('data', onData)
        socket.off('error', onError)
        socket.off('close', onClose)
      }

      const finish = (err?: Error) => {
        if (settled) return
        settled = true
        cleanup()
        if (err) {
          socket.destroy()
          reject(err)
        } else {
          socket.end()
          resolve()
        }
      }

      /** Real agent output resets the unproductive-nudge streak. */
      const markProgress = () => {
        sawAgentActivity = true
        unproductiveNudges = 0
        lastActivityAt = Date.now()
      }

      const onError = (error: Error) => finish(error)

      const onClose = () => {
        if (settled) return
        // The critical distinction: a clean close after real agent work is
        // still a failure (we never saw a terminal result), but a close with
        // NO agent output at all indicates the runner died — report that
        // plainly instead of letting it masquerade as success.
        if (!acknowledged) {
          finish(new Error('Session runner socket closed before acknowledging the event message'))
        } else if (!sawAgentActivity) {
          finish(new Error('Session runner exited without producing any agent output'))
        } else {
          finish(new Error('Session runner socket closed before the run completed'))
        }
      }

      const handleRunnerEvent = (event: { type?: string; line?: string; message?: string }) => {
        if (event.type === 'stdin_ack') {
          acknowledged = true
          lastActivityAt = Date.now()
          return
        }
        if (event.type === 'error') {
          finish(new Error(event.message || 'Session runner returned an error'))
          return
        }
        if (event.type !== 'stdout' || typeof event.line !== 'string') return

        try {
          const inner = JSON.parse(event.line) as { type?: string; status?: string; error?: string }
          if (inner.type === 'assistant' || inner.type === 'tool_use' || inner.type === 'content_block_delta') {
            markProgress()
            return
          }
          if (inner.type === 'result') {
            markProgress()
            if (inner.status === 'success') finish()
            else finish(new Error(inner.error || 'Agent run failed'))
          }
        } catch {
          // Non-JSON stdout lines are progress signals, not results.
          markProgress()
        }
      }

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        while (true) {
          const idx = buffer.indexOf('\n')
          if (idx < 0) return
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (!line.trim()) continue
          try {
            handleRunnerEvent(JSON.parse(line) as { type?: string; line?: string; message?: string })
          } catch {
            // Ignore unparseable frames.
          }
        }
      }

      socket.on('data', onData)
      socket.on('error', onError)
      socket.on('close', onClose)
      socket.write(
        `${JSON.stringify({ type: 'stdin', data: prompt.endsWith('\n') ? prompt : `${prompt}\n` })}\n`,
        error => {
          if (error) finish(error)
        },
      )
    })
  }
}
