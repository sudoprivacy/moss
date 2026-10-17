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

void test('owner discovery bounds concurrent metadata requests and preserves the durable managed names', { timeout: 5_000 }, async () => {
  const names = Array.from({ length: 24 }, (_, index) => `agent-${index}`)
  let release!: () => void
  const batch = new Promise<void>(resolve => { release = resolve })
  let active = 0, maximum = 0, completed = 0
  const client = {
    async stat(path: string, token: string) {
      assert.equal(token, 'owner-token')
      if (path === '/agents') return { isDirectory: true }
      maximum = Math.max(maximum, ++active)
      if (active === 8) release()
      try {
        await batch
        const name = path.split('/')[2]!
        return Number(name.slice('agent-'.length)) % 2 ? null : { isDirectory: true }
      } finally { active--; completed++ }
    },
    async readdir() { return names.map(name => ({ name })) },
    async call() { return '[]' },
  } as unknown as NexusVfsClient
  const result = await readAgentNamespace(client, 'owner-token', 'alice', true)
  assert(maximum > 1 && maximum <= 8)
  assert.equal(completed, names.length)
  assert.deepEqual(result.managedNames, names.filter((_, index) => index % 2 === 0))
})
