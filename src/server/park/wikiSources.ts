import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DocumentStore } from '../documentStore.js'
import type { WikiSourceSnapshot } from '../wikiSourceSnapshot.js'
import type { ParkStore } from './store.js'
import { HttpError } from '../httpRespond.js'

interface BuiltSources {
  sourceDocumentIds: string[]
  sourceDocuments?: WikiSourceSnapshot[]
  builtAt: number
}

function parseMeta(value: unknown): BuiltSources {
  if (!value || typeof value !== 'object') throw new Error('Invalid wiki metadata')
  const meta = value as Record<string, unknown>
  if (
    !Array.isArray(meta.sourceDocumentIds) ||
    !meta.sourceDocumentIds.every((id) => typeof id === 'string') ||
    typeof meta.builtAt !== 'number'
  ) {
    throw new Error('Invalid wiki sources')
  }
  const snapshots = Array.isArray(meta.sourceDocuments) ? meta.sourceDocuments : []
  const sourceDocuments = snapshots.filter((item): item is WikiSourceSnapshot => {
    if (!item || typeof item !== 'object') return false
    const row = item as Record<string, unknown>
    return (
      typeof row.id === 'string' &&
      typeof row.fileName === 'string' &&
      typeof row.nodeName === 'string' &&
      typeof row.sizeBytes === 'number'
    )
  })
  return { sourceDocumentIds: meta.sourceDocumentIds, sourceDocuments, builtAt: meta.builtAt }
}

export async function getParkWikiSources(
  store: ParkStore,
  documents: DocumentStore,
  orgId: string,
  wikiId: string,
) {
  const wiki = await documents.getWiki(wikiId, orgId)
  if (!wiki) throw new HttpError(404, 'Wiki not found')
  let meta: BuiltSources
  try {
    meta = parseMeta(JSON.parse(await readFile(join(wiki.storagePath, '_moss_meta.json'), 'utf8')))
  } catch {
    return { built_at: null, record_status: 'unavailable' as const, sources: [] }
  }
  const sources = await Promise.all(
    meta.sourceDocumentIds.map(async (id) => {
      const document = await documents.getDocument(id, orgId)
      const snapshot = meta.sourceDocuments?.find((item) => item.id === id)
      const history = document ? undefined : await store.documentHistory(orgId, id)
      const node = document && !snapshot ? await documents.getNode(document.nodeId, orgId) : null
      const metadata =
        snapshot ??
        (document
          ? {
              id,
              fileName: document.fileName,
              nodeName: node?.name ?? '',
              sizeBytes: document.sizeBytes,
            }
          : history)
      const status = document
        ? 'available'
        : (await store.wasPolicyDocumentDeleted(orgId, id))
          ? 'deleted'
          : 'unavailable'
      return {
        id,
        fileName: metadata?.fileName ?? null,
        nodeName: metadata?.nodeName ?? null,
        sizeBytes: metadata?.sizeBytes ?? null,
        status,
      }
    }),
  )
  return { built_at: meta.builtAt, record_status: 'available' as const, sources }
}
