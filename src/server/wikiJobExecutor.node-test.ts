import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { WikiBuildJob, WikiRecord } from './documentStore.js'
import type { WorkspaceFileAccess } from './backends/podWorkspace.js'
import type { SessionCreateInput, SessionRecord } from './types.js'

void test('a cloud Wiki job receives its sources and instructions, collects output, and releases its session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-cloud-job-'))
  const previousHome = process.env.MOSS_HOME
  process.env.MOSS_HOME = root
  try {
    const promptDir = join(root, 'assistants', 'system', 'wiki-builder')
    await mkdir(promptDir, { recursive: true })
    await writeFile(join(promptDir, 'wiki-builder.md'), 'Trusted builtin Wiki instructions for the source documents')
    const { WikiJobExecutor } = await import('../channels/gateway/WikiJobExecutor.js')
    for (const fixture of [
      { name: 'single-instance', claimedBy: null, instanceId: undefined, isFailure: false, expectedStatus: 'succeeded' },
      { name: 'owned-instance', claimedBy: 'owner', instanceId: 'owner', isFailure: false, expectedStatus: 'succeeded' },
      { name: 'lost-owner', claimedBy: 'peer', instanceId: 'owner', isFailure: false, expectedStatus: 'cancelled' },
      { name: 'foreign-claim', claimedBy: 'peer', instanceId: undefined, isFailure: false, expectedStatus: 'cancelled' },
      { name: 'unsafe-output', claimedBy: null, instanceId: undefined, isFailure: true, expectedStatus: 'failed' },
    ]) {
      const { isFailure } = fixture
      const jobId = fixture.name
      const job = { id: jobId, wikiId: 'owned-wiki', status: 'running', claimedBy: fixture.claimedBy } as WikiBuildJob
      const wiki = { id: job.wikiId, orgId: 'org-fixture', name: 'Owned fixture', storagePath: join(root, 'live'), sourceDocumentIds: [] } as unknown as WikiRecord
      const files = new Map<string, Buffer>()
      const terminated: string[] = []
      let createdInput: SessionCreateInput | undefined
      let status = 'running'
      let isPublished = false
      const runtime = {
        createSession: async (input: SessionCreateInput) => {
          createdInput = input
          return { sessionId: 'build-' + jobId, cwd: input.cwd!, runtime: { type: 'k8s' } } as SessionRecord
        },
        ensureSessionReady: async () => ({ attempt: {} }),
        connectToAttempt: async () => ({ destroy: () => {} }),
        terminateSession: async (id: string) => { terminated.push(id) },
      }
      const documents = {
        getWikiById: async () => wiki,
        getBuildJob: async () => ({ ...job, status }),
        updateBuildJob: async (_id: string, patch: { status?: string }) => { if (patch.status) status = patch.status },
        setWikiBuildResult: async () => {},
      }
      const workspace = {
        writeFile: async (file: string, bytes: Buffer) => { files.set(file, bytes) },
        listTree: async () => [...files].map(([relativePath, bytes]) => ({ relativePath, size: bytes.length, isDir: false, ...(isFailure && relativePath === 'WIKI.md' ? { isSymbolicLink: true } : {}) })),
        readFile: async (file: string) => files.get(file)!,
      } satisfies WorkspaceFileAccess
      const executor = new WikiJobExecutor(runtime as never, documents as never,
        { markWikiNeedsRebuild: async () => {} } as never, undefined, fixture.instanceId, () => workspace)
      const internals = executor as unknown as {
        running: Map<string, { startedAt: number; sessionId?: string }>
        prepareInputs: (_wiki: WikiRecord, stage: string) => Promise<string[]>
        driveSession: (_socket: unknown, _jobId: string, prompt: string) => Promise<{ ok: boolean }>
        publishStaged: (_wiki: WikiRecord, stage: string) => Promise<void>
        runJob: (input: WikiBuildJob) => Promise<void>
      }
      internals.running.set(jobId, { startedAt: Date.now() })
      internals.prepareInputs = async (_wiki, stage) => {
        await mkdir(join(stage, 'input'), { recursive: true })
        await writeFile(join(stage, 'input', 'facts.md'), 'Controlled source fact')
        return ['owned-document']
      }
      internals.driveSession = async (_socket, _jobId, prompt) => {
        assert.match(prompt, /Trusted builtin Wiki instructions/)
        assert.equal(files.get('input/facts.md')?.toString(), 'Controlled source fact')
        files.set('WIKI.md', Buffer.from('# Generated source facts'))
        files.set('chunk-001-facts.md', Buffer.from('# Controlled source fact'))
        files.set('MEMORY.md', Buffer.from('Private runtime memory'))
        return { ok: true }
      }
      internals.publishStaged = async (_wiki, stage) => {
        assert.equal(await readFile(join(stage, 'WIKI.md'), 'utf8'), '# Generated source facts')
        await assert.rejects(readFile(join(stage, 'MEMORY.md')), { code: 'ENOENT' })
        isPublished = true
      }
      await internals.runJob(job)
      assert.equal(status, fixture.expectedStatus, fixture.name)
      assert.equal(isPublished, fixture.expectedStatus === 'succeeded', fixture.name)
      assert.deepEqual(terminated, ['build-' + jobId])
      assert.deepEqual(createdInput?.runtime, { hostMode: 'session', dockerMode: 'session', k8sMode: 'session' })
      assert.deepEqual(createdInput?.enabledSkills, [])
    }
  } finally {
    if (previousHome === undefined) delete process.env.MOSS_HOME
    else process.env.MOSS_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})
