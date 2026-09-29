// Runs under Node (AuthCenterDb uses node:sqlite, which Bun lacks): `tsx --test`.
// §5.4 supplement: membership_revision must advance when a user's org changes
// (org moves change membership semantics like role/status do), so delegations
// minted against the old revision are refused immediately instead of relying
// on the org-filtered membership lookup fallback.
import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { AuthCenterDb } from '../authCenter/db.js'

let raw: DatabaseSync
let db: AuthCenterDb

beforeEach(async () => {
  raw = new DatabaseSync(':memory:')
  db = new AuthCenterDb(raw, ':memory:')
  await db.createOrganization('org-1', 'Org One', 1)
  await db.createOrganization('org-2', 'Org Two', 2)
  await db.createUser({
    id: 'user-1',
    orgId: 'org-1',
    email: 'user-1@example.test',
    name: 'user-1',
    displayName: 'user-1',
    departmentId: null,
    role: 'user',
    status: 'active',
    localAuth: true,
    tokenLimit: null,
    createdAt: 1,
    passwordHash: null,
    passwordUpdatedAt: null,
    lastLoginAt: null,
    extUserId: null,
  })
})

async function revision(): Promise<number> {
  const user = await db.getUserById('user-1')
  assert.ok(user)
  return user.membershipRevision
}

describe('updateUser bumps membership_revision on org moves', () => {
  it('advances when orgId changes', async () => {
    const before = await revision()
    await db.updateUser('user-1', { orgId: 'org-2' })
    assert.equal(await revision(), before + 1)
  })

  it('does not advance when orgId stays the same', async () => {
    await db.updateUser('user-1', { orgId: 'org-1' })
    assert.equal(await revision(), 0)
  })

  it('keeps the existing role/status semantics (bump on real change only)', async () => {
    await db.updateUser('user-1', { role: 'admin' })
    assert.equal(await revision(), 1)
    await db.updateUser('user-1', { role: 'admin' })
    assert.equal(await revision(), 1)
    await db.updateUser('user-1', { status: 'disabled' })
    assert.equal(await revision(), 2)
  })

  it('does not advance on patches without membership-relevant fields', async () => {
    await db.updateUser('user-1', { displayName: 'renamed' })
    assert.equal(await revision(), 0)
  })
})
