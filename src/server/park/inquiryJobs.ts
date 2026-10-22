import type { ParkStore } from './store.js'
import { EXTRACTION_VERSION, type InquiryExtractor } from './inquiryExtraction.js'

const workingStores = new WeakSet<ParkStore>()

/** Inference happens outside transactions; only claiming and publishing results are atomic. */
export async function processInquiryJobs(store: ParkStore, extract?: InquiryExtractor): Promise<void> {
  if (workingStores.has(store)) return
  workingStores.add(store)
  try {
    const jobs = await store.db.all<{ inquiry_id: string; org_id: string; session_id: string; signal_json: string; attempts: number }>(
      "SELECT * FROM park_lead_jobs WHERE status = 'queued' AND next_at <= ? ORDER BY next_at LIMIT 20", [Date.now()])
    for (const job of jobs) {
      if (await store.db.run("UPDATE park_lead_jobs SET status = 'processing' WHERE inquiry_id = ? AND status = 'queued'", [job.inquiry_id]) !== 1) continue
      try {
        const row = await store.db.get('SELECT * FROM park_inquiries WHERE org_id = ? AND id = ?', [job.org_id, job.inquiry_id])
        if (!row) throw new Error('Inquiry missing')
        const previous = await store.db.all("SELECT concerns_json FROM park_inquiries WHERE org_id = ? AND session_id = ? AND extraction_status = 'completed' AND created_at < ? ORDER BY created_at DESC LIMIT 10",
          [job.org_id, job.session_id, Number(row.created_at)])
        const previousTopics = previous.flatMap(item => JSON.parse(String(item.concerns_json)) as string[])
        if (!extract) throw new Error('Inquiry extractor unavailable')
        const result = await extract(job.org_id, String(row.redacted_question), previousTopics)
        const signal = result.signal
        await store.db.transaction(async () => {
          await store.db.run(`UPDATE park_inquiries SET category = ?, intent = ?, industry = ?, scale = ?, urgency = ?,
            concerns_json = ?, confidence = ?, extraction_status = 'completed', extraction_json = ?, extraction_version = ? WHERE org_id = ? AND id = ?`,
          [signal.category, signal.intent, signal.industry, signal.scale, signal.urgency, JSON.stringify(signal.concerns), result?.confidence ?? 0,
            JSON.stringify(result?.evidence ?? {}), EXTRACTION_VERSION, job.org_id, job.inquiry_id])
          if (signal.score >= 40) await store.saveLead(job.org_id, job.session_id, job.inquiry_id, signal)
          await store.db.run("UPDATE park_lead_jobs SET status = 'done', last_error = NULL WHERE inquiry_id = ?", [job.inquiry_id])
        })
      } catch (error) {
        const attempts = Number(job.attempts) + 1
        const message = error instanceof Error ? error.message : ''
        const reason = message.startsWith('Unverified') || message.startsWith('Invalid') ? 'EXTRACTION_EVIDENCE_INVALID'
          : message.includes('unavailable') ? 'EXTRACTION_MODEL_UNAVAILABLE'
          : /^Inquiry extraction HTTP \d+$/.test(message) ? message.replace('Inquiry extraction HTTP ', 'EXTRACTION_HTTP_') : 'INQUIRY_EXTRACTION_FAILED'
        await store.db.transaction(async () => {
          await store.db.run('UPDATE park_lead_jobs SET status = ?, attempts = ?, next_at = ?, last_error = ? WHERE inquiry_id = ?',
            [attempts >= 3 ? 'failed' : 'queued', attempts, Date.now() + attempts * 5000, reason, job.inquiry_id])
          await store.db.run('UPDATE park_inquiries SET extraction_status = ? WHERE id = ?', [attempts >= 3 ? 'failed' : 'queued', job.inquiry_id])
        })
      }
    }
  } finally { workingStores.delete(store) }
}
