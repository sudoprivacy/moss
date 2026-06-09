/**
 * Structured runtime metric events.
 *
 * The project does not (yet) ship a Prometheus registry, so this module
 * deliberately stays small: one log entry per event, single canonical line
 * format, and explicit guards against high-cardinality labels.
 *
 *   moss-runtime-metric event=<name> [k=v]...
 *
 * Pipe `[claude-server:runtime-metric]` lines into ES/Loki and aggregate via
 * log queries until a Prometheus registry exists. Once it does, swap the
 * implementation here without touching call sites.
 *
 * Label cardinality rules (enforced):
 *   - REJECT user / userId / session / sessionId / containerId — those have
 *     no upper bound and would blow up any downstream metrics backend.
 *   - ALLOW reason / kind / state / outcome / org enums.
 *   - sid / userId belong in structured logs (not metric labels) and go on a
 *     SEPARATE logger surface (logSessionContext below).
 */

export type RuntimeMetricEvent =
  | 'user_container_ensure_started'
  | 'user_container_ensure_ok'
  | 'user_container_ensure_failed'
  | 'user_container_reused'
  | 'user_container_external_vanished'
  | 'user_container_reclaim_started'
  | 'user_container_reclaim_ok'
  | 'user_container_reclaim_failed'
  | 'user_container_force_drain'
  | 'session_acquire'
  | 'session_acquire_rejected'
  | 'session_release'
  | 'session_reap_ok'
  | 'session_reap_failed'
  | 'session_reap_timeout'
  | 'session_persist_in_progress_ok'
  | 'session_persist_in_progress_failed'
  | 'session_host_exec_force_kill'
  | 'session_idle_busy_timeout'
  | 'reconcile_user_container_seen'
  | 'reconcile_orphan_scode'
  | 'reconcile_pid_reuse'
  | 'reconcile_probe_failed'
  | 'release_session_via_child_close'

const HIGH_CARDINALITY_KEYS = new Set([
  'userId',
  'user_id',
  'user',
  'sessionId',
  'session_id',
  'sid',
  'containerId',
  'container_id',
  'pid',
  'transcriptSessionId',
])

export type MetricLabels = Record<string, string | number | boolean | undefined>

function sanitizeLabels(labels: MetricLabels | undefined): string {
  if (!labels) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(labels)) {
    if (v === undefined) continue
    if (HIGH_CARDINALITY_KEYS.has(k)) continue
    parts.push(`${k}=${formatValue(v)}`)
  }
  return parts.length ? ` ${parts.join(' ')}` : ''
}

function formatValue(v: string | number | boolean): string {
  if (typeof v === 'string' && /\s/.test(v)) return JSON.stringify(v)
  return String(v)
}

/**
 * Emit a runtime metric counter event. Designed to be cheap (one stderr
 * write) and low-cardinality. High-cardinality keys (userId/sessionId/etc)
 * are silently dropped; use `logSessionContext` to include them in
 * structured logs for ES/Loki indexing.
 */
export function logRuntimeMetric(
  event: RuntimeMetricEvent,
  labels?: MetricLabels,
): void {
  process.stderr.write(
    `[claude-server:runtime-metric] event=${event}${sanitizeLabels(labels)}\n`,
  )
}

/**
 * Companion structured log surface that DOES carry sessionId / userId /
 * containerId / pid so operators can grep by them in ES/Loki without
 * polluting metric label space. Keep `event` aligned with the metric name
 * where applicable so the two surfaces stay correlated.
 */
export function logRuntimeEvent(
  event: RuntimeMetricEvent | string,
  context: Record<string, string | number | boolean | undefined>,
): void {
  const parts: string[] = []
  for (const [k, v] of Object.entries(context)) {
    if (v === undefined) continue
    parts.push(`${k}=${formatValue(v)}`)
  }
  process.stderr.write(
    `[claude-server:runtime-event] event=${event}${parts.length ? ` ${parts.join(' ')}` : ''}\n`,
  )
}
