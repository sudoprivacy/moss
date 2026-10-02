import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canExtendCredentialExpiry,
  canReadCredentialDestination,
  credentialRouteForScope,
  expiryAlertLevel,
  hasSavedCredentialField,
} from '../lib/credential-list'

const admin = {
  canReadAdminSecrets: true,
  canReadDepartmentSecrets: true,
  canWriteUserSecrets: true,
  canWriteAdminSecrets: true,
}

const departmentReader = {
  canReadAdminSecrets: false,
  canReadDepartmentSecrets: true,
  canWriteUserSecrets: false,
  canWriteAdminSecrets: false,
}

const userWriter = {
  canReadAdminSecrets: false,
  canReadDepartmentSecrets: false,
  canWriteUserSecrets: true,
  canWriteAdminSecrets: false,
}

test('saved credential fields remain saved when metadata redacts their value', () => {
  const entries = [{ key: 'client_secret', value: null }]
  assert.equal(hasSavedCredentialField(entries, 'client_secret'), true)
  assert.equal(hasSavedCredentialField(entries, 'missing'), false)
})

test('credential destinations match their owning scope', () => {
  assert.equal(credentialRouteForScope('system'), '/secrets/enterprise')
  assert.equal(credentialRouteForScope('department'), '/secrets/department')
  assert.equal(credentialRouteForScope('user'), '/secrets/user-credentials')
})

test('credential navigation preserves the existing role spectrum', () => {
  assert.equal(canReadCredentialDestination('system', admin), true)
  assert.equal(canReadCredentialDestination('department', departmentReader), true)
  assert.equal(canReadCredentialDestination('user', departmentReader), false)
  assert.equal(canReadCredentialDestination('user', userWriter), true)
  assert.equal(canReadCredentialDestination('department', userWriter), false)
})

test('only allowed roles can extend credential expiry metadata', () => {
  assert.equal(canExtendCredentialExpiry('system', admin), true)
  assert.equal(canExtendCredentialExpiry('department', departmentReader), false)
  assert.equal(canExtendCredentialExpiry('user', userWriter), true)
  assert.equal(canExtendCredentialExpiry('system', userWriter), false)
})

test('expiry risk uses expired, six-hour urgent, and upcoming boundaries', () => {
  const now = 1_700_000_000_000
  assert.equal(expiryAlertLevel(null, now), 'expired')
  assert.equal(expiryAlertLevel(now, now), 'expired')
  assert.equal(expiryAlertLevel(now + 6 * 60 * 60 * 1000 - 1, now), 'urgent')
  assert.equal(expiryAlertLevel(now + 6 * 60 * 60 * 1000, now), 'upcoming')
})
