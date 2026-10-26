/** Node-operator RPCs used to provision a Moss session issuer. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import * as grpc from '@grpc/grpc-js'
import * as loader from '@grpc/proto-loader'
import protobuf from 'protobufjs'
import { RAFT_TRANSPORT_PROTO, RAFT_COMMANDS_PROTO, CORE_METADATA_PROTO } from '../../node_modules/@nexus-ai-fs/vfs-client/dist/generated/proto.js'

type NodeMethod = 'ListSessionMinters' | 'MintAgent' | 'AllowSessionMinter'
interface INodeResponse {
  success: boolean
  error?: string
  agent_cert_pem?: Buffer
  agent_key_pem?: Buffer
  ca_pem?: Buffer
}
type NodeCall = (request: object, options: grpc.CallOptions,
  callback: (error: grpc.ServiceError | null, response: INodeResponse) => void) => grpc.ClientUnaryCall

/** Connect using the operator's node certificate and the installed daemon schema. */
export function connectNodeAdmin(directory: string, endpoint: string) {
  const root = new protobuf.Root()
  for (const proto of [CORE_METADATA_PROTO, RAFT_COMMANDS_PROTO, RAFT_TRANSPORT_PROTO])
    protobuf.parse(proto, root, { keepCase: true })
  root.resolveAll()
  const definition = grpc.loadPackageDefinition(loader.fromJSON(root.toJSON(), {
    keepCase: true, longs: String, bytes: Buffer,
  })) as unknown as { nexus: { raft: { ZoneApiService: grpc.ServiceClientConstructor } } }
  const client = new definition.nexus.raft.ZoneApiService(endpoint, grpc.credentials.createSsl(
    readFileSync(join(directory, 'ca.pem')), readFileSync(join(directory, 'node-key.pem')),
    readFileSync(join(directory, 'node.pem')),
  ), { 'grpc.ssl_target_name_override': 'nexus-node' }) as unknown as grpc.Client & Record<NodeMethod, NodeCall>
  const rpc = (method: NodeMethod, request: object): Promise<INodeResponse> => new Promise((resolve, reject) => {
    client[method](request, { deadline: Date.now() + 20_000 }, (error, response) => {
      if (error) reject(error)
      else resolve(response)
    })
  })
  return {
    rpc,
    /** The listener can precede the replicated issuer store; readiness uses a read-only RPC. */
    async waitForIssuer(): Promise<void> {
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        const response = await rpc('ListSessionMinters', {})
        if (response.success) return
        assert.equal(response.error, 'this node has no session-mint plane (auth-off)',
          'unexpected issuer readiness failure')
        await delay(100)
      }
      throw new Error('The authenticated session issuer did not become ready')
    },
    close: () => client.close(),
  }
}
