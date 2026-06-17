/**
 * WikiJobExecutor — Document Center build worker
 *
 * Picks up queued rows from `wiki_build_jobs` and runs them through
 * RuntimeService (the same pipeline that drives chat sessions). The agent
 * for each build is the system-level `wiki-builder` assistant (currently
 * hard-coded as a prompt below; will be promoted to $MOSS_HOME/assistants/
 * system/wiki-builder/system.md once tuned).
 *
 * Design choices (per Document Center design doc):
 * - Reuses RuntimeService — no separate agent pool
 * - Global concurrency cap of 2 jobs
 * - Failed jobs are NOT auto-retried (user clicks "重新构建")
 * - Build output lands directly in the wiki's storage_path (cwd is set
 *   to that dir before spawning scode, which has full write access there)
 */

import { readFile, mkdir, readdir, writeFile, rename, rm, stat } from 'fs/promises'
import path from 'path'
import { RuntimeService } from '../../server/runtimeService.js'
import { DocumentStore, type DocumentRecord, type WikiBuildJob, type WikiRecord } from '../../server/documentStore.js'
import type { DirectConnectStore } from '../../server/db.js'
import { MOSS_WIKIS_DIR } from '../../utils/wikis/localWikiDirectories.js'

// Each build runs in its own private staging dir under wikis/.stage/ (same
// filesystem as wikis/, so the publish rename is atomic). The wiki's live
// dir is never touched until a build fully succeeds, so a failed rebuild
// can't corrupt the existing wiki, and concurrent builds of the same wiki
// no longer interleave their writes.
const STAGE_DIR = path.join(MOSS_WIKIS_DIR, '.stage')

const MAX_CONCURRENT_BUILDS = 2
const TICK_INTERVAL_MS = 3_000
const BUILD_TIMEOUT_MS = 30 * 60_000 // 30 minutes hard cap

// ============================================================
// Wiki-builder trigger message.
//
// The actual system prompt now lives on disk at
// `$MOSS_HOME/assistants/system/wiki-builder/wiki-builder.md`
// (seeded by `seedBuiltinSystemAssistants` in server.ts on first boot).
// scode's first-message injection path picks it up automatically via
// `prepareFirstMessageForScode(...assistantName: 'wiki-builder')` —
// the executor just needs to send a short trigger to kick the agent off.
//
// Customers can customize build behavior by editing the .md file in
// place; subsequent server boots skip re-seeding.
// ============================================================
const WIKI_BUILDER_TRIGGER = '请开始构建 Wiki。'

// ============================================================

type JobState = {
  jobId: string
  wikiId: string
  startedAt: number
}

export class WikiJobExecutor {
  private running = new Map<string, JobState>()
  private timer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(
    private runtime: RuntimeService,
    private docStore: DocumentStore,
    private db: DirectConnectStore,
  ) {}

  /** Start polling for queued jobs. Idempotent. */
  start(): void {
    if (this.timer) return
    this.stopped = false
    // Reclaim orphaned staging artifacts from a prior crash before we start
    // accepting jobs (in particular, recover any wiki left absent by an
    // interrupted publish swap). Fire-and-forget — polling starts in
    // parallel; the sweep only touches .stage/ and missing live dirs.
    void this.sweepStaging().catch((err) => {
      console.error('[WikiJobExecutor] staging sweep failed:', err)
    })
    const tick = () => {
      if (this.stopped) return
      this.tickOnce().catch(err => {
        console.error('[WikiJobExecutor] tick error:', err)
      }).finally(() => {
        if (!this.stopped) {
          this.timer = setTimeout(tick, TICK_INTERVAL_MS)
        }
      })
    }
    this.timer = setTimeout(tick, 100)
    console.log('[WikiJobExecutor] started')
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    console.log('[WikiJobExecutor] stopped')
  }

