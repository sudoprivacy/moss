import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'

import { authClient } from '../lib/api/client'
import {
  createOrganization,
  deleteOrganization,
  ORGANIZATIONS_CHANGED_EVENT,
  updateOrganization,
  addOrganizationMember,
  getAccountOrganizations,
  switchOrg,
} from '../lib/api/auth'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalPost = authClient.post
const originalPatch = authClient.patch
const originalDelete = authClient.delete
const originalGet = authClient.get
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
let changes = 0

beforeEach(() => {
  changes = 0
  const events = new EventTarget()
  events.addEventListener(ORGANIZATIONS_CHANGED_EVENT, () => { changes++ })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events })
})

afterEach(() => {
  authClient.post = originalPost
  authClient.patch = originalPatch
  authClient.delete = originalDelete
  authClient.get = originalGet
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

test('refreshes organization consumers only after each mutation succeeds', async () => {
  const response = { organization: { id: 'test-org', name: 'Renamed' } }
  let finishCreate!: (value: typeof response) => void
  authClient.post = (() => new Promise(resolve => { finishCreate = resolve })) as typeof authClient.post
  authClient.patch = (async () => response) as typeof authClient.patch
  authClient.delete = (async () => ({ ok: true })) as typeof authClient.delete

  const creating = createOrganization({ name: 'Test' })
  assert.equal(changes, 0)
  finishCreate(response)
  assert.equal(await creating, response)
  assert.equal(changes, 1)
  assert.equal(await updateOrganization('test-org', { name: 'Renamed' }), response)
  assert.equal(changes, 2)
  assert.deepEqual(await deleteOrganization('test-org'), { ok: true })
  assert.equal(changes, 3)
})

test('failed organization mutations do not announce a changed list', async () => {
  const reject = async () => { throw new Error('Organization mutation rejected') }
  authClient.post = reject
  authClient.patch = reject
  authClient.delete = reject

  await assert.rejects(createOrganization({ name: 'Test' }), /mutation rejected/)
  await assert.rejects(updateOrganization('test-org', { name: 'Renamed' }), /mutation rejected/)
  await assert.rejects(deleteOrganization('test-org'), /mutation rejected/)
  assert.equal(changes, 0)
})

test('organization creation preserves the idempotency key and refresh notification', async () => {
  const payload = { name: 'Shared billing' }
  authClient.post = (async (path, body, options) => {
    assert.equal(path, '/api/v1/organizations')
    assert.deepEqual(body, payload)
    assert.deepEqual(options?.headers, { 'Idempotency-Key': 'create-shared-org' })
    return { organization: { id: 'shared-org', name: payload.name } }
  }) as typeof authClient.post
  await createOrganization(payload, 'create-shared-org')
  assert.equal(changes, 1)
})

test('available enterprises come from the human account endpoint rather than global organization administration', async () => {
  const result = { organizations: [{ id: 'company', name: 'Company', userId: 'company-member', role: 'user' }] }
  authClient.get = (async path => { assert.equal(path, '/api/v1/auth/organizations'); return result }) as typeof authClient.get
  assert.deepEqual(await getAccountOrganizations(), result)
})

test('adding an existing account sends only the phone and leaves role and Moss access to the administrator', async () => {
  authClient.post = (async (path, body) => {
    assert.equal(path, '/api/v1/users/memberships')
    assert.deepEqual(body, { phone: '13900000001' })
    return { user: { id: 'company-member', role: 'user' }, created: true }
  }) as typeof authClient.post
  const result = await addOrganizationMember(' 13900000001 ')
  assert.equal(result.created, true)
  assert.equal(result.user.role, 'user')
})

test('successful enterprise selection replaces both tokens; rejected selection preserves the original session', async () => {
  const storage = new Map([['moss_access_token', 'original-access'], ['moss_refresh_token', 'original-refresh']])
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    setItem: (key: string, value: string) => storage.set(key, String(value)),
    getItem: (key: string) => storage.get(key) ?? null,
  } })
  authClient.post = (async () => { throw new Error('Membership is unavailable') }) as typeof authClient.post
  await assert.rejects(switchOrg('foreign'), /Membership is unavailable/)
  assert.equal(storage.get('moss_access_token'), 'original-access')
  assert.equal(storage.get('moss_refresh_token'), 'original-refresh')
  authClient.post = (async (path, body) => {
    assert.equal(path, '/api/v1/auth/switch-org')
    assert.deepEqual(body, { org_id: 'company' })
    return { access_token: 'company-access', refresh_token: 'company-refresh', expires_in: 3600 }
  }) as typeof authClient.post
  await switchOrg('company')
  assert.equal(storage.get('moss_access_token'), 'company-access')
  assert.equal(storage.get('moss_refresh_token'), 'company-refresh')
})
