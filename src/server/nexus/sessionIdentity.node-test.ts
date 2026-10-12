import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NexusVfsClient, NexusZoneApiClient, userRuntimeServerName, type SessionCredential } from '@nexus-ai-fs/vfs-client'

import { mintSessionIdentity, renewSessionCredential, ownerField, type SessionIdentity } from './sessionIdentity.js'
import { connectSessionRuntime } from './sessionConnection.js'
import { ManagedAgentClient } from './managedAgentClient.js'

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
  credential: { subjectId: 'session-00000000-0000-0000-0000-000000000000', certPem: Buffer.alloc(0), keyPem: Buffer.alloc(0), caPem: Buffer.alloc(0) },
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

const managedReply = JSON.stringify({ session_id: 'pid-test', durable_session_id: 'history-test',
  session_endpoint: { protocol: 'acp-mailbox/1', channel_id: 'channel-test', agent: 'moss-alice',
    controller: identity.subjectId, transcript: `/conversations/${'a'.repeat(32)}/transcript` } })

void test('delegated execution and file requests never carry the deployment token', async t => {
  const calls: Array<{ method: string; token: string; params?: Record<string, unknown> }> = []
  let isIssuerClosed = false
  const operatorTls = { ca: '/ca.pem', cert: '/operator.pem', key: '/operator-key.pem' }
  t.mock.method(NexusZoneApiClient, 'withMtls', (_endpoint: string, tls: unknown) => {
    assert.equal(tls, operatorTls)
    return {
      mintSessionAgent: async (owner: string) => {
        assert.equal(owner, 'alice')
        return { subjectId: identity.subjectId, caPem: 'session-ca', certPem: 'session-cert', keyPem: 'session-key' }
      },
      close: () => { isIssuerClosed = true },
    }
  })
  t.mock.method(NexusVfsClient, 'withMtls', (_endpoint: string, tls: unknown) => {
    assert.deepEqual(tls, { ca: 'session-ca', cert: 'session-cert', key: 'session-key', serverName: undefined })
    return {
      call: async (method: string, payload: string, token: string) => {
        calls.push({ method, token, params: JSON.parse(payload) as Record<string, unknown> })
        return managedReply
      },
      read: async (_path: string, token: string) => { calls.push({ method: 'read', token }); return Buffer.from('owned-file') },
      close: () => {},
      maintainSessionCredential: (credential: { subjectId: string }, options: { validitySecs: number }) => {
        assert.equal(credential.subjectId, identity.subjectId)
        assert.equal(options.validitySecs, 300)
      },
    }
  })
  const connection = await connectSessionRuntime({ endpoint: 'https://runtime:8444', tls: operatorTls,
    authToken: 'shared-deployment-credential' }, 'alice')
  try {
    assert.equal(isIssuerClosed, true)
    await new ManagedAgentClient(connection.client, connection.authToken).startSession({
      agentId: 'moss-alice', ...ownerField(connection.identity, 'alice'),
    })
    await connection.client.read('/agents/moss-alice/workspaces/session/file.txt', connection.authToken)
    assert.deepEqual(calls.map(call => call.token), ['', ''])
    assert.equal('owner_id' in calls[0]!.params!, false)
  } finally { connection.client.close() }
})

void test('closing a controller cancels its in-flight credential renewal and closes the issuer', async t => {
  const abort = new AbortController()
  let closeCount = 0
  t.mock.method(NexusZoneApiClient, 'withMtls', () => ({
    renewSessionAgent: async (credential: unknown) => {
      assert.equal(credential, identity.credential)
      await new Promise<never>((_resolve, reject) => {
        abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true })
      })
    },
    close: () => { closeCount++ },
  }))
  const promise = renewSessionCredential('https://runtime:8444', { ca: '/ca', cert: '/cert', key: '/key' }, identity.credential, abort.signal)
  const rejected = assert.rejects(promise)
  abort.abort()
  await rejected
  assert.equal(closeCount, 2, 'abort closes the live RPC and finally releases the issuer')
})

