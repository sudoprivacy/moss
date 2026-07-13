// Opaque resource tokens for public wiki-asset URLs.
//
// A token encodes `(wikiId, relPath)` plus a truncated HMAC-SHA256 tag keyed by
// a server secret. It lets us hand end users a public, browser-loadable URL for
// a wiki image without exposing a readable path and without any server-side
// storage: the token *is* the path, and the tag makes it unforgeable and
// untamperable. Because the encoding is deterministic (no nonce, no expiry), the
// same `(wikiId, relPath)` always yields the same token — so a URL baked into a
// stored chat transcript keeps resolving across restarts, which is what makes
// "load images when viewing history" work.
//
// Security shape: this is *integrity*, not *authentication*. Anyone holding a
// valid token can fetch the asset (it is a public route). The tag only stops
// people from guessing/editing a token to reach a different path. Path traversal
// is independently blocked by the serving route's containment check. Secret:
// MOSS_RESOURCE_TOKEN_SECRET (see config), dedicated to this feature.

import { createHmac, timingSafeEqual } from 'node:crypto'

// Truncated HMAC length in bytes. 16 bytes (128 bits) is ample to make forgery
// infeasible while keeping tokens short.
const TAG_BYTES = 16
const SEP = '\0'

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64url')
}

function b64urlDecode(s: string): Buffer | null {
  // base64url is a strict subset of what Buffer.from accepts; guard against
  // obviously malformed input so a bad token can't throw downstream.
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null
  try {
    return Buffer.from(s, 'base64url')
  } catch {
    return null
  }
}

function tag(payload: Buffer, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest().subarray(0, TAG_BYTES)
}

/**
 * Build an opaque token for `(wikiId, relPath)`. Returns
 * `base64url(payload).base64url(tag)`.
 */
export function encodeResourceToken(wikiId: string, relPath: string, secret: string): string {
  const payload = Buffer.from(`${wikiId}${SEP}${relPath}`, 'utf8')
  return `${b64urlEncode(payload)}.${b64urlEncode(tag(payload, secret))}`
}

/**
 * Decode + verify a token. Returns the `(wikiId, relPath)` it carries, or null
 * if the token is malformed, the tag doesn't match (wrong/forged), or the
 * secret differs. Uses a constant-time compare on the tag.
 */
export function decodeResourceToken(
  token: string,
  secret: string,
): { wikiId: string; relPath: string } | null {
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const payload = b64urlDecode(token.slice(0, dot))
  const got = b64urlDecode(token.slice(dot + 1))
  if (!payload || !got || got.length !== TAG_BYTES) return null

  const want = tag(payload, secret)
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null

  const sepIdx = payload.indexOf(0) // SEP is a NUL byte
  if (sepIdx < 0) return null
  const wikiId = payload.subarray(0, sepIdx).toString('utf8')
  const relPath = payload.subarray(sepIdx + 1).toString('utf8')
  if (wikiId === '' || relPath === '') return null
  return { wikiId, relPath }
}
