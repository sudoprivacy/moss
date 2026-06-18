/**
 * Wiki vector index builder.
 *
 * Called from WikiJobExecutor (Stage 4.5) after the wiki-builder agent has
 * produced WIKI.md + chunk-*.md in a staging dir, but BEFORE the staging
 * dir is published into the live wiki dir. The builder:
 *
 *   1. Discovers all .md files in stageDir (top-level only).
 *   2. Splits each into Passage[] via chunkSplitter.
 *   3. Embeds passages in batches.
 *   4. Writes `_moss_index.bin` (flat float32) and `_moss_index.jsonl`
 *      (one line of manifest + one line per passage) into stageDir.
 *
 * The whole thing is best-effort — model absence returns an `embedder-
 * unavailable` reason, embed failures return `embed-failed`. The wiki
 * itself is published either way (the caller in WikiJobExecutor logs the
 * skip but does not throw).
 */

import { readdir, readFile, writeFile } from 'fs/promises'
import path from 'path'
import { ensureEmbedder } from './embedder.js'
import { splitMarkdown, type Passage } from './chunkSplitter.js'
import {
  MOSS_MODELS_DIR,
  WIKI_VECTOR_BIN_FILE,
  WIKI_VECTOR_JSONL_FILE,
} from '../../utils/wikis/localWikiDirectories.js'

export interface BuildOptions {
  /**
   * Wiki staging dir containing WIKI.md + chunk-*.md. The vector sidecar
   * files are written into this same dir (published atomically alongside
   * the markdown by WikiJobExecutor.publishStaged).
   */
  stageDir: string
  /** HF repo id passed to transformers.js. */
  modelId: string
  /** Optional HF mirror endpoint for offline / private deployments. */
  modelMirror?: string
  /** Cap on passages produced per wiki; oversize wikis are truncated. */
  maxPassages?: number
  /** Cache dir for embedder model files. Defaults to MOSS_MODELS_DIR. */
  cacheDir?: string
}

export type BuildResult =
  | { ok: true; count: number }
  | { ok: false; reason: 'embedder-unavailable' | 'embed-failed' | 'no-passages'; error?: unknown }

interface Manifest {
  version: 1
  model: string
  dim: number
  count: number
  builtAt: number
}

export async function buildVectorIndex(opts: BuildOptions): Promise<BuildResult> {
  // 1. Collect .md files at the wiki root. Subdirectories (images/, etc.)
  // are excluded — they don't have semantic content the agent would want
  // to retrieve.
  let entries: Array<{ name: string; isFile: () => boolean }>
  try {
    entries = await readdir(opts.stageDir, { withFileTypes: true })
  } catch (err) {
    return { ok: false, reason: 'no-passages', error: err }
  }
  const mdFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort()

  if (mdFiles.length === 0) {
    return { ok: false, reason: 'no-passages' }
  }

  // 2. Split each file into passages. Per-file cap stays at chunkSplitter's
  // default (1000); we additionally enforce a wiki-wide cap below.
  const allPassages: Passage[] = []
  for (const file of mdFiles) {
    let content: string
    try {
      content = await readFile(path.join(opts.stageDir, file), 'utf-8')
    } catch {
      continue
    }
    const passages = splitMarkdown(content, file)
    allPassages.push(...passages)
  }
  if (allPassages.length === 0) {
    return { ok: false, reason: 'no-passages' }
  }
  const maxPassages = opts.maxPassages ?? 20_000
  const passages = allPassages.length > maxPassages ? allPassages.slice(0, maxPassages) : allPassages
  if (allPassages.length > maxPassages) {
    console.warn(
      `[wikiIndex] ${opts.stageDir} produced ${allPassages.length} passages; truncating to ${maxPassages}`,
    )
  }

  // 3. Load embedder (lazy singleton). Null means model absent — degrade.
  const cacheDir = opts.cacheDir ?? MOSS_MODELS_DIR
  const embedder = await ensureEmbedder({
    modelId: opts.modelId,
    cacheDir,
    mirror: opts.modelMirror,
  })
  if (!embedder) {
    return { ok: false, reason: 'embedder-unavailable' }
  }

  // 4. Embed in batches. embedder.passage() already batches internally
  // (size 32) so we just hand it the full list.
  let vectors: Float32Array[]
  try {
    vectors = await embedder.passage(passages.map((p) => p.text))
  } catch (err) {
    return { ok: false, reason: 'embed-failed', error: err }
  }
  if (vectors.length !== passages.length) {
    return {
      ok: false,
      reason: 'embed-failed',
      error: new Error(`embedder returned ${vectors.length} vectors for ${passages.length} passages`),
    }
  }

  // 5. Write .bin and .jsonl. The .bin is a single Float32Array; we
  // memcpy each per-passage vector into the right offset. The .jsonl
  // starts with the manifest line then has one passage per row.
  const dim = embedder.dim
  const flat = new Float32Array(passages.length * dim)
  for (let i = 0; i < passages.length; i++) {
    const v = vectors[i]!
    if (v.length !== dim) {
      return {
        ok: false,
        reason: 'embed-failed',
        error: new Error(`vector ${i} has dim ${v.length} != model dim ${dim}`),
      }
    }
    flat.set(v, i * dim)
  }

  const manifest: Manifest = {
    version: 1,
    model: embedder.modelId,
    dim,
    count: passages.length,
    builtAt: Date.now(),
  }
  const jsonlLines = [JSON.stringify(manifest), ...passages.map((p) => JSON.stringify(p))]

  await writeFile(
    path.join(opts.stageDir, WIKI_VECTOR_BIN_FILE),
    Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength),
  )
  await writeFile(
    path.join(opts.stageDir, WIKI_VECTOR_JSONL_FILE),
    jsonlLines.join('\n') + '\n',
    'utf-8',
  )

  return { ok: true, count: passages.length }
}
