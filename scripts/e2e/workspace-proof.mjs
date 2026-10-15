import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

/** Verify restored bytes without rewriting them; seed only the initial fixture. */
export async function verifyWorkspaceProof(request, sessionId, headers, previous) {
  const endpoint = `/api/v1/sessions/${encodeURIComponent(sessionId)}/workspace/file`
  const proof = previous ?? { path: `moss-e2e-persist-${randomUUID()}.txt`, content: `MOSS_WORKSPACE_${randomUUID()}\n` }
  assert.equal(typeof proof.path, 'string', 'Retained workspace proof needs a path')
  assert.match(proof.path, /^moss-e2e-persist-[a-f0-9-]+\.txt$/)
  assert.equal(typeof proof.content, 'string', 'Retained workspace proof needs expected bytes')
  assert.ok(proof.content.length > 0, 'Workspace proof cannot be empty')
  if (previous === undefined) {
    await request(endpoint, { method: 'POST', headers,
      body: JSON.stringify({ path: proof.path, content_base64: Buffer.from(proof.content).toString('base64') }) })
  }
  const actual = await request(`${endpoint}?path=${encodeURIComponent(proof.path)}`, { headers })
  assert.equal(actual.content, proof.content, 'Restored workspace file differs from its original bytes')
  return proof
}
