/**
 * Scheduled-task runs: a job in "reuse" mode sends many runs into one
 * session. Each run is digested on its own, named after the job and the run's
 * start time, and every search hit says where it came from.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, utimesSync, writeFileSync } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { CronService } from '../../services/cron/CronService.js'
import { runUnitKey } from '../digestService.js'
import { cronRunNote, formatRunTime } from '../runLabel.js'
import type { Summarizer } from '../summarizer.js'
import { createFixture, ORG, PAIR_AGENTS, configurePair, type Fixture } from './agentifyFixture.js'

const DAY = 24 * 3600 * 1000
const SHOUHOU = 'agent-shouhou-uuid'
const JOB_NAME = '类目经营日报'

function line(role: 'user' | 'assistant', text: string, sessionId: string, at: number): string {
  const message = role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] }
  return `${JSON.stringify({ type: role, sessionId, uuid: randomUUID(), parentUuid: null, isSidechain: false, timestamp: new Date(at).toISOString(), message })}\n`
}

/** A reused scheduled-task session the way the scheduler leaves it: one session, a run row per fire. */
function cronSession(fx: Fixture) {
  const jobId = randomUUID()
  const now = Date.now()
  fx.store.db
    .prepare(`INSERT INTO cron_jobs (id, org_id, user_id, name, schedule_kind, schedule_value, payload_message, conversation_mode, assistant_id, assistant_name, created_at, updated_at)
              VALUES (?, ?, 'u-owner', ?, 'cron', '30 10 * * 1-5', '生成经营日报文件', 'reuse', ?, '售后返厂助手', ?, ?)`)
    .run(jobId, ORG, JOB_NAME, SHOUHOU, now, now)
  const sessionId = fx.addSession({
    agent: 'shouhou',
    userId: 'u-owner',
    source: JSON.stringify({ source: 'cron', cronJobId: jobId, cronJobName: JOB_NAME }),
    turns: [],
  })
  const s = fx.store.db.prepare('SELECT transcript_path, cwd FROM sessions WHERE session_id = ?').get(sessionId) as { transcript_path: string; cwd: string }
  writeFileSync(s.transcript_path, '')
  const runs: Array<{ runId: string; startedAt: number }> = []
  /** One fire: its run row, the note + message, the agent's reply, and the report it wrote. */
  const addRun = (startedAt: number, reply: string, file: { name: string; content: string }, runUser = 'u-owner') => {
    const runId = randomUUID()
    fx.store.db
      .prepare(`INSERT INTO cron_job_runs (id, job_id, org_id, user_id, session_id, status, started_at, finished_at, created_at)
                VALUES (?, ?, ?, ?, ?, 'ok', ?, ?, ?)`)
      .run(runId, jobId, ORG, runUser, sessionId, startedAt, startedAt + 60_000, startedAt - 1000)
    appendFileSync(s.transcript_path, line('user', `${cronRunNote(JOB_NAME, startedAt)}\n生成经营日报文件`, sessionId, startedAt + 1000))
    appendFileSync(s.transcript_path, line('assistant', reply, sessionId, startedAt + 30_000))
    const p = path.join(s.cwd, file.name)
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, file.content)
    // Written while the agent works, after it started replying.
    utimesSync(p, new Date(startedAt + 31_000), new Date(startedAt + 31_000))
    const last = startedAt + 32_000
    utimesSync(s.transcript_path, new Date(last), new Date(last))
    fx.store.db.prepare('UPDATE sessions SET created_at = MIN(created_at, ?), last_active_at = ? WHERE session_id = ?').run(startedAt, last, sessionId)
    runs.push({ runId, startedAt })
    return runId
  }
  return { jobId, sessionId, cwd: s.cwd, runs, addRun }
}

/** Counts summary model calls. */
function countingSummarizer(fx: Fixture): { calls: string[] } {
  const seen = { calls: [] as string[] }
  const deps = (fx.svc.digest as unknown as { deps: { summarizer: Summarizer } }).deps
  const inner = deps.summarizer
  deps.summarizer = {
    async summarize(input) {
      seen.calls.push(input.origin)
      return inner.summarize(input)
    },
  }
  return seen
}

