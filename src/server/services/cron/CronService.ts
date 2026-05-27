/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Cron } from 'croner'
import type { DatabaseSync } from 'node:sqlite'
import { CronStore, type CronJob, type CronJobRun } from './CronStore.js'
import type { RuntimeService } from '../runtimeService.js'

const CRON_RUN_TIMEOUT_MS = Number(process.env.MOSS_CRON_RUN_TIMEOUT_MS) || 30 * 60 * 1000

export interface CronServiceConfig {
  runtimeService: RuntimeService
  workspace?: string
  /** Get user auth context (role, scopes) for session creation */
  getUserAuth: (userId: string, orgId: string) => Promise<{ role: string; scopes: string[] } | null>
}

/**
 * CronService - Scheduled task execution engine
 *
 * Features:
 * - Parses cron expressions using 'croner' library
 * - DB lease for distributed lock (multi-instance safe)
 * - Handles 'new' and 'reuse' conversation modes
 * - Logs execution history in cron_job_runs
 * - Supports missed job detection (no auto-replay)
 */
export class CronService {
  private store: CronStore
  private timers: Map<string, Cron> = new Map()
  private config: CronServiceConfig
  private db: DatabaseSync
  private running = false
  private checkInterval?: ReturnType<typeof setInterval>

  constructor(db: DatabaseSync, config: CronServiceConfig) {
    this.db = db
    this.store = new CronStore(db)
    this.config = config
  }

  /**
   * Initialize the cron service and start timers for all enabled jobs
   */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    this.markMissedJobsOnStartup()

    // Load all enabled jobs and start their timers
    const jobs = this.store.listEnabled()
    for (const job of jobs) {
      this.scheduleNextRun(job)
    }

    // Also start periodic check for missed/due jobs (every 60s)
    this.checkInterval = setInterval(() => {
      this.checkDueJobs()
    }, 60000)

    // Initial check immediately
    this.checkDueJobs()

