/** Provision Moss as an agent and session minter using the daemon's official RPC schema. */
import fs from 'node:fs'
import path from 'node:path'
import * as grpc from '@grpc/grpc-js'
import * as loader from '@grpc/proto-loader'
import protobuf from 'protobufjs'
import { RAFT_TRANSPORT_PROTO, RAFT_COMMANDS_PROTO, CORE_METADATA_PROTO } from '../../node_modules/@nexus-ai-fs/vfs-client/dist/generated/proto.js'

const directory = process.argv[2]
if (!directory) throw new Error('Nexus data directory required')
const identity = path.join(directory, 'moss-client')
const tls = path.join(directory, 'tls')
const root = new protobuf.Root()
protobuf.parse(CORE_METADATA_PROTO, root, { keepCase: true })
protobuf.parse(RAFT_COMMANDS_PROTO, root, { keepCase: true })
protobuf.parse(RAFT_TRANSPORT_PROTO, root, { keepCase: true })
root.resolveAll()
const definition = grpc.loadPackageDefinition(loader.fromJSON(root.toJSON(), { keepCase: true, longs: String, bytes: Buffer })) as any
const client = new definition.nexus.raft.ZoneApiService('127.0.0.1:2126', grpc.credentials.createSsl(
  fs.readFileSync(path.join(tls, 'ca.pem')), fs.readFileSync(path.join(tls, 'node-key.pem')), fs.readFileSync(path.join(tls, 'node.pem')),
), { 'grpc.ssl_target_name_override': 'nexus-node' })
async function rpc(method: string, request: object): Promise<any> {
  return new Promise((resolve, reject) => client[method](request, { deadline: Date.now() + 30000 }, (error: Error, response: any) => {
    if (error) reject(error)
    else if (!response.success) reject(new Error(method + ' refused: ' + response.error))
    else resolve(response)
  }))
}
try {
  fs.mkdirSync(identity, { recursive: true, mode: 0o700 })
  if (!fs.existsSync(path.join(identity, 'agent.pem'))) {
    const minted = await rpc('MintAgent', { subject_id: 'atlas-moss', display_name: 'Atlas Moss controller', allow_existing: false })
    for (const [name, value] of Object.entries({ 'agent.pem': minted.agent_cert_pem, 'agent-key.pem': minted.agent_key_pem, 'ca.pem': minted.ca_pem })) {
      fs.writeFileSync(path.join(identity, name), value as Buffer, { mode: 0o600 })
    }
  }
  await rpc('AllowSessionMinter', { agent_id: 'atlas-moss' })
  console.log('Moss agent identity and session-minter grant provisioned')
} finally { client.close() }
