import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { AuthCenterDb } from '../authCenter/db.js'
import { createIdentityTestRepository } from '../testing/compatibilityRepositories.js'
import { AuthService, AuthServiceError } from './service.js'
import type { AuthContext } from './token.js'

void test('invalid user and department budgets cannot clear or change the stored quota', async () => {
  const raw = new DatabaseSync(':memory:')
  const db = new AuthCenterDb(raw)
  createIdentityTestRepository(raw, {}, db.driver)
  const service = new AuthService(db, 3600)
  try {
    await db.createOrganization('quota-org', 'Quota tests', 1)
    const admin = await service.createUser({ orgId: 'quota-org', name: 'admin', role: 'admin', password: 'StrongPass123' })
    const member = await service.createUser({ orgId: 'quota-org', name: 'member', role: 'user', password: 'StrongPass123' })
    const auth = { userId: admin.user.id, orgId: 'quota-org', role: 'admin', scopes: ['admin:users'] } as AuthContext
    const { department } = await service.createDepartment({ orgId: 'quota-org', name: 'Team' }, auth)
    const userInput = { orgId: 'quota-org', userId: member.user.id }
    const departmentInput = { orgId: 'quota-org', departmentId: department.id }

    await service.setUserTokenLimit({ ...userInput, tokenLimit: 100 }, auth)
    await service.setDepartmentTokenLimit({ ...departmentInput, tokenLimit: 100 }, auth)
    for (const tokenLimit of [-1, 'invalid', '100', '', undefined, true, {}, [], NaN, Infinity, 1.5]) {
      const isBadRequest = (error: unknown) => error instanceof AuthServiceError && error.statusCode === 400
      await assert.rejects(service.setUserTokenLimit({ ...userInput, tokenLimit }, auth), isBadRequest)
      await assert.rejects(service.setDepartmentTokenLimit({ ...departmentInput, tokenLimit }, auth), isBadRequest)
      assert.equal((await db.getUserById(member.user.id))?.tokenLimit, 100)
      assert.equal((await db.getDepartmentByIdAndOrg(department.id, 'quota-org'))?.tokenLimit, 100)
    }

    for (const tokenLimit of [0, 12345, null]) {
      await service.setUserTokenLimit({ ...userInput, tokenLimit }, auth)
      await service.setDepartmentTokenLimit({ ...departmentInput, tokenLimit }, auth)
      assert.equal((await db.getUserById(member.user.id))?.tokenLimit, tokenLimit)
      assert.equal((await db.getDepartmentByIdAndOrg(department.id, 'quota-org'))?.tokenLimit, tokenLimit)
    }
  } finally {
    raw.close()
  }
})
