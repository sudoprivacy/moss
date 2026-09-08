/**
 * 会话存档 record decryption.
 *
 * Two-stage, and the RSA half is NOT the same key material as the event
 * callback's EncodingAESKey:
 *
 *   1. WeCom generates a random symmetric key per record and encrypts it
 *      with OUR RSA PUBLIC key (which we upload to the console; WeCom
 *      never holds the private half).
 *   2. `encrypt_chat_msg` is decrypted with that symmetric key by the
 *      native SDK's DecryptData.
 *
 * Each record carries `publickey_ver`, naming which of our keys WeCom
 * used. Rotating the public key does NOT re-encrypt history, so every
 * private key we have ever used must be retained forever — dropping one
 * makes those records permanently unreadable. Hence keys are stored as a
 * version->PEM map rather than a single value.
 */

import { privateDecrypt, constants } from 'node:crypto'

/** version (as string) -> PEM private key. */
export type PrivateKeyMap = Record<string, string>

/**
 * Parse the `privateKeys` credential. Stored as a JSON string because the
 * secret store holds Record<string,string> (sources/secrets.ts) and
 * cannot nest. Also accepts a bare PEM for the common single-key case,
 * which is then treated as version "1".
 */
export function parsePrivateKeys(raw: string | undefined): PrivateKeyMap {
  if (!raw) return {}
  const trimmed = raw.trim()
  if (!trimmed) return {}
  if (trimmed.startsWith('-----BEGIN')) return { '1': trimmed }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: PrivateKeyMap = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v.includes('-----BEGIN')) out[String(k)] = v
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Strip PKCS#1 v1.5 type-2 padding from a raw RSA decryption.
 *
 * Layout: 0x00 0x02 <at least 8 nonzero padding bytes> 0x00 <payload>
 *
 * Node >= 18 refuses RSA_PKCS1_PADDING for private decryption (Marvin
 * attack mitigation, CVE-2023-46809), but WeCom encrypts the per-record
 * key with exactly that padding — so the only route is RSA_NO_PADDING
 * plus unpadding here. That makes this code, not OpenSSL, responsible
 * for rejecting malformed blocks.
 */
function unpadPkcs1(raw: Buffer): Buffer {
  // A valid block is exactly the modulus size and starts 0x00 0x02.
  if (raw.length < 11 || raw[0] !== 0x00 || raw[1] !== 0x02) {
    throw new Error('msgaudit: malformed PKCS#1 v1.5 block')
  }
  let i = 2
  while (i < raw.length && raw[i] !== 0x00) i++
  if (i >= raw.length) throw new Error('msgaudit: PKCS#1 v1.5 block has no separator')
  // The spec requires >= 8 padding bytes; a shorter run means corruption.
  if (i - 2 < 8) throw new Error('msgaudit: PKCS#1 v1.5 padding too short')
  return raw.subarray(i + 1)
}

/**
 * Recover the per-record symmetric key.
 *
 * See unpadPkcs1 for why this cannot use RSA_PKCS1_PADDING directly.
 */
export function decryptRandomKey(
  privateKeys: PrivateKeyMap,
  publickeyVer: number | string,
  encryptRandomKey: string,
): string {
  const ver = String(publickeyVer)
  const pem = privateKeys[ver]
  if (!pem) {
    const have = Object.keys(privateKeys).sort().join(',') || '(none)'
    throw new Error(
      `msgaudit: no private key for publickey_ver=${ver} (have: ${have}). ` +
        `Records encrypted with a rotated-away key cannot be decrypted without it.`,
    )
  }
  const raw = privateDecrypt(
    { key: pem, padding: constants.RSA_NO_PADDING },
    Buffer.from(encryptRandomKey, 'base64'),
  )
  return unpadPkcs1(raw).toString('utf8')
}
