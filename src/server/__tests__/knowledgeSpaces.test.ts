// Runs under Node (`tsx --test`): DirectConnectStore needs node:sqlite.
// Knowledge spaces: tenant vs a user's 私有 (private) space. Pins the storage
// rules the routes rely on — private roots, scope/owner inheritance, no
// crossing between spaces, and the legacy-row migration defaults.
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const home = mkdtempSync(path.join(tmpdir(), 'moss-knowledge-'))
process.env.MOSS_HOME = home // before documentStore resolves its storage dirs

const { DirectConnectStore } = await import('../db.js')
const { DocumentStore, DocumentStoreError } = await import('../documentStore.js')

after(() => rmSync(home, { recursive: true, force: true }))

const ORG = 'org-1'

function setup() {
  const store = new DirectConnectStore(':memory:')
  return { store, docs: new DocumentStore(store) }
}

describe('private space', () => {
  it('creates one root per user, lazily and idempotently', () => {
    const { docs } = setup()
    const a = docs.getOrCreatePrivateRoot(ORG, 'u1')
    const b = docs.getOrCreatePrivateRoot(ORG, 'u1')
    const c = docs.getOrCreatePrivateRoot(ORG, 'u2')
    assert.equal(a.id, b.id)
    assert.notEqual(a.id, c.id)
    assert.equal(a.scope, 'private')
    assert.equal(a.ownerId, 'u1')
    assert.equal(a.parentId, null)
  })

  it('children and uploads inherit the space; tenant listing never shows them', async () => {
    const { docs } = setup()
    const root = docs.getOrCreatePrivateRoot(ORG, 'u1')
    const folder = docs.createNode({ orgId: ORG, parentId: root.id, name: 'notes', ownerId: 'someone-else' })
    assert.equal(folder.scope, 'private')
    assert.equal(folder.ownerId, 'u1')
    const doc = await docs.uploadDocument({
      orgId: ORG, nodeId: folder.id, fileName: 'a.md', mimeType: 'text/markdown',
      content: Buffer.from('# hi'), uploadedBy: 'u1',
    })
    assert.equal(doc.scope, 'private')
    assert.equal(doc.ownerId, 'u1')
    const tenantNode = docs.createNode({ orgId: ORG, parentId: null, name: 'org kb', ownerId: 'admin-1' })
    assert.deepEqual(docs.listTree(ORG, { scope: 'tenant' }).map(n => n.id), [tenantNode.id])
    assert.deepEqual(
      docs.listTree(ORG, { scope: 'private', ownerId: 'u1' }).map(n => n.id).sort(),
      [root.id, folder.id].sort(),
    )
    assert.equal(docs.privateUsageBytes(ORG, 'u1'), 4)
  })

  it('folders cannot move across spaces', () => {
    const { docs } = setup()
    const root1 = docs.getOrCreatePrivateRoot(ORG, 'u1')
    const root2 = docs.getOrCreatePrivateRoot(ORG, 'u2')
    const mine = docs.createNode({ orgId: ORG, parentId: root1.id, name: 'mine' })
    const tenant = docs.createNode({ orgId: ORG, parentId: null, name: 'org', ownerId: 'admin-1' })
    assert.throws(() => docs.updateNode(mine.id, ORG, { parentId: root2.id }), DocumentStoreError)
    assert.throws(() => docs.updateNode(mine.id, ORG, { parentId: tenant.id }), DocumentStoreError)
    assert.throws(() => docs.updateNode(tenant.id, ORG, { parentId: root1.id }), DocumentStoreError)
    assert.throws(() => docs.updateNode(mine.id, ORG, { parentId: null }), DocumentStoreError)
    assert.throws(() => docs.updateNode(root1.id, ORG, { parentId: tenant.id }), DocumentStoreError)
  })
})

describe('wiki sources stay inside their space', () => {
  it('a tenant wiki cannot read private folders or documents', async () => {
    const { docs } = setup()
    const root = docs.getOrCreatePrivateRoot(ORG, 'u1')
    const doc = await docs.uploadDocument({
      orgId: ORG, nodeId: root.id, fileName: 'a.md', mimeType: 'text/markdown',
      content: Buffer.from('x'), uploadedBy: 'u1',
    })
    await assert.rejects(
      docs.createWiki({ orgId: ORG, name: 't', sourceDocumentIds: [], sourceMode: 'dir', sourceNodeIds: [root.id], createdBy: 'admin-1' }),
      DocumentStoreError,
    )
    await assert.rejects(
      docs.createWiki({ orgId: ORG, name: 't', sourceDocumentIds: [doc.id], createdBy: 'admin-1' }),
      DocumentStoreError,
    )
  })

  it('a private wiki reads only its owner’s space and records owner + scope', async () => {
    const { docs } = setup()
    const root1 = docs.getOrCreatePrivateRoot(ORG, 'u1')
    const root2 = docs.getOrCreatePrivateRoot(ORG, 'u2')
    const tenant = docs.createNode({ orgId: ORG, parentId: null, name: 'org', ownerId: 'admin-1' })
    const create = (nodeId: string) =>
      docs.createWiki({
        orgId: ORG, name: 'p', sourceDocumentIds: [], sourceMode: 'dir', sourceNodeIds: [nodeId],
        createdBy: 'u1', scope: 'private', visibleTo: { department_ids: null, user_ids: ['u1'] },
      })
    await assert.rejects(create(root2.id), DocumentStoreError)
    await assert.rejects(create(tenant.id), DocumentStoreError)
    const w = await create(root1.id)
    assert.equal(w.scope, 'private')
    assert.equal(w.ownerId, 'u1')
    assert.deepEqual(w.visibleTo, { department_ids: null, user_ids: ['u1'] })
    assert.equal(w.enabled, true)
    assert.throws(() => docs.updateWiki(w.id, ORG, { sourceNodeIds: [tenant.id] }), DocumentStoreError)
    const disabled = docs.updateWiki(w.id, ORG, { enabled: false, visibleTo: null })
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.visibleTo, null)
  })

  it('uploads flag the dir-mode wikis tracking the folder', async () => {
    const { docs } = setup()
    const root = docs.getOrCreatePrivateRoot(ORG, 'u1')
    const sub = docs.createNode({ orgId: ORG, parentId: root.id, name: 'sub' })
    const w = await docs.createWiki({
      orgId: ORG, name: 'p', sourceDocumentIds: [], sourceMode: 'dir', sourceNodeIds: [root.id],
      createdBy: 'u1', scope: 'private',
    })
    assert.equal(w.needsRebuild, false)
    assert.deepEqual(docs.markDirWikisStale(sub.id, ORG).map(x => x.id), [w.id])
    assert.equal(docs.getWiki(w.id, ORG)!.needsRebuild, true)
  })
})

describe('legacy rows', () => {
  it('default to tenant, owned by admin, enabled', () => {
    const { store, docs } = setup()
    store.db.exec(`
      INSERT INTO document_tree_nodes (id, org_id, parent_id, name, created_at, updated_at)
      VALUES ('n-old', '${ORG}', NULL, 'old', 1, 1);
      INSERT INTO wikis (id, org_id, name, storage_path, created_by, created_at, updated_at)
      VALUES ('w-old', '${ORG}', 'old', '/tmp/w-old', 'someone', 1, 1);
    `)
    const node = docs.getNode('n-old', ORG)!
    assert.equal(node.scope, 'tenant')
    assert.equal(node.ownerId, 'admin')
    const w = docs.getWiki('w-old', ORG)!
    assert.equal(w.scope, 'tenant')
    assert.equal(w.ownerId, 'admin')
    assert.equal(w.enabled, true)
  })
})
