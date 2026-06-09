/**
 * `docker exec moss-session-reap <sid> <grace-ms>` wrapper. Used by
 * DockerBackend (containerMode='user') in the runner process to kill the
 * scode process group cleanly without disturbing other sessions in the same
 * user container.
 *
 * Failure to reap (container missing, daemon unreachable) is NEVER escalated
 * to `docker rm -f` of the user container — that would nuke peer sessions.
 * Caller logs the failure and lets reconcileOnStartup clean orphans.
 */

import { spawn } from 'child_process'

export type ReapOutcome = {
  ok: boolean
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export async function reapInUserContainer(args: {
  userContainerName: string
  sessionId: string
  graceMs: number
  hardTimeoutMs?: number
}): Promise<ReapOutcome> {
  const hardTimeoutMs = args.hardTimeoutMs ?? args.graceMs + 2000

  return new Promise<ReapOutcome>(resolve => {
    const child = spawn(
      'docker',
      [
        'exec',
        args.userContainerName,
        '/usr/local/bin/moss-session-reap',
        args.sessionId,
        String(args.graceMs),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', d => { stdout += d.toString('utf8') })
    child.stderr?.on('data', d => { stderr += d.toString('utf8') })

    let settled = false
    const finish = (outcome: ReapOutcome) => {
      if (settled) return
      settled = true
      resolve(outcome)
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      finish({ ok: false, code: -1, stdout, stderr, timedOut: true })
    }, hardTimeoutMs)

    child.on('error', err => {
      clearTimeout(timer)
      finish({ ok: false, code: -1, stdout, stderr: stderr || String(err), timedOut: false })
    })
    child.on('close', code => {
      clearTimeout(timer)
      const c = code ?? -1
      finish({ ok: c === 0, code: c, stdout, stderr, timedOut: false })
    })
  })
}