void test('user runtime execution and renewal use separate endpoints and credentials', async t => {
  const issuerEndpoint = 'https://issuer:8443'
  const runtimeEndpoint = 'https://alice-runtime:8444'
  const operatorTls = { ca: '/ca.pem', cert: '/operator.pem', key: '/operator-key.pem', serverName: 'issuer' }
  const credential = { subjectId: identity.subjectId, caPem: Buffer.from('session-ca'),
    certPem: Buffer.from('session-cert'), keyPem: Buffer.from('session-key') }
  let issuerConnections = 0
  let issuerCloses = 0
  let runtimeConnections = 0
  let renew: ((current: SessionCredential, signal: AbortSignal) => Promise<SessionCredential>) | undefined
  t.mock.method(NexusZoneApiClient, 'withMtls', (endpoint: string, tls: unknown) => {
    assert.equal(endpoint, issuerEndpoint)
    assert.equal(tls, operatorTls)
    issuerConnections++
    return {
      mintSessionAgent: async (owner: string) => {
        assert.equal(owner, 'alice')
        return credential
      },
      renewSessionAgent: async (current: unknown) => {
        assert.equal(current, credential)
        return { ...credential, certPem: Buffer.from('renewed-session-cert') }
      },
      close: () => { issuerCloses++ },
    }
  })
  t.mock.method(NexusVfsClient, 'withMtls', (endpoint: string, tls: unknown) => {
    assert.equal(endpoint, runtimeEndpoint)
    assert.deepEqual(tls, { ca: credential.caPem, cert: credential.certPem, key: credential.keyPem,
      serverName: userRuntimeServerName('alice') })
    runtimeConnections++
    return {
      maintainSessionCredential: (current: unknown, options: { renew: typeof renew }) => {
        assert.equal(current, credential)
        renew = options.renew
      },
      close: () => {},
    }
  })
  const connection = await connectSessionRuntime({ endpoint: issuerEndpoint, runtimeEndpoint, tls: operatorTls,
    authToken: 'deployment-token' }, 'alice')
  try {
    assert.equal(connection.authToken, '')
    assert.deepEqual(ownerField(connection.identity, 'alice'), {})
    assert.equal((await renew!(credential, new AbortController().signal)).certPem.toString(), 'renewed-session-cert')
    assert.equal(issuerConnections, 2)
    assert.equal(issuerCloses, 2)
    assert.equal(runtimeConnections, 1)
  } finally { connection.client.close() }
})

void test('user runtime placement cannot open an operator or plaintext fallback', async t => {
  t.mock.method(NexusZoneApiClient, 'withMtls', () => { throw new Error('unexpected issuer dial') })
  t.mock.method(NexusVfsClient, 'withMtls', () => { throw new Error('unexpected runtime dial') })
  const config = { endpoint: 'https://issuer:8443', runtimeEndpoint: 'https://runtime:8444', authToken: 'operator-token' }
  const tls = { ca: '/ca.pem', cert: '/operator.pem', key: '/operator-key.pem' }
  await assert.rejects(connectSessionRuntime({ ...config, tls: null }, 'alice'), /authenticated owner/)
  await assert.rejects(connectSessionRuntime({ ...config, tls }, undefined), /authenticated owner/)
  await assert.rejects(connectSessionRuntime({ ...config, tls }, ''), /authenticated owner/)
  await assert.rejects(connectSessionRuntime({ ...config, tls }, 'alice\n'), /owner/i)
})

void test('an already closed controller does not open a credential issuer', async t => {
  const abort = new AbortController()
  abort.abort()
  t.mock.method(NexusZoneApiClient, 'withMtls', () => { throw new Error('unexpected issuer dial') })
  await assert.rejects(renewSessionCredential('https://runtime:8444', { ca: '/ca', cert: '/cert', key: '/key' }, identity.credential, abort.signal), { name: 'AbortError' })
})

