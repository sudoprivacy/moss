import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { HttpError } from '../httpError.js'
import type { BrowserBinding } from './browserGateway.js'

/** Attempt-scoped capabilities survive host restarts without exposing keys.
 * The current database attempt and account are checked on every operation.
 */
export class BrowserAgentCapabilities {
  constructor(private readonly secret = process.env.MOSS_BROWSER_SECRET || randomBytes(32).toString('hex')) {
    if (secret.length < 32) throw new Error('Browser capability secret must contain at least 32 characters')
  }

  issue(binding: BrowserBinding, attemptId: string): string {
    return createHmac('sha256', this.secret).update(JSON.stringify(['browser-agent-v1', binding.orgId, binding.userId, binding.sessionId, attemptId])).digest('base64url')
  }

  async authorize(sessionId: string, token: string | null, deps: {
    getSession: (id: string) => Promise<(BrowserBinding & { currentAttemptId: string | null; desiredState: string }) | null>
    isUserActive: (binding: BrowserBinding) => Promise<boolean>
  }): Promise<BrowserBinding> {
    if (!token || !/^[a-zA-Z0-9_-]{43}$/.test(token)) throw new HttpError(401, 'Invalid browser capability')
    const session = await deps.getSession(sessionId)
    if (!session || session.sessionId !== sessionId || !session.currentAttemptId ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(this.issue(session, session.currentAttemptId)))) {
      throw new HttpError(401, 'Invalid browser capability')
    }
    if (session.desiredState !== 'active' || !(await deps.isUserActive(session))) throw new HttpError(403, 'Browser capability revoked')
    return { orgId: session.orgId, userId: session.userId, sessionId }
  }
}
