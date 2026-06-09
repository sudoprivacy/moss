/**
 * probeContainerSession - verifies whether a scode process is still alive
 * inside a long-lived user container, with PID-reuse detection via
 * /proc/<pid>/stat field 22 (start_ticks in USER_HZ since boot).
 *
 * Same unit as moss-session-launch records, so this comparison is sound
 * regardless of clock drift / container restarts / `date` versions.
 */

import { spawn } from 'child_process'

export type ProbeKind = 'alive' | 'dead' | 'missing' | 'stale_pid_reuse'

export type ProbeResult = {
  kind: ProbeKind
  pid?: number
  recordedStartTicks?: string
  currentStartTicks?: string
}

export async function probeContainerSession(args: {
  userContainerName: string
  sessionId: string
  runtimeDirInContainer?: string
  hardTimeoutMs?: number
}): Promise<ProbeResult> {
  const hardTimeoutMs = args.hardTimeoutMs ?? 3000
  const runtimeDir = args.runtimeDirInContainer ?? '/data/runtime'
  // We render the probe as a single sh -c to avoid two roundtrips.
  const script = `
    SID="${args.sessionId}"
    META="${runtimeDir}/sessions/$SID/runtime"
    PIDFILE="$META/scode.pid"
    TICKSFILE="$META/scode.start_ticks"
    if [ ! -f "$PIDFILE" ]; then
      echo MISSING
      exit 0
    fi
    PID=$(cat "$PIDFILE")
    if [ ! -r "/proc/$PID/stat" ]; then
      echo "DEAD $PID"
      exit 0
    fi
    if [ ! -r "$TICKSFILE" ]; then
      echo "DEAD $PID"
      exit 0
    fi
    CUR=$(awk '{print $22}' "/proc/$PID/stat")
    REC=$(cat "$TICKSFILE")
    if [ "$CUR" = "$REC" ]; then
      echo "ALIVE $PID $CUR"
    else
      echo "STALE $PID $REC $CUR"
    fi
  `
  return new Promise<ProbeResult>(resolve => {
    const child = spawn(
      'docker',
      ['exec', args.userContainerName, 'sh', '-c', script],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let settled = false
    const finish = (r: ProbeResult) => { if (!settled) { settled = true; resolve(r) } }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      // Probe inconclusive — treat as missing so caller cleans metadata only.
      finish({ kind: 'missing' })
    }, hardTimeoutMs)
    child.stdout?.on('data', d => { stdout += d.toString('utf8') })
    child.on('error', () => {
      clearTimeout(timer)
      finish({ kind: 'missing' })
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) {
        finish({ kind: 'missing' })
        return
      }
      const line = stdout.trim().split('\n')[0] || ''
      const parts = line.split(/\s+/)
      const head = parts[0]
      switch (head) {
        case 'MISSING':
          finish({ kind: 'missing' })
          return
        case 'DEAD':
          finish({ kind: 'dead', pid: Number(parts[1]) || undefined })
          return
        case 'ALIVE':
          finish({
            kind: 'alive',
            pid: Number(parts[1]) || undefined,
            currentStartTicks: parts[2],
            recordedStartTicks: parts[2],
          })
          return
        case 'STALE':
          finish({
            kind: 'stale_pid_reuse',
            pid: Number(parts[1]) || undefined,
            recordedStartTicks: parts[2],
            currentStartTicks: parts[3],
          })
          return
        default:
          finish({ kind: 'missing' })
      }
    })
  })
}
