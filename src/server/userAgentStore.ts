/**
 * Agents a user made for themselves.
 *
 * A user starts with one implicit agent (`user-<id>`, no row here) and gains one
 * per template they pick. Neither covers the case of wanting a *second* context
 * of one's own — a different piece of work, with its own memory, not derived
 * from any template. Without it every conversation started without a template
 * accumulates into a single memory bucket that cannot be partitioned, so work
 * for one project is recalled while doing another.
 *
 * Only identity lives here: an id, who owns it, and what they called it. What
 * the agent accumulates — memory, conversations, its inbox — lives in its nexus
 * home, keyed by the id. The display name is deliberately not the key: it is
 * meant to be renamed, and renaming must not orphan the agent's past.
 */

import { randomUUID } from 'node:crypto'
import type { DbDriver } from './db/driver.js'

export type UserAgent = {
  id: string
  displayName: string
  createdAt: number
}

type Row = { id: string; display_name: string; created_at: number }

/** Used only without a database, for isolated tests and standalone callers. */
const memoryStore = new Map<string, UserAgent[]>()

let driver: DbDriver | null = null

function memoryKey(orgId: string, userId: string): string {
  return `${orgId}\u0000${userId}`
}

export async function initUserAgentStore(database: DbDriver): Promise<void> {
  driver = database
  // The postgres backend gets this table from pg_schema.ts, applied before any
  // call here; sqlite builds it on the spot, as the other per-user stores do.
  if (driver.kind === 'sqlite') {
    await driver.exec(`
      CREATE TABLE IF NOT EXISTS user_agents (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
    await driver.exec(
      'CREATE INDEX IF NOT EXISTS idx_user_agents_owner ON user_agents (org_id, user_id, created_at)',
    )
  }
}

/** Longest name accepted; the field is a label, not a document. */
const DISPLAY_NAME_MAX = 60

export class InvalidAgentNameError extends Error {}

export async function createUserAgent(input: {
  orgId: string
  userId: string
  displayName: string
}): Promise<UserAgent> {
  const displayName = input.displayName.trim()
  if (!displayName) throw new InvalidAgentNameError('an agent needs a name')
  if (displayName.length > DISPLAY_NAME_MAX) {
    throw new InvalidAgentNameError(`an agent name is at most ${DISPLAY_NAME_MAX} characters`)
  }

  const agent: UserAgent = { id: randomUUID(), displayName, createdAt: Date.now() }
  if (driver) {
    await driver.run(
      'INSERT INTO user_agents (id, org_id, user_id, display_name, created_at) VALUES (?, ?, ?, ?, ?)',
      [agent.id, input.orgId, input.userId, agent.displayName, agent.createdAt],
    )
    return agent
  }
  const key = memoryKey(input.orgId, input.userId)
  memoryStore.set(key, [...(memoryStore.get(key) ?? []), agent])
  return agent
}

export async function listUserAgents(orgId: string, userId: string): Promise<UserAgent[]> {
  if (driver) {
    const rows = await driver.all<Row>(
      'SELECT id, display_name, created_at FROM user_agents WHERE org_id = ? AND user_id = ? ORDER BY created_at ASC',
      [orgId, userId],
    )
    return rows.map(row => ({
      id: row.id,
      displayName: row.display_name,
      createdAt: Number(row.created_at),
    }))
  }
  return [...(memoryStore.get(memoryKey(orgId, userId)) ?? [])]
}

/**
 * One agent, only if this user owns it.
 *
 * Ownership is part of the lookup rather than a check afterwards: an agent id
 * is the key to someone's memory and conversations, so a caller holding one
 * must not be able to read another person's agent by passing it.
 */
export async function getUserAgent(
  orgId: string,
  userId: string,
  id: string,
): Promise<UserAgent | null> {
  const agents = await listUserAgents(orgId, userId)
  return agents.find(agent => agent.id === id) ?? null
}

/** Test seam: drop in-memory state between cases. */
export function resetUserAgentStoreForTests(): void {
  memoryStore.clear()
  driver = null
}
