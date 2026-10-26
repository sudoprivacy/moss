import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { authClient, ApiRequestError } from '../lib/api/client'
import { getMossMemberAccess, setMossMemberAccess } from '../lib/api/moss-member-access'

const originalGet = authClient.get
const originalPut = authClient.put
afterEach(() => { authClient.get = originalGet; authClient.put = originalPut })

test('member access reads are uncached, encode the member and carry cancellation', async () => {
  const controller = new AbortController()
  authClient.get = (async (path, options) => {
    assert.equal(path, '/api/v1/moss/member-access/member%2Fone')
    assert.equal(options?.signal, controller.signal)
    assert.equal(options?.cache, 'no-store')
    return { isEnabled: false, source: 'role' }
  }) as typeof authClient.get
  assert.equal((await getMossMemberAccess('member/one', controller.signal)).isEnabled, false)
})

test('grant and revoke use the same member endpoint and preserve server denials', async () => {
  const controller = new AbortController()
  const changes: boolean[] = []
  authClient.put = (async (path, body, options) => {
    assert.equal(path, '/api/v1/moss/member-access/member%2Fone')
    assert.equal(options?.signal, controller.signal)
    changes.push((body as { enabled: boolean }).enabled)
    return { isEnabled: (body as { enabled: boolean }).enabled }
  }) as typeof authClient.put
  assert.equal((await setMossMemberAccess('member/one', true, controller.signal)).isEnabled, true)
  assert.equal((await setMossMemberAccess('member/one', false, controller.signal)).isEnabled, false)
  assert.deepEqual(changes, [true, false])
  authClient.put = async () => { throw new ApiRequestError(403, 'Organization administrator required') }
  await assert.rejects(setMossMemberAccess('member/one', true), error => error instanceof ApiRequestError && error.status === 403)
})
