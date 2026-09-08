import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { LegacyIdentitySnapshot, LegacyProviderIdentity } from './identityMergePlanner.js'

type SqlRow = Record<string, unknown>

export interface SudoworkIdentitySourceSnapshot extends LegacyIdentitySnapshot {
  checksum: string
}

export class SudoworkIdentitySourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SudoworkIdentitySourceError'
  }
}

export class SudoworkIdentitySourceReader {
  private readonly databasePath: string

  constructor(snapshotDirectory: string) {
    this.databasePath = resolve(snapshotDirectory, 'sudowork.sqlite')
  }

  readSnapshot(): SudoworkIdentitySourceSnapshot {
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(this.databasePath, { readOnly: true })
      db.exec('PRAGMA query_only=ON')
      if (!tableExists(db, 'enterprises') || !tableExists(db, 'users')) {
        throw new SudoworkIdentitySourceError('身份快照缺少 enterprises 或 users 表')
      }
      const organizations = (db.prepare('SELECT id, name, code FROM enterprises ORDER BY id').all() as SqlRow[])
        .map(row => ({
          legacyId: positiveInteger(row.id, 'enterprises.id'),
          name: text(row.name) || `Enterprise ${String(row.id)}`,
          code: text(row.code) || null,
          codeVerified: Boolean(text(row.code)),
        }))
      const organizationIds = new Set(organizations.map(item => item.legacyId))
      const identities = tableExists(db, 'third_party_auth_identities')
        ? db.prepare(`
            SELECT provider_id, external_user_id, user_id, enterprise_id
            FROM third_party_auth_identities ORDER BY user_id, id
          `).all() as SqlRow[]
        : []
      const providersByUser = new Map<number, LegacyProviderIdentity[]>()
      for (const row of identities) {
        const userId = positiveInteger(row.user_id, 'third_party_auth_identities.user_id')
        const providerId = requiredText(row.provider_id, 'third_party_auth_identities.provider_id')
        const provider = { provider: 'cas', issuer: providerId, subject: requiredText(row.external_user_id, 'third_party_auth_identities.external_user_id') }
        providersByUser.set(userId, [...(providersByUser.get(userId) ?? []), provider])
      }
      const users = (db.prepare(`
        SELECT id, phone, nickname, role, status, enterprise_id, password_hash, login_type
        FROM users ORDER BY id
      `).all() as SqlRow[]).map(row => {
        const legacyId = positiveInteger(row.id, 'users.id')
        const enterpriseId = positiveInteger(row.enterprise_id, 'users.enterprise_id')
        if (!organizationIds.has(enterpriseId)) {
          throw new SudoworkIdentitySourceError(`旧用户 ${legacyId} 引用不存在的企业 ${enterpriseId}`)
        }
        const providers = providersByUser.get(legacyId) ?? []
        const phone = text(row.phone) || null
        return {
          legacyId,
          enterpriseId,
          username: phone ?? `legacy-${legacyId}`,
          displayName: text(row.nickname) || null,
          phone,
          phoneVerified: phone !== null,
          email: null,
          emailVerified: false,
          passwordHash: text(row.password_hash) || null,
          role: requiredText(row.role, 'users.role'),
          status: legacyStatus(Number(row.status)),
          providerIdentity: providers[0] ?? null,
          providerIdentities: providers,
        }
      })
      const danglingIdentity = [...providersByUser.keys()].find(userId => !users.some(user => user.legacyId === userId))
      if (danglingIdentity !== undefined) {
        throw new SudoworkIdentitySourceError(`三方身份引用不存在的旧用户 ${danglingIdentity}`)
      }
      const value = { organizations, users }
      return { ...value, checksum: createHash('sha256').update(JSON.stringify(value)).digest('hex') }
    } catch (error) {
      if (error instanceof SudoworkIdentitySourceError) throw error
      throw new SudoworkIdentitySourceError(`无法只读读取 Sudowork 身份快照: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      db?.close()
    }
  }
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
}

function positiveInteger(value: unknown, field: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw new SudoworkIdentitySourceError(`${field} 必须是正整数`)
  return number
}

function requiredText(value: unknown, field: string): string {
  const result = text(value)
  if (!result) throw new SudoworkIdentitySourceError(`${field} 不能为空`)
  return result
}

function text(value: unknown): string {
  return value == null ? '' : String(value).trim()
}

function legacyStatus(value: number): 'PENDING' | 'ACTIVE' | 'LOCKED' {
  if (value === 0) return 'PENDING'
  if (value === 1) return 'ACTIVE'
  if (value === 2) return 'LOCKED'
  throw new SudoworkIdentitySourceError(`users.status 非法: ${value}`)
}
