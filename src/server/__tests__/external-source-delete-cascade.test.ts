import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DirectConnectStore } from '../db.js'

// Deleting an external data source optionally cascade-deletes the auto-managed
// "knowledge tree" (document_tree_nodes with source_id = <source>) it created:
//   - { cascadeTree: true }  → the tree is removed too (documents cascade; a built
//     wiki survives with node_id nulled).
//   - default (keep)         → the tree is preserved, just orphaned. It can no
//     longer be swept by sync (the source is gone), but stays for the admin to
//     delete manually.
describe('deleteExternalSource — optional knowledge-tree cascade', () => {
  let dir: string
  let store: DirectConnectStore
  const ORG = 'org-1'

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'moss-ext-del-'))
    store = new DirectConnectStore(join(dir, 'test.db'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function seedSourceWithTreeAndWiki(): void {
    store.createExternalSource({
      id: 'src-1',
      org_id: ORG,
      type: 'wedrive',
      name: '企业微盘',
      config_json: '{}',
      created_by: 'u1',
    })
    store.createDocumentTreeNode({
      id: 'root-1', org_id: ORG, parent_id: null, name: '企业微盘',
      source_id: 'src-1', source_path: '', auto_managed: 1,
    })
    store.createDocumentTreeNode({
      id: 'child-1', org_id: ORG, parent_id: 'root-1', name: '子文件夹',
      source_id: 'src-1', source_path: 'sub', auto_managed: 1,
    })
    store.createWiki({
      id: 'wiki-1', org_id: ORG, node_id: 'child-1', name: '已构建的 wiki',
      storage_path: '/tmp/wiki-1', created_by: 'u1',
    })
  }

  it('cascadeTree: true removes the whole tree but preserves a built wiki', () => {
    seedSourceWithTreeAndWiki()
    expect(store.listDocumentTreeNodes(ORG).map(n => n.id).sort()).toEqual(['child-1', 'root-1'])

    store.deleteExternalSource('src-1', ORG, { cascadeTree: true })

    expect(store.getExternalSource('src-1', ORG)).toBeNull()
    expect(store.listDocumentTreeNodes(ORG)).toEqual([])
    // The built wiki survives, unanchored from the deleted tree.
    const wiki = store.getWiki('wiki-1', ORG)
    expect(wiki).not.toBeNull()
    expect(wiki?.node_id).toBeNull()
  })

  it('default (keep) removes only the source, leaving the tree and wiki intact', () => {
    seedSourceWithTreeAndWiki()

    store.deleteExternalSource('src-1', ORG)

    expect(store.getExternalSource('src-1', ORG)).toBeNull()
    // Tree is preserved (orphaned).
    expect(store.listDocumentTreeNodes(ORG).map(n => n.id).sort()).toEqual(['child-1', 'root-1'])
    // Wiki stays anchored — nothing was deleted under it.
    const wiki = store.getWiki('wiki-1', ORG)
    expect(wiki?.node_id).toBe('child-1')
  })

  it('cascade only removes the deleted source\'s tree, not other sources\' trees', () => {
    // Two distinct sources in the same org (external_sources.id is a global PRIMARY
    // KEY, so a source_id maps to exactly one source).
    store.createExternalSource({ id: 'src-a', org_id: ORG, type: 'wedrive', name: 'A', config_json: '{}', created_by: 'u1' })
    store.createExternalSource({ id: 'src-b', org_id: ORG, type: 'wedrive', name: 'B', config_json: '{}', created_by: 'u1' })
    store.createDocumentTreeNode({ id: 'n-a', org_id: ORG, parent_id: null, name: 'A', source_id: 'src-a', auto_managed: 1 })
    store.createDocumentTreeNode({ id: 'n-b', org_id: ORG, parent_id: null, name: 'B', source_id: 'src-b', auto_managed: 1 })

    store.deleteExternalSource('src-a', ORG, { cascadeTree: true })

    expect(store.listDocumentTreeNodes(ORG).map(n => n.id)).toEqual(['n-b'])
    expect(store.getExternalSource('src-a', ORG)).toBeNull()
    expect(store.getExternalSource('src-b', ORG)).not.toBeNull()
  })
})
