import { describe, expect, it } from 'bun:test'
import { buildClientCredentials, sealCredentials } from '../credentialsEnvelope.js'

/**
 * The client already ships a decryptor for this envelope, so the server has no
 * freedom here — cipher, nonce length, tag placement and key are all fixed by
 * code that is already installed. The test below decrypts exactly the way the
 * client does; if it passes, an installed client can read what we send.
 */

const SHARED_KEY_B64 = 'L7CbnQlwVrzWlaehCWSIiKuwBxFDh9i1AFaifYv7UXE='

/** Mirrors the client's decryptCredentials: WebCrypto, tag appended, no AAD. */
async function decryptAsClientDoes(nonce: string, ciphertext: string): Promise<unknown> {
  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.from(SHARED_KEY_B64, 'base64'),
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  )
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(nonce, 'base64') },
    key,
    Buffer.from(ciphertext, 'base64'),
  )
  return JSON.parse(new TextDecoder().decode(plain))
}

describe('credentials envelope', () => {
  it('produces something the installed client can decrypt', async () => {
    const sealed = sealCredentials({ skillhub: { token: 'hub-token-value' } })
    expect(await decryptAsClientDoes(sealed.nonce, sealed.ciphertext))
      .toEqual({ skillhub: { token: 'hub-token-value' } })
  })

  it('uses a fresh nonce every time', () => {
    // Reusing a nonce under one key is the way to break GCM outright.
    const nonces = new Set(
      Array.from({ length: 20 }, () => sealCredentials({ skillhub: { token: 'x' } }).nonce),
    )
    expect(nonces.size).toBe(20)
  })

  it('emits a 12-byte nonce, which is what the client passes as the IV', () => {
    const { nonce } = sealCredentials({})
    expect(Buffer.from(nonce, 'base64')).toHaveLength(12)
  })

  it('survives a round trip with an empty payload', async () => {
    const sealed = sealCredentials({})
    expect(await decryptAsClientDoes(sealed.nonce, sealed.ciphertext)).toEqual({})
  })
})

describe('what the deployment offers', () => {
  it('serves the hub token when one is configured', () => {
    expect(buildClientCredentials('  hub-token  ')).toEqual({ skillhub: { token: 'hub-token' } })
  })

  it('omits the field entirely when it is not configured', () => {
    // The client reads an absent field as "not configured"; an empty string
    // would read as a token and fail later, further from the cause.
    expect(buildClientCredentials(undefined)).toEqual({})
    expect(buildClientCredentials('   ')).toEqual({})
  })
})
