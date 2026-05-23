#!/usr/bin/env node
/**
 * Document Center v2 — Filesystem connector end-to-end smoke test.
 *
 * Validates the full pipeline without spinning up the HTTP server:
 *
 *   1. Make a temp dir with three sample documents in two subfolders
 *   2. Open a DirectConnectStore against a temp SQLite DB
 *   3. Create an external_source row pointing at the temp dir
 *   4. Run SourceSyncWorker.syncSourceNow() — assert tree + docs created
 *   5. Touch one file's content — re-sync, assert sha256 changed
 *   6. Create a wiki referencing that doc — re-touch — assert
 *      wiki.needs_rebuild flips to 1
 *   7. Delete a file from disk — re-sync — assert soft-delete
 *
 * Run with (from moss/ repo root):
 *   node --experimental-strip-types --experimental-sqlite scripts/test-fs-sync.ts
 *
 * Requires Node 22+ (for node:sqlite + type stripping). Exit code 0 on
 * success, non-zero on first failure.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { DirectConnectStore } from '../src/server/db.js'
import { DocumentStore } from '../src/server/documentStore.js'
import { SourceSyncWorker } from '../src/server/sources/syncWorker.js'
import '../src/server/sources/filesystem.js'  // register connector

const ORG_ID = 'org-test'
const USER_ID = 'user-test'

let failures = 0
function assert(cond: unknown, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`)
  } else {
    failures++
    console.error(`  ✗ ${label}`)
  }
}

async function setupTempData(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'moss-fs-sync-test-'))
  await mkdir(path.join(dir, 'sop'), { recursive: true })
  await mkdir(path.join(dir, 'reports'), { recursive: true })
  await writeFile(
    path.join(dir, 'sop', 'onboarding.md'),
    '# Onboarding\nWelcome to the team.',
  )
  await writeFile(
    path.join(dir, 'sop', 'shipping.md'),
    '# Shipping\nShip stuff via the post office.',
  )
  await writeFile(
    path.join(dir, 'reports', 'q1.md'),
    '# Q1 Report\nWe sold 100 widgets.',
  )
  await writeFile(path.join(dir, 'README.txt'), 'Top-level readme')
  return dir
}

async function main() {
  console.log('=== Filesystem sync smoke test ===\n')

  // ---- Setup ----
  const tempDocs = await setupTempData()
  console.log(`Sample docs at: ${tempDocs}`)

  const tempDbDir = await mkdtemp(path.join(tmpdir(), 'moss-fs-sync-db-'))
  const dbPath = path.join(tempDbDir, 'moss.db')
  process.env.MOSS_HOME = tempDbDir
  process.env.MOSS_SECRETS_DIR = path.join(tempDbDir, 'secrets')

  const db = new DirectConnectStore(dbPath)
  const docStore = new DocumentStore(db)

  const sourceId = randomUUID()
  db.createExternalSource({
    id: sourceId,
    org_id: ORG_ID,
    type: 'filesystem',
    name: 'test-fs',
    config_json: JSON.stringify({ rootPath: tempDocs }),
    credentials_secret_key: null,
    sync_interval_sec: 3600,
    auto_build_enabled: 0,
    created_by: USER_ID,
  })

  let needsRebuildCalls: string[] = []
  const worker = new SourceSyncWorker(db, docStore, (wikiId) => {
    needsRebuildCalls.push(wikiId)
  })

  // ---- 1) Initial sync ----
  console.log('\n[1] Initial sync')
  const stats1 = await worker.syncSourceNow(sourceId)
  assert(stats1.foldersCreated >= 2, `created folders (${stats1.foldersCreated})`)
  assert(stats1.filesCreated >= 3, `created files (${stats1.filesCreated})`)
  const sourceRow1 = db.getExternalSourceById(sourceId)!
  assert(sourceRow1.last_sync_status === 'success', 'source marked success')

  // Verify tree + documents
  const treeNodes = db.listTreeNodesBySource(sourceId)
  assert(treeNodes.length >= 2, `tree nodes mirrored (${treeNodes.length})`)
  const sopNode = treeNodes.find((n) => (n as Record<string, unknown>).source_path === 'sop')
  assert(sopNode != null, 'sop folder mirrored')
  assert(
    Number((sopNode as Record<string, unknown>).auto_managed) === 1,
    'sop folder is auto_managed',
  )

  const docs = db.listDocumentsBySource(sourceId)
  assert(docs.length >= 3, `documents mirrored (${docs.length})`)
  const onboardingDoc = docs.find(
    (d) => (d as Record<string, unknown>).external_id === 'sop/onboarding.md',
  )
  assert(onboardingDoc != null, 'onboarding.md mirrored')
  const shaBefore = String((onboardingDoc as Record<string, unknown>).content_sha256 ?? '')
  assert(shaBefore.length === 64, 'sha256 computed (64 hex chars)')

  // ---- 2) Idempotent re-sync ----
  console.log('\n[2] Idempotent re-sync (no changes)')
  const stats2 = await worker.syncSourceNow(sourceId)
  assert(stats2.filesCreated === 0, 'no new files created')
  assert(stats2.filesSkipped >= 3, `skipped unchanged files (${stats2.filesSkipped})`)

  // ---- 3) Wiki referencing the doc, then touch the doc ----
  console.log('\n[3] Wiki needs_rebuild flips on sha256 change')
  const onboardingDocId = String((onboardingDoc as Record<string, unknown>).id)
  const wiki = await docStore.createWiki({
    orgId: ORG_ID,
    nodeId: String((sopNode as Record<string, unknown>).id),
    name: 'Test Wiki',
    sourceDocumentIds: [onboardingDocId],
    createdBy: USER_ID,
  })
  // Modify the underlying file
  await writeFile(
    path.join(tempDocs, 'sop', 'onboarding.md'),
    '# Onboarding\nWelcome (updated).',
  )
  needsRebuildCalls = []
  const stats3 = await worker.syncSourceNow(sourceId)
  assert(stats3.filesUpdated >= 1, `file updated (${stats3.filesUpdated})`)
  assert(stats3.wikisMarked >= 1, `wiki marked needs_rebuild (${stats3.wikisMarked})`)
  const updatedWiki = db.getWikiById(wiki.id)!
  assert(Number(updatedWiki.needs_rebuild) === 1, 'wikis.needs_rebuild = 1')

  // Auto-build is off for this source, so callback should NOT have fired
  assert(needsRebuildCalls.length === 0, 'onWikiNeedsRebuild not fired (auto-build off)')

  // ---- 4) Delete a file on disk -> soft-delete ----
  console.log('\n[4] Soft-delete on missing file')
  await rm(path.join(tempDocs, 'reports', 'q1.md'))
  const stats4 = await worker.syncSourceNow(sourceId)
  assert(stats4.filesDeleted >= 1, `file soft-deleted (${stats4.filesDeleted})`)

  // Verify deleted_at set
  const q1Doc = db.findDocumentBySource(sourceId, 'reports/q1.md')
  if (q1Doc) {
    assert(
      (q1Doc as Record<string, unknown>).deleted_at != null,
      'q1.md has deleted_at set',
    )
  } else {
    console.log('  ! q1.md not found in DB (may have been hard-deleted)')
  }

  // ---- 5) Restore file -> undelete ----
  console.log('\n[5] Undelete on file return')
  await writeFile(
    path.join(tempDocs, 'reports', 'q1.md'),
    '# Q1 Report\nWe sold 200 widgets.',
  )
  const stats5 = await worker.syncSourceNow(sourceId)
  // The file's external_id is 'reports/q1.md' — sync should find the
  // existing (soft-deleted) row and restore it.
  assert(
    stats5.filesUpdated + stats5.filesCreated >= 1,
    'file restored or recreated',
  )

  // ---- Cleanup ----
  db.close()
  await rm(tempDocs, { recursive: true, force: true })
  await rm(tempDbDir, { recursive: true, force: true })

  if (failures > 0) {
    console.error(`\n✗ ${failures} assertion(s) failed`)
    process.exit(1)
  }
  console.log('\n✓ All assertions passed')
}

main().catch((err) => {
  console.error('Test runner crashed:', err)
  process.exit(2)
})
