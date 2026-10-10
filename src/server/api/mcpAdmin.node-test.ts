import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import { test } from 'node:test'
import { createMcpAdminApi } from './mcpAdmin.js'
import type { AuthContext } from '../auth/token.js'
import { HttpError, writeError } from '../httpRespond.js'

void test('MCP template validation and conflicts retain their HTTP status without inserting rows', async () => {
  let writes = 0
  let isDuplicate = false
  const api = createMcpAdminApi({
    authService: { requireScope() {} },
    mcpStore: {
      async getTemplateByName() { return isDuplicate ? { id: 'existing' } : null },
      async createTemplate() { writes++; throw new Error('Invalid input reached persistence') },
    },
    async getUserName() { return undefined },
    async getUserDepartmentId() { return null },
  } as unknown as Parameters<typeof createMcpAdminApi>[0])
  const auth = { orgId: 'org', userId: 'admin', role: 'admin', scopes: ['*'] } as AuthContext
  const cases = [
    { input: { name: '', icon: 'tool' }, expected: 400 },
    { input: { name: 'tool', icon: '' }, expected: 400 },
    { input: { name: 'tool', icon: 'tool', config_json: '{' }, expected: 400 },
    { input: { name: 'tool', icon: 'tool', config_json: '{"user_config_items":42}' }, expected: 400 },
    { input: { name: 'tool', icon: 'tool' }, expected: 409 },
  ]
  for (const { input, expected } of cases) {
    isDuplicate = expected === 409
    let status = 0
    let payload = ''
    const response = {
      writeHead(value: number) { status = value },
      end(value: string) { payload = value },
    } as unknown as ServerResponse
    try {
      await api.createTemplate(auth, { mcp_type: 'http', ...input })
      assert.fail('Expected rejected template')
    } catch (error) {
      assert.ok(error instanceof HttpError)
      writeError({ info() {}, warn() {}, debug() {}, error() { assert.fail('A 4xx was logged as a server error') } }, response, error)
    }
    assert.equal(status, expected)
    assert.equal(typeof (JSON.parse(payload) as { error: unknown }).error, 'string')
  }
  assert.equal(writes, 0)
})
