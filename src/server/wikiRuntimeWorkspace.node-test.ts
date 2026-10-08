import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { copyWikiInputsToRuntime, copyWikiOutputsFromRuntime, loadWikiBuilderPrompt } from './wikiRuntimeWorkspace.js'
import { parseStatLines } from './backends/podWorkspace.js'

void test('the builtin Wiki prompt is loaded without a tenant catalog installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-prompt-'))
  const directory = join(root, 'assistants', 'system', 'wiki-builder')
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'wiki-builder.md'), 'Customer-adjusted builtin Wiki instructions')
    const prompt = await loadWikiBuilderPrompt(root)
    assert.match(prompt, /Customer-adjusted builtin Wiki instructions/)
    assert.match(prompt, /input\//)
    assert.match(prompt, /do not ask the user questions/)
    await writeFile(join(directory, 'wiki-builder.md'), '  ')
    await assert.rejects(loadWikiBuilderPrompt(root), /instructions are empty/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

void test('source documents and images cross the host/runtime filesystem boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-input-'))
  const delivered = new Map<string, Buffer>()
  try {
    await mkdir(join(root, 'input', 'images'), { recursive: true })
    await writeFile(join(root, 'input', 'facts.md'), 'QA source fact')
    await writeFile(join(root, 'input', 'images', 'plot.png'), Buffer.from([0, 255, 17]))
    await writeFile(join(root, 'AGENTS.md'), 'Runtime identity remains private')
    await copyWikiInputsToRuntime(root, { writeFile: async (file, bytes) => { delivered.set(file, bytes) } })
    assert.equal(delivered.get('input/facts.md')?.toString(), 'QA source fact')
    assert.deepEqual(delivered.get('input/images/plot.png'), Buffer.from([0, 255, 17]))
    assert.equal(delivered.size, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

void test('generated pages and images are collected while private runtime files stay out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-output-'))
  const files = ['WIKI.md', 'chunk-001-facts.md', '_moss_images.md', 'images/plot.png', 'AGENTS.md', 'MEMORY.md', '.nexus/sudocode/sudocode.json', '.moss/transcript.jsonl']
  const read: string[] = []
  try {
    const entries = files.map(relativePath => ({ relativePath, isDir: false, size: 10 }))
    await copyWikiOutputsFromRuntime(root, {
      listTree: async () => entries,
      readFile: async file => { read.push(file); return Buffer.from('generated ' + file) },
    })
    assert.deepEqual(read, files.slice(0, 4))
    assert.equal(await readFile(join(root, 'WIKI.md'), 'utf8'), 'generated WIKI.md')
    assert.equal(await readFile(join(root, 'images', 'plot.png'), 'utf8'), 'generated images/plot.png')
    await assert.rejects(readFile(join(root, 'MEMORY.md')), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

void test('runtime output cannot escape staging or export a linked configuration file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-boundary-'))
  try {
    for (const relativePath of ['../outside.md', '/outside.md', 'C:\\outside.md', 'images/../../outside.md']) {
      let isRead = false
      await assert.rejects(copyWikiOutputsFromRuntime(root, {
        listTree: async () => [{ relativePath, isDir: false, size: 10 }],
        readFile: async () => { isRead = true; return Buffer.from('private') },
      }))
      assert.equal(isRead, false)
    }
    const entries = parseStatLines('symbolic link|30|./WIKI.md\nregular file|20|./chunk-001-facts.md', root)
    assert.equal(entries[0]?.isSymbolicLink, true)
    let isRead = false
    await assert.rejects(copyWikiOutputsFromRuntime(root, {
      listTree: async () => entries,
      readFile: async () => { isRead = true; return Buffer.from('private') },
    }), /symbolic links/)
    assert.equal(isRead, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

void test('source symlinks are refused before an external file is sent to the runtime', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-source-boundary-'))
  try {
    await mkdir(join(root, 'input'))
    await writeFile(join(root, 'private.txt'), 'private configuration')
    await symlink(join(root, 'private.txt'), join(root, 'input', 'linked.md'))
    let isWritten = false
    await assert.rejects(copyWikiInputsToRuntime(root, { writeFile: async () => { isWritten = true } }), /symbolic links/)
    assert.equal(isWritten, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
