import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyWorkspaceProof } from './workspace-proof.mjs'

test('a fresh workspace proof is written and read through the authenticated file API', async () => {
  const headers = { authorization: 'Bearer fixture-owner' }
  let content
  const calls = []
  const proof = await verifyWorkspaceProof(async (path, init) => {
    calls.push({ path, method: init.method ?? 'GET' })
    assert.equal(init.headers, headers)
    if (init.method === 'POST') {
      const body = JSON.parse(init.body)
      content = Buffer.from(body.content_base64, 'base64').toString()
      return {}
    }
    return { content }
  }, 'original-session', headers)
  assert.equal(proof.content, content)
  assert.deepEqual(calls.map(row => row.method), ['POST', 'GET'])
  assert.ok(calls.every(row => row.path.startsWith('/api/v1/sessions/original-session/workspace/file')))
})

for (const content of ['original bytes', 'corrupted bytes', undefined]) {
  test(`resume checks retained workspace bytes without seeding over ${content ?? 'a missing file'}`, async () => {
    const previous = { path: 'moss-e2e-persist-a1.txt', content: 'original bytes' }
    let reads = 0
    const result = verifyWorkspaceProof(async (_path, init) => {
      assert.equal(init.method, undefined, 'Resume must never repair its own evidence')
      reads++
      return { content }
    }, 'original-session', {}, previous)
    if (content === previous.content) assert.equal(await result, previous)
    else await assert.rejects(result, /Restored workspace file differs/)
    assert.equal(reads, 1)
  })
}
