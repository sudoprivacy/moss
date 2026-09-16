import assert from 'node:assert/strict'
import { createCipheriv, generateKeyPairSync, publicEncrypt, randomBytes } from 'node:crypto'
import { constants } from 'node:crypto'
import { describe, it } from 'node:test'

import { QmsEncryptionError, decodeQmsPayload } from './hybridDecryption.js'

function encryptedPayload(value: unknown) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const aesKey = randomBytes(32)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', aesKey, nonce)
  const encryptedData = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const encryptedKey = publicEncrypt({
    key: publicKey,
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
  }, aesKey)
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    payload: {
      algorithm: 'hybrid-v1' as const,
      encrypted_key: encryptedKey.toString('base64url'),
      encrypted_data: encryptedData.toString('base64url'),
      nonce: nonce.toString('base64url'),
      tag: tag.toString('base64url'),
    },
  }
}

describe('QMS hybrid request decryption', () => {
  it('passes plaintext only when encryption is optional', () => {
    const body = { events: [{ type: 'perf' }] }
    assert.deepEqual(decodeQmsPayload(body, { encryptionRequired: false }), body)
    assert.throws(() => decodeQmsPayload(body, { encryptionRequired: true, privateKeyPem: 'unused' }),
      (error: unknown) => error instanceof QmsEncryptionError && error.code === 'ENCRYPTION_REQUIRED')
  })

  it('decrypts the legacy RSA-OAEP and AES-256-GCM envelope', () => {
    const expected = { events: [{ type: 'perf', value_ms: 17 }] }
    const encrypted = encryptedPayload(expected)

    assert.deepEqual(decodeQmsPayload(encrypted.payload, {
      encryptionRequired: true,
      privateKeyPem: encrypted.privateKeyPem,
    }), expected)
  })

  it('rejects missing private keys and authenticated ciphertext tampering', () => {
    const encrypted = encryptedPayload({ value: 1 })
    assert.throws(() => decodeQmsPayload(encrypted.payload, { encryptionRequired: true }),
      (error: unknown) => error instanceof QmsEncryptionError && error.code === 'INVALID_PRIVATE_KEY')

    const tampered = { ...encrypted.payload, tag: Buffer.alloc(16, 1).toString('base64') }
    assert.throws(() => decodeQmsPayload(tampered, {
      encryptionRequired: true,
      privateKeyPem: encrypted.privateKeyPem,
    }), (error: unknown) => error instanceof QmsEncryptionError && error.code === 'AES_DECRYPT_ERROR')
  })
})
