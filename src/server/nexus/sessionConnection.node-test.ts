import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, X509Certificate } from 'node:crypto'
import { dirname, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'
import forge from 'node-forge'
import { NexusVfsClient, userRuntimeServerName } from '@nexus-ai-fs/vfs-client'

import { connectSessionRuntime } from './sessionConnection.js'

interface TlsMaterial {
  cert: Buffer
  key: Buffer
}

function keyPair() {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    publicKey: forge.pki.publicKeyFromPem(keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()),
    privateKey: forge.pki.privateKeyFromPem(keys.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()),
  }
}

function testAuthority() {
  const keys = keyPair()
  const certificate = forge.pki.createCertificate()
  certificate.publicKey = keys.publicKey
  certificate.serialNumber = '01'
  certificate.validity.notBefore = new Date(Date.now() - 1000)
  certificate.validity.notAfter = new Date(Date.now() + 3600_000)
  certificate.setSubject([{ name: 'commonName', value: 'session-connection-test-ca' }])
  certificate.setIssuer(certificate.subject.attributes)
  certificate.setExtensions([{ name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true }])
  certificate.sign(keys.privateKey, forge.md.sha256.create())
  const ca = Buffer.from(forge.pki.certificateToPem(certificate))
  let serial = 1
  const issue = (name: string, altNames: Array<{ type: number; value: string }>, validitySecs = 300): TlsMaterial => {
    const leafKeys = keyPair()
    const leaf = forge.pki.createCertificate()
    leaf.publicKey = leafKeys.publicKey
    leaf.serialNumber = (++serial).toString(16).padStart(2, '0')
    leaf.validity.notBefore = new Date(Date.now() - 1000)
    leaf.validity.notAfter = new Date(Date.now() + validitySecs * 1000)
    leaf.setSubject([{ name: 'commonName', value: name }])
    leaf.setIssuer(certificate.subject.attributes)
    leaf.setExtensions([{ name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', clientAuth: true, serverAuth: true },
      { name: 'subjectAltName', altNames }])
    leaf.sign(keys.privateKey, forge.md.sha256.create())
    return { cert: Buffer.from(forge.pki.certificateToPem(leaf)),
      key: Buffer.from(forge.pki.privateKeyToPem(leafKeys.privateKey)) }
  }
  return { ca, issue }
}

// Load the installed official client's own proto files; do not copy its wire contract.
const protoRoot = join(dirname(fileURLToPath(import.meta.resolve('@nexus-ai-fs/vfs-client'))), '../proto')
const definitions = protoLoader.loadSync([
  join(protoRoot, 'nexus/grpc/vfs/vfs.proto'),
  join(protoRoot, 'nexus/raft/transport.proto'),
], { includeDirs: [protoRoot], keepCase: true, longs: String, defaults: true })

async function serve(
  t: TestContext,
  ca: Buffer,
  material: TlsMaterial,
  service: string,
  handlers: grpc.UntypedServiceImplementation,
): Promise<string> {
  const server = new grpc.Server()
  server.addService(definitions[service] as grpc.ServiceDefinition, handlers)
  t.after(() => server.forceShutdown())
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createSsl(ca,
      [{ private_key: material.key, cert_chain: material.cert }], true),
    (error, bound) => error ? reject(error) : resolve(bound))
  })
  return `https://127.0.0.1:${port}`
}

