// Runs under Node (AuthCenterDb uses node:sqlite, which Bun lacks): `tsx --test`.
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { AuthCenterDb } from '../authCenter/db.js'
import { AuthService } from '../auth/service.js'
import { importPhoneUsers, parsePhoneImportRequest } from '../auth/phoneImport.js'
import { resolveSessionApiKey } from '../backends/backendUtils.js'

let db: AuthCenterDb
let raw: DatabaseSync
let auth: AuthService

beforeEach(() => {
  raw = new DatabaseSync(':memory:')
  db = new AuthCenterDb(raw, ':memory:')
  auth = new AuthService(db, 3600)
})

afterEach(() => {
  auth.destroy()
  raw.close()
})

const ALICE = { phone: '13800138001', nickname: 'Alice', group: '9', sudorouterKey: 'sk-alice' }
const BOB = { phone: '13800138002', nickname: 'Bob', group: '9', sudorouterKey: 'sk-bob' }
const SOLO = { phone: '13800138003', nickname: 'Solo', group: '21', sudorouterKey: 'sk-solo' }

describe('phone import', () => {
  it('groups users by their source grouping key, and a group of one is just an org of one', () => {
    const result = importPhoneUsers(auth, {
      users: [ALICE, BOB, SOLO],
      groupNames: { '9': 'Acme', '21': 'Solo Consulting' },
    })

    assert.equal(result.summary.created, 3)
    assert.equal(result.summary.organizationsCreated, 2)

    const [alice, bob, solo] = result.rows
    assert.equal(alice?.orgId, bob?.orgId, 'same source group must land in one org')
    assert.notEqual(solo?.orgId, alice?.orgId)

    // The one-person case needs no special handling: it is an ordinary org that
    // happens to hold one member, so merging or splitting later is a membership
    // change rather than another migration.
    assert.equal(db.listUsersByOrg(solo!.orgId!).length, 1)
    assert.equal(auth.findOrganizationByName('Solo Consulting')?.id, solo?.orgId)
  })

  it('rehearses without writing: a dry run reports what the real run then does', () => {
    const request = { users: [ALICE, BOB], groupNames: { '9': 'Acme' } }

    const rehearsal = importPhoneUsers(auth, { ...request, dryRun: true })
    assert.equal(rehearsal.dryRun, true)
    assert.equal(rehearsal.summary.created, 2)
    assert.equal(rehearsal.summary.organizationsCreated, 1)

    // Nothing survived the rehearsal — neither the users nor the org it created.
    assert.equal(db.getUserByPhone(ALICE.phone), null)
    assert.equal(auth.findOrganizationByName('Acme'), null)

    const real = importPhoneUsers(auth, request)
    assert.deepEqual(real.summary, { ...rehearsal.summary })
    assert.notEqual(db.getUserByPhone(ALICE.phone), null)
  })

  it('is re-runnable: a second pass creates nothing and reports the accounts as already present', () => {
    importPhoneUsers(auth, { users: [ALICE, BOB], groupNames: { '9': 'Acme' } })
    const second = importPhoneUsers(auth, { users: [ALICE, BOB], groupNames: { '9': 'Acme' } })

    assert.equal(second.summary.created, 0)
    assert.equal(second.summary.existing, 2)
    assert.equal(second.summary.organizationsCreated, 0, 'the org must be reused, not duplicated')
    assert.equal(db.listOrganizations().filter(o => o.name === 'Acme').length, 1)
  })

  it('fails a bad row on its own without taking the batch down with it', () => {
    const result = importPhoneUsers(auth, {
      users: [ALICE, { phone: 'sudo', nickname: 'not a phone' }, BOB],
      groupNames: { '9': 'Acme' },
    })

    assert.equal(result.summary.created, 2)
    assert.equal(result.summary.error, 1)
    // Echoed as supplied, so the operator can find the offending line in the source.
    const failed = result.rows.find(r => r.outcome === 'error')
    assert.equal(failed?.phone, 'sudo')
    assert.notEqual(db.getUserByPhone(BOB.phone), null, 'rows after the bad one still import')
  })

  it('attaches a gateway token to someone who signed up before migration reached them', () => {
    // They registered themselves in the meantime, so they exist but are still
    // spending the shared server key — their carried-over balance would never move.
    auth.provisionPhoneUser({ phone: ALICE.phone, nickname: 'Alice', autoCreateOrg: true })
    assert.equal(auth.getUserModelCredential(db.getUserByPhone(ALICE.phone)!.id), null)

    const result = importPhoneUsers(auth, { users: [ALICE], groupNames: { '9': 'Acme' } })

    assert.equal(result.summary.linked, 1)
    assert.equal(result.summary.created, 0)
    const user = db.getUserByPhone(ALICE.phone)!
    assert.equal(auth.getUserModelCredential(user.id)?.sudorouterKey, 'sk-alice')
  })

  it('never lets a gateway token reach a user-facing payload', () => {
    importPhoneUsers(auth, { users: [ALICE], groupNames: { '9': 'Acme' } })
    const user = db.getUserByPhone(ALICE.phone)!

    const listed = auth.listUsers(user.orgId)

    assert.match(JSON.stringify(listed), /Alice/, 'sanity: this payload does describe the user')
    assert.doesNotMatch(
      JSON.stringify(listed),
      /sk-alice/,
      'the token is stored off the mapped user type precisely so it cannot appear here',
    )
  })

  it('rejects a malformed request body before touching the database', () => {
    assert.throws(() => parsePhoneImportRequest({ users: [] }), /Invalid import request/)
    assert.throws(() => parsePhoneImportRequest({ users: [{ nickname: 'no phone' }] }), /phone/)
    const ok = parsePhoneImportRequest({ users: [{ phone: ALICE.phone }], dryRun: true })
    assert.equal(ok.users.length, 1)
  })
})

describe('session model key precedence', () => {
  it('spends the injected key rather than the shared server key', () => {
    // The regression this guards: the runner used to prefer its own settings
    // value, which is always the shared key, so a per-user token resolved by the
    // main process was silently discarded and every user billed one account.
    assert.equal(
      resolveSessionApiKey({ ANTHROPIC_API_KEY: 'sk-user' }, 'sk-shared'),
      'sk-user',
    )
    assert.equal(
      resolveSessionApiKey({ ANTHROPIC_AUTH_TOKEN: 'sk-user' }, 'sk-shared'),
      'sk-user',
    )
  })

  it('falls back to settings for spawn paths that inject nothing', () => {
    assert.equal(resolveSessionApiKey({}, 'sk-shared'), 'sk-shared')
    assert.equal(resolveSessionApiKey({}, undefined), undefined)
  })
})
