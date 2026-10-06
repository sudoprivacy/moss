/**
 * Who a session belongs to, when the user did not pick anybody.
 *
 * An agent is the durable principal: it owns the config, the prompts, the
 * skills and the memory, and it outlives any one session or process. A session
 * belongs to exactly one — there is no such thing as a session that belongs to
 * nobody. Before this, a session opened without choosing an assistant carried
 * no agent at all, which had two visible consequences: the sidebar had nothing
 * to group it under, and `memory_mode` fell to `session`, so every one of those
 * conversations was an island with no memory of the last one.
 *
 * The cohort that never picks an assistant is the majority, so "no agent" was
 * the common case rather than the edge one.
 *
 * Such a session belongs to the user's own agent. Its name is derived from the
 * user id rather than the display name: `/agents/{name}` is a real path
 * segment, and a display name can be changed, can collide with another user's,
 * and can contain separators — a rename would otherwise orphan every
 * conversation the user had had.
 *
 * This agent is NOT a catalog entry. It exists because a user exists, so every
 * lookup that asks the organization catalog "which assistant is this?" has to
 * skip it rather than 404 on it.
 */

import { createHash } from 'node:crypto'

/**
 * Marks an agent that exists because a user does.
 *
 * The marker has to be one a catalog assistant cannot carry, and an assistant's
 * name is whatever somebody typed — the deployment has `AI 学习辅导`,
 * `企业知识中枢Agent`, `Remote Agent`, and a test installs one called
 * `agent-one`. A short prefix like `user-` or `agent-` is a name, not a
 * reservation, and claiming one silently swallows every assistant that starts
 * with it: the catalog lookup is skipped, so a request that should answer 404
 * for an assistant another organization owns instead proceeds.
 *
 * `moss-agent:` follows the convention already in this field — `moss-prepared:`
 * marks the other kind of non-catalog reference.
 */
const DEFAULT_AGENT_PREFIX = 'moss-agent:user:'

/**
 * Marks an agent a user made for themselves — a second context of their own,
 * with its own memory, that did not come from a template.
 *
 * The id is generated, not the name the user typed: a display name is meant to
 * be changed, and the agent's home, memory and conversations all hang off this.
 */
const USER_CREATED_AGENT_PREFIX = 'moss-agent:own:'

/** The reference stored for an agent the user made. `id` is generated at creation. */
export function userCreatedAgentName(id: string): string {
  return `${USER_CREATED_AGENT_PREFIX}${id}`
}

export function isUserCreatedAgentName(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.startsWith(USER_CREATED_AGENT_PREFIX)
}

/**
 * Whether this reference names one of the user's own agents — the implicit
 * default, or one they made — rather than a template.
 *
 * This is the question nearly every caller is really asking. A template is
 * looked up in the organization catalog and carries a role; a user's own agent
 * is in neither, and asking the catalog for it answers 404 for a session that
 * is perfectly valid.
 */
export function isUserOwnedAgentName(name: string | null | undefined): boolean {
  return isDefaultAgentName(name) || isUserCreatedAgentName(name)
}

/** The agent a session belongs to when the user did not choose an assistant. */
export function defaultAgentName(userId: string): string {
  return `${DEFAULT_AGENT_PREFIX}${userId}`
}

/**
 * Whether this name is a user's own agent rather than a catalog assistant.
 *
 * Callers use it to skip the organization-catalog lookup: a default agent has
 * no catalog entry to find, so asking for one answers 404 for a session that
 * is perfectly valid.
 */
export function isDefaultAgentName(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.startsWith(DEFAULT_AGENT_PREFIX)
}

/**
 * The agent a session's runtime belongs to, as nexus will name it.
 *
 * `assistantName` says which template a session chose; it is NOT the agent.
 * Two users who both pick 「招聘专家」 chose the same template and are not the
 * same principal — the template is shared, and a shared thing cannot own one
 * person's memory, conversations or inbox. Handing the template's name to
 * `start_session` made them one: `/agents/{name}` is a zone-wide namespace and
 * a zone is a tenant, so every user in an organization landed in the same agent
 * home, sharing its state stream and conversation list.
 *
 * So the runtime's agent is the pair: this user, that template.
 *
 * The result also has to survive being a path segment, which the raw value does
 * not. Production `sessions.assistant_name` holds spaces (`AI 学习辅导`), CJK
 * (`企业知识中枢Agent`), an `@` (a channel's WeChat openid) and UI placeholders
 * (`Remote Agent`) — all of which have been going into `/agents/{name}` as-is.
 * The readable part is therefore reduced to a safe slug, and a digest of the
 * original is appended so two templates that slugify alike stay apart.
 */
export function sessionAgentName(userId: string, assistantRef?: string | null): string {
  // The stored reference carries a marker so a catalog assistant cannot be
  // mistaken for one of these; the marker is not part of the agent's name,
  // which has to survive being a path segment.
  if (!assistantRef || isDefaultAgentName(assistantRef)) return `user-${userId}`
  // An agent the user made is already theirs, but it is still paired: an id that
  // leaked between users must not let one of them address the other's agent.
  // The marker is in-band for storage only; the id alone goes into the path.
  if (isUserCreatedAgentName(assistantRef)) {
    return `u-${userId}--${assistantRef.slice(USER_CREATED_AGENT_PREFIX.length)}`
  }
  return `u-${userId}--${pathSafeSlug(assistantRef)}`
}

/** Longest readable part kept; the digest after it carries the uniqueness. */
const SLUG_MAX = 32

function pathSafeSlug(value: string): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 8)
  const readable = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '')
  // A value with nothing safe in it (all CJK, say) still gets a stable name.
  return readable ? `${readable}-${digest}` : digest
}
