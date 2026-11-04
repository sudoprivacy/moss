/**
 * How a scheduled-task run is named, both in the message the run sends to the
 * agent and in the history documents digested from it. One format for both,
 * so what the agent saw while working matches what it later finds in recall.
 */

/** Same default as the scheduler: jobs without their own time zone run on it. */
const DEFAULT_TZ = process.env.MOSS_CRON_DEFAULT_TZ || 'Asia/Shanghai'

/** "2026-11-04 10:30" in the job's time zone. */
export function formatRunTime(ms: number, timeZone?: string | null): string {
  const tz = timeZone && timeZone.trim() ? timeZone : DEFAULT_TZ
  try {
    // sv-SE formats as "2026-11-04 10:30".
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
  }
}

/** First line of a run's message: which job, and when this run started. */
export function cronRunNote(jobName: string, startedAtMs: number, timeZone?: string | null): string {
  return `【定时任务「${jobName}」本轮运行，开始于 ${formatRunTime(startedAtMs, timeZone)}】`
}

/** Where a digested run came from, as shown in its history documents. */
export function describeCronRun(jobName: string | null, startedAtMs: number, timeZone: string | null, userName: string | undefined): string {
  const who = userName ? `员工 ${userName}` : '员工'
  return `定时任务「${jobName ?? ''}」${formatRunTime(startedAtMs, timeZone)} 的运行（${who}名下）`
}