  private async tickOnce(): Promise<void> {
    // Reap timed-out jobs
    const now = Date.now()
    for (const [jobId, state] of this.running.entries()) {
      if (now - state.startedAt > BUILD_TIMEOUT_MS) {
        this.failJob(jobId, state.wikiId, 'build exceeded timeout')
        this.running.delete(jobId)
      }
    }

    // Pull queued jobs up to the concurrency cap
    const slotsAvailable = MAX_CONCURRENT_BUILDS - this.running.size
    if (slotsAvailable <= 0) return

    const queued = this.docStore.listQueuedBuildJobs(slotsAvailable)
    for (const job of queued) {
      // Fire-and-forget — runJob handles its own state updates.
      this.running.set(job.id, { jobId: job.id, wikiId: job.wikiId, startedAt: Date.now() })
      void this.runJob(job).finally(() => {
        this.running.delete(job.id)
      })
    }
  }

  private async runJob(job: WikiBuildJob): Promise<void> {
    console.log(`[WikiJobExecutor] picking up job ${job.id} (wiki=${job.wikiId})`)

    // Recency marker for last-started-wins on publish. Sourced from the
    // running-state stamp set in tickOnce (falls back to now). Recorded in
    // _moss_meta.json.startedAt and compared in publishStaged so a slow,
    // earlier-started build cannot clobber a newer one's output.
    const startedAt = this.running.get(job.id)?.startedAt ?? Date.now()

    // Mark job + wiki as running
    this.docStore.updateBuildJob(job.id, {
      status: 'running',
      progress: 5,
      currentStep: '准备工作目录',
      startedAt: Date.now(),
    })
    this.docStore.setWikiBuildResult(job.wikiId, { status: 'running' })

    let wiki: WikiRecord | null = null
    // Private staging dir for this build. Built in full here; only swapped
    // into the live wiki dir on success (see publishStaged). Cleaned up on
    // every exit path (success swap consumes it; failure rm -rf's it).
    const stageDir = path.join(STAGE_DIR, `${job.wikiId}.${job.id}`)
    try {
      wiki = this.docStore.getWikiById(job.wikiId)
      if (!wiki) throw new Error(`wiki ${job.wikiId} not found`)

      // Stage 1: prepare cwd/input with predigested markdown
      await mkdir(stageDir, { recursive: true })
      await this.prepareInputs(wiki, stageDir)
      this.docStore.updateBuildJob(job.id, { progress: 25, currentStep: '调用 AI 生成 Wiki' })

      // Stage 2: spawn agent session
      const created = await this.runtime.createSession({
        cwd: stageDir,
        dangerouslySkipPermissions: true,
        userId: 'system:wiki-builder',
        orgId: wiki.orgId,
        role: 'admin',
        scopes: ['sessions:create', 'sessions:attach:any'],
        source: 'wiki-build',
        channelChatId: job.id,
        // Note: assistantName is forwarded by RuntimeService through to the
        // first-message system block. The actual prompt content is provided
        // inline via stdin below since wiki-builder is not yet a real
        // assistant on disk.
        assistantName: 'wiki-builder',
      })

      this.docStore.updateBuildJob(job.id, {
        sessionId: created.sessionId,
        progress: 40,
        currentStep: 'Agent 正在阅读文档',
      })

      // Stage 3: attach + send prompt + wait for completion
      const ready = await this.runtime.ensureSessionReady(created.sessionId)
      const socket = await this.runtime.connectToAttempt(ready.attempt)

      const result = await this.driveSession(socket, job.id, WIKI_BUILDER_TRIGGER)
      socket.destroy()

      if (!result.ok) {
        throw new Error(result.error ?? 'build session failed')
      }

      // Stage 4: verify output presence (in the staging dir — the live
      // wiki dir is untouched until the swap below).
      const wikiIndexPath = path.join(stageDir, 'WIKI.md')
      try {
        await readFile(wikiIndexPath, 'utf-8')
      } catch {
        throw new Error('build finished but WIKI.md was not produced')
      }

      // Stage 4.5: soft-validate image captioning. Any image referenced in a
      // chunk but absent from _moss_images.md is logged as a warning — we do
      // NOT fail the build (a build with some uncaptioned images is still
      // useful, and decorative images are intentionally left out). Surfaces
      // the common failure mode where a non-vision model produced no captions.
      try {
        const uncaptioned = await findUncaptionedImages(stageDir)
        if (uncaptioned.length > 0) {
          console.warn(
            `[WikiJobExecutor] job ${job.id}: ${uncaptioned.length} image(s) ` +
              `referenced without a caption entry in _moss_images.md: ${uncaptioned.join(', ')}`,
          )
          this.docStore.updateBuildJob(job.id, {
            currentStep: `构建完成(${uncaptioned.length} 张图片未配文)`,
          })
        }
      } catch (e) {
        console.warn(`[WikiJobExecutor] job ${job.id}: caption validation skipped:`, e)
      }

      // Stage 5: write _moss_meta.json into the staging dir so wikiCli and
      // tooling can inspect the wiki without re-scanning the directory each
      // time. Includes the page list (WIKI.md + chunk-*.md) with type/title.
      // Unlike the live-dir write before, this MUST succeed: it carries
      // `startedAt`, which publishStaged uses to avoid clobbering a newer
      // build. If it fails, fail the whole build rather than publish a wiki
      // with no recency marker.
      await this.writeWikiMeta(wiki, stageDir, startedAt)

      // Stage 6: atomically publish the staging dir into the live wiki dir.
      // Fail-safe against concurrent same-wiki swaps (see publishStaged).
      await this.publishStaged(wiki, stageDir, startedAt)

      this.docStore.updateBuildJob(job.id, {
        status: 'succeeded',
        progress: 100,
        currentStep: '构建完成',
        finishedAt: Date.now(),
      })
      this.docStore.setWikiBuildResult(job.wikiId, {
        status: 'succeeded',
        lastBuiltAt: Date.now(),
        lastBuildError: null,
      })
      // Document Center v2: clear needs_rebuild on successful build.
      this.db.markWikiNeedsRebuild(job.wikiId, false)
      console.log(`[WikiJobExecutor] job ${job.id} succeeded`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[WikiJobExecutor] job ${job.id} failed:`, message)
      this.failJob(job.id, job.wikiId, message)
    } finally {
      // Always reclaim the staging dir. On a successful publish it has
      // already been renamed into the live dir (rm of a missing path is a
      // no-op with force); on failure or a lost recency race it's still
      // here and must be removed so .stage/ doesn't accumulate orphans.
      await rm(stageDir, { recursive: true, force: true }).catch((e) => {
        console.error(`[WikiJobExecutor] failed to clean staging dir ${stageDir}:`, e)
      })
    }
  }

  /**
   * Document Center v2: write `_moss_meta.json` summarizing the built
   * wiki. Format:
   *   {
   *     version: 2,
   *     wikiId, name, description,
   *     startedAt (epoch ms — when this build started; publishStaged
   *                compares it to the live wiki's to avoid clobbering a
   *                newer build),
   *     builtAt (epoch ms),
   *     sourceDocumentIds: [...],
   *     pages: [{ file, type: 'index'|'chunk', title }],
   *     images: [{ id, chunk, caption }]   // v2: from _moss_images.md;
   *                                        // caption only (detail stays in
   *                                        // the sidecar, fetched on demand)
   *   }
   * Readers must tolerate `images` being absent (v1 wikis / no figures).
   *
   * Title is extracted from each markdown's first `# ` heading; falls
   * back to the file name (sans `.md`). wikiCli reads this file to
   * give the agent a structured table of contents without re-parsing
   * every chunk on each request.
   *
   * `dir` is the staging dir being built (not the live wiki dir): meta is
   * written alongside the pages it describes, then published atomically.
   */
  private async writeWikiMeta(wiki: WikiRecord, dir: string, startedAt: number): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    const mdFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort()

    type Page = { file: string; type: 'index' | 'chunk'; title: string; topic?: string }
    const pages: Page[] = []
    for (const file of mdFiles) {
      let title = file.replace(/\.md$/, '')
      let type: 'index' | 'chunk' = file === 'WIKI.md' ? 'index' : 'chunk'
      let topic: string | undefined
      try {
        const content = await readFile(path.join(dir, file), 'utf-8')
        // Try YAML frontmatter first (preferred, set by wiki-builder prompt)
        const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/)
        if (fmMatch && fmMatch[1]) {
          const lines = fmMatch[1].split('\n')
          for (const line of lines) {
            const kv = line.match(/^(\w+):\s*(.+?)\s*$/)
            if (!kv) continue
            const key = kv[1]
            const value = (kv[2] ?? '').replace(/^['"]|['"]$/g, '').trim()
            if (key === 'title' && value) title = value
            else if (key === 'topic' && value) topic = value
            else if (key === 'type' && (value === 'index' || value === 'chunk')) {
              type = value
            }
          }
        } else {
          // Fall back to first H1
          const m = content.match(/^\s*#\s+(.+?)\s*$/m)
          if (m && m[1]) title = m[1].trim()
        }
      } catch {
        // ignore — fall back to filename
      }
      pages.push({ file, type, title, ...(topic ? { topic } : {}) })
    }

    // Document Center v2: parse the agent-written image sidecar
    // (_moss_images.md) into a lightweight index. Caption only (not the full
    // detail) so meta stays small; detail is fetched on demand from the
    // sidecar itself. Absent sidecar → empty images[].
    const images = await parseImageSidecar(dir)

    const meta = {
      version: 2 as const,
      wikiId: wiki.id,
      name: wiki.name,
      description: wiki.description,
      startedAt,
      builtAt: Date.now(),
      sourceDocumentIds: wiki.sourceDocumentIds,
      pages,
      images,
    }
    await writeFile(
      path.join(dir, '_moss_meta.json'),
      JSON.stringify(meta, null, 2),
      'utf-8',
    )
  }

  /**
   * Read the `startedAt` recency marker from an existing wiki's
   * `_moss_meta.json`. Returns null if the dir/file is absent or
   * unparseable (treated as "no existing build" / oldest possible).
   */
  private async readPublishedStartedAt(wikiDir: string): Promise<number | null> {
    try {
      const raw = await readFile(path.join(wikiDir, '_moss_meta.json'), 'utf-8')
      const parsed = JSON.parse(raw) as { startedAt?: unknown }
      return typeof parsed.startedAt === 'number' ? parsed.startedAt : null
    } catch {
      return null
    }
  }

  /**
   * Atomically publish a fully-built staging dir into the live wiki dir,
   * lock-free, with last-started-wins semantics.
   *
   * Swap sequence (all on the same filesystem, so each rename is atomic):
   *   1. rename  wikis/<id>            → <stage>.old      (if live dir exists)
   *   2. rename  <stage>               → wikis/<id>
   *   3. rm -rf  <stage>.old                              (best-effort)
   *
   * Recency gate: before swapping, compare this build's startedAt to the
   * live wiki's _moss_meta.json.startedAt. If a newer build already
   * published, skip the swap entirely (the caller's finally rm's the
   * stage). This is a read-then-act check WITHOUT a lock, so two swaps
   * racing in the sub-ms window between read and rename can both proceed —
   * an accepted, rare staleness race (an earlier build may win). What we
   * must NOT do is lose the wiki: every failure path is fail-safe.
   *
   * Fail-safe rules (the important part):
   *   - Step 1 ENOENT (no live dir — first build) is normal: proceed.
   *   - If step 2 fails AFTER step 1 moved the live dir aside, restore it
   *     (.old → wikis/<id>) so the wiki is never left absent, then throw.
   *   - On ANY swap error, if wikis/<id> currently EXISTS, another swap
   *     already won — do NOT revert over it; just drop our stage and return.
   *   - Step 3 (.old cleanup) failing is cosmetic: log, never throw.
   */
  private async publishStaged(wiki: WikiRecord, stageDir: string, startedAt: number): Promise<void> {
    const liveDir = wiki.storagePath
    const oldDir = `${stageDir}.old`

    // Recency gate (best-effort, lock-free). A newer published build wins.
    const publishedStartedAt = await this.readPublishedStartedAt(liveDir)
    if (publishedStartedAt !== null && publishedStartedAt > startedAt) {
      console.log(
        `[WikiJobExecutor] skipping publish for wiki=${wiki.id}: ` +
          `live build (startedAt=${publishedStartedAt}) is newer than this one (startedAt=${startedAt})`,
      )
      return // caller's finally removes stageDir
    }

    let movedAside = false
    try {
      // Step 1: move the current live dir aside (skip if first build).
      try {
        await rename(liveDir, oldDir)
        movedAside = true
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        // ENOENT: no existing wiki dir — first build. Proceed to step 2.
      }

      // Step 2: move our freshly-built dir into place.
      await rename(stageDir, liveDir)
    } catch (err) {
      // A concurrent swap already populated the live dir — it won. Don't
      // clobber the winner; abandon our publish and let finally clean up.
      if (await this.pathExists(liveDir)) {
        console.warn(
          `[WikiJobExecutor] publish race for wiki=${wiki.id}: live dir present after error, ` +
            `another build won; abandoning this publish`,
        )
        // If we'd moved our copy of the old dir aside, drop it.
        if (movedAside) {
          await rm(oldDir, { recursive: true, force: true }).catch(() => {})
        }
        return
      }
      // Live dir is absent and we moved the old one aside — restore it so
      // the wiki is never left missing, then surface the failure.
      if (movedAside) {
        await rename(oldDir, liveDir).catch((revertErr) => {
          console.error(
            `[WikiJobExecutor] CRITICAL: failed to restore wiki=${wiki.id} from ${oldDir} after swap error:`,
            revertErr,
          )
        })
      }
      throw err
    }

    // Step 3: best-effort cleanup of the previous version. The new wiki is
    // already live; a cleanup failure must not fail the build.
    if (movedAside) {
      await rm(oldDir, { recursive: true, force: true }).catch((e) => {
        console.error(`[WikiJobExecutor] failed to remove old wiki dir ${oldDir}:`, e)
      })
    }
  }

  private async pathExists(p: string): Promise<boolean> {
    try {
      await stat(p)
      return true
    } catch {
      return false
    }
  }

  /**
   * Reclaim orphaned staging artifacts left by a crash mid-build or
   * mid-swap. Called once on start().
   *
   * The one dangerous crash window is between publishStaged step 1 and step
   * 2: the live wiki dir has been renamed to `<stage>.old` and the live
   * path is absent. Recover that first — restore `<wikiId>.<jobId>.old` →
   * `wikis/<wikiId>` if the live dir is missing — before deleting any other
   * `.stage/` leftovers (abandoned builds, post-publish `.old` dirs).
   */
  private async sweepStaging(): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(STAGE_DIR)
    } catch {
      return // .stage/ doesn't exist yet — nothing to sweep
    }

    // Pass 1: recover any interrupted swaps from `<wikiId>.<jobId>.old`.
    for (const name of entries) {
      if (!name.endsWith('.old')) continue
      // name = "<wikiId>.<jobId>.old" → recover wikiId (everything before
      // the last two dot-segments).
      const base = name.slice(0, -'.old'.length) // <wikiId>.<jobId>
      const dotIdx = base.lastIndexOf('.')
      if (dotIdx <= 0) continue
      const wikiId = base.slice(0, dotIdx)
      const liveDir = path.join(MOSS_WIKIS_DIR, wikiId)
      const oldPath = path.join(STAGE_DIR, name)
      if (!(await this.pathExists(liveDir))) {
        // Crash between step 1 and step 2: restore the only surviving copy.
        try {
          await rename(oldPath, liveDir)
          console.warn(`[WikiJobExecutor] recovered wiki=${wikiId} from interrupted swap (${name})`)
          continue
        } catch (e) {
          console.error(`[WikiJobExecutor] failed to recover wiki=${wikiId} from ${name}:`, e)
        }
      }
      // Live dir already present (publish completed) — stale .old, drop it.
      await rm(oldPath, { recursive: true, force: true }).catch(() => {})
    }

    // Pass 2: drop everything else still under .stage/ (abandoned builds).
    let remaining: string[]
    try {
      remaining = await readdir(STAGE_DIR)
    } catch {
      return
    }
    for (const name of remaining) {
      await rm(path.join(STAGE_DIR, name), { recursive: true, force: true }).catch((e) => {
        console.error(`[WikiJobExecutor] failed to sweep staging entry ${name}:`, e)
      })
    }
  }

  /**
   * Convert original uploaded documents (docx/pdf/xlsx/pptx/md/txt) to
   * plain markdown and stage them under `<cwd>/input/` so the wiki-
   * builder agent can read them via its built-in file tools.
   *
   * Conversion strategy (see sources/docParsers.ts):
   *   - .md / .txt          → pass through
   *   - .docx               → mammoth (preserves headings/lists)
   *   - .pdf                → pdf-parse
   *   - everything else     → libreoffice --convert-to txt (if available)
   *   - parser failure / no parser found → raw bytes copied with original
   *     name as a last resort, so the agent can at least see the file
   */
  private async prepareInputs(wiki: WikiRecord, baseDir: string): Promise<void> {
    const inputDir = path.join(baseDir, 'input')
    await mkdir(inputDir, { recursive: true })

    const { parseAndWrite } = await import('../../server/sources/docParsers.js')

    for (const docId of wiki.sourceDocumentIds) {
      // Cross-org lookup: build runs as system, document still has org_id
      const docRow = this.db.getDocument(docId, wiki.orgId)
      if (!docRow) {
        console.warn(`[WikiJobExecutor] source doc ${docId} not found, skipping`)
        continue
      }
      const doc = mapDocumentRow(docRow)
      const safeName = path.basename(doc.fileName)

      try {
        const parsed = await parseAndWrite(doc.storagePath, safeName, inputDir)
        if (parsed) {
          console.log(
            `[WikiJobExecutor] staged ${safeName} via ${parsed.via}`,
          )
        } else {
          // No parser worked. Copy raw bytes so at least the file is
          // present and the agent can pick it up via its read_file tool.
          const content = await readFile(doc.storagePath)
          await writeFile(path.join(inputDir, safeName), content)
          console.warn(
            `[WikiJobExecutor] no parser for ${safeName}; copied raw bytes`,
          )
        }
      } catch (err) {
        console.warn(`[WikiJobExecutor] failed to stage source doc ${docId}:`, err)
      }
    }
  }

  /**
   * Send the wiki-builder prompt over the session attach socket and wait
   * for the runner to emit a terminal `result` line.
   */
  private async driveSession(
    socket: import('net').Socket,
    jobId: string,
    prompt: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return new Promise(resolve => {
      let buffer = ''
      let lastProgress = 40
      let settled = false

      const settle = (r: { ok: boolean; error?: string }) => {
        if (settled) return
        settled = true
        socket.removeAllListeners('data')
        socket.removeAllListeners('error')
        socket.removeAllListeners('close')
        resolve(r)
      }

      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        while (true) {
          const idx = buffer.indexOf('\n')
          if (idx < 0) break
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (!line.trim()) continue

          try {
            const parsed = JSON.parse(line)
            if (parsed.type === 'stdout' && typeof parsed.line === 'string') {
              this.handleAgentLine(parsed.line, jobId, (step) => {
                lastProgress = Math.min(lastProgress + 5, 90)
                this.docStore.updateBuildJob(jobId, {
                  progress: lastProgress,
                  currentStep: step,
                })
              }, settle)
            } else if (parsed.type === 'exit') {
              settle({ ok: true })
              return
            }
          } catch {
            // Non-JSON noise — ignore
          }
        }
      })

      socket.on('error', err => {
        settle({ ok: false, error: err instanceof Error ? err.message : String(err) })
      })

      socket.on('close', () => {
        settle({ ok: true })
      })

      // Send the prompt to the runner
      socket.write(JSON.stringify({ type: 'stdin', data: prompt + '\n' }) + '\n')
    })
  }

