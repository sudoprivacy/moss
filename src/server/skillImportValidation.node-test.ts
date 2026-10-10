import assert from 'node:assert/strict'
import { test } from 'node:test'
import JSZip from 'jszip'
import { ResourceAccessError } from './catalog/resourceError.js'
import { importTenantSkillArchive, importTenantSkillDirectory } from './skillStore.js'

const clientError = (error: unknown) => error instanceof ResourceAccessError && error.statusCode === 400
const contentBase64 = Buffer.from('---\nname: qa-invalid-import\ndescription: QA fixture\n---\nFixture').toString('base64')

for (const entryPath of ['../SKILL.md', '/outside/SKILL.md', 'nested/../../SKILL.md', 'C:\\outside\\SKILL.md']) {
  void test(`tenant skill directory rejects unsafe path ${entryPath} as a client error`, async () => {
    await assert.rejects(importTenantSkillDirectory({ userId: 'qa-user', entries: [{ path: entryPath, contentBase64 }] }), clientError)
  })
}

void test('a malformed tenant skill archive is a client error', async () => {
  await assert.rejects(importTenantSkillArchive({ userId: 'qa-user', fileName: 'qa.zip', archiveBase64: Buffer.from('not a zip').toString('base64') }), clientError)
})

void test('a tenant skill archive preserves the original path for traversal validation', async () => {
  const zip = new JSZip()
  zip.file('../SKILL.md', Buffer.from(contentBase64, 'base64'))
  await assert.rejects(importTenantSkillArchive({ userId: 'qa-user', fileName: 'qa.zip', archiveBase64: await zip.generateAsync({ type: 'base64' }) }), clientError)
})

void test('a tenant skill without SKILL.md is a client error', async () => {
  await assert.rejects(importTenantSkillDirectory({ userId: 'qa-user', entries: [{ path: 'references/qa.txt', contentBase64 }] }), clientError)
})

void test('empty tenant import payloads are client errors', async () => {
  await assert.rejects(importTenantSkillDirectory({ userId: 'qa-user', entries: [] }), clientError)
  await assert.rejects(importTenantSkillArchive({ userId: 'qa-user', fileName: 'qa.zip', archiveBase64: '' }), clientError)
})
