import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { test } from 'node:test'
import { writeAssistantOverrideAgentsMd } from '../sharedAgentMemory.js'
import { defaultAgentName } from '../agentIdentity.js'
import { buildWorkspaceInstructionsSecret, buildWorkspaceStorage } from './k8sBackend.js'

void test('workspace persistence is opt-in and claims survive pod cleanup without sharing sessions', () => {
  assert.deepEqual(buildWorkspaceStorage('first', 'moss-sessions'), { volume: { name: 'workspace', emptyDir: {} }, claim: undefined })
  const first = buildWorkspaceStorage('same-prefix-first', 'moss-sessions', 'local-path', '5Gi')
  const retry = buildWorkspaceStorage('same-prefix-first', 'moss-sessions', 'local-path', '5Gi')
  const second = buildWorkspaceStorage('same-prefix-second', 'moss-sessions', 'local-path', '5Gi')
  assert.deepEqual(retry, first)
  assert.notEqual(first.claim!.metadata.name, second.claim!.metadata.name)
  assert.deepEqual(first.volume.persistentVolumeClaim, { claimName: first.claim!.metadata.name })
  assert.equal(first.claim!.metadata.namespace, 'moss-sessions')
  assert.equal(first.claim!.metadata.labels['moss.sudo.dev/session-id'], 'same-prefix-first')
  assert.equal('ownerReferences' in first.claim!.metadata, false)
  assert.deepEqual(first.claim!.spec.resources.requests, { storage: '5Gi' })
  assert.deepEqual(first.claim!.spec.accessModes, ['ReadWriteOnce'])
  assert.match(first.claim!.metadata.name, /^[a-z0-9-]{1,63}$/)
})

void test('assistant rules reach the pod workspace and take precedence over the catalog display name', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-k8s-instructions-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  const configDir = join(root, 'config')
  await mkdir(workspace)
  const assistant = { configDir, workspace, assistantName: 'tenant-agent-id', assistantDisplayName: 'test' }
  await writeAssistantOverrideAgentsMd({ ...assistant, assistantRules: '# 角色\n你是测试demo', sharedMemory: 'User prefers Chinese.' })

  const secret = await buildWorkspaceInstructionsSecret(workspace, assistant.assistantName)
  assert.deepEqual(secret.mounts, [{ key: 'AGENTS.md', mountPath: posix.join(workspace, 'AGENTS.md') }])
  assert.equal(secret.data['AGENTS.md'], await readFile(join(workspace, 'AGENTS.md'), 'utf8'))
  assert.match(secret.data['AGENTS.md']!, /## Assistant Rules\n\n# 角色\n你是测试demo/)
  assert.match(secret.data['AGENTS.md']!, /If those rules do not specify an identity, use test/)
  assert.match(secret.data['AGENTS.md']!, /model identity truthfully/)
  assert.doesNotMatch(secret.data['AGENTS.md']!, /MUST answer/)
  assert.match(secret.data['AGENTS.md']!, /User prefers Chinese/)

  await writeAssistantOverrideAgentsMd({ ...assistant, assistantRules: 'Updated tenant rules' })
  const refreshed = await buildWorkspaceInstructionsSecret(workspace, assistant.assistantName)
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
  assert.doesNotMatch((await buildWorkspaceInstructionsSecret(second, 'second')).data['AGENTS.md']!, /First tenant rules/)

  await writeFile(join(first, 'AGENTS.md'), '# Repository instructions\nKeep this file.')
  await writeAssistantOverrideAgentsMd({ workspace: first, assistantName: 'first', assistantRules: 'Replacement' })
  const secret = await buildWorkspaceInstructionsSecret(first, 'first')
  assert.equal(secret.data['AGENTS.md'], '# Repository instructions\nKeep this file.')
  assert.equal(await readFile(join(first, 'AGENTS.md'), 'utf8'), secret.data['AGENTS.md'])
})

void test('a selected assistant cannot silently start without its instructions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-k8s-missing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.deepEqual(await buildWorkspaceInstructionsSecret(root), { data: {}, mounts: [] })
  await assert.rejects(buildWorkspaceInstructionsSecret(root, 'catalog-agent'), /Unable to deliver assistant instructions/)
})

void test('the default user agent starts without catalog instructions and preserves workspace instructions when present', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-k8s-default-agent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const assistantName = defaultAgentName('test-user')
  assert.deepEqual(await buildWorkspaceInstructionsSecret(root, assistantName), { data: {}, mounts: [] })
  await writeFile(join(root, 'AGENTS.md'), '# Workspace rules\nPreserve original videos.')
  assert.equal((await buildWorkspaceInstructionsSecret(root, assistantName)).data['AGENTS.md'], '# Workspace rules\nPreserve original videos.')
})
