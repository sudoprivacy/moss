import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'

import { authClient } from '../lib/api/client'
import {
  createOrganization,
  deleteOrganization,
  ORGANIZATIONS_CHANGED_EVENT,
  updateOrganization,
} from '../lib/api/auth'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalPost = authClient.post
const originalPatch = authClient.patch
const originalDelete = authClient.delete
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
