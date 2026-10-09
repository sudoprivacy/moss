import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto'

/** Accept the raw Base64 supplied by Fuiou as well as complete RSA PEM keys. */
export function parseFuiouRsaKey(value: string | KeyObject, kind: 'private' | 'public'): KeyObject {
  try {
    let key: KeyObject
    if (typeof value !== 'string') key = value
    else {
      const text = value.replaceAll('\\n', '\n').trim()
      const parse = kind === 'private' ? createPrivateKey : createPublicKey
      if (text.startsWith('-----BEGIN')) key = parse(text)
      else {
        const base64 = text.replace(/\s/g, '')
        if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error()
        const der = Buffer.from(base64, 'base64')
        if (der.toString('base64') !== base64) throw new Error()
        if (kind === 'private') {
          try { key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }) }
          catch { key = createPrivateKey({ key: der, format: 'der', type: 'pkcs1' }) }
        } else {
          try { key = createPublicKey({ key: der, format: 'der', type: 'spki' }) }
          catch { key = createPublicKey({ key: der, format: 'der', type: 'pkcs1' }) }
        }
      }
    }
    if (key.type !== kind || key.asymmetricKeyType !== 'rsa' || !key.asymmetricKeyDetails?.modulusLength) throw new Error()
    return key
  } catch {
    // Never include supplied key material or decoder diagnostics in client-visible errors.
    throw new Error(`Invalid Fuiou ${kind} RSA key`)
  }
}
