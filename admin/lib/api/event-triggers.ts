import { dcClient } from './client'

/**
 * Event Triggers — external systems POST an event to run an agent in
 * near-real-time. See src/server/api/eventTriggers.ts.
 *
 * NOTE: unlike the cron API (which returns camelCase), this API returns
 * snake_case, so the shapes below mirror the server response verbatim rather
 * than re-mapping. Keep them in sync with mapTrigger/mapRun on the server.
 */

export type EventRunStatus = 'queued' | 'running' | 'ok' | 'error' | 'skipped'

export interface EventTrigger {
  id: string
  org_id: string
  user_id: string
  /** Owner display name, resolved server-side. */
  user_name?: string
  name: string
  enabled: boolean
  /** Display-only fragment of the secret; the secret itself is unrecoverable. */
  secret_prefix: string
  prompt_template: string
  assistant_name: string | null
  conversation_mode: 'new' | 'reuse'
  bound_session_id: string | null
  last_session_id: string | null
  workspace: string | null
  timeout_ms: number | null
  rate_limit_per_min: number | null
  last_used_at: number | null
  created_at: number
  updated_at: number
  /** Path clients POST events to. */
  events_url: string
}

export interface EventTriggerRun {
  id: string
  trigger_id: string
  org_id: string
  user_id: string
  session_id: string | null
  status: EventRunStatus
  /** Parsed event body as POSTed (server returns it already parsed). */
  payload: unknown
  idempotency_key: string | null
  started_at: number | null
  finished_at: number | null
  error: string | null
  summary: string | null
  created_at: number
}

export interface EventTriggerFormInput {
  name: string
  promptTemplate: string
  assistantName?: string
  conversationMode: 'new' | 'reuse'
  workspace?: string
  timeoutMs?: number | null
  rateLimitPerMin?: number | null
  enabled?: boolean
}

/** Create/rotate responses carry the plaintext secret exactly once. */
export interface EventTriggerSecretResponse {
  success: boolean
  trigger?: EventTrigger
  secret?: string
  message?: string
}

export async function getEventTriggers(): Promise<{ triggers: EventTrigger[] }> {
  return dcClient.get<{ triggers: EventTrigger[] }>('/api/v1/triggers')
}

export async function getEventTrigger(id: string): Promise<{ trigger: EventTrigger }> {
  return dcClient.get<{ trigger: EventTrigger }>(`/api/v1/triggers/${id}`)
}

export async function createEventTrigger(
  input: EventTriggerFormInput,
): Promise<EventTriggerSecretResponse> {
  return dcClient.post<EventTriggerSecretResponse>('/api/v1/triggers', {
    name: input.name,
    prompt_template: input.promptTemplate,
    assistant_name: input.assistantName || undefined,
    conversation_mode: input.conversationMode,
    workspace: input.workspace || undefined,
    timeout_ms: input.timeoutMs ?? undefined,
    rate_limit_per_min: input.rateLimitPerMin ?? undefined,
    enabled: input.enabled ?? true,
  })
}

export async function updateEventTrigger(
  id: string,
  updates: Partial<EventTriggerFormInput>,
): Promise<{ success: boolean; trigger?: EventTrigger; message?: string }> {
  const body: Record<string, unknown> = {}
  if (updates.name !== undefined) body.name = updates.name
  if (updates.promptTemplate !== undefined) body.prompt_template = updates.promptTemplate
  if (updates.assistantName !== undefined) body.assistant_name = updates.assistantName || null
  if (updates.conversationMode !== undefined) body.conversation_mode = updates.conversationMode
  if (updates.workspace !== undefined) body.workspace = updates.workspace || null
  if (updates.timeoutMs !== undefined) body.timeout_ms = updates.timeoutMs
  if (updates.rateLimitPerMin !== undefined) body.rate_limit_per_min = updates.rateLimitPerMin
  if (updates.enabled !== undefined) body.enabled = updates.enabled
  return dcClient.patch<{ success: boolean; trigger?: EventTrigger; message?: string }>(
    `/api/v1/triggers/${id}`,
    body,
  )
}

export async function setEventTriggerEnabled(
  id: string,
  enabled: boolean,
): Promise<{ success: boolean; trigger?: EventTrigger; message?: string }> {
  return updateEventTrigger(id, { enabled })
}

export async function deleteEventTrigger(id: string): Promise<{ success: boolean; message?: string }> {
  return dcClient.delete<{ success: boolean; message?: string }>(`/api/v1/triggers/${id}`)
}

/** Mints a new secret and invalidates the previous one immediately. */
export async function rotateEventTriggerSecret(id: string): Promise<EventTriggerSecretResponse> {
  return dcClient.post<EventTriggerSecretResponse>(`/api/v1/triggers/${id}/rotate-secret`)
}

export async function getEventTriggerRuns(
  id: string,
  limit?: number,
): Promise<{ runs: EventTriggerRun[] }> {
  const query = limit ? `?limit=${limit}` : ''
  return dcClient.get<{ runs: EventTriggerRun[] }>(`/api/v1/triggers/${id}/runs${query}`)
}

export async function getEventTriggerRun(
  id: string,
  runId: string,
): Promise<{ run: EventTriggerRun }> {
  return dcClient.get<{ run: EventTriggerRun }>(`/api/v1/triggers/${id}/runs/${runId}`)
}
