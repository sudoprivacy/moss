import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { ApiClient, ApiRequestError } from '../lib/api/client'
import { createExternalAgentsApi, type OnboardExternalAgent } from '../lib/api/external-agents'
import { externalAgentError } from '../lib/external-agent-errors'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test('management uses external contract routes with revisions and no client-supplied owner', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  globalThis.fetch = (async (input, init) => {
    calls.push({ path: String(input), body: init?.body ? JSON.parse(String(init.body)) : {} })
    return Response.json({ success: true, data: {} })
  }) as typeof fetch
  const api = createExternalAgentsApi(new ApiClient('http://moss.test'))
  await api.review('agent-a', { approved: true, revision: 3, review_days: 1 })
  await api.review('agent-a', { approved: false, revision: 4 })
  await api.archive('agent-a', 5)
  await api.unknownTasks()
  await api.reconcileTask('task-a', 'Checked provider run without replay.')
  assert.deepEqual(
    calls.map((call) => [call.path, call.body]),
    [
      ['http://moss.test/api/v1/external-agents/agent-a/review', { approved: true, revision: 3, review_days: 1 }],
      ['http://moss.test/api/v1/external-agents/agent-a/review', { approved: false, revision: 4 }],
      ['http://moss.test/api/v1/external-agents/admin/agent-a/archive', { revision: 5 }],
      ['http://moss.test/api/v1/external-agents/admin/unknown-tasks', {}],
      ['http://moss.test/api/v1/external-agents/admin/reconcile-task', { task_id: 'task-a', action: 'close', note: 'Checked provider run without replay.' }],
    ],
  )
})

test('ambiguous onboarding retry preserves the exact request and never implicitly approves', async () => {
  const requests: string[] = []
  globalThis.fetch = (async (_input, init) => {
    requests.push(String(init?.body))
    if (requests.length === 1) throw new Error('connection lost')
    return Response.json({ success: true, data: { approved: false } })
  }) as typeof fetch
  const api = createExternalAgentsApi(new ApiClient('http://moss.test'))
  const draft: OnboardExternalAgent = {
    request_id: 'request-a',
    name: 'Agent',
    endpoint: 'http://127.0.0.1/v1',
    api_key: 'synthetic-test-key',
    app_id: 'app',
    workspace_id: 'workspace',
    source_definition: '{}',
    decoder: 'text',
    allowed_user_ids: ['member'],
    review_days: 7,
    review_note: 'Synthetic fixture',
  }
  await assert.rejects(api.onboard(draft))
  assert.equal((await api.onboard(draft)).approved, false)
  assert.equal(requests[0], requests[1])
  assert.equal(requests.length, 2)
})

test('scope cancellation discards late responses and propagates the signal', async () => {
  const controller = new AbortController()
  let resolve!: (response: Response) => void
  let signal: AbortSignal | null | undefined
  globalThis.fetch = (async (_input, init) => {
    signal = init?.signal
    return new Promise<Response>((done) => {
      resolve = done
    })
  }) as typeof fetch
  const api = createExternalAgentsApi(new ApiClient('http://moss.test'), controller.signal)
  const result = api.list()
  controller.abort()
  resolve(Response.json({ success: true, data: [{ id: 'old-org-agent' }] }))
  await assert.rejects(result, (error) => error instanceof Error && error.name === 'AbortError')
  assert.equal(signal, controller.signal)
})

test('API errors retain server codes without displaying arbitrary provider error text', async () => {
  globalThis.fetch = (async () =>
    Response.json({ success: false, error: { code: 'CONFIGURATION_CHANGED' } }, { status: 409 })) as typeof fetch
  const api = createExternalAgentsApi(new ApiClient('http://moss.test'))
  await assert.rejects(api.archive('agent', 1), (error) => {
    assert.ok(error instanceof ApiRequestError)
    assert.equal(error.code, 'CONFIGURATION_CHANGED')
    assert.match(externalAgentError(error), /刷新/)
    return true
  })
  assert.doesNotMatch(externalAgentError(new Error('sensitive provider response')), /sensitive/)
  assert.match(externalAgentError(new Error('EXECUTION_UNCONFIRMED')), /不要重新发送任务/)
})

test('endpoint workflow submits only address and reason; grant and review send policy revision', async () => {
  const calls: Array<{ path: string; body: unknown }> = []
  const api = createExternalAgentsApi({
    async get<T>(path: string) { calls.push({ path, body: null }); return { success: true, data: {} } as T },
    async post<T>(path: string, body?: unknown) { calls.push({ path, body }); return { success: true, data: {} } as T },
  })
  await api.requestEndpoint({ endpoint: 'http://127.0.0.2/v1', reason: 'Team API' })
  await api.approveEndpoint({ endpoint: 'http://127.0.0.2/v1', note: 'Reviewed', policy_revision: 4 })
  await api.reviewEndpoint({ id: 'request-a', revision: 1, policy_revision: 5, approved: false, note: 'Owner not verified' })
  await api.endpointRequests('cursor-a')
  assert.deepEqual(calls, [
    { path: '/api/v1/external-agents/admin/endpoint-requests', body: { endpoint: 'http://127.0.0.2/v1', reason: 'Team API' } },
    { path: '/api/v1/external-agents/admin/endpoints/approve', body: { endpoint: 'http://127.0.0.2/v1', note: 'Reviewed', policy_revision: 4 } },
    { path: '/api/v1/external-agents/admin/endpoint-requests/review', body: { id: 'request-a', revision: 1, policy_revision: 5, approved: false, note: 'Owner not verified' } },
    { path: '/api/v1/external-agents/admin/endpoint-requests?after=cursor-a', body: null },
  ])
})