  private handleAgentLine(
    line: string,
    _jobId: string,
    bumpProgress: (step: string) => void,
    settle: (r: { ok: boolean; error?: string }) => void,
  ): void {
    try {
      const msg = JSON.parse(line)
      if (msg.type === 'tool_use') {
        const toolName = msg.name ?? msg.tool_name ?? 'tool'
        bumpProgress(`Agent 调用 ${toolName}`)
      } else if (msg.type === 'assistant') {
        bumpProgress('Agent 正在生成内容')
      } else if (msg.type === 'finish' || msg.type === 'result') {
        settle({ ok: true })
      } else if (msg.type === 'error') {
        settle({ ok: false, error: msg.message ?? msg.error ?? 'agent error' })
      }
    } catch {
      // ignore
    }
  }

  private failJob(jobId: string, wikiId: string, message: string): void {
    this.docStore.updateBuildJob(jobId, {
      status: 'failed',
      currentStep: '构建失败',
      errorMessage: message,
      finishedAt: Date.now(),
    })
    this.docStore.setWikiBuildResult(wikiId, {
      status: 'failed',
      lastBuildError: message,
    })
  }
}

export type WikiImageEntry = { id: string; chunk: string; caption: string }

/**
 * Parse the agent-written `_moss_images.md` sidecar into a lightweight index.
 * Strict format (one block per image), as specified in the wiki-builder
 * prompt:
 *
 *   ## <id>
 *   - chunk: <chunk file>
 *   - caption: <short caption>
 *   - detail: <2-5 sentences>      // not indexed here; stays in the sidecar
 *
 * Returns caption-only entries (`detail` is intentionally dropped to keep
 * `_moss_meta.json` small). Missing/blank fields fall back to empty strings;
 * a missing sidecar yields []. Never throws.
 */
