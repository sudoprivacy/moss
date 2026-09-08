import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  IdentityMergePlanner,
  type LegacyIdentitySnapshot,
  type TargetIdentitySnapshot,
} from './identityMergePlanner.js'

const source: LegacyIdentitySnapshot = {
  organizations: [
    { legacyId: 7, name: '旧企业', code: 'ACME', codeVerified: true },
  ],
  users: [
    {
      legacyId: 17,
      enterpriseId: 7,
      username: 'alice',
      displayName: 'Alice',
      phone: '13800000000',
      phoneVerified: true,
      email: 'alice@example.test',
      emailVerified: true,
      passwordHash: '$2b$10$legacy',
      role: 'USER',
      status: 'ACTIVE',
      providerIdentity: { provider: 'cas', issuer: 'corp', subject: 'alice-cas' },
    },
  ],
}

function target(overrides: Partial<TargetIdentitySnapshot> = {}): TargetIdentitySnapshot {
  return {
    organizations: [{ id: 'org-a', code: 'ACME', codeVerified: true }],
    users: [{
      id: 'user-a', orgId: 'org-a', email: 'alice@example.test', emailVerified: true,
      phone: '13800000000', phoneVerified: true,
      providerIdentities: [{ provider: 'cas', issuer: 'corp', subject: 'alice-cas' }],
    }],
    ...overrides,
  }
}

describe('IdentityMergePlanner', () => {
  test('matches organizations by verified code and users by provider before phone or email', () => {
    const plan = new IdentityMergePlanner(target()).plan(source, [])
    assert.equal(plan.status, 'ready')
    assert.deepEqual(plan.organizations[0], {
      legacyId: 7, action: 'reuse', targetId: 'org-a', matchedBy: 'verified_code',
    })
    assert.deepEqual(plan.users[0], {
      legacyId: 17, enterpriseId: 7, action: 'reuse', targetId: 'user-a', targetOrgId: 'org-a', matchedBy: 'provider',
    })
  })

  test('falls back to unique verified phone and then unique verified email', () => {
    const phonePlan = new IdentityMergePlanner(target({
      users: [{
        id: 'user-phone', orgId: 'org-a', email: 'other@example.test', emailVerified: true,
        phone: '13800000000', phoneVerified: true, providerIdentities: [],
      }],
    })).plan(source, [])
    assert.equal(phonePlan.users[0].matchedBy, 'verified_phone')

    const emailPlan = new IdentityMergePlanner(target({
      users: [{
        id: 'user-email', orgId: 'org-a', email: 'alice@example.test', emailVerified: true,
        phone: null, phoneVerified: false, providerIdentities: [],
      }],
    })).plan(source, [])
    assert.equal(emailPlan.users[0].matchedBy, 'verified_email')
  })

  test('never uses organization names, usernames, or display names as identity keys', () => {
    const plan = new IdentityMergePlanner({
      organizations: [{ id: 'org-same-name', code: 'OTHER', codeVerified: true, name: '旧企业' }],
      users: [{
        id: 'user-same-name', orgId: 'org-same-name', email: null, emailVerified: false,
        phone: null, phoneVerified: false, username: 'alice', displayName: 'Alice', providerIdentities: [],
      }],
    }).plan(source, [])
    assert.equal(plan.status, 'ready')
    assert.equal(plan.organizations[0].action, 'create')
    assert.equal(plan.users[0].action, 'create')
    assert.match(plan.organizations[0].targetId!, /^[0-9a-f-]{36}$/)
    assert.match(plan.users[0].targetId!, /^[0-9a-f-]{36}$/)
    assert.equal(plan.users[0].targetOrgId, plan.organizations[0].targetId)
    assert.deepEqual(new IdentityMergePlanner({ organizations: [], users: [] }).plan(source, []),
      new IdentityMergePlanner({ organizations: [], users: [] }).plan(source, []))
  })

  test('blocks ambiguous verified identifiers and cross-organization provider matches', () => {
    const ambiguous = new IdentityMergePlanner(target({
      users: [
        { id: 'u1', orgId: 'org-a', email: null, emailVerified: false, phone: '13800000000', phoneVerified: true, providerIdentities: [] },
        { id: 'u2', orgId: 'org-a', email: null, emailVerified: false, phone: '13800000000', phoneVerified: true, providerIdentities: [] },
      ],
    })).plan(source, [])
    assert.equal(ambiguous.status, 'blocked')
    assert(ambiguous.issues.some(issue => issue.code === 'AMBIGUOUS_VERIFIED_PHONE'))

    const crossOrg = new IdentityMergePlanner(target({
      organizations: [{ id: 'org-a', code: 'ACME', codeVerified: true }, { id: 'org-b', code: 'BETA', codeVerified: true }],
      users: [{
        id: 'user-b', orgId: 'org-b', email: null, emailVerified: false,
        phone: null, phoneVerified: false,
        providerIdentities: [{ provider: 'cas', issuer: 'corp', subject: 'alice-cas' }],
      }],
    })).plan(source, [])
    assert.equal(crossOrg.status, 'blocked')
    assert(crossOrg.issues.some(issue => issue.code === 'CROSS_ORGANIZATION_IDENTITY'))
  })

  test('uses explicit reviewed resolutions and rejects unknown targets', () => {
    const resolved = new IdentityMergePlanner(target()).plan(source, [
      { kind: 'organization', sourceId: '7', targetId: 'org-a' },
      { kind: 'user', sourceId: '17', targetId: 'user-a' },
    ])
    assert.equal(resolved.organizations[0].matchedBy, 'explicit')
    assert.equal(resolved.users[0].matchedBy, 'explicit')

    const invalid = new IdentityMergePlanner(target()).plan(source, [
      { kind: 'organization', sourceId: '7', targetId: 'missing' },
    ])
    assert.equal(invalid.status, 'blocked')
    assert(invalid.issues.some(issue => issue.code === 'INVALID_MANUAL_RESOLUTION'))
  })

  test('恢复和重跑优先复用迁移已建立的永久数字别名', () => {
    const plan = new IdentityMergePlanner({
      organizations: [{ id: 'org-a', code: '', codeVerified: false, legacyAlias: 7 }],
      users: [{
        id: 'user-a', orgId: 'org-a', email: 'alice@example.test', emailVerified: false,
        phone: null, phoneVerified: false, legacyAlias: 17, providerIdentities: [],
      }],
    }).plan(source, [])

    assert.equal(plan.status, 'ready')
    assert.equal(plan.organizations[0].matchedBy, 'legacy_alias')
    assert.equal(plan.users[0].matchedBy, 'legacy_alias')
    assert.equal(plan.users[0].targetOrgId, 'org-a')
  })

  test('blocks reuse when an already exposed numeric alias differs from the legacy id', () => {
    const plan = new IdentityMergePlanner(target({
      organizations: [{ id: 'org-a', code: 'ACME', codeVerified: true, legacyAlias: 99 }],
      users: [{
        id: 'user-a', orgId: 'org-a', email: 'alice@example.test', emailVerified: true,
        phone: '13800000000', phoneVerified: true, legacyAlias: 88,
        providerIdentities: [{ provider: 'cas', issuer: 'corp', subject: 'alice-cas' }],
      }],
    })).plan(source, [])

    assert.equal(plan.status, 'blocked')
    assert(plan.issues.some(issue => issue.code === 'NUMERIC_ALIAS_CONFLICT' && issue.resourceType === 'organization'))
    assert(plan.issues.some(issue => issue.code === 'NUMERIC_ALIAS_CONFLICT' && issue.resourceType === 'user'))
  })
})
