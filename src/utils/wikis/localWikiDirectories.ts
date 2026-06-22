import os from 'os'
import path from 'path'

/**
 * Document Center storage roots.
 *
 * - $MOSS_HOME/docs/<docId>/<originalFileName>   raw uploaded documents
 * - $MOSS_HOME/wikis/<wikiId>/                    AI-built wiki bundles:
 *     ├── WIKI.md                                  AI summary + index
 *     ├── chunk-NNN-<topic>.md                     chunks
 *     ├── images/                                  extracted figures
 *     └── _moss_meta.json                          wiki metadata
 *
 * For P0 we store on local filesystem only; external blob storage (S3/OSS)
 * can be added later without changing on-disk layout — only resolution changes.
 */

export const MOSS_HOME = process.env.MOSS_HOME || path.join(os.homedir(), '.moss')

export const MOSS_DOCS_DIR = path.join(MOSS_HOME, 'docs')
export const MOSS_WIKIS_DIR = path.join(MOSS_HOME, 'wikis')
export const MOSS_MODELS_DIR = process.env.MOSS_MODELS_DIR || path.join(MOSS_HOME, 'models')

export const WIKI_META_FILE = '_moss_meta.json'
export const WIKI_INDEX_FILE = 'WIKI.md'
export const WIKI_IMAGES_DIR_NAME = 'images'

// Vector index produced at wiki build time. Two files per wiki, written into
// the staging dir and published atomically by WikiJobExecutor.publishStaged.
// Layout details in src/server/wikiIndex/query.ts (loadIndex).
export const WIKI_VECTOR_BIN_FILE = '_moss_index.bin'
export const WIKI_VECTOR_JSONL_FILE = '_moss_index.jsonl'

export function getDocumentStoragePath(docId: string, fileName: string): string {
  return path.join(MOSS_DOCS_DIR, docId, fileName)
}

export function getDocumentDir(docId: string): string {
  return path.join(MOSS_DOCS_DIR, docId)
}

export function getWikiDir(wikiId: string): string {
  return path.join(MOSS_WIKIS_DIR, wikiId)
}

export function getWikiIndexPath(wikiId: string): string {
  return path.join(getWikiDir(wikiId), WIKI_INDEX_FILE)
}

export function getWikiMetaPath(wikiId: string): string {
  return path.join(getWikiDir(wikiId), WIKI_META_FILE)
}

export function getWikiImagesDir(wikiId: string): string {
  return path.join(getWikiDir(wikiId), WIKI_IMAGES_DIR_NAME)
}

export function getWikiVectorBinPath(wikiId: string): string {
  return path.join(getWikiDir(wikiId), WIKI_VECTOR_BIN_FILE)
}

export function getWikiVectorJsonlPath(wikiId: string): string {
  return path.join(getWikiDir(wikiId), WIKI_VECTOR_JSONL_FILE)
}

export function getModelDir(modelId: string): string {
  return path.join(MOSS_MODELS_DIR, modelId)
}