export async function parseImageSidecar(dir: string): Promise<WikiImageEntry[]> {
  let raw: string
  try {
    raw = await readFile(path.join(dir, '_moss_images.md'), 'utf-8')
  } catch {
    return []
  }
  const entries: WikiImageEntry[] = []
  // Split on level-2 headings; each `## <id>` starts a new image block.
  const blocks = raw.split(/^##\s+/m).slice(1)
  for (const block of blocks) {
    const lines = block.split('\n')
    const id = (lines[0] ?? '').trim()
    if (!id) continue
    let chunk = ''
    let caption = ''
    for (const line of lines.slice(1)) {
      const m = line.match(/^\s*-\s*(chunk|caption)\s*:\s*(.+?)\s*$/)
      if (!m) continue
      if (m[1] === 'chunk') chunk = m[2]
      else if (m[1] === 'caption') caption = m[2]
    }
    entries.push({ id, chunk, caption })
  }
  return entries
}

/**
 * Soft-validate image captioning: list every `![](images/...)` reference in
 * the built chunk `.md` files that lacks a matching entry in the image
 * sidecar (`_moss_images.md`). Decorative images the agent chose not to
 * caption will surface here too — this is a warning signal, not a hard
 * failure (we cannot reliably distinguish "skipped decorative" from
 * "missed figure" without re-running vision). Never throws.
 */
export async function findUncaptionedImages(dir: string): Promise<string[]> {
  const sidecar = await parseImageSidecar(dir)
  const captioned = new Set(sidecar.map((e) => e.id))
  let files: string[]
  try {
    files = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== '_moss_images.md')
      .map((e) => e.name)
  } catch {
    return []
  }
  const missing = new Set<string>()
  // ![alt](images/<name>.ext) — capture the basename sans extension as the id.
  const imgRe = /!\[[^\]]*\]\(images\/([^)]+?)\)/g
  for (const file of files) {
    let content: string
    try {
      content = await readFile(path.join(dir, file), 'utf-8')
    } catch {
      continue
    }
    let m: RegExpExecArray | null
    while ((m = imgRe.exec(content)) !== null) {
      const ref = m[1] ?? ''
      const base = path.posix.basename(ref).replace(/\.[^.]+$/, '')
      if (base && !captioned.has(base)) missing.add(base)
    }
  }
  return [...missing]
}

// Helper: map row to record (avoids importing private mappers from documentStore)
function mapDocumentRow(row: Record<string, unknown>): DocumentRecord {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    nodeId: String(row.node_id),
    fileName: String(row.file_name),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    storagePath: String(row.storage_path),
    uploadedBy: String(row.uploaded_by),
    uploadedAt: Number(row.uploaded_at),
  }
}
