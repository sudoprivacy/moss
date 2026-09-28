import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ArtifactTracker, readArtifacts, projectArtifactDrafts } from './artifacts.js'
import { detectFileIntent, buildDraftsInstruction, cleanupIntermediateFiles } from './draftsCleanup.js'

void test('runtime artifacts preserve inputs, validate JSON, retain dependencies and archive released drafts without collisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'moss-artifacts-'))
  const workspace = join(root, 'workspace')
  const metadata = join(root, 'session.artifacts.json')
  await mkdir(join(workspace, '.drafts'), { recursive: true })
  await writeFile(join(workspace, 'temp_input.json'), '{"input":true}')
  await writeFile(join(root, 'outside.json'), '{}')
  await symlink(join(root, 'outside.json'), join(workspace, 'linked.json'))
  const tracker = new ArtifactTracker(workspace, 's', metadata)
  try {
    await tracker.begin('t1')
    await writeFile(join(workspace, '报价 数据.json'), '{"total":90.3}')
    await writeFile(join(workspace, 'temp_output.json'), '{}')
    await writeFile(join(workspace, 'temp_legacy.json'), '{}')
    await writeFile(join(workspace, 'bad.json'), '// @final\n{}')
    await writeFile(join(workspace, 'unspecified.csv'), 'x,y\n1,2')
    await writeFile(join(workspace, '.drafts', 'calculate.py'), '#!/usr/bin/env python3\nprint(42)')
    await writeFile(join(workspace, '.drafts', 'temp_legacy.json'), '{"keep":1}')
    tracker.declare({ files: [
      { path: '报价 数据.json', intent: 'final' }, { path: 'temp_output.json', intent: 'final' },
      { path: 'bad.json', intent: 'final' }, { path: 'temp_input.json', intent: 'draft', release: true },
      { path: '../outside.json', intent: 'final' }, { path: 'linked.json', intent: 'final' },
    ] })
    const first = await tracker.finish()
    const byPath = new Map(first.manifest.records.map(r => [r.relativePath, r]))
    assert.equal(byPath.get('报价 数据.json')?.intent, 'final')
    assert.equal(byPath.get('temp_output.json')?.intent, 'final')
    assert.equal(byPath.get('temp_legacy.json')?.intent, 'draft')
    const tree = { name: 'workspace', relativePath: '', fullPath: workspace, isFile: false, isDir: true, children: [{ name: '.drafts', relativePath: '.drafts', fullPath: join(workspace, '.drafts'), isFile: false, isDir: true, children: [] as any[] }] }
    await projectArtifactDrafts(tree, workspace, first.manifest)
    assert(tree.children[0]!.children.some(node => node.relativePath === 'temp_legacy.json'))

    assert.equal(byPath.get('bad.json')?.intent, 'unknown')
    assert.match(byPath.get('bad.json')?.error ?? '', /Invalid JSON/)
    assert.equal(byPath.get('unspecified.csv')?.intent, 'unknown')
    assert.equal(byPath.get('temp_input.json')?.origin, 'existing')
    assert.equal(byPath.has('linked.json'), false)
    assert.equal(await readFile(join(workspace, 'temp_input.json'), 'utf8'), '{"input":true}')
    // Fresh tracker simulates resume. Root legacy data remains readable until explicitly released.
    const resumed = new ArtifactTracker(workspace, 's', metadata)
    await resumed.begin('t2')
    assert.deepEqual(JSON.parse(await readFile(join(workspace, 'temp_legacy.json'), 'utf8')), {})
    resumed.declare({ files: [{ path: 'temp_legacy.json', intent: 'draft', release: true }] })
    const second = await resumed.finish()
    const archived = second.changed.find(r => r.relativePath.startsWith('.drafts/temp_legacy-'))!
    assert(archived)
    assert.equal(await readFile(join(workspace, archived.relativePath), 'utf8'), '{}')
    assert.equal(await readFile(join(workspace, '.drafts/temp_legacy.json'), 'utf8'), '{"keep":1}')
    await writeFile(join(workspace, 'temp_output.json'), '{"uploaded replacement":true}')
    await resumed.begin('t3')
    resumed.declare({ files: [{ path: 'temp_output.json', intent: 'final' }] })
    await writeFile(join(workspace, '报价 数据.json'), '{"changed":true}')
    const third = await resumed.finish(true)
    assert.equal(third.changed.find(r => r.relativePath === 'temp_output.json')?.origin, 'existing')
    assert.equal(third.changed.find(r => r.relativePath === '报价 数据.json')?.intent, 'unknown')
    assert.match(await readFile(join(workspace, '.drafts/calculate.py'), 'utf8'), /^#!/)
    assert.equal((await readArtifacts(metadata)).v, 1)
    await cleanupIntermediateFiles(workspace)
    assert.equal(await readFile(join(workspace, 'temp_input.json'), 'utf8'), '{"input":true}')
  } finally { await rm(root, { recursive: true, force: true }) }
})

void test('format-safe compatibility uses draft directories and legal comments', () => {
  assert.equal(detectFileIntent('result.json', '// @final\n{}').intent, 'unknown')
  assert.equal(detectFileIntent('data.csv', '# @draft\na,b').intent, 'unknown')
  assert.equal(detectFileIntent('.drafts/a.json', '{}').intent, 'draft')
  assert.equal(detectFileIntent('script.py', '#!/usr/bin/python3\n# @draft\nprint(1)').intent, 'draft')
  assert.equal(detectFileIntent('result.md', '<!-- @final -->\n# Result').intent, 'final')
  assert(!buildDraftsInstruction('/workspace').includes('FIRST LINE'))
})