void test('real mTLS separates issuer authority from owner runtime and preserves the target on automatic renewal', { timeout: 30_000 }, async t => {
  const { ca, issue } = testAuthority()
  const operator = issue('operator', [{ type: 6, value: 'nexus://agent/moss' }])
  const issuer = issue('issuer', [{ type: 2, value: 'issuer.test' }])
  const runtime = issue('runtime', [{ type: 2, value: userRuntimeServerName('alice') }])
  const subjectId = `session-${randomUUID()}`
  const altNames = [{ type: 6, value: `nexus://agent/${subjectId}` }, { type: 6, value: 'nexus://owner/alice' }]
  let original: TlsMaterial
  let renewed: TlsMaterial | undefined
  let renewalCount = 0
  let markRenewed: () => void = () => {}
  const renewalReceived = new Promise<void>(resolve => { markRenewed = resolve })
  const reply = (material: TlsMaterial) => ({ success: true, subject_id: subjectId,
    ca_pem: ca, agent_cert_pem: material.cert, agent_key_pem: material.key })
  const issuerEndpoint = await serve(t, ca, issuer, 'nexus.raft.ZoneApiService', {
    MintSessionAgent(call: grpc.ServerUnaryCall<{ owner_id: string }, unknown>, callback: grpc.sendUnaryData<unknown>) {
      assert.equal(call.getAuthContext().sslPeerCertificate?.subject.CN, 'operator')
      assert.equal(call.request.owner_id, 'alice')
      original = issue(subjectId, altNames, 12)
      callback(null, reply(original))
    },
    RenewSessionAgent(call: grpc.ServerUnaryCall<{ proof: Buffer; agent_cert_pem: Buffer }, unknown>, callback: grpc.sendUnaryData<unknown>) {
      assert.equal(call.getAuthContext().sslPeerCertificate?.subject.CN, 'operator')
      assert.ok(call.request.proof.length > 0)
      assert.deepEqual(call.request.agent_cert_pem, original.cert)
      renewed = issue(subjectId, altNames)
      renewalCount++
      callback(null, reply(renewed))
      markRenewed()
    },
  })
  const runtimePeers: Buffer[] = []
  const runtimeEndpoint = await serve(t, ca, runtime, 'nexus.grpc.vfs.NexusVFSService', {
    Read(call: grpc.ServerUnaryCall<{ auth_token: string }, unknown>, callback: grpc.sendUnaryData<unknown>) {
      const peer = call.getAuthContext().sslPeerCertificate!
      assert.equal(peer.subject.CN, subjectId)
      assert.equal(call.request.auth_token, '')
      runtimePeers.push(peer.raw)
      callback(null, { content: Buffer.from('owned runtime bytes') })
    },
  })
  const connection = await connectSessionRuntime({ endpoint: issuerEndpoint, runtimeEndpoint,
    tls: { ca, ...operator, serverName: 'issuer.test' }, authToken: 'operator-deployment-token' }, 'alice')
  t.after(() => connection.client.close())
  assert.equal((await connection.client.read('/agents/a/file', connection.authToken)).toString(), 'owned runtime bytes')
  assert.deepEqual(runtimePeers.at(-1), new X509Certificate(original!.cert).raw)
  await Promise.race([
    renewalReceived,
    setTimeout(15_000, undefined, { ref: false }).then(() => {
      throw new Error(`Issuer did not receive renewal; count=${renewalCount}`)
    }),
  ])
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    await connection.client.read('/agents/a/file', connection.authToken)
    if (runtimePeers.at(-1)!.equals(new X509Certificate(renewed!.cert).raw)) break
    await setTimeout(25)
  }
  assert.equal(renewalCount, 1)
  assert.deepEqual(runtimePeers.at(-1), new X509Certificate(renewed!.cert).raw)
})

void test('a runtime with another owner server name fails the real TLS handshake', { timeout: 45_000 }, async t => {
  const { ca, issue } = testAuthority()
  const operator = issue('operator', [{ type: 6, value: 'nexus://agent/moss' }])
  const issuer = issue('issuer', [{ type: 2, value: 'issuer.test' }])
  const runtime = issue('bob-runtime', [{ type: 2, value: userRuntimeServerName('bob') }])
  const subjectId = `session-${randomUUID()}`
  const delegated = issue(subjectId, [{ type: 6, value: `nexus://agent/${subjectId}` }, { type: 6, value: 'nexus://owner/alice' }])
  const issuerEndpoint = await serve(t, ca, issuer, 'nexus.raft.ZoneApiService', {
    MintSessionAgent(_call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) {
      callback(null, { success: true, subject_id: subjectId, ca_pem: ca,
        agent_cert_pem: delegated.cert, agent_key_pem: delegated.key })
    },
  })
  let runtimeRequests = 0
  const runtimeEndpoint = await serve(t, ca, runtime, 'nexus.grpc.vfs.NexusVFSService', {
    Read(_call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) {
      runtimeRequests++
      callback(null, { content: Buffer.from('wrong owner') })
    },
  })
  const positive = NexusVfsClient.withMtls(runtimeEndpoint,
    { ca, ...delegated, serverName: userRuntimeServerName('bob') })
  t.after(() => positive.close())
  assert.equal((await positive.read('/agents/a/file', '')).toString(), 'wrong owner')
  assert.equal(runtimeRequests, 1, 'The same endpoint and CA must be reachable with its actual server name')
  const connection = await connectSessionRuntime({ endpoint: issuerEndpoint, runtimeEndpoint,
    tls: { ca, ...operator, serverName: 'issuer.test' }, authToken: 'operator-deployment-token' }, 'alice')
  t.after(() => connection.client.close())
  await assert.rejects(connection.client.read('/agents/a/file', connection.authToken), /DEADLINE_EXCEEDED|UNAVAILABLE/)
  assert.equal(runtimeRequests, 1, 'The Alice-target connection must not reach the Bob runtime')
})
