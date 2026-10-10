/** Mount an operator-configured model without putting its credential in Raft. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'

const [endpoint, tls, baseUrl, storage, frontDoor] = process.argv.slice(2)
assert(endpoint && tls && baseUrl && storage, 'endpoint, TLS directory, provider URL and storage are required')
const proto = join(process.cwd(), 'node_modules/@nexus-ai-fs/vfs-client/proto')
const definitions = grpc.loadPackageDefinition(protoLoader.loadSync([
  join(proto, 'nexus/raft/transport.proto'), join(proto, 'nexus/grpc/vfs/vfs.proto'),
], { keepCase: true, longs: String, defaults: true, includeDirs: [proto] })) as any
const credentials = grpc.credentials.createSsl(
  readFileSync(join(tls, 'ca.pem')), readFileSync(join(tls, 'node-key.pem')), readFileSync(join(tls, 'node.pem')),
)
const options = { 'grpc.ssl_target_name_override': 'nexus-node', 'grpc.default_authority': 'nexus-node' }
const vfs = new definitions.nexus.grpc.vfs.NexusVFSService(endpoint, credentials, options)
const node = new definitions.nexus.raft.ZoneApiService(endpoint, credentials, options)
const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
  node[method](params, new grpc.Metadata(), { deadline: Date.now() + 25_000 }, (error: Error | null, value: any) => error ? reject(error) : resolve(value))
})
try {
  await new Promise<void>((resolve, reject) => vfs.waitForReady(Date.now() + 60_000, (error: Error | undefined) => error ? reject(error) : resolve()))
  if (frontDoor && !existsSync(join(frontDoor, 'agent-key.pem'))) {
    const subject = `moss-front-door-${randomUUID()}`
    const identity = await rpc('mintAgent', { subject_id: subject, display_name: subject })
    assert.equal(identity.success, true)
    assert.equal((await rpc('allowSessionMinter', { agent_id: subject })).success, true)
    mkdirSync(frontDoor, { recursive: true, mode: 0o700 })
    for (const [name, content] of [['ca.pem', identity.ca_pem], ['agent.pem', identity.agent_cert_pem], ['agent-key.pem', identity.agent_key_pem]]) {
      writeFileSync(join(frontDoor, name), content, { mode: 0o600 })
    }
  }
  await new Promise<void>((resolve, reject) => vfs.setattr({
    path: '/model', entry_type: 2, backend_type: 'anthropic', backend_name: 'controlled-model', zone_id: 'model',
    backend_params: { base_url: baseUrl.replace(/\/+$/, '').replace(/\/v1$/, ''), blob_root: storage },
  }, new grpc.Metadata(), { deadline: Date.now() + 30_000 }, (error: Error | null) => error ? reject(error) : resolve()))
  console.log(JSON.stringify({ mounted: '/model', credentials_in_mount_parameters: false }))
} finally {
  vfs.close()
  node.close()
}
