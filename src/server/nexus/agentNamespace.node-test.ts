import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NexusVfsClient } from '@nexus-ai-fs/vfs-client'
import { readAgentNamespace } from './agentNamespace.js'

void test('native discovery reads the durable names and filters live records to the authenticated owner', async () => {
  const calls: string[] = []
  const client = {
    async stat(path: string, token: string) {
      assert.equal(token, 'owner-token')
      calls.push(path)
      return path === '/agents' || path === '/agents/stopped/sessions' ? { isDirectory: true } : null
    },
    async readdir() { return [{ name: 'stopped' }, { name: 'live' }, { name: '../foreign' }] },
    async call(method: string, payload: string, token: string) {
      assert.equal(method, 'agent_list')
      assert.equal(token, 'owner-token')
      assert.deepEqual(JSON.parse(payload), { owner_id: 'alice' })
      return JSON.stringify({ result: [{ name: 'live', owner_id: 'alice', kind: 'managed', state: 'AWAITING_INPUT' },
        { name: 'foreign', owner_id: 'bob', kind: 'managed', state: 'READY' }] })
    },
  } as unknown as NexusVfsClient
  assert.deepEqual(await readAgentNamespace(client, 'owner-token', 'alice', true), {
    isOwnerConfined: true, names: ['stopped', 'live'], managedNames: ['stopped'],
    executions: [{ name: 'live', ownerId: 'alice', kind: 'managed', state: 'awaiting_input' }],
  })
  assert.ok(!calls.some(path => path.includes('foreign')))
  calls.length = 0
  assert.deepEqual((await readAgentNamespace(client, 'owner-token', 'alice', false)).managedNames, [])
  assert.deepEqual(calls, ['/agents'], 'legacy directory names never grant durable ownership')
})
