/**
 * Per-session identity for the `start_session` call.
 *
 * `owner_id` used to be a field moss filled in and nexus believed. Anything
 * that could reach the RPC could open a session in anyone's name, because the
 * service had no way to see who was calling. nexus now reads the owner from
 * the caller's certificate and refuses a body that disagrees, so moss stops
 * asserting the owner and starts proving it: mint a credential bound to the
 * user, make the call as that credential, and send no `owner_id` at all —
 * an empty body is not a disagreement, so the certificate decides alone.
 */

import { NexusZoneApiClient, type NexusVfsTlsConfig } from '@nexus-ai-fs/vfs-client'

import type { NexusTlsConfig } from './nexusEnvConfig.js'

/**
 * How long a minted credential stays valid.
 *
 * The daemon signs whatever is asked for — there is no server-side ceiling
 * despite the RPC's documentation, verified by asking for a century and
 * getting one — so this number is the only bound that exists, and it belongs
 * here rather than in a caller's hopes.
 *
 * It only has to outlive one RPC. The credential is used for `start_session`
 * and then dropped: afterwards the owner is recorded in the session's process
 * record, and nothing re-asserts identity on the byte tunnel. Tying the
 * credential to the session's lifetime instead would force a validity long
 * enough for the longest session anyone might run, which is the opposite of
 * what a session credential is for. If the tunnel ever authenticates per
 * operation, the answer is to re-mint, not to widen this.
 */
const VALIDITY_SECS = 300

/** mTLS material for one `start_session`, held in memory and never written down. */
export type SessionIdentity = {
  tls: NexusVfsTlsConfig
  /** The `session-<uuid>` the daemon minted, for logs. */
  subjectId: string
}

/**
 * Mint a credential that proves `ownerId`.
 *
 * Returns `null` when moss cannot mint — a plaintext loopback daemon has no
 * client certificate to present, and a session with no authenticated user has
 * no owner to bind. Both keep today's behaviour instead of failing the spawn:
 * nexus falls back to the request body for a caller it cannot identify, which
 * is what makes this roll out by credential rather than by flag day.
 */
export async function mintSessionIdentity(
  endpoint: string,
  tls: NexusTlsConfig | null,
  ownerId: string | undefined,
): Promise<SessionIdentity | null> {
  if (!tls || !ownerId) return null

  const zoneApi = NexusZoneApiClient.withMtls(endpoint, tls)
  try {
    const credential = await zoneApi.mintSessionAgent(ownerId, { validitySecs: VALIDITY_SECS })
    return {
      subjectId: credential.subjectId,
      tls: {
        ca: credential.caPem,
        cert: credential.certPem,
        key: credential.keyPem,
        serverName: tls.serverName,
      },
    }
  } finally {
    zoneApi.close()
  }
}

/**
 * What the request body should say about the owner.
 *
 * Nothing, once a credential proves it: nexus refuses a body that disagrees
 * with the certificate, so sending the owner as well turns a correct call into
 * a refused one the moment the two ever drift. A proven owner is never also
 * asserted — spelt out here rather than left in a conditional, because the
 * failure it prevents looks like "every session broke" and reads like a typo.
 */
export function ownerField(
  identity: SessionIdentity | null,
  ownerId: string | undefined,
): { ownerId?: string } {
  if (identity || !ownerId) return {}
  return { ownerId }
}
