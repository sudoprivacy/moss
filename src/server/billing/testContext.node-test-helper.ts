import { DatabaseSync } from 'node:sqlite'
import { AuthCenterDb } from '../authCenter/db.js'
import { IdentityRepository } from '../identity/identityRepository.js'
import { BillingRepository } from './billingRepository.js'
import { ensureBillingSchema } from './billingSchema.js'
import { WalletService } from './walletService.js'

export function setupBillingTestContext() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const auth = new AuthCenterDb(db)
  const identities = new IdentityRepository(db)
  auth.createOrganization('org1', 'Org 1', 1)
  auth.createUser({
    id: 'u1', orgId: 'org1', email: 'u1@example.test', name: 'u1', displayName: null,
    departmentId: null, role: 'user', status: 'active', localAuth: true, tokenLimit: null,
    createdAt: 1, passwordHash: null, passwordUpdatedAt: null, lastLoginAt: null, extUserId: null,
  })
  identities.createWallet('user', 'u1', 0)
  ensureBillingSchema(db)
  const repository = new BillingRepository(db)
  const wallet = new WalletService(db, repository, () => 100)
  return { db, identities, repository, wallet }
}
