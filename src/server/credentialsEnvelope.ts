/**
 * The credentials envelope the desktop client fetches after signing in.
 *
 * Shape and cipher are fixed by the client, which already ships a decryptor:
 * AES-256-GCM, a 12-byte nonce, the tag appended to the ciphertext, no AAD,
 * and a key compiled into the client itself.
 *
 * That last part is worth being clear about rather than papering over: a key
 * present in every installed copy of the client gives no confidentiality
 * against anyone holding the client. **The Bearer token on the request is what
 * actually protects this endpoint** — the envelope only keeps the values out of
 * plain sight in logs and proxies. Do not put anything here that the session
 * itself should not be trusted with.
 */
import { createCipheriv, randomBytes } from 'node:crypto'

/** The key the client is built with; changing it breaks every existing install. */
const SHARED_KEY_B64 = 'L7CbnQlwVrzWlaehCWSIiKuwBxFDh9i1AFaifYv7UXE='

/** Every field is optional — the client treats an absent one as "not configured". */
export type ClientCredentials = {
  skillhub?: { token: string }
  log_report?: { key: string }
  product_improvement?: { api_key: string; public_key?: string }
}

export type SealedEnvelope = { nonce: string; ciphertext: string }

export function sealCredentials(credentials: ClientCredentials): SealedEnvelope {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(SHARED_KEY_B64, 'base64'), iv)
  const body = Buffer.concat([
    cipher.update(JSON.stringify(credentials), 'utf8'),
    cipher.final(),
  ])
  return {
    nonce: iv.toString('base64'),
    // Tag appended, matching the client's decrypt.
    ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString('base64'),
  }
}

/**
 * What this deployment has to hand the client.
 *
 * Only the skill hub is served. The other two fields belong to log reporting
 * and product improvement, which moss declares OFF in its system config — a
 * client reading this has already been told not to use them, so carrying keys
 * for them would be configuration nobody consumes. Adding a field later is one
 * line; the shape is open on purpose.
 */
export function buildClientCredentials(hubAuthorization: string | undefined): ClientCredentials {
  const token = hubAuthorization?.trim()
  return token ? { skillhub: { token } } : {}
}
