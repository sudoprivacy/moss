import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentToolsApi } from '../lib/api/agent-tools'

test('tool management separates read-only evidence from review/disable commands and rejects stale-org responses', async () => {
  const calls: { path: string; body?: unknown }[] = []
  const controller = new AbortController()
  const client = { get: async <T>(path: string): Promise<T> => { calls.push({ path }); return { data: [] } as T },
    post: async <T>(path: string, body?: unknown): Promise<T> => { calls.push({ path, body }); return { data: [] } as T } }
  const api = createAgentToolsApi(client, () => controller.signal)
  await api.reviews('server-a'); await api.calls('server-a'); await api.discover('server-a')
  await api.disable('server-a', { resource: 'mcp:server-a/sum', revision: 'r1' } as Parameters<typeof api.disable>[1])
  assert.deepEqual(calls, [
    { path: '/api/v1/admin/mcp-servers/server-a/agent-tools' }, { path: '/api/v1/admin/mcp-servers/server-a/agent-tools/calls' },
    { path: '/api/v1/admin/mcp-servers/server-a/agent-tools/discover', body: {} },
    { path: '/api/v1/admin/mcp-servers/server-a/agent-tools/disable', body: { resource: 'mcp:server-a/sum', expected_revision: 'r1' } },
  ])
  controller.abort(); await assert.rejects(api.calls('server-a'), e => e instanceof Error && e.name === 'AbortError')
})
