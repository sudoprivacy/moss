/**
 * Document Center v2 — Credentials store.
 *
 * Per-source secrets (CorpID / AgentSecret / API tokens etc) get
 * AES-256-GCM encrypted with a master key derived from
 * `$MOSS_HOME/.master_key` (auto-generated on first use) and persisted
 * under `$MOSS_HOME/secrets/<key>.json`.
 *
 * Design choices for P0:
 *   - File-per-secret keeps the surface small. No DB table for now.
 *   - Master key on disk in $MOSS_HOME — same trust boundary as the
 *     SQLite DB. Deploy-time ops should chmod 600 the moss dir.
 *   - Returned keys are random UUIDs and stored in
 *     external_sources.credentials_secret_key. Rotation = create a new
 *     key + update the row + delete the old file.
 *
 * Phase 2: move into the SQLite DB as a proper `tenant_secrets` table
 * with org_id, key, ciphertext columns + a daily KEK rotation.
 */

import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'crypto'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import path from 'path'
import { MOSS_HOME } from '../../utils/wikis/localWikiDirectories.js'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const KEY_LEN = 32

function getSecretsDir(): string {
  return process.env.MOSS_SECRETS_DIR || path.join(MOSS_HOME, 'secrets')
}

function getMasterKeyPath(): string {
  return process.env.MOSS_MASTER_KEY_FILE || path.join(MOSS_HOME, '.master_key')
}

let cachedKey: Buffer | null = null

async function loadOrCreateMasterKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey
  const keyPath = getMasterKeyPath()
  try {
    const seed = await readFile(keyPath, 'utf8')
    cachedKey = scryptSync(seed.trim(), 'moss-secrets-v1', KEY_LEN)
    return cachedKey
  } catch {
    const seed = randomBytes(48).toString('base64url')
    await mkdir(path.dirname(keyPath), { recursive: true })
    await writeFile(keyPath, seed, { mode: 0o600 })
    cachedKey = scryptSync(seed, 'moss-secrets-v1', KEY_LEN)
    return cachedKey
  }
}

type SecretPayload = {
  iv: string         // base64
  ciphertext: string // base64
  authTag: string    // base64
  alg: typeof ALGO
}

/**
 * Encrypt and persist a secret object. Returns the generated key that
 * should be stored in external_sources.credentials_secret_key.
 */
export async function storeSecret(value: Record<string, string>): Promise<string> {
  const key = await loadOrCreateMasterKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, key, iv)
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag()

  const payload: SecretPayload = {
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: authTag.toString('base64'),
    alg: ALGO,
  }

  const id = randomUUID()
  const dir = getSecretsDir()
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify(payload), {
    mode: 0o600,
  })
  return id
}

export async function readSecret(secretKey: string): Promise<Record<string, string>> {
  const key = await loadOrCreateMasterKey()
  const file = path.join(getSecretsDir(), `${secretKey}.json`)
  const raw = await readFile(file, 'utf8')
  const payload = JSON.parse(raw) as SecretPayload
  const iv = Buffer.from(payload.iv, 'base64')
  const ciphertext = Buffer.from(payload.ciphertext, 'base64')
  const authTag = Buffer.from(payload.authTag, 'base64')
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  const parsed = JSON.parse(plaintext.toString('utf8')) as unknown
  if (!parsed || typeof parsed !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

export async function deleteSecret(secretKey: string): Promise<void> {
  const file = path.join(getSecretsDir(), `${secretKey}.json`)
  try {
    await rm(file, { force: true })
  } catch {
    // ignore
  }
}
