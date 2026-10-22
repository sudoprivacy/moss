import type { AuthContext } from '../auth/token.js'
import type { ParkStore } from './store.js'
import { PARK_PUBLIC_SESSION_SOURCE } from './mossSessions.js'

/** Park leadership never gains raw consultation access through a generic admin scope. */
export async function canReadParkRuntime(store: ParkStore, auth: AuthContext,
  session: { orgId: string; source?: string | null }): Promise<boolean> {
  if (session.source !== PARK_PUBLIC_SESSION_SOURCE) return true
  if (session.orgId !== auth.orgId) return false
  return await store.role(auth.orgId, auth.userId) !== 'park_leader'
}