void test('a failed owner credential cannot fall back to the operator connection', async t => {
  let connections = 0
  let isIssuerClosed = false
  t.mock.method(NexusZoneApiClient, 'withMtls', () => ({
    mintSessionAgent: async () => { throw new Error('issuer unavailable') },
    close: () => { isIssuerClosed = true },
  }))
  t.mock.method(NexusVfsClient, 'withMtls', () => { connections++; throw new Error('unexpected operator fallback') })
  await assert.rejects(connectSessionRuntime({ endpoint: 'https://runtime:8444', authToken: 'operator-token',
    tls: { ca: '/ca', cert: '/cert', key: '/key' } }, 'alice'), /issuer unavailable/)
  assert.equal(isIssuerClosed, true)
  assert.equal(connections, 0)
})

void test('the plaintext bearer contract retains its token and asserted owner', async t => {
  let sent: { token: string; params: Record<string, unknown> } | undefined
  t.mock.method(NexusVfsClient.prototype, 'call', async (_method: string, payload: string, token: string) => {
    sent = { token, params: JSON.parse(payload) as Record<string, unknown> }
    return managedReply
  })
  const connection = await connectSessionRuntime({ endpoint: 'http://127.0.0.1:1', tls: null,
    authToken: 'existing-bearer-token' }, 'legacy-owner')
  try {
    assert.equal(connection.identity, null)
    await new ManagedAgentClient(connection.client, connection.authToken).startSession({
      agentId: 'legacy-agent', ...ownerField(connection.identity, 'legacy-owner'),
    })
    assert.equal(sent?.token, 'existing-bearer-token')
    assert.equal(sent?.params.owner_id, 'legacy-owner')
  } finally { connection.client.close() }
})

void test('a placed user runtime delegates issuance and renewal to the control plane', async t => {
  const issuerTls = { ca: '/issuer/ca', cert: '/issuer/moss', key: '/issuer/moss-key' }
  const credential = { subjectId: identity.subjectId, caPem: 'root-ca', certPem: 'alice-cert', keyPem: 'alice-key' }
  const issuerEndpoints: string[] = []
  let renewal: ((current: typeof credential, signal: AbortSignal) => Promise<unknown>) | undefined
  t.mock.method(NexusZoneApiClient, 'withMtls', (endpoint: string, tls: unknown) => {
    issuerEndpoints.push(endpoint)
    assert.equal(tls, issuerTls)
    return {
      mintSessionAgent: async (owner: string) => { assert.equal(owner, 'alice'); return credential },
      renewSessionAgent: async (current: unknown) => { assert.equal(current, credential); return credential },
      close() {},
    }
  })
  t.mock.method(NexusVfsClient, 'withMtls', (endpoint: string, tls: unknown) => {
    assert.equal(endpoint, 'https://alice-pod:8443')
    assert.deepEqual(tls, { ca: 'root-ca', cert: 'alice-cert', key: 'alice-key', serverName: userRuntimeServerName('alice') })
    return {
      maintainSessionCredential: (_credential: unknown, options: { renew: typeof renewal }) => { renewal = options.renew },
      close() {},
    }
  })
  const connection = await connectSessionRuntime({ endpoint: 'https://control-plane:8443', tls: issuerTls,
    runtimeEndpoint: 'https://alice-pod:8443', authToken: 'unused-operator-token' }, 'alice')
  try {
    assert.equal(connection.authToken, '')
    assert.ok(renewal)
    await renewal(credential, new AbortController().signal)
    assert.deepEqual(issuerEndpoints, ['https://control-plane:8443', 'https://control-plane:8443'])
  } finally { connection.client.close() }
})

void test('a placed user runtime refuses an unowned connection before opening a transport', async t => {
  let calls = 0
  t.mock.method(NexusVfsClient, 'withMtls', () => { calls++; throw new Error('unexpected fallback') })
  await assert.rejects(connectSessionRuntime({ endpoint: 'https://control-plane:8443', authToken: '',
    runtimeEndpoint: 'https://user-pod:8443', tls: { ca: '/ca', cert: '/cert', key: '/key' } },
  undefined), /authenticated owner/)
  assert.equal(calls, 0)
})
