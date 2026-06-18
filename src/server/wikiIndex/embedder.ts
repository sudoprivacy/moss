/**
 * Lazy singleton wrapper around @xenova/transformers for the wiki vector
 * index.
 *
 * Why a wrapper:
 *  - Model load is slow (1-2s ONNX session warmup) and side-effectful
 *    (downloads ~120MB on first use). We don't want every wiki build or
 *    search request paying that cost — load once per process.
 *  - Failure must be non-fatal. Private deploys may not have the model
 *    on disk and may have no outbound network. The whole system should
 *    keep working with grep-only retrieval. So `ensureEmbedder` resolves
 *    to `null` on any failure path, and burned-in `unavailable=true` so
 *    we don't keep retrying every request.
 *  - Tests must be able to inject a fake without touching @xenova at all.
 *    `_setEmbedderForTests` overrides the singleton for the rest of the
 *    process; the prod code path doesn't even load transformers when the
 *    test hook is set.
 *
 * Degrade template: src/server/sources/docParsers.ts:246-286 (libreoffice
 * multi-path resolution + null return on missing binary).
 */

import { mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'

export interface Embedder {
  /** Embedding dimensionality (e.g. 384 for multilingual-e5-small). */
  dim: number
  modelId: string
  /**
   * Embed a batch of strings with the e5 "passage:" prefix. Returns
   * L2-normalized Float32Array per input. Batched and serialized
   * internally (single ONNX session ≠ parallel).
   */
  passage(texts: string[]): Promise<Float32Array[]>
  /** Embed a single query with the e5 "query:" prefix. */
  query(text: string): Promise<Float32Array>
}

interface State {
  embedder: Embedder | null
  /** Once true, ensureEmbedder returns null without retrying inside this process. */
  unavailable: boolean
  /** In-flight load promise so concurrent callers share work. */
  loading: Promise<Embedder | null> | null
  /** True when a test override is in effect — bypass real loading entirely. */
  testOverride: boolean
}

const state: State = {
  embedder: null,
  unavailable: false,
  loading: null,
  testOverride: false,
}

export interface EnsureEmbedderOptions {
  /** HF repo id, e.g. 'Xenova/multilingual-e5-small'. */
  modelId: string
  /**
   * Directory to use as the transformers.js cache. Files end up under
   * `<cacheDir>/<modelId>/`. We point this at MOSS_MODELS_DIR.
   */
  cacheDir: string
  /** Optional HF endpoint override for offline / private mirror deployments. */
  mirror?: string
}

/**
 * Returns a singleton Embedder, or null if the model cannot be loaded.
 * Subsequent failures within the same process do NOT trigger another
 * load attempt — a single warn line is logged on the first failure.
 */
export async function ensureEmbedder(opts: EnsureEmbedderOptions): Promise<Embedder | null> {
  if (state.testOverride) return state.embedder
  if (state.embedder) return state.embedder
  if (state.unavailable) return null
  if (state.loading) return state.loading

  state.loading = loadEmbedder(opts)
    .then((emb) => {
      state.embedder = emb
      if (!emb) state.unavailable = true
      return emb
    })
    .catch((err) => {
      console.warn('[wikiIndex] embedder load threw, degrading to grep-only:', err)
      state.unavailable = true
      return null
    })
    .finally(() => {
      state.loading = null
    })

  return state.loading
}

async function loadEmbedder(opts: EnsureEmbedderOptions): Promise<Embedder | null> {
  await mkdir(opts.cacheDir, { recursive: true }).catch(() => {})

  let mod: typeof import('@xenova/transformers')
  try {
    mod = await import('@xenova/transformers')
  } catch (err) {
    console.warn(
      `[wikiIndex] @xenova/transformers not available; semantic search disabled. ${formatErr(err)}`,
    )
    return null
  }

  // Configure transformers.js env BEFORE pipeline() runs.
  // - cacheDir: where downloaded files live; lets ops pre-seed via rsync.
  // - allowLocalModels: needed for the local_files_only fallback below.
  // - remoteHost: optional HF mirror.
  const env = mod.env as unknown as Record<string, unknown>
  env.cacheDir = opts.cacheDir
  env.allowLocalModels = true
  env.localModelPath = opts.cacheDir
  // Disable WASM backend resolution — Node uses onnxruntime-node natively.
  // (Setting these defensively; in v2 they're already correct by default.)
  if (env.backends && typeof env.backends === 'object') {
    const backends = env.backends as Record<string, unknown>
    const onnx = backends.onnx as Record<string, unknown> | undefined
    if (onnx) {
      const wasm = onnx.wasm as Record<string, unknown> | undefined
      if (wasm) wasm.numThreads = 1
    }
  }
  if (opts.mirror) {
    env.remoteHost = opts.mirror
  }

  const modelDir = path.join(opts.cacheDir, opts.modelId)
  const onnxFile = path.join(modelDir, 'onnx', 'model_quantized.onnx')
  const hasLocalModel = existsSync(onnxFile)

  if (!hasLocalModel) {
    // We don't have the files. Two choices: download (if remoteHost is
    // reachable) or fail. We default to "try download once"; if it fails,
    // mark unavailable and stop retrying.
    env.allowRemoteModels = true
    console.warn(
      `[wikiIndex] model "${opts.modelId}" not present at ${modelDir}; attempting download from ${(env.remoteHost as string) ?? 'huggingface.co'}. ` +
        `Set MOSS_MODEL_MIRROR or pre-seed the directory to skip this on next boot.`,
    )
  } else {
    env.allowRemoteModels = false
  }

  let pipeline: Awaited<ReturnType<typeof mod.pipeline>>
  try {
    pipeline = await mod.pipeline('feature-extraction', opts.modelId, {
      quantized: true,
    })
  } catch (err) {
    console.warn(
      `[wikiIndex] failed to load model "${opts.modelId}" from ${opts.cacheDir}: ${formatErr(err)}. Falling back to grep-only.`,
    )
    return null
  }

  // Probe to discover dimensionality. e5-small is 384; bge-small-zh is 512.
  const probe = await pipeline('query: probe', { pooling: 'mean', normalize: true })
  const dim = probe.dims[probe.dims.length - 1] ?? 0
  if (dim <= 0) {
    console.warn(`[wikiIndex] model "${opts.modelId}" returned invalid dim ${dim}`)
    return null
  }

  // Serialize calls — onnxruntime-node is single-session and concurrent
  // pipeline calls can throw or corrupt internal state.
  let chain: Promise<unknown> = Promise.resolve()
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }

  const embedTexts = async (prefixedTexts: string[]): Promise<Float32Array[]> => {
    return serialize(async () => {
      // Batch in chunks to keep memory bounded; transformers.js handles
      // padding internally per batch.
      const batchSize = 32
      const out: Float32Array[] = []
      for (let i = 0; i < prefixedTexts.length; i += batchSize) {
        const batch = prefixedTexts.slice(i, i + batchSize)
        const tensor = await pipeline(batch, { pooling: 'mean', normalize: true })
        // tensor.data is a Float32Array of shape [batch, dim].
        const data = tensor.data as Float32Array
        for (let b = 0; b < batch.length; b++) {
          const view = data.subarray(b * dim, (b + 1) * dim)
          // Copy out of the shared tensor buffer — next call reuses it.
          out.push(new Float32Array(view))
        }
      }
      return out
    })
  }

  console.log(`[wikiIndex] embedder ready: model=${opts.modelId} dim=${dim}`)

  return {
    dim,
    modelId: opts.modelId,
    passage: (texts: string[]) => embedTexts(texts.map((t) => `passage: ${t}`)),
    query: async (text: string) => {
      const [v] = await embedTexts([`query: ${text}`])
      return v ?? new Float32Array(dim)
    },
  }
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

/**
 * Install a fake embedder (or clear with null) for tests. While in test
 * override mode, ensureEmbedder returns the supplied value without ever
 * importing @xenova/transformers.
 */
export function _setEmbedderForTests(fake: Embedder | null): void {
  state.embedder = fake
  state.testOverride = true
  state.unavailable = false
  state.loading = null
}

/** Reset all embedder state — undo `_setEmbedderForTests`. */
export function _resetEmbedderForTests(): void {
  state.embedder = null
  state.testOverride = false
  state.unavailable = false
  state.loading = null
}
