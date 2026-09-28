import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { writeAssistantOverrideAgentsMd } from './sharedAgentMemory.js'
import { SessionStartupError } from './sessionStartup.js'
import { ResourceAccessError } from './catalog/resourceError.js'

void test('application role separates model identity and preserves user AGENTS.md', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'moss-role-'))
  try {
    await writeAssistantOverrideAgentsMd({ workspace, assistantName: 'quote', assistantDisplayName: '物料报价助手', assistantRules: 'Calculate a 7.5% service fee.' })
    const role = await readFile(join(workspace, 'AGENTS.md'), 'utf8')
    assert.match(role, /business role is 物料报价助手/)
    assert.match(role, /model identity truthfully/)
    assert.doesNotMatch(role, /override any default|Do not answer that you are|MUST answer/)
    await writeFile(join(workspace, 'AGENTS.md'), '# User rules\nKeep this file.')
    await writeAssistantOverrideAgentsMd({ workspace, assistantName: 'other' })
    assert.equal(await readFile(join(workspace, 'AGENTS.md'), 'utf8'), '# User rules\nKeep this file.')
    await writeFile(join(workspace, 'AGENTS.md'), '# Moss Assistant Override\nold generated rules')
    await writeAssistantOverrideAgentsMd({ workspace, assistantName: 'updated' })
    assert.match(await readFile(join(workspace, 'AGENTS.md'), 'utf8'), /business role is updated/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

void test('startup failures are actionable, safe, and distinct for new attempts', () => {
  const first = new SessionStartupError(new ResourceAccessError(404, 'Bound skill not available'))
  const second = new SessionStartupError(new ResourceAccessError(404, 'Bound skill not available'))
  assert.equal(first.failure.isRetryable, false)
  assert.match(first.message, /organization administrator/)
  assert.notEqual(first.failure.attemptId, second.failure.attemptId)
  const runner = new SessionStartupError(new Error('secret internal path /private/key'), 's', 'attempt-1')
  assert.equal(runner.failure.attemptId, 'attempt-1')
  assert.equal(runner.failure.isRetryable, true)
  assert.doesNotMatch(runner.message, /private|secret/)
})

void test('artifact MCP protocol rejects invalid JSON and accepts valid declarations', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'moss-mcp-'))
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('src/server/artifactMcp.ts')], cwd: workspace, stderr: 'pipe' })
  const client = new Client({ name: 'regression-test', version: '1' })
  try {
    await client.connect(transport)
    assert((await client.listTools()).tools.some(tool => tool.name === 'moss_declare_artifacts'))
    await writeFile(join(workspace, 'data.json'), '// @final\n{}')
    const invalid = await client.callTool({ name: 'moss_declare_artifacts', arguments: { files: [{ path: 'data.json', intent: 'final' }] } })
    assert.equal(invalid.isError, true)
    await writeFile(join(workspace, 'data.json'), '{"amount":90.3}')
    const valid = await client.callTool({ name: 'moss_declare_artifacts', arguments: { files: [{ path: 'data.json', intent: 'final' }] } })
    assert.notEqual(valid.isError, true)
    const outside = await client.callTool({ name: 'moss_declare_artifacts', arguments: { files: [{ path: '../outside.json', intent: 'final' }] } })
    assert.equal(outside.isError, true)
  } finally { await client.close(); await transport.close(); await rm(workspace, { recursive: true, force: true }) }
})
