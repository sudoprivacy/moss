import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NexusAcpTransport } from './nexusAcpTransport.js'
import { ManagedAgentClient } from '../nexus/managedAgentClient.js'
import type { NexusVfsClient } from '@nexus-ai-fs/vfs-client'

const endpoint = {protocol: 'acp-mailbox/1', channel_id: 'generation', agent: 'worker', controller: 'operator',
  transcript: '/conversations/0123456789abcdef0123456789abcdef/transcript'} as const

for (const spawnSpec of [undefined, {cmd: 'scode', args: ['acp'], env: {}, cwd: '/workspace'}]) {
  void test(`both hosting modes use one mailbox (${spawnSpec ? 'subprocess' : 'cohost'})`, async () => {
    const calls: any[] = []
    const writes: any[] = []
    let closes = 0
    const client = {
      async call(method: string, body: string, auth: string) {
        assert.equal(auth, 'controller-token')
        calls.push({method, body: JSON.parse(body)})
        return JSON.stringify({result: method.includes('start_session') ? {session_id: 'pid', session_endpoint: endpoint} : {cancelled: true}})
      },
      async streamReadAt(_path: string, offset: string) {
        await new Promise(resolve => setTimeout(resolve, 5))
        return {data: Buffer.alloc(0), nextOffset: offset, timedOut: true, eof: false}
      },
      async streamWrite(path: string, bytes: Buffer, auth: string) {
        assert.equal(auth, 'controller-token')
        writes.push({path, envelope: JSON.parse(bytes.toString())})
      },
      close() { closes++ },
    }
    const agent = new ManagedAgentClient(client as unknown as NexusVfsClient, 'controller-token')
    const session = await agent.startSession({agentId: 'worker', spawnSpec})
    const transport = new NexusAcpTransport(agent, session)
    transport.start({onMessage() {}, onStderr() {}, onClose() {}})
    await transport.send({jsonrpc: '2.0', id: 0, result: {outcome: {outcome: 'selected', optionId: 'allow_once'}}})
    await transport.close()
    await transport.close()
    assert.equal(writes.length, 2)
    assert(writes.every(write => write.path === endpoint.transcript))
    assert.equal(JSON.parse(writes[0].envelope.body).message.id, 0)
    assert.equal(calls.filter(call => call.method.includes('cancel')).length, 1)
    assert.equal(closes, 1)
  })
}

void test('an old daemon is rejected and the just-created process is reaped', async () => {
  const calls: string[] = []
  const agent = new ManagedAgentClient({async call(method: string) {
    calls.push(method)
    return JSON.stringify({result: {session_id: 'pid'}})
  }} as unknown as NexusVfsClient, '')
  await assert.rejects(agent.startSession({agentId: 'worker'}), /does not support acp-mailbox/)
  assert.deepEqual(calls, ['managed_agent.start_session_v1', 'managed_agent.cancel_v1'])
})
