import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { writeAssistantOverrideAgentsMd } from '../sharedAgentMemory.js'
import { buildWorkspaceInstructionsSecret } from './k8sBackend.js'

void test('assistant rules reach the pod workspace and take precedence over the catalog display name', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-k8s-instructions-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  const configDir = join(root, 'config')
  await mkdir(workspace)
  const assistant = { configDir, workspace, assistantName: 'tenant-agent-id', assistantDisplayName: 'test' }
  await writeAssistantOverrideAgentsMd({ ...assistant, assistantRules: '# 角色\n你是测试demo', sharedMemory: 'User prefers Chinese.' })

  const secret = await buildWorkspaceInstructionsSecret(workspace, true)
  assert.deepEqual(secret.mounts, [{ key: 'AGENTS.md', mountPath: join(workspace, 'AGENTS.md') }])
  assert.equal(secret.data['AGENTS.md'], await readFile(join(workspace, 'AGENTS.md'), 'utf8'))
  assert.match(secret.data['AGENTS.md']!, /## Assistant Rules\n\n# 角色\n你是测试demo/)
  assert.match(secret.data['AGENTS.md']!, /If those rules do not specify an identity, use test/)
  assert.match(secret.data['AGENTS.md']!, /model identity truthfully/)
  assert.doesNotMatch(secret.data['AGENTS.md']!, /MUST answer/)
  assert.match(secret.data['AGENTS.md']!, /User prefers Chinese/)

  await writeAssistantOverrideAgentsMd({ ...assistant, assistantRules: 'Updated tenant rules' })
  const refreshed = await buildWorkspaceInstructionsSecret(workspace, true)
  assert.match(refreshed.data['AGENTS.md']!, /Updated tenant rules/)
  assert.doesNotMatch(refreshed.data['AGENTS.md']!, /测试demo|User prefers Chinese/)
})

void test('workspace instructions remain isolated and user-authored instructions are preserved', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-k8s-isolation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = join(root, 'first')
  const second = join(root, 'second')
  await mkdir(first)
  await mkdir(second)
  await writeAssistantOverrideAgentsMd({ workspace: first, assistantName: 'first', assistantRules: 'First tenant rules' })
  await writeAssistantOverrideAgentsMd({ workspace: second, assistantName: 'second', assistantRules: 'Second tenant rules' })
  assert.doesNotMatch((await buildWorkspaceInstructionsSecret(second, true)).data['AGENTS.md']!, /First tenant rules/)

  await writeFile(join(first, 'AGENTS.md'), '# Repository instructions\nKeep this file.')
  await writeAssistantOverrideAgentsMd({ workspace: first, assistantName: 'first', assistantRules: 'Replacement' })
  const secret = await buildWorkspaceInstructionsSecret(first, true)
  assert.equal(secret.data['AGENTS.md'], '# Repository instructions\nKeep this file.')
  assert.equal(await readFile(join(first, 'AGENTS.md'), 'utf8'), secret.data['AGENTS.md'])
})

void test('a selected assistant cannot silently start without its instructions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-k8s-missing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.deepEqual(await buildWorkspaceInstructionsSecret(root), { data: {}, mounts: [] })
  await assert.rejects(buildWorkspaceInstructionsSecret(root, true), /Unable to deliver assistant instructions/)
})
