import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { scanDiscoverySource, discoveryOrigins, type DiscoverySource } from './inventoryDiscovery.js'

void test('discovery reads actual HTTP pagination, validates tenant scopes and never imports credentials or prompt content', async (t) => {
  let mode = 'valid',
    pages = 0,
    leakedRedirect = 0
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer synthetic-discovery-only')
    const url = new URL(req.url!, 'http://test')
    res.setHeader('content-type', 'application/json')
    if (mode === 'redirect') {
      res.writeHead(302, { location: '/leak' })
      res.end()
      return
    }
    if (url.pathname === '/leak') {
      leakedRedirect++
      res.end('{}')
      return
    }
    if (url.pathname === '/console/api/workspaces') {
      res.end(
        JSON.stringify({ workspaces: [{ id: mode === 'wrong-workspace' ? 'foreign' : 'workspace-a', current: true }] }),
      )
      return
    }
    if (url.pathname === '/console/api/apps') {
      pages++
      const second = url.searchParams.get('page') === '2'
      res.end(
        JSON.stringify({
          data: [
            {
              id: second ? 'app-b' : 'app-a',
              name: 'Synthetic app',
              mode: 'advanced-chat',
              api_key: 'never-save-me',
              prompt: 'private-prompt',
            },
          ],
          has_more: !second,
        }),
      )
      return
    }
    if (url.pathname === '/api/user/self') {
      res.end(JSON.stringify({ success: true, data: { id: 1, username: 'lab' } }))
      return
    }
    if (url.pathname === '/api/log/') {
      assert.equal(url.searchParams.get('username'), 'lab')
      const createdAt = Number(url.searchParams.get('end_timestamp'))
      res.end(
        JSON.stringify({
          success: true,
          data: {
            total: 2,
            items: [1, 2].map((id) => ({
              id,
              token_id: 42,
              user_id: mode === 'wrong-router' ? 2 : 1,
              type: 2,
              created_at: createdAt,
              model_name: `model-${id}`,
              content: 'secret-prompt',
              quota: 200,
            })),
          },
        }),
      )
      return
    }
    if (url.pathname === '/agent-inventory/v1/agents') {
      res.end(
        JSON.stringify({
          api_version: 'agent-inventory.sudo.dev/v1alpha1',
          scope: 'workspace-a',
          items: [
            {
              id: 'saas-a',
              name: 'External SaaS',
              platform: 'saas',
              external_domain: false,
              ...(mode === 'unknown-field' ? { credential: 'forged' } : {}),
            },
          ],
          next_cursor: mode === 'bad-cursor' ? 'wrong' : null,
        }),
      )
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const address = server.address() as { port: number }
  const source: DiscoverySource = {
    id: 'source-a',
    name: 'test',
    kind: 'dify',
    origin: `http://127.0.0.1:${address.port}`,
    scope: 'workspace-a',
    enabled: true,
    external_domain: false,
  }
  const token = 'synthetic-discovery-only'
  const dify = await scanDiscoverySource(source, token)
  assert.equal(pages, 2)
  assert.equal(dify.length, 2)
  assert.equal(dify[0].metadata.owner_user_id, null)
  assert.equal(dify[0].metadata.requested_level, 'L0')
  assert.ok(!JSON.stringify(dify).includes('never-save-me') && !JSON.stringify(dify).includes('private-prompt'))
  mode = 'wrong-workspace'
  await assert.rejects(scanDiscoverySource(source, token), /DISCOVERY_SCOPE_MISMATCH/)
  assert.equal(pages, 2)
  mode = 'valid'
  const router = await scanDiscoverySource({ ...source, kind: 'router', scope: '1' }, token)
  assert.equal(router.length, 1)
  assert.deepEqual(router[0].metadata.model_paths, ['model-1', 'model-2'])
  assert.ok(!JSON.stringify(router).includes('secret-prompt'))
  mode = 'wrong-router'
  await assert.rejects(
    scanDiscoverySource({ ...source, kind: 'router', scope: '1' }, token),
    /DISCOVERY_SCOPE_MISMATCH/,
  )
  mode = 'valid'
  const platform = await scanDiscoverySource({ ...source, kind: 'platform' }, token)
  assert.equal(platform[0].metadata.hosting, 'public_saas')
  assert.equal(platform[0].observation.external_domain, true)
  for (const invalid of ['unknown-field', 'bad-cursor']) {
    mode = invalid
    await assert.rejects(
      scanDiscoverySource({ ...source, kind: 'platform' }, token),
      /DISCOVERY_RESPONSE_INVALID|DISCOVERY_PAGINATION_INVALID/,
    )
  }
  mode = 'redirect'
  await assert.rejects(scanDiscoverySource(source, token))
  assert.equal(leakedRedirect, 0)
})

void test('discovery transport allowlist is organization scoped and disallows credentials, paths and DNS origins', () => {
  const previous = process.env.MOSS_AGENT_DISCOVERY_ORIGINS
  try {
    process.env.MOSS_AGENT_DISCOVERY_ORIGINS = JSON.stringify({ a: ['http://127.0.0.1:12345'] })
    assert.deepEqual(discoveryOrigins('a'), ['http://127.0.0.1:12345'])
    assert.deepEqual(discoveryOrigins('b'), [])
    for (const origin of [
      'http://user:password@127.0.0.1:12345',
      'http://127.0.0.1:12345/v1',
      'https://example.com',
      'file:///tmp/test',
    ]) {
      process.env.MOSS_AGENT_DISCOVERY_ORIGINS = JSON.stringify({ a: [origin] })
      assert.throws(() => discoveryOrigins('a'), /INVALID_DISCOVERY_ORIGIN/)
    }
  } finally {
    if (previous === undefined) delete process.env.MOSS_AGENT_DISCOVERY_ORIGINS
    else process.env.MOSS_AGENT_DISCOVERY_ORIGINS = previous
  }
})
