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

import { readFile, mkdir, readdir, writeFile } from 'fs/promises'
import path from 'path'
import { RuntimeService } from '../../server/runtimeService.js'
import { DocumentStore, type DocumentRecord, type WikiBuildJob, type WikiRecord } from '../../server/documentStore.js'
import type { DirectConnectStore } from '../../server/db.js'

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

    // Mark job + wiki as running
    this.docStore.updateBuildJob(job.id, {
      status: 'running',
      progress: 5,
      currentStep: '准备工作目录',
      startedAt: Date.now(),
    })
    this.docStore.setWikiBuildResult(job.wikiId, { status: 'running' })

    let wiki: WikiRecord | null = null
    try {
      wiki = this.docStore.getWikiById(job.wikiId)
      if (!wiki) throw new Error(`wiki ${job.wikiId} not found`)

      // Stage 1: prepare cwd/input with predigested markdown
      await this.prepareInputs(wiki)
      this.docStore.updateBuildJob(job.id, { progress: 25, currentStep: '调用 AI 生成 Wiki' })

      // Stage 2: spawn agent session
      const created = await this.runtime.createSession({
        cwd: wiki.storagePath,
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

      // Stage 4: verify output presence
      const wikiIndexPath = path.join(wiki.storagePath, 'WIKI.md')
      try {
        await readFile(wikiIndexPath, 'utf-8')
      } catch {
        throw new Error('build finished but WIKI.md was not produced')
      }

      // Stage 5: write _moss_meta.json so wikiCli and tooling can
      // inspect the wiki without re-scanning the directory each time.
      // Includes the page list (WIKI.md + chunk-*.md) with type/title.
      try {
        await this.writeWikiMeta(wiki)
      } catch (err) {
        console.error('[WikiJobExecutor] failed to write _moss_meta.json:', err)
        // Non-fatal — wiki is still usable via wikiCli's directory scan.
      }

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
    }
  }

  /**
   * Document Center v2: write `_moss_meta.json` summarizing the built
   * wiki. Format:
   *   {
   *     version: 1,
   *     wikiId, name, description,
   *     builtAt (epoch ms),
   *     sourceDocumentIds: [...],
   *     pages: [{ file, type: 'index'|'chunk', title }]
   *   }
   *
   * Title is extracted from each markdown's first `# ` heading; falls
   * back to the file name (sans `.md`). wikiCli reads this file to
   * give the agent a structured table of contents without re-parsing
   * every chunk on each request.
   */
  private async writeWikiMeta(wiki: WikiRecord): Promise<void> {
    const entries = await readdir(wiki.storagePath, { withFileTypes: true })
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
        const content = await readFile(path.join(wiki.storagePath, file), 'utf-8')
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

    const meta = {
      version: 1 as const,
      wikiId: wiki.id,
      name: wiki.name,
      description: wiki.description,
      builtAt: Date.now(),
      sourceDocumentIds: wiki.sourceDocumentIds,
      pages,
    }
    await writeFile(
      path.join(wiki.storagePath, '_moss_meta.json'),
      JSON.stringify(meta, null, 2),
      'utf-8',
    )
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
  private async prepareInputs(wiki: WikiRecord): Promise<void> {
    const inputDir = path.join(wiki.storagePath, 'input')
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
