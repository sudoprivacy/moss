import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { authClient, ApiRequestError } from '../lib/api/client'
import { bindMossIm, getMossImBindings, getMyMossAgent, unlinkMossIm } from '../lib/api/moss-im'

const original = { get: authClient.get, post: authClient.post, delete: authClient.delete }
afterEach(() => Object.assign(authClient, original))

test('own Agent and binding reads are uncached and canceled with the current scope', async () => {
  const controller = new AbortController()
  const paths: string[] = []
  authClient.get = (async (path, options) => {
    paths.push(path)
    assert.equal(options?.signal, controller.signal)
    assert.equal(options?.cache, 'no-store')
    return path.endsWith('/agent') ? { ownerId: 'alice', orgId: 'org-a', agentName: 'moss-qa' } : { bindings: [] }
  }) as typeof authClient.get
  assert.equal((await getMyMossAgent(controller.signal)).ownerId, 'alice')
  assert.deepEqual(await getMossImBindings(controller.signal), { bindings: [] })
  assert.deepEqual(paths, ['/api/v1/moss/agent', '/api/v1/moss/im/bindings'])
})

test('binding posts only the private proof; unlink encodes the self binding and rejects server denials', async () => {
  const controller = new AbortController()
  authClient.post = (async (path, body, options) => {
    assert.equal(path, '/api/v1/moss/im/bind')
    assert.deepEqual(body, { code: 'qa-private-proof' })
    assert.equal(options?.signal, controller.signal)
    return { success: true }
  }) as typeof authClient.post
  authClient.delete = (async path => {
    assert.equal(path, '/api/v1/moss/im/bindings/self%2Fbinding')
    throw new ApiRequestError(404, 'Binding not available')
  }) as typeof authClient.delete
  assert.deepEqual(await bindMossIm('qa-private-proof', controller.signal), { success: true })
  await assert.rejects(unlinkMossIm('self/binding'), error => error instanceof ApiRequestError && error.status === 404)
})
