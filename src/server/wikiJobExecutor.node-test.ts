import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { WikiBuildJob, WikiRecord } from './documentStore.js'
import type { WorkspaceFileAccess } from './backends/podWorkspace.js'
import type { SessionCreateInput, SessionRecord } from './types.js'
import type { WikiSourceSnapshot } from './wikiSourceSnapshot.js'
import { createHash } from 'node:crypto'

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
        prepareInputs: (_wiki: WikiRecord, stage: string) => Promise<WikiSourceSnapshot[]>
        driveSession: (_socket: unknown, _jobId: string, prompt: string) => Promise<{ ok: boolean }>
        publishStaged: (_wiki: WikiRecord, stage: string) => Promise<void>
        runJob: (input: WikiBuildJob) => Promise<void>
      }
      internals.running.set(jobId, { startedAt: Date.now() })
      internals.prepareInputs = async (_wiki, stage) => {
        await mkdir(join(stage, 'input'), { recursive: true })
        await writeFile(join(stage, 'input', 'facts.md'), 'Controlled source fact')
        await mkdir(`${stage}.sources`, { recursive: true })
        await writeFile(join(`${stage}.sources`, 'owned-document.md'), 'Controlled source fact')
        return [{ id: 'owned-document', fileName: 'facts.md', nodeName: 'Facts', sizeBytes: 22,
          markdownPath: '_sources/owned-document.md', markdownSha256: createHash('sha256').update('Controlled source fact').digest('hex') }]
      }
      internals.driveSession = async (_socket, _jobId, prompt) => {
        assert.match(prompt, /Trusted builtin Wiki instructions/)
        assert.equal(files.get('input/facts.md')?.toString(), 'Controlled source fact')
        files.set('WIKI.md', Buffer.from('# Generated source facts'))
        files.set('chunk-001-facts.md', Buffer.from('# Controlled source fact'))
        files.set('MEMORY.md', Buffer.from('Private runtime memory'))
        assert.equal(files.has('_sources/owned-document.md'), false, 'model never receives authoritative snapshot')
        return { ok: true }
      }
      internals.publishStaged = async (_wiki, stage) => {
        assert.deepEqual(terminated, ['build-' + jobId], `${fixture.name} releases its runtime before publish`)
        assert.equal(await readFile(join(stage, 'WIKI.md'), 'utf8'), '# Generated source facts')
        const meta = JSON.parse(await readFile(join(stage, '_moss_meta.json'), 'utf8'))
        assert.deepEqual(meta.sourceDocumentIds, ['owned-document'])
        assert.equal(meta.sourceDocuments[0].markdownPath, '_sources/owned-document.md')
        assert.equal(await readFile(join(stage, '_sources', 'owned-document.md'), 'utf8'), 'Controlled source fact')
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

void test('same-named build inputs and snapshots preserve each distinct document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-duplicate-input-'))
  try {
    const { WikiJobExecutor } = await import('../channels/gateway/WikiJobExecutor.js')
    for (const id of ['first', 'second']) await writeFile(join(root, `${id}.md`), `# ${id} policy`)
    const executor = new WikiJobExecutor({} as never, { getNode: async () => ({ name: 'Policies' }) } as never,
      { getDocument: async (id: string) => ({ id, file_name: 'policy.md', storage_path: join(root, `${id}.md`), size_bytes: 20 }) } as never)
    const internals = executor as unknown as { prepareInputs(wiki: WikiRecord, dir: string): Promise<WikiSourceSnapshot[]> }
    const stage = join(root, 'stage')
    const result = await internals.prepareInputs({ orgId: 'park', sourceMode: 'files', sourceDocumentIds: ['first', 'second'] } as WikiRecord, stage)
    assert.equal(result.length, 2)
    for (const id of ['first', 'second']) {
      assert.equal(await readFile(join(stage, 'input', `${id}-policy.md`), 'utf8'), `# ${id} policy`)
      assert.equal(await readFile(join(`${stage}.sources`, `${id}.md`), 'utf8'), `# ${id} policy`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

void test('wiki input snapshots include only files successfully staged and preserve source metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-input-snapshot-'))
  try {
    const { WikiJobExecutor } = await import('../channels/gateway/WikiJobExecutor.js')
    const file = join(root, 'policy.md')
    await writeFile(file, '# Original policy')
    const wiki = { orgId: 'park', sourceMode: 'files', sourceDocumentIds: ['valid', 'missing', 'broken'] } as WikiRecord
    const db = { getDocument: async (id: string, orgId: string) => {
      assert.equal(orgId, 'park')
      if (id === 'missing') return null
      return { id, org_id: orgId, node_id: 'directory', file_name: 'policy.md', mime_type: 'text/markdown', size_bytes: 17, storage_path: id === 'valid' ? file : join(root, 'absent.md'), uploaded_by: 'operator', uploaded_at: 1 }
    } }
    const documents = { getNode: async () => ({ name: 'Original directory' }) }
    const executor = new WikiJobExecutor({} as never, documents as never, db as never)
    const internals = executor as unknown as { prepareInputs(wiki: WikiRecord, dir: string): Promise<WikiSourceSnapshot[]> }
    const result = await internals.prepareInputs(wiki, join(root, 'stage'))
    assert.deepEqual(result, [{ id: 'valid', fileName: 'policy.md', nodeName: 'Original directory', sizeBytes: 17,
      markdownPath: '_sources/valid.md', markdownSha256: createHash('sha256').update('# Original policy').digest('hex') }])
    assert.equal(await readFile(join(root, 'stage', 'input', 'valid-policy.md'), 'utf8'), '# Original policy')
    assert.equal(await readFile(join(root, 'stage.sources', 'valid.md'), 'utf8'), '# Original policy')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
