import { constants, createDecipheriv, privateDecrypt } from 'node:crypto'

export type QmsEncryptionErrorCode =
  | 'ENCRYPTION_REQUIRED'
  | 'DECRYPTION_FAILED'
  | 'INVALID_PAYLOAD'
  | 'RSA_DECRYPT_ERROR'
  | 'AES_DECRYPT_ERROR'
  | 'INVALID_PRIVATE_KEY'

export class QmsEncryptionError extends Error {
  constructor(readonly code: QmsEncryptionErrorCode, message: string) {
    super(message)
    this.name = 'QmsEncryptionError'
  }
}

interface EncryptedPayload {
  encrypted_key: string
  encrypted_data: string
  nonce: string
  tag: string
  algorithm?: 'hybrid-v1'
}

function isEncryptedPayload(value: unknown): value is EncryptedPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.encrypted_key === 'string'
    && typeof candidate.encrypted_data === 'string'
    && typeof candidate.nonce === 'string'
    && typeof candidate.tag === 'string'
}

function decodeBase64(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(normalized, 'base64')
}

export function decodeQmsPayload(
  body: unknown,
  options: { encryptionRequired: boolean; privateKeyPem?: string },
): unknown {
  if (!isEncryptedPayload(body)) {
    if (options.encryptionRequired) {
      throw new QmsEncryptionError('ENCRYPTION_REQUIRED', 'Encryption required for this endpoint')
    }
    return body
  }
  if (body.algorithm && body.algorithm !== 'hybrid-v1') {
    throw new QmsEncryptionError('INVALID_PAYLOAD', 'Unsupported encryption algorithm')
  }
  if (!options.privateKeyPem) {
    throw new QmsEncryptionError('INVALID_PRIVATE_KEY', 'Encryption configured but private key missing')
  }

  let aesKey: Buffer
  try {
    aesKey = privateDecrypt({
      key: options.privateKeyPem,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    }, decodeBase64(body.encrypted_key))
  } catch {
    throw new QmsEncryptionError('RSA_DECRYPT_ERROR', 'Decryption failed')
  }
  if (aesKey.byteLength !== 32) {
    throw new QmsEncryptionError('RSA_DECRYPT_ERROR', 'Decryption failed')
  }

  let plaintext: string
  try {
    const nonce = decodeBase64(body.nonce)
    const tag = decodeBase64(body.tag)
    if (nonce.byteLength !== 12 || tag.byteLength !== 16) {
      throw new Error('Invalid AES-GCM nonce or tag')
    }
    const decipher = createDecipheriv('aes-256-gcm', aesKey, nonce)
    decipher.setAuthTag(tag)
    plaintext = Buffer.concat([
      decipher.update(decodeBase64(body.encrypted_data)),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    throw new QmsEncryptionError('AES_DECRYPT_ERROR', 'Decryption failed')
  }

  try {
    return JSON.parse(plaintext) as unknown
  } catch {
    throw new QmsEncryptionError('DECRYPTION_FAILED', 'Decryption failed')
  }
}
