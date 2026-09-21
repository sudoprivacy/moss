import { DatabaseSync } from 'node:sqlite'
import { AuthCenterDb } from '../authCenter/db.js'
import { ensureCompatibilityCoreSchema } from '../db/compatibilitySchema.js'
import { ensureIdentitySchema, IdentityRepository } from '../identity/identityRepository.js'
import { BillingRepository } from './billingRepository.js'
import { ensureBillingSchema } from './billingSchema.js'
import { WalletService } from './walletService.js'

export async function setupBillingTestContext() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const auth = new AuthCenterDb(db)
  const driver = auth.driver
  ensureIdentitySchema(db)
  ensureBillingSchema(db)
  ensureCompatibilityCoreSchema(db)
  const identities = new IdentityRepository(driver)
  await auth.createOrganization('org1', 'Org 1', 1)
  await auth.createUser({
    id: 'u1', orgId: 'org1', email: 'u1@example.test', name: 'u1', displayName: null,
    departmentId: null, role: 'user', status: 'active', localAuth: true, tokenLimit: null,
    createdAt: 1, passwordHash: null, passwordUpdatedAt: null, lastLoginAt: null, extUserId: null,
  })
  await identities.createWallet('user', 'u1', 0)
  const repository = new BillingRepository(driver)
  const wallet = new WalletService(driver, repository, () => 100)
  return { db, driver, identities, repository, wallet }
}
