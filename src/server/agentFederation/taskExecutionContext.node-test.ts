import assert from 'node:assert/strict'
import { test } from 'node:test'
import { taskExecutionHeaders, readTaskExecutionContext, assertNoTaskCredential, CONTEXT_HEADER, TOKEN_HEADER } from './taskExecutionContext.js'
import type { CustomAgentManifest, TaskGrantProfile, TaskExecutionContext } from '../../../contracts/agent-federation/v1alpha1/contract.js'
import type { ProviderInvocation } from './adapter.js'
import { parseCustomManifest } from './manifest.js'
import { startProtocolReference } from '../testing/standardProtocolReference.js'

const profile: TaskGrantProfile = { profile: 'sudo-task-grant/v1', model_resource: 'model:lab', tool_resources: ['mcp:server/add_numbers'], max_model_calls: 2 }
function fixture() {
  const context: TaskExecutionContext = { ...profile, task_id: 'task-a', attempt_id: 'attempt-a', session_id: 'session-a', org_id: 'org-a',
    grant_id: 'grant-a', spec_digest: 'sha256:' + 'a'.repeat(64), expires_at: Date.now() + 60000,
    model_gateway: 'https://moss.example/api/v1/agent-models/org-a/invoke', tool_gateway: 'https://moss.example/api/v1/agent-tools/org-a/invoke', access_token: 'sk-synthetic-task-only' }
  const input = { ...context, execution_context: async () => context } as unknown as ProviderInvocation
  return { context, input, manifest: { execution_context: profile } as CustomAgentManifest }
}
void test('task header is opt-in, bounded, scoped and separate from provider connection auth and metadata', async () => {
  const f = fixture(), headers = await taskExecutionHeaders(f.manifest, f.input)
  assert.equal(headers[TOKEN_HEADER], f.context.access_token)
  assert(!Buffer.from(headers[CONTEXT_HEADER], 'base64url').toString().includes(f.context.access_token))
  assert.deepEqual(readTaskExecutionContext(new Headers(headers), profile, 'org-a', 'https://moss.example'), f.context)
  assert.throws(() => readTaskExecutionContext(new Headers(headers), profile, 'org-b', 'https://moss.example'))
  assert.throws(() => readTaskExecutionContext(new Headers(headers), profile, 'org-a', 'https://other.example'))
  assert.deepEqual(await taskExecutionHeaders({} as CustomAgentManifest, { ...f.input, execution_context: undefined }), {})
  await assert.rejects(taskExecutionHeaders({} as CustomAgentManifest, f.input))
  await assert.rejects(taskExecutionHeaders(f.manifest, { ...f.input, execution_context: undefined }), /TASK_EXECUTION_CONTEXT_REQUIRED/)
  assert.throws(() => assertNoTaskCredential({ text: f.context.access_token }, f.context.access_token), /PROVIDER_CREDENTIAL_DISCLOSURE/)
})
void test('forged context and destinations never leave the adapter', async () => {
  const f = fixture()
  for (const patch of [{ task_id: 'other' }, { attempt_id: 'other' }, { session_id: 'other' }, { org_id: 'other' }, { grant_id: '' },
    { spec_digest: 'sha256:bad' }, { expires_at: 1 }, { expires_at: Date.now() + 400000 }, { model_resource: 'other' },
    { tool_resources: ['mcp:other/tool'] }, { max_model_calls: 33 }, { access_token: 'token\r\nprivate' }, { access_token: 'a'.repeat(8193) },
    { model_gateway: 'https://other.example/api/v1/agent-models/org-a/invoke' }, { model_gateway: 'https://moss.example/api/v1/agent-models/org-a/invoke?token=x' },
    { model_gateway: 'https://user:password@moss.example/api/v1/agent-models/org-a/invoke' }, { tool_gateway: 'https://moss.example/private' }, { private_field: 'x' }]) {
    await assert.rejects(taskExecutionHeaders(f.manifest, { ...f.input, execution_context: async () => ({ ...f.context, ...patch }) }))
  }
  const good = await taskExecutionHeaders(f.manifest, f.input)
  for (const encoded of ['{bad', Buffer.from('{bad').toString('base64url'), Buffer.from(JSON.stringify({ ...f.context })).toString('base64url'), good[CONTEXT_HEADER] + '=']) {
    assert.throws(() => readTaskExecutionContext(new Headers({ ...good, [CONTEXT_HEADER]: encoded }), profile, 'org-a', 'https://moss.example'))
  }
})
void test('only reviewed valid manifests can declare task capabilities; source hashes include their scope', async t => {
  const reference = await startProtocolReference('http', 'synthetic'); t.after(reference.close)
  const manifest = { ...reference.legacyManifest(), execution_context: profile }
  assert.deepEqual(parseCustomManifest(JSON.stringify(manifest)).execution_context, profile)
  for (const patch of [{ profile: 'unknown' }, { tool_resources: ['mcp:server/add_numbers', 'mcp:server/add_numbers'] }, { tool_resources: ['filesystem:*'] },
    { max_model_calls: 0 }, { token: 'secret' }, { model_resource: 'bad\nresource' }]) {
    assert.throws(() => parseCustomManifest(JSON.stringify({ ...manifest, execution_context: { ...profile, ...patch } })))
  }
})
