import type { DbDriver } from '../db/driver.js'
import { BillingRepository } from '../billing/billingRepository.js'
import { quotaToPoints, type SudorouterPort } from '../billing/sudorouterAdapter.js'
import { WalletService } from '../billing/walletService.js'
import { migrationCommandContext } from '../application/commandContext.js'

const NAMESPACE = 'moss:sudorouter-users'
const MIGRATION = 'legacy-sudorouter-credentials-v1'

interface SecretStore {
  getSecret(namespace: string, key: string, subject?: string): Promise<{ value: string | null } | null>
  putSecret(namespace: string, key: string, value: string, subject?: string): Promise<void>
}

/** Adopt existing gateway accounts before login can provision a replacement. */
export async function migrateLegacySudorouterCredentials(
  driver: DbDriver,
  provider: Pick<SudorouterPort, 'getUser'>,
  secrets: SecretStore,
): Promise<{ imported: number }> {
  const result = await driver.tryRunExclusiveSession(`moss:${MIGRATION}`, async () => {
    const repository = new BillingRepository(driver)
    const wallet = new WalletService(driver, repository)
    const users = await driver.all<{
      id: string; org_id: string; sudorouter_user_id: string; sudorouter_key: string
    }>(`
      SELECT id, org_id, sudorouter_user_id, sudorouter_key FROM users
      WHERE sudorouter_user_id IS NOT NULL AND TRIM(sudorouter_user_id) <> ''
        AND sudorouter_key IS NOT NULL AND TRIM(sudorouter_key) <> ''
      ORDER BY id
    `)
    let imported = 0
    for (const user of users) {
      const account = await repository.getExternalAccount('sudorouter', 'user', user.id)
      // A completed binding is authoritative, including later credential rotations.
      if (account?.tokenSecretRef) continue
      const externalAccountId = String(user.sudorouter_user_id).trim()
      if (account && account.externalAccountId !== externalAccountId) {
        throw new Error(`Legacy Sudorouter binding conflict for user ${user.id}`)
      }
      const snapshot = account ?? await provider.getUser(externalAccountId)
      if (!snapshot || ('externalUserId' in snapshot && snapshot.externalUserId !== externalAccountId)) {
        throw new Error(`Legacy Sudorouter account unavailable for user ${user.id}`)
      }
      if (!Number.isSafeInteger(snapshot.quotaUnits) || !Number.isSafeInteger(snapshot.usedQuotaUnits)
        || snapshot.usedQuotaUnits < 0) {
        throw new Error(`Legacy Sudorouter quota invalid for user ${user.id}`)
      }
      const subject = `org:${user.org_id}`
      const token = normalizeToken(user.sudorouter_key)
      const existing = await secrets.getSecret(NAMESPACE, user.id, subject)
      if (existing?.value?.trim() && normalizeToken(existing.value) !== token) {
        throw new Error(`Legacy Sudorouter secret conflict for user ${user.id}`)
      }
      if (!existing?.value?.trim()) await secrets.putSecret(NAMESPACE, user.id, token, subject)
      const stored = await secrets.getSecret(NAMESPACE, user.id, subject)
      if (!stored?.value?.trim() || normalizeToken(stored.value) !== token) {
        throw new Error(`Legacy Sudorouter secret verification failed for user ${user.id}`)
      }
      await driver.transaction(async () => {
        const current = await repository.getExternalAccount('sudorouter', 'user', user.id)
        if (current?.tokenSecretRef) return
        if (current && current.externalAccountId !== externalAccountId) {
          throw new Error(`Legacy Sudorouter binding changed for user ${user.id}`)
        }
        // Offline imports already have an opening ledger. Native-only users do not.
        const existingWallet = await repository.getWallet('user', user.id)
        if (!existingWallet) throw new Error(`Legacy Sudorouter wallet missing for user ${user.id}`)
        const openingPoints = quotaToPoints(snapshot.quotaUnits)
        if (!account && openingPoints !== 0 && existingWallet.balanceUnits === 0
          && await repository.countOwnerLedgerEntries('user', user.id) === 0) {
          await wallet.post({
            ownerType: 'user', ownerId: user.id, orgId: user.org_id,
            deltaUnits: openingPoints, entryType: 'OPENING',
            sourceType: MIGRATION, sourceId: externalAccountId, allowNegative: true,
            memo: 'Existing Sudorouter balance at credential migration',
          }, migrationCommandContext(MIGRATION, `${MIGRATION}:wallet:${user.id}`))
        }
        await repository.upsertExternalAccount({
          provider: 'sudorouter', ownerType: 'user', ownerId: user.id, externalAccountId,
          quotaUnits: snapshot.quotaUnits, usedQuotaUnits: snapshot.usedQuotaUnits,
          tokenSecretRef: `nexus://${NAMESPACE}/${user.id}`, updatedAt: Date.now(),
        })
        imported += 1
      })
    }
    return { imported }
  })
  if (result === null) throw new Error('Legacy Sudorouter credentials migration is running on another instance; retry startup')
  return result
}

function normalizeToken(value: string): string {
  const token = value.trim()
  return token.startsWith('sk-') ? token : `sk-${token}`
}