    console.log(`[CronService] Started with ${jobs.length} jobs`)
  }

  private markMissedJobsOnStartup(): void {
    const now = Date.now()
    const missedJobs = this.store.listOverdueJobs(now)
    for (const job of missedJobs) {
      const run = this.store.createRun(job.id, job.orgId, job.userId)
      this.store.updateRunStatus(run.id, {
        status: 'missed',
        error: 'Missed while Moss server was offline; waiting for the next scheduled run.',
        summary: `Cron job "${job.name}" missed while server was offline`,
      })
      this.store.updateRunResult(job.id, {
        lastStatus: 'missed',
        lastError: 'Missed while Moss server was offline; waiting for the next scheduled run.',
        runCountIncrement: 0,
      })
      this.calculateNextRun(job)
      console.warn(`[CronService] Marked missed job ${job.id} (name: ${job.name})`)
    }
  }

  /**
   * Stop all timers and cleanup
   */
  stop(): void {
    if (!this.running) return
    this.running = false

    for (const [jobId, timer] of this.timers) {
      timer.stop()
    }
    this.timers.clear()

    if (this.checkInterval) {
      clearInterval(this.checkInterval)
    }

    console.log('[CronService] Stopped')
  }

  /**
   * Start a timer for a specific job
   */
  private startTimer(job: CronJob): void {
    // Only handle 'cron' schedule kind with timers
    if (job.schedule.kind !== 'cron') return

    // Stop existing timer if any
    this.stopTimer(job.id)

    try {
      const timer = new Cron(job.schedule.value, { timezone: job.schedule.tz }, () => {
        this.executeDueJob(job.id).catch(error => {
          console.error(`[CronService] Error executing cron job ${job.id}:`, error)
        })
      })
      this.timers.set(job.id, timer)

      // Update next_run_at
      const nextRun = timer.nextRun()
      if (nextRun) {
        this.store.updateNextRunAt(job.id, nextRun.getTime())
      }
    } catch (error) {
      console.error(`[CronService] Failed to start timer for job ${job.id}:`, error)
    }
  }

  /**
   * Stop timer for a specific job
   */
  stopTimer(jobId: string): void {
    const timer = this.timers.get(jobId)
    if (timer) {
      timer.stop()
      this.timers.delete(jobId)
    }
  }

  /**
   * Add a new job and start its timer
   */
  addJob(job: CronJob): void {
    if (job.enabled && !job.deletedAt) {
      this.scheduleNextRun(job)
    }
  }

  /**
   * Update a job's timer
   */
  updateJob(job: CronJob): void {
    this.stopTimer(job.id)
    if (job.enabled && !job.deletedAt) {
      this.scheduleNextRun(job)
    } else {
      this.store.updateNextRunAt(job.id, null)
    }
  }

  /**
   * Remove a job's timer
   */
  removeJob(jobId: string): void {
    this.stopTimer(jobId)
  }

  /**
   * Check for due jobs (for 'at' and 'every' kinds, or missed cron jobs)
   */
  private checkDueJobs(): void {
    if (!this.running) return

    const now = Date.now()
    const dueJobs = this.store.listDueJobs(now)

    for (const job of dueJobs) {
      // Try to acquire lease before executing
      this.executeDueJob(job.id, now).catch(error => {
        console.error(`[CronService] Error executing job ${job.id}:`, error)
      })
    }
  }

  /**
   * Acquire DB lease for a job (distributed lock)
   */
  private acquireLease(jobId: string, nowTs: number): boolean {
    const leaseUntil = nowTs + 30000 // 30 second lease
    return this.store.acquireLease(jobId, nowTs, leaseUntil)
  }

  private async executeDueJob(jobId: string, nowTs = Date.now()): Promise<void> {
    if (!this.acquireLease(jobId, nowTs)) return
    await this.executeJob(jobId)
  }

  /**
   * Execute a job
   */
  private async executeJob(jobId: string): Promise<void> {
    const job = this.store.getById(jobId)
    if (!job || !job.enabled || job.deletedAt) {
      console.log(`[CronService] Job ${jobId} not found, disabled, or deleted`)
      return
    }

    // Create run record
    const run = this.store.createRun(job.id, job.orgId, job.userId)
    console.log(`[CronService] Starting job ${job.id} (name: ${job.name}), run ${run.id}`)

    // Mark run as running
    this.store.startRun(run.id)

    try {
      // Get user auth context
      const userAuth = await this.config.getUserAuth(job.userId, job.orgId)
      if (!userAuth) {
        throw new Error(`User auth not found for ${job.userId}`)
      }

      const sessionId = await this.resolveSessionForRun(job, run, userAuth, `job ${job.id}`)
      this.markRunSessionStarted(job, run, sessionId)

      await this.sendCronMessage(sessionId, job.payloadMessage)

      // Update run status with session
      this.store.updateRunStatus(run.id, {
        status: 'ok',
        sessionId,
        summary: `Cron job "${job.name}" executed successfully`,
      })

      // Update job status
      this.store.updateRunResult(job.id, {
        lastSessionId: sessionId,
        lastStatus: 'ok',
      })

      console.log(`[CronService] Job ${job.id} completed successfully, session: ${sessionId}`)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)

      // Update run status
      this.store.updateRunStatus(run.id, {
        status: 'error',
        error: errorMsg,
      })

      // Update job status
      this.store.updateRunResult(job.id, {
        lastStatus: 'error',
        lastError: errorMsg,
      })

      console.error(`[CronService] Job ${job.id} failed:`, errorMsg)
    }

    // Calculate next run time
    this.calculateNextRun(this.store.getById(job.id) ?? job)
  }

  /**
   * Create a new session for cron execution
   */
  private async createCronSession(
    job: CronJob,
    run: CronJobRun,
    userAuth: { role: string; scopes: string[] },
  ): Promise<string> {
    // Build cron metadata for session source
    const cronMetadata = {
      source: 'cron',
      cronJobId: job.id,
      cronJobName: job.name,
      cronRunId: run.id,
      agentMode: 'remote',
    }

    // Create session via RuntimeService
    const session = await this.config.runtimeService.createSession({
      cwd: this.config.workspace || '/tmp/cron',
      dangerouslySkipPermissions: false,
      userId: job.userId,
      orgId: job.orgId,
      role: userAuth.role,
      scopes: userAuth.scopes,
      assistantName: job.assistantName || undefined,
      source: JSON.stringify(cronMetadata),
    })

    return session.sessionId
  }

  private async resolveSessionForRun(
    job: CronJob,
    run: CronJobRun,
    userAuth: { role: string; scopes: string[] },
    logContext: string,
  ): Promise<string> {
    if (job.conversationMode !== 'reuse') {
      return this.createCronSession(job, run, userAuth)
    }

    if (job.boundSessionId) {
      const existingSession = this.config.runtimeService.getSession(job.boundSessionId)
      if (existingSession) {
        console.log(`[CronService] Reusing bound session ${job.boundSessionId} for ${logContext}`)
        return job.boundSessionId
      }

      throw new Error(`Bound session ${job.boundSessionId} not found for ${logContext}`)
    }

    if (job.lastSessionId) {
      const existingSession = this.config.runtimeService.getSession(job.lastSessionId)
      if (existingSession) {
        console.log(`[CronService] Reusing last session ${job.lastSessionId} for ${logContext}`)
        return job.lastSessionId
      }

      console.warn(`[CronService] Last session ${job.lastSessionId} not found for ${logContext}`)
    }

    console.warn(`[CronService] No reusable session found for ${logContext}, creating new session instead`)
    return this.createCronSession(job, run, userAuth)
  }

  private async sendCronMessage(sessionId: string, message: string): Promise<void> {
    const ready = await this.config.runtimeService.ensureSessionReady(sessionId)
    const runnerSocket = await this.config.runtimeService.connectToAttempt(ready.attempt)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        runnerSocket.destroy()
        reject(new Error('Timed out waiting for cron run to complete'))
      }, CRON_RUN_TIMEOUT_MS)

      let buffer = ''
      let acknowledged = false
      const cleanup = () => {
        clearTimeout(timeout)
        runnerSocket.off('data', onData)
        runnerSocket.off('error', onError)
        runnerSocket.off('close', onClose)
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const onClose = () => {
        cleanup()
        reject(new Error(acknowledged ? 'Session runner socket closed before cron run completed' : 'Session runner socket closed before acknowledging cron message'))
      }
      const handleRunnerEvent = (event: { type?: string; line?: string; message?: string }) => {
        if (event.type === 'stdin_ack') {
          acknowledged = true
          return
        }
        if (event.type === 'error') {
          cleanup()
          runnerSocket.destroy()
          reject(new Error(event.message || 'Session runner returned an error'))
          return
        }
        if (event.type !== 'stdout' || typeof event.line !== 'string') {
          return
        }

        try {
          const stdoutEvent = JSON.parse(event.line) as { type?: string; status?: string; error?: string }
          if (stdoutEvent.type === 'result') {
            cleanup()
            runnerSocket.end()
            if (stdoutEvent.status === 'success') {
              resolve()
            } else {
              reject(new Error(stdoutEvent.error || 'Cron run failed'))
            }
          }
        } catch {}
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
            const parsed = JSON.parse(line) as { type?: string; line?: string; message?: string }
            handleRunnerEvent(parsed)
          } catch {}
        }
      }

      runnerSocket.on('data', onData)
      runnerSocket.on('error', onError)
      runnerSocket.on('close', onClose)
      runnerSocket.write(`${JSON.stringify({ type: 'stdin', data: message.endsWith('\n') ? message : `${message}\n` })}\n`, error => {
        if (error) {
          cleanup()
          runnerSocket.destroy()
          reject(error)
        }
      })
    })
  }

  /**
   * Calculate next run time based on schedule kind
   */
  private calculateNextRun(job: CronJob): void {
    const now = Date.now()

    switch (job.schedule.kind) {
      case 'cron': {
        const timer = this.timers.get(job.id)
        const nextRun = timer?.nextRun()
        if (nextRun) {
          this.store.updateNextRunAt(job.id, nextRun.getTime())
        } else {
          // Timer might have been stopped, try to parse manually
          try {
            const cron = new Cron(job.schedule.value)
            const next = cron.nextRun()
            if (next) {
              this.store.updateNextRunAt(job.id, next.getTime())
            }
          } catch {
            this.store.updateNextRunAt(job.id, null)
          }
        }
        break
      }

      case 'every': {
        // Parse 'every' value (e.g., "1h", "30m", "1d")
        const value = job.schedule.value
        const match = value.match(/^(\d+)([mhd])$/)
        if (match) {
          const num = parseInt(match[1], 10)
          const unit = match[2]
          let ms = 0
          switch (unit) {
            case 'm': ms = num * 60 * 1000; break
            case 'h': ms = num * 60 * 60 * 1000; break
            case 'd': ms = num * 24 * 60 * 60 * 1000; break
          }
          this.store.updateNextRunAt(job.id, now + ms)
        }
        break
      }

      case 'at': {
        // 'at' jobs are one-time, disable after execution
        this.db.prepare(`
          UPDATE cron_jobs SET enabled = 0, next_run_at = NULL, lease_until = NULL WHERE id = ?
        `).run(job.id)
        this.stopTimer(job.id)
        break
      }
    }
  }

  private scheduleNextRun(job: CronJob): void {
    this.stopTimer(job.id)
    if (!job.enabled || job.deletedAt) {
      this.store.updateNextRunAt(job.id, null)
      return
    }

    if (job.schedule.kind === 'cron') {
      this.startTimer(job)
      return
    }

    const now = Date.now()
    if (job.schedule.kind === 'at') {
      const atMs = Date.parse(job.schedule.value)
      this.store.updateNextRunAt(job.id, Number.isFinite(atMs) && atMs > now ? atMs : now)
      return
    }

    if (job.schedule.kind === 'every') {
      this.calculateNextRun(job)
    }
  }

  /**
   * Trigger a job manually
   */
  async triggerJob(jobId: string): Promise<CronJobRun> {
    const job = this.store.getById(jobId)
    if (!job) {
      throw new Error(`Job ${jobId} not found`)
    }

    // Create run record
    const run = this.store.createRun(job.id, job.orgId, job.userId)

    // Mark run as running
    this.store.startRun(run.id)

    try {
      // Get user auth context
      const userAuth = await this.config.getUserAuth(job.userId, job.orgId)
      if (!userAuth) {
        throw new Error(`User auth not found for ${job.userId}`)
      }

      const sessionId = await this.resolveSessionForRun(job, run, userAuth, `manual trigger of job ${job.id}`)
      this.markRunSessionStarted(job, run, sessionId)

      void this.completeRunInSession(job, run, sessionId, `Cron job "${job.name}" triggered manually`)

      return this.store.getRunById(run.id)!
    } catch (error) {
      this.markRunFailed(job, run, error)
      throw error
    }
  }

  /**
   * Get the store for direct access
   */
  getStore(): CronStore {
    return this.store
  }

  private markRunSessionStarted(job: CronJob, run: CronJobRun, sessionId: string): void {
    this.store.updateRunStatus(run.id, {
      status: 'running',
      sessionId,
    })

    this.store.updateRunResult(job.id, {
      lastSessionId: sessionId,
      lastStatus: 'running',
      runCountIncrement: 0,
    })
  }

  private async completeRunInSession(job: CronJob, run: CronJobRun, sessionId: string, summary: string): Promise<void> {
    try {
      await this.sendCronMessage(sessionId, job.payloadMessage)

      this.store.updateRunStatus(run.id, {
        status: 'ok',
        sessionId,
        summary,
      })

      this.store.updateRunResult(job.id, {
        lastSessionId: sessionId,
        lastStatus: 'ok',
      })
    } catch (error) {
      this.markRunFailed(job, run, error)
    }
  }

  private markRunFailed(job: CronJob, run: CronJobRun, error: unknown): void {
    const errorMsg = error instanceof Error ? error.message : String(error)

    this.store.updateRunStatus(run.id, {
      status: 'error',
      error: errorMsg,
    })

    this.store.updateRunResult(job.id, {
      lastStatus: 'error',
      lastError: errorMsg,
    })
  }
}