describe('scheduled-task runs in history', () => {
  let fx: Fixture
  afterEach(() => fx?.cleanup())

  it('digests a reused session one run at a time, each named by the run’s start time', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    const job = cronSession(fx)
    const t1 = Date.now() - 20 * DAY
    const t2 = Date.now() - 10 * DAY
    const t3 = Date.now() - 2 * DAY
    job.addRun(t1, '锂电项目组 GMV 118 万，毛利率 21%', { name: '经营日报_run1.md', content: '# 经营日报\n锂电 GMV 118 万\n' })
    job.addRun(t2, '锂电项目组 GMV 131 万，阀芯缺货预警', { name: '经营日报_run2.md', content: '# 经营日报\n阀芯缺货预警 3 个 SKU\n' })
    job.addRun(t3, '锂电项目组 GMV 125 万，无预警', { name: '经营日报_run3.md', content: '# 经营日报\n锂电 GMV 125 万\n' }, 'u-clicker')
    const counter = countingSummarizer(fx)

    assert.equal((await fx.svc.digest.digestAgent(ORG, SHOUHOU)).digested, 1)
    assert.equal(counter.calls.length, 3, 'one summary per run')
    assert.equal(fx.svc.store.getDocByKey(ORG, SHOUHOU, `summary:${job.sessionId}`), null, 'no whole-session summary')

    const runs = fx.store.db.prepare('SELECT id, started_at FROM cron_job_runs WHERE session_id = ? ORDER BY started_at').all(job.sessionId) as Array<{ id: string; started_at: number }>
    const keys = runs.map(r => runUnitKey(job.sessionId, { runId: r.id, startedAt: r.started_at, userId: '', jobName: null, timeZone: null }))
    const docs = keys.map(k => fx.svc.store.getDocByKey(ORG, SHOUHOU, `summary:${k}`)!)
    docs.forEach((d, i) => {
      const at = [t1, t2, t3][i]!
      assert.ok(d, `run ${i + 1} has its own summary`)
      assert.equal(d.title, `售后返厂助手｜定时任务「${JOB_NAME}」${formatRunTime(at)}`)
      assert.equal(d.meta.origin, `定时任务「${JOB_NAME}」${formatRunTime(at)} 的运行（员工 ${i === 2 ? '用户u-clicker' : '用户u-owner'}名下）`)
      assert.equal(d.createdAt, at, 'dated by the run')
      assert.equal(d.sessionId, job.sessionId)
    })
    // Who the run executed as owns it (a manual trigger runs as whoever clicked).
    assert.equal(docs[2]!.userId, 'u-clicker')

    // Each run keeps only its own report, and the file hit says which run produced it.
    const home = path.join(fx.dir, 'agent-home', ORG, SHOUHOU)
    assert.ok(existsSync(path.join(home, 'artifacts', keys[1]!, '经营日报_run2.md')))
    assert.ok(!existsSync(path.join(home, 'artifacts', keys[1]!, '经营日报_run1.md')))
    const hits = await fx.svc.index.search({ orgId: ORG, agentId: SHOUHOU, query: '阀芯缺货预警', viewer: { kind: 'user', userId: 'u-owner' } })
    const fileHit = hits.find(h => h.kind === 'artifact' && h.title.startsWith('经营日报_run2.md'))
    assert.ok(fileHit, 'the report is found by its content')
    assert.equal(fileHit.origin, `定时任务「${JOB_NAME}」${formatRunTime(t2)} 的运行（员工 用户u-owner名下）`)
    const summaryHit = hits.find(h => h.kind === 'summary')
    assert.ok(summaryHit && summaryHit.title.includes(formatRunTime(t2)), 'the summary hit is the run that raised the warning')

    // The history list (what `agentctl history list` prints) carries the origin too.
    const listed = fx.svc.store.listDocs({ orgId: ORG, agentId: SHOUHOU, kinds: ['summary'], limit: 10 })
    assert.equal(listed.length, 3)
    assert.ok(listed.every(d => String(d.meta.origin).startsWith(`定时任务「${JOB_NAME}」`)))
  })

  it('a new run costs one summary; finished runs are not redone', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    const job = cronSession(fx)
    job.addRun(Date.now() - 3 * DAY, '第一轮', { name: 'a.md', content: 'a' })
    job.addRun(Date.now() - 2 * DAY, '第二轮', { name: 'b.md', content: 'b' })
    const counter = countingSummarizer(fx)
    await fx.svc.digest.digestAgent(ORG, SHOUHOU)
    assert.equal(counter.calls.length, 2)

    job.addRun(Date.now() - 1 * DAY, '第三轮', { name: 'c.md', content: 'c' })
    await fx.svc.digest.digestAgent(ORG, SHOUHOU)
    assert.equal(counter.calls.length, 3, 'only the new run is summarised')
    assert.equal(fx.svc.store.listDocs({ orgId: ORG, agentId: SHOUHOU, kinds: ['summary'], limit: 10 }).length, 3)
  })

  it('replaces a whole-session digest from before, and deletes old runs without touching newer ones', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    const cfg = fx.svc.store.getAgent(ORG, SHOUHOU)!.config
    await fx.svc.configure(ORG, 'shouhou', { ...cfg, memory: { ...cfg.memory, digestLookbackHours: 100 * 24, deleteAfterHours: 0 } })
    const job = cronSession(fx)
    const old = Date.now() - 40 * DAY
    job.addRun(old, '四十天前：灯具 7 件', { name: 'old.md', content: '灯具 7 件' })
    job.addRun(Date.now() - 2 * DAY, '两天前：花洒 3 件', { name: 'new.md', content: '花洒 3 件' })

    // As digested before this change: the scheduler's runs were not known, one document set for the session.
    const runRows = fx.store.db.prepare('SELECT * FROM cron_job_runs WHERE session_id = ?').all(job.sessionId)
    fx.store.db.prepare('DELETE FROM cron_job_runs WHERE session_id = ?').run(job.sessionId)
    await fx.svc.digest.digestAgent(ORG, SHOUHOU)
    assert.ok(fx.svc.store.getDocByKey(ORG, SHOUHOU, `summary:${job.sessionId}`))
    const home = path.join(fx.dir, 'agent-home', ORG, SHOUHOU)
    assert.ok(existsSync(path.join(home, 'artifacts', job.sessionId)))
    for (const r of runRows as Array<Record<string, unknown>>) {
      fx.store.db
        .prepare(`INSERT INTO cron_job_runs (id, job_id, org_id, user_id, session_id, status, started_at, finished_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(r.id as string, r.job_id as string, r.org_id as string, r.user_id as string, r.session_id as string, r.status as string, r.started_at as number, r.finished_at as number, r.created_at as number)
    }
    fx.svc.store.deleteDigestState(job.sessionId)
    await fx.svc.digest.digestAgent(ORG, SHOUHOU)
    assert.equal(fx.svc.store.getDocByKey(ORG, SHOUHOU, `summary:${job.sessionId}`), null, 'whole-session documents replaced')
    assert.equal(fx.svc.store.listSessionDocs(ORG, SHOUHOU, job.sessionId, `file:${job.sessionId}:`).length, 0)
    assert.ok(!existsSync(path.join(home, 'artifacts', job.sessionId)), 'whole-session copies removed')
    assert.equal(fx.svc.store.listDocs({ orgId: ORG, agentId: SHOUHOU, kinds: ['summary'], limit: 10 }).length, 2)

    // Delete after 30 days: the 40-day-old run goes, the recent one stays.
    await fx.svc.configure(ORG, 'shouhou', { ...cfg, memory: { ...cfg.memory, deleteAfterHours: 30 * 24 } })
    const purged = await fx.svc.digest.purgeExpired()
    assert.equal(purged.sessions, 1)
    const left = fx.svc.store.listDocs({ orgId: ORG, agentId: SHOUHOU, kinds: ['summary'], limit: 10 })
    assert.equal(left.length, 1)
    assert.ok(left[0]!.title.includes(formatRunTime(job.runs[1]!.startedAt)))
    const oldKey = runUnitKey(job.sessionId, { runId: job.runs[0]!.runId, startedAt: old, userId: '', jobName: null, timeZone: null })
    assert.ok(!existsSync(path.join(home, 'artifacts', oldKey)), 'the old run’s copies are gone')
    assert.ok(existsSync(path.join(home, 'artifacts', runUnitKey(job.sessionId, { runId: job.runs[1]!.runId, startedAt: job.runs[1]!.startedAt, userId: '', jobName: null, timeZone: null }), 'new.md')))

    // The next run does not bring the deleted one back.
    const counter = countingSummarizer(fx)
    job.addRun(Date.now() - 1 * DAY, '昨天：阀芯 2 件', { name: 'next.md', content: '阀芯 2 件' })
    await fx.svc.digest.digestAgent(ORG, SHOUHOU)
    assert.equal(counter.calls.length, 1)
    assert.equal(fx.svc.store.getDocByKey(ORG, SHOUHOU, `summary:${oldKey}`), null)
  })

  it('sessions people start are still one document set', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    const s = fx.addSession({ agent: 'shouhou', userId: 'u', turns: [{ role: 'user', text: '统计返厂' }, { role: 'assistant', text: '共 12 件' }] })
    await fx.svc.digest.digestAgent(ORG, SHOUHOU)
    const doc = fx.svc.store.getDocByKey(ORG, SHOUHOU, `summary:${s}`)!
    assert.ok(doc)
    assert.equal(doc.meta.origin, '员工 用户u发起的对话')
    const hits = await fx.svc.index.search({ orgId: ORG, agentId: SHOUHOU, query: '返厂', viewer: { kind: 'user', userId: 'u' } })
    assert.equal(hits.find(h => h.kind === 'summary')?.origin, '员工 用户u发起的对话')
  })
})

describe('the run note', () => {
  let fx: Fixture
  afterEach(() => fx?.cleanup())

  it('names the job and the run’s start time, in the job’s time zone', () => {
    const at = Date.UTC(2026, 10, 4, 2, 30)
    assert.equal(formatRunTime(at), '2026-11-04 10:30', 'Asia/Shanghai by default, like the scheduler')
    assert.equal(formatRunTime(at, 'UTC'), '2026-11-04 02:30')
    assert.equal(cronRunNote('类目经营日报', at), '【定时任务「类目经营日报」本轮运行，开始于 2026-11-04 10:30】')
  })

  it('is added to the run’s message for agentified agents only', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    const cron = new CronService(fx.store.db, {
      runtimeService: {} as never,
      runtimeDir: path.join(fx.dir, 'runtime'),
      defaultRuntime: 'host',
      dockerContainerMode: 'session',
      getUserAuth: async () => ({ role: 'user', scopes: [] }),
    })
    const message = (job: Record<string, unknown>, run: { id: string }) =>
      (cron as unknown as { runMessage(j: unknown, r: unknown): Promise<string> }).runMessage(job, run)
    const job = { id: 'j', orgId: ORG, name: '返厂日报', payloadMessage: '履行你的职责', assistantId: SHOUHOU, assistantName: '售后返厂助手', schedule: { kind: 'cron', value: '0 10 * * 1-5' } }
    const store = cron.getStore()
    const run = store.createRun('j', ORG, 'u')
    store.startRun(run.id)
    const startedAt = store.getRunById(run.id)!.startedAt!

    assert.equal(await message(job, run), '履行你的职责', 'no note before agentify is wired')
    cron.setRunNote(({ job: j, startedAt: at }) =>
      fx.svc.cronRunNote({ orgId: j.orgId, assistant: j.assistantId ?? j.assistantName, jobName: j.name, startedAt: at, timeZone: j.schedule.tz }),
    )
    assert.equal(await message(job, run), `【定时任务「返厂日报」本轮运行，开始于 ${formatRunTime(startedAt)}】\n履行你的职责`)
    // An agent without agentify: the message is unchanged.
    assert.equal(await message({ ...job, assistantId: 'agent-other-uuid', assistantName: '其他助手' }, run), '履行你的职责')
    // A failing note never blocks the run.
    cron.setRunNote(async () => {
      throw new Error('boom')
    })
    assert.equal(await message(job, run), '履行你的职责')
  })
})
