import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { parseDocument } from '../src/server/sources/docParsers.js'
import { searchParkPolicySources } from '../src/server/park/policySearch.js'
import type { WikiSourceSnapshot } from '../src/server/wikiSourceSnapshot.js'

// One-time repair of the currently bound built corpus. Never substitute a
// current upload unless its parsed bytes exactly match the old build input.
const [databasePath, wikiId] = process.argv.slice(2)
if (!databasePath || !wikiId) throw new Error('Usage: node --import tsx scripts/repair-park-policy-sources.ts <moss.db> <wiki-id>')
const db = new DatabaseSync(databasePath, { readOnly: true })
try {
  const wiki = db.prepare('SELECT org_id, storage_path FROM wikis WHERE id = ?').get(wikiId) as { org_id: string; storage_path: string } | undefined
  if (!wiki) throw new Error('Wiki not found')
  const config = db.prepare('SELECT assistant_config FROM park_config WHERE org_id = ?').get(wiki.org_id) as { assistant_config: string } | undefined
  if (JSON.parse(config?.assistant_config ?? '{}').policy_wiki_id !== wikiId) throw new Error('Only the bound park policy wiki can be repaired')
  const metaPath = join(wiki.storage_path, '_moss_meta.json')
  const raw = await readFile(metaPath, 'utf8')
  const meta = JSON.parse(raw) as { wikiId: string; builtAt: number; sourceDocuments: WikiSourceSnapshot[] }
  if (meta.wikiId !== wikiId || !meta.sourceDocuments?.length) throw new Error('Invalid built source metadata')
  if (meta.sourceDocuments.every(source => source.markdownPath && source.markdownSha256)) {
    await searchParkPolicySources(wiki.storage_path, wikiId, '政策')
    console.log('Verified existing source snapshots; no changes needed')
  } else {
    const verified: Array<{ source: WikiSourceSnapshot; bytes: Buffer }> = []
    for (const source of meta.sourceDocuments) {
      const doc = db.prepare('SELECT file_name,storage_path FROM documents WHERE id = ? AND org_id = ? AND deleted_at IS NULL').get(source.id, wiki.org_id) as { file_name: string; storage_path: string } | undefined
      if (!doc || doc.file_name !== source.fileName) throw new Error(`Source ${source.id} cannot be verified; rebuild required`)
      const parsed = await parseDocument(doc.storage_path, doc.file_name)
      if (!parsed) throw new Error(`Source ${source.id} cannot be parsed; rebuild required`)
      const name = `${basename(source.fileName, extname(source.fileName))}.md`
      const bytes = await readFile(join(wiki.storage_path, 'input', name))
      if (!bytes.equals(Buffer.from(parsed.markdown, 'utf8'))) throw new Error(`Source ${source.id} differs from built input; rebuild required`)
      verified.push({ source, bytes })
    }
    // Verification finishes before any writes. Sources are never partially
    // activated; the final metadata rename publishes all mappings together.
    await copyFile(metaPath, `${metaPath}.before-policy-repair`)
    await mkdir(join(wiki.storage_path, '_sources'), { recursive: true })
    for (const { source, bytes } of verified) {
      source.markdownPath = `_sources/${source.id}.md`
      source.markdownSha256 = createHash('sha256').update(bytes).digest('hex')
      await writeFile(join(wiki.storage_path, source.markdownPath), bytes)
    }
    if (raw !== await readFile(metaPath, 'utf8')) throw new Error('Wiki rebuilt during repair; retry against the new build')
    const next = `${metaPath}.policy-repair`
    await writeFile(next, JSON.stringify(meta, null, 2), 'utf8')
    await rename(next, metaPath)
    await searchParkPolicySources(wiki.storage_path, wikiId, '政策')
    console.log(`Verified and repaired ${verified.length} built sources for ${wikiId}`)
  }
} finally {
  db.close()
}
