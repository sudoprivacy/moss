import { createHash, randomUUID } from 'node:crypto'
import { AuthCenterDb, hashPassword } from '../authCenter/db.js'
import { IdentityRepository } from './identityRepository.js'
import { normalizePhone } from '../auth/phoneAuth.js'
import { PlatformConfigError } from '../configuration/platformConfigService.js'

/** Explicit, previewable migration. Never reset a password that already exists. */
export async function migratePhonePasswords(auth: AuthCenterDb, input: { apply?: boolean; fingerprint?: string; actorId: string }) {
  const identities = new IdentityRepository(auth.driver)
  return auth.driver.transaction(async () => {
    const rows = await auth.driver.all<{ id: string; org_id: string; name: string; phone: string | null; subject: string; status: string }>(`
      SELECT u.id, u.org_id, u.name, u.phone, a.normalized_subject AS subject, u.status
      FROM users u JOIN user_auth_identities a ON a.user_id = u.id AND a.org_id = u.org_id
      WHERE a.provider = 'phone' AND a.issuer = 'sudowork'
        AND (u.password_hash IS NULL OR u.password_hash = '') AND u.role = 'user'
      ORDER BY u.id
    `)
    const skipReason = (row: typeof rows[number]): string | null => {
      if (row.status !== 'active') return '用户未启用'
      const phone = normalizePhone(row.subject)
      if (!phone) return '手机身份格式无效'
      if (row.phone && normalizePhone(row.phone) !== phone) return '手机号与身份记录冲突'
      return null
    }
    const candidates = rows.filter(row => skipReason(row) === null)
    const fingerprint = createHash('sha256').update(JSON.stringify(candidates.map(r => [r.id, r.org_id, r.subject]))).digest('hex')
    if (input.apply && input.fingerprint !== fingerprint) throw new PlatformConfigError(409, '用户状态已变化，请重新预览')
    let updated = 0
    if (input.apply) {
      for (const row of candidates) {
        const phone = normalizePhone(row.subject)!
        const count = await auth.driver.run(`UPDATE users SET password_hash = ?, password_updated_at = ?, local_auth = 1
          WHERE id = ? AND (password_hash IS NULL OR password_hash = '') AND status = 'active'`, [hashPassword(phone), Date.now(), row.id])
        if (!count) continue
        if (!(await identities.findAuthIdentityByUser(row.id, 'password', 'moss'))) {
          await identities.createAuthIdentity({ id: randomUUID(), userId: row.id, orgId: row.org_id,
            provider: 'password', issuer: 'moss', normalizedSubject: row.name, metadata: { initializedBy: input.actorId } })
        }
        updated += count
      }
    }
    return { fingerprint, eligible: candidates.length, skipped: rows.length - candidates.length, updated,
      users: candidates.map(row => ({ userId: row.id, organizationId: row.org_id })),
      skippedUsers: rows.filter(row => skipReason(row) !== null).map(row => ({ userId: row.id, reason: skipReason(row) })) }
  })
}
