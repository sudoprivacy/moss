import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mintSessionIdentity, ownerField, type SessionIdentity } from './sessionIdentity.js'

/**
 * Two properties are worth pinning here, and both fail silently otherwise.
 *
 * The first is that minting is skipped, not attempted, when there is nothing
 * to mint with. nexus falls back to the request body for a caller it cannot
 * identify, which is what lets this reach production without a flag day — but
 * only if moss actually reaches that path instead of dialling with no client
 * certificate and failing the spawn.
 *
 * The second is that a proven owner is never also asserted. nexus refuses a
 * body that disagrees with the certificate, so re-adding `owner_id` "for
 * clarity" would refuse every session, and the symptom reads nothing like the
 * cause.
 */

const identity: SessionIdentity = {
  subjectId: 'session-00000000-0000-0000-0000-000000000000',
  tls: { ca: Buffer.alloc(0), cert: Buffer.alloc(0), key: Buffer.alloc(0) },
}

void test('no client certificate means no credential, not a failed spawn', async () => {
  // A plaintext loopback daemon: moss has nothing to present, so there is
  // nobody to mint as. Reaching the daemon anyway would throw.
  assert.equal(await mintSessionIdentity('127.0.0.1:2126', null, 'ethan'), null)
})

void test('no authenticated user means no credential', async () => {
  // A system-initiated session has no person to bind the credential to, and a
  // credential bound to nobody proves nothing.
  const tls = { ca: '/certs/ca.pem', cert: '/certs/moss.pem', key: '/certs/moss-key.pem' }
  assert.equal(await mintSessionIdentity('https://127.0.0.1:8443', tls, undefined), null)
  assert.equal(await mintSessionIdentity('https://127.0.0.1:8443', tls, ''), null)
})

void test('a proven owner is never also asserted', () => {
  assert.deepEqual(ownerField(identity, 'ethan'), {}, 'the certificate decides alone')
})

void test('without a credential the body still carries the owner', () => {
  assert.deepEqual(ownerField(null, 'ethan'), { ownerId: 'ethan' })
  assert.deepEqual(ownerField(null, undefined), {}, 'nothing to say is not the same as empty')
})
