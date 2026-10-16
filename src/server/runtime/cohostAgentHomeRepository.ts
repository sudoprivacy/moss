import { PRIMARY_RUNTIME_ALLOCATION, runtimeAllocationId, type AgentRuntimeHome, type AgentRuntimeHomeStore } from '@sudo/user-runtime'
import type { DbDriver } from '../db/driver.js'

interface HomeRow extends Record<string, unknown> {
  owner_user_id: string
  native_agent_id: string
  allocation_id: string
}

function homeFromRow(row: HomeRow): AgentRuntimeHome {
  return { ownerId: row.owner_user_id, agentId: row.native_agent_id,
    allocationId: runtimeAllocationId(row.allocation_id) }
}

/** Shared SQL facts implement the common placement policy's atomic owner claim. */
export class CohostAgentHomeRepository implements AgentRuntimeHomeStore {
  constructor(private readonly driver: DbDriver) {}

  async find(ownerId: string, agentId: string): Promise<AgentRuntimeHome | undefined> {
    const row = await this.driver.get<HomeRow>(`
      SELECT owner_user_id, native_agent_id, allocation_id FROM cohost_agent_homes
      WHERE owner_user_id = ? AND native_agent_id = ?
    `, [ownerId, agentId])
    return row ? homeFromRow(row) : undefined
  }

  async list(ownerId: string): Promise<AgentRuntimeHome[]> {
    const rows = await this.driver.all<HomeRow>(`
      SELECT owner_user_id, native_agent_id, allocation_id FROM cohost_agent_homes
      WHERE owner_user_id = ? ORDER BY allocation_id, native_agent_id
    `, [ownerId])
    return rows.map(homeFromRow)
  }

  async claim(ownerId: string, agentId: string,
    chooseAllocation: (homes: readonly AgentRuntimeHome[]) => string): Promise<AgentRuntimeHome> {
    // Existing Agent homes are immutable. Session startup needs one indexed read,
    // without an owner-wide transaction or a scan of previous native bindings.
    const existing = await this.find(ownerId, agentId)
    if (existing) return existing
    return this.driver.transaction(async () => {
      if (this.driver.kind === 'postgres') {
        // Re-read committed homes after acquiring the owner lock, even when
        // the pool's default would keep a snapshot taken before that wait.
        await this.driver.exec('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
        await this.driver.get('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`moss:agent-home:${ownerId}`])
      }
      const raced = await this.find(ownerId, agentId)
      if (raced) return raced
      // Native histories created before home routing already live on primary.
      // Import them before packing new Agents; existing assignments always win.
      await this.driver.run(`
        INSERT INTO cohost_agent_homes (owner_user_id, native_agent_id, allocation_id)
        SELECT DISTINCT owner_user_id, native_agent_id, ? FROM cohost_sessions
        WHERE owner_user_id = ?
        ON CONFLICT (owner_user_id, native_agent_id) DO NOTHING
      `, [PRIMARY_RUNTIME_ALLOCATION, ownerId])
      const adopted = await this.find(ownerId, agentId)
      if (adopted) return adopted
      const home = { ownerId, agentId, allocationId: runtimeAllocationId(chooseAllocation(await this.list(ownerId))) }
      await this.driver.run(`
        INSERT INTO cohost_agent_homes (owner_user_id, native_agent_id, allocation_id) VALUES (?, ?, ?)
      `, [home.ownerId, home.agentId, home.allocationId])
      return home
    })
  }
}
