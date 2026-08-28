/**
 * 企微客户群群发消息队列 (WeCom customer-group broadcast queue).
 *
 * WeCom lets each customer group RECEIVE only one broadcast per day, and the
 * quota is spent when a human CONFIRMS the task — not when the API creates it.
 * Confirmation can land hours later, so a caller that only inspects delivered
 * broadcasts cannot see the conflict: a second task queued while the first is
 * still awaiting confirmation is accepted, approved, confirmed, and then
 * silently discarded (send-result status 3), burning a human's click.
 *
 * This queue closes that gap by remembering intent. A group's daily slot is
 * claimed locally *before* the send, so concurrent agents cannot both proceed,
 * and pending entries from every agent are visible — unlike the WeCom APIs,
 * where send results are scoped to one sender.
 *
 * Layout (mirrors $MOSS_HOME/docs/<docId>, $MOSS_HOME/wikis/<wikiId>):
 *
 *   $MOSS_HOME/wecom-queue/<corpAppId>/<chat_id>.json
 *
 * One file per group keeps the blast radius of a corrupt write to a single
 * group, and makes the state trivially inspectable. Writes are atomic
 * (tmp + rename) and serialised per corp app by an advisory lock, because a
 * read-modify-write from two agents would otherwise lose an entry.
 *
 * Division of responsibility — deliberately narrow:
 *   - THIS MODULE knows *whether a group may be sent to* (mechanical) and
 *     *how long an entry may wait* (a timestamp comparison).
 *   - CALLERS know *whether a message should still be sent* (business data).
 * `reap` therefore never reads `meta`; business-driven cancellation goes
 * through `cancelEntry` instead.
 */

import { randomUUID } from 'crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'fs/promises'
import path from 'path'
import { MOSS_HOME } from '../../utils/wikis/localWikiDirectories.js'

export const MOSS_WECOM_QUEUE_DIR = path.join(MOSS_HOME, 'wecom-queue')

/** Timezone the WeCom daily quota resets in — the provider's clock, not ours. */
const QUOTA_TZ = 'Asia/Shanghai'

/**
 * Fallback lifetime for an entry enqueued without an explicit `--expires-at`.
 *
 * reap() only ever acted on entries that carried their own expiry, and expiry
 * is optional — so one omitted flag left a claimed/sent entry holding the
 * group's slot forever: `next` skipped the group with `pending_exists` every
 * day thereafter, silently and with no error to notice. 72h is deliberately
 * generous: the daily cap is settled when a human confirms, which was measured
 * hours after creation, so this is a backstop against a stuck entry, not a
 * business deadline. Callers that care about timeliness still pass
 * `--expires-at`; this only bounds the ones that do not.
 */
const DEFAULT_ENTRY_TTL_MS = 72 * 60 * 60 * 1000

export type QueueEntryState =
  | 'pending'   // queued, nothing sent
  | 'claimed'   // holds today's slot while content is composed
  | 'sent'      // task created at WeCom, awaiting approval + confirmation
  | 'delivered' // confirmed by send-result status 1
  | 'failed'    // send-result status 2/3, or the send call failed
  | 'cancelled' // reaped (expired) or cancelled by the caller

export type QueueEntry = {
  entryId: string
  state: QueueEntryState
  meta: Record<string, unknown>
  idempotencyKey?: string
  /** Absolute instant after which a still-pending entry is reaped. */
  expiresAt?: string
  enqueuedAt: string
  claimedAt?: string | null
  sentAt?: string | null
  settledAt?: string | null
  /** Recorded at mark-sent: reconcile needs it, and entries may differ. */
  sender?: string | null
  msgid?: string | null
  /** The quota day this entry claimed, so a release knows what to undo. */
  quotaDate?: string | null
  reason?: string | null
}

export type GroupQueue = {
  chatId: string
  lastSentDate?: string | null
  lastDeliveredMsgid?: string | null
  entries: QueueEntry[]
}

/** Why `next` passed a group over. Surfaced so callers never skip silently. */
export type SkipReason = 'already_sent_today' | 'pending_exists'

export type SkippedGroup = {
  chatId: string
  reason: SkipReason
  blockingEntryId?: string
  blockingMsgid?: string | null
  lastSentDate?: string | null
}

// ============================================================
// Time helpers
// ============================================================

/**
 * Today's date on the provider's clock. The quota resets on WeCom's calendar
 * day, so a container running UTC must not use its own date — at 23:30 UTC it
 * is already tomorrow in Shanghai.
 */
export function quotaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: QUOTA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** States that occupy a group's daily slot and therefore block a new send. */
const BLOCKING_STATES: QueueEntryState[] = ['pending', 'claimed', 'sent']

function isBlocking(e: QueueEntry): boolean {
  return BLOCKING_STATES.includes(e.state)
}

// ============================================================
// Storage
// ============================================================

function queueDir(corpAppId: string): string {
  return path.join(MOSS_WECOM_QUEUE_DIR, corpAppId)
}

/**
 * A chat id is provider-supplied (`wr_...`) but still reaches us from an agent
 * request, so refuse anything that could escape the queue directory.
 */
function queueFile(corpAppId: string, chatId: string): string {
  if (!chatId || chatId.includes('/') || chatId.includes('\\') || chatId.includes('..')) {
    throw new Error(`invalid chat id: ${chatId}`)
  }
  return path.join(queueDir(corpAppId), `${chatId}.json`)
}

export async function readGroupQueue(corpAppId: string, chatId: string): Promise<GroupQueue> {
  try {
    const raw = await readFile(queueFile(corpAppId, chatId), 'utf8')
    const parsed = JSON.parse(raw) as GroupQueue
    return { chatId, entries: [], ...parsed }
  } catch {
    // Absent or unparseable — treat as empty. A corrupt file must not wedge the
    // queue permanently; the worst case is a re-send the guard would have
    // caught, which the caller still detects at reconcile time.
    return { chatId, entries: [] }
  }
}

async function writeGroupQueue(corpAppId: string, q: GroupQueue): Promise<void> {
  await mkdir(queueDir(corpAppId), { recursive: true })
  const target = queueFile(corpAppId, q.chatId)
  const tmp = `${target}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(q, null, 2), 'utf8')
  await rename(tmp, target)
}

export async function listGroupChatIds(corpAppId: string): Promise<string[]> {
  try {
    const names = await readdir(queueDir(corpAppId))
    return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length))
  } catch {
    return []
  }
}

// ============================================================
// Locking
// ============================================================

/**
 * In-process serialisation per corp app. Every mutation is a
 * read-modify-write, so two concurrent agent requests would otherwise read the
 * same file and one would overwrite the other's entry.
 *
 * Scope note: this guards concurrency *within one moss-server process*, which
 * is where agent requests are served. It is not a cross-process file lock — a
 * second server instance sharing the same MOSS_HOME would need one.
 */
const locks = new Map<string, Promise<unknown>>()

function withLock<T>(corpAppId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(corpAppId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  // Keep the chain alive but don't let a rejection poison later callers.
  locks.set(corpAppId, next.catch(() => undefined))
  return next
}

async function mutate<T>(
  corpAppId: string,
  chatId: string,
  fn: (q: GroupQueue) => T | Promise<T>,
): Promise<T> {
  return withLock(corpAppId, async () => {
    const q = await readGroupQueue(corpAppId, chatId)
    const result = await fn(q)
    await writeGroupQueue(corpAppId, q)
    return result
  })
}

// ============================================================
// Actions
// ============================================================

export type EnqueueInput = {
  chatId: string
  meta: Record<string, unknown>
  idempotencyKey?: string
  expiresAt?: string
}

/**
 * Queue a message *intent*. Content is deliberately not stored: it must be
 * composed from fresh data at send time, which may be hours later.
 *
 * An idempotency key makes re-runs safe — a scheduled producer firing twice in
 * one window must not queue the same reminder twice. Only live entries count as
 * duplicates, so a cancelled or failed entry can legitimately be re-queued
 * under the same key.
 */
export async function enqueue(
  corpAppId: string,
  input: EnqueueInput,
  now: Date = new Date(),
): Promise<{ entry: QueueEntry; duplicate: boolean }> {
  return mutate(corpAppId, input.chatId, (q) => {
    if (input.idempotencyKey) {
      const existing = q.entries.find(
        (e) => e.idempotencyKey === input.idempotencyKey && isBlocking(e),
      )
      if (existing) return { entry: existing, duplicate: true }
    }
    const entry: QueueEntry = {
      entryId: `q_${randomUUID()}`,
      state: 'pending',
      meta: input.meta ?? {},
      idempotencyKey: input.idempotencyKey,
      // Always carry an expiry so reap() can eventually free the slot.
      expiresAt:
        input.expiresAt ?? new Date(now.getTime() + DEFAULT_ENTRY_TTL_MS).toISOString(),
      enqueuedAt: now.toISOString(),
      claimedAt: null,
      sender: null,
      msgid: null,
      quotaDate: null,
    }
    q.entries.push(entry)
    return { entry, duplicate: false }
  })
}

/**
 * Decide whether a group may be sent to, and if so which entry is up next.
 *
 * Returns at most ONE entry per group — the quota permits no more — choosing
 * the oldest live entry (FIFO across all producers, since the daily slot is
 * shared between skills).
 */
export function evaluateGroup(
  q: GroupQueue,
  now: Date = new Date(),
): { entry: QueueEntry } | { skip: SkippedGroup } {
  const today = quotaToday(now)
  if (q.lastSentDate === today) {
    return {
      skip: {
        chatId: q.chatId,
        reason: 'already_sent_today',
        lastSentDate: q.lastSentDate,
      },
    }
  }
  const live = q.entries.filter(isBlocking).sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt))
  if (live.length === 0) return { skip: { chatId: q.chatId, reason: 'pending_exists' } }

  // An entry already claimed or sent is holding the slot: nothing else may go
  // out today, and the holder itself is not offered again.
  //
  // This is NOT redundant with the lastSentDate check above, and the two cover
  // different phases. lastSentDate is written only by reconcile on status 1 —
  // i.e. after a human confirms, measured hours after the task was created. In
  // the window between claim and that confirmation the group has spent nothing
  // yet by that measure, so lastSentDate is still unset and would happily offer
  // a second entry: precisely the double-send this queue exists to prevent.
  // A holder is bounded by its expiry (defaulted at enqueue), so it cannot
  // block the group indefinitely.
  const holder = live.find((e) => e.state === 'claimed' || e.state === 'sent')
  if (holder) {
    return {
      skip: {
        chatId: q.chatId,
        reason: 'pending_exists',
        blockingEntryId: holder.entryId,
        blockingMsgid: holder.msgid ?? null,
      },
    }
  }
  return { entry: live[0]! }
}

export type NextResult = {
  entries: (QueueEntry & { chatId: string })[]
  skipped: SkippedGroup[]
  totalEligible: number
  hasMore: boolean
}

/**
 * Sendable entries across every group of a corp app.
 *
 * `limit` is deliberate throttling, not a safety valve: `totalEligible` and
 * `hasMore` are always reported so a truncated batch is never mistaken for "we
 * are done". Each send costs an admin approval plus a sender confirmation, so
 * pacing a large run is a legitimate operational choice.
 */
export async function next(
  corpAppId: string,
  opts: { chatId?: string; limit?: number; now?: Date } = {},
): Promise<NextResult> {
  const now = opts.now ?? new Date()
  const chatIds = opts.chatId ? [opts.chatId] : await listGroupChatIds(corpAppId)
  const eligible: (QueueEntry & { chatId: string })[] = []
  const skipped: SkippedGroup[] = []

  for (const chatId of chatIds) {
    const q = await readGroupQueue(corpAppId, chatId)
    const verdict = evaluateGroup(q, now)
    if ('entry' in verdict) eligible.push({ ...verdict.entry, chatId })
    else if (verdict.skip.blockingEntryId || verdict.skip.reason === 'already_sent_today') {
      // Only report groups actually held back; an empty queue is not a "skip".
      skipped.push(verdict.skip)
    }
  }

  const limit = opts.limit && opts.limit > 0 ? opts.limit : eligible.length
  return {
    entries: eligible.slice(0, limit),
    skipped,
    totalEligible: eligible.length,
    hasMore: eligible.length > limit,
  }
}

/**
 * Take the group's slot for today, before any content is composed.
 *
 * Composing can take a while (querying data, building a spreadsheet). Without
 * claiming first, a second agent could pass `next` for the same group in that
 * window and both would send — the loser discovering it only via status 3,
 * after a human confirmed it.
 */
export async function claim(
  corpAppId: string,
  chatId: string,
  entryId: string,
  now: Date = new Date(),
): Promise<{ ok: boolean; reason?: string; entry?: QueueEntry }> {
  return mutate(corpAppId, chatId, (q) => {
    const today = quotaToday(now)
    if (q.lastSentDate === today) return { ok: false, reason: 'already_sent_today' }
    const entry = q.entries.find((e) => e.entryId === entryId)
    if (!entry) return { ok: false, reason: 'not_found' }
    if (entry.state !== 'pending') return { ok: false, reason: `state_is_${entry.state}` }
    const holder = q.entries.find((e) => e.state === 'claimed' || e.state === 'sent')
    if (holder) return { ok: false, reason: 'slot_taken' }
    entry.state = 'claimed'
    entry.claimedAt = now.toISOString()
    entry.quotaDate = today
    return { ok: true, entry }
  })
}

/** Hand the slot back when a claimed entry could not be sent. */
export async function release(
  corpAppId: string,
  chatId: string,
  entryId: string,
  reason: string,
): Promise<{ ok: boolean; reason?: string }> {
  return mutate(corpAppId, chatId, (q) => {
    const entry = q.entries.find((e) => e.entryId === entryId)
    if (!entry) return { ok: false, reason: 'not_found' }
    if (entry.state !== 'claimed') return { ok: false, reason: `state_is_${entry.state}` }
    entry.state = 'pending'
    entry.claimedAt = null
    entry.quotaDate = null
    entry.reason = reason
    return { ok: true }
  })
}

/**
 * Bind the WeCom msgid so reconcile can follow this entry, and record which
 * sender it was assigned to (send-result lookups are per-sender).
 *
 * Note this does NOT set `lastSentDate`: the task exists but nothing has been
 * delivered yet. Only reconcile, seeing status 1, can say the quota was spent.
 */
export async function markSent(
  corpAppId: string,
  chatId: string,
  entryId: string,
  msgid: string,
  sender: string,
): Promise<{ ok: boolean; reason?: string }> {
  return mutate(corpAppId, chatId, (q) => {
    const entry = q.entries.find((e) => e.entryId === entryId)
    if (!entry) return { ok: false, reason: 'not_found' }
    if (entry.state !== 'claimed') return { ok: false, reason: `state_is_${entry.state}` }
    entry.state = 'sent'
    entry.msgid = msgid
    entry.sender = sender
    entry.sentAt = new Date().toISOString()
    return { ok: true }
  })
}

/**
 * Cancel an entry for a business reason — "the schedule moved", "the customer
 * already replied". This is the caller's half of cancellation; the queue has no
 * way to know such things, which is why `reap` handles only expiry.
 */
export async function cancelEntry(
  corpAppId: string,
  chatId: string,
  entryId: string,
  reason: string,
): Promise<{ ok: boolean; reason?: string; msgid?: string | null }> {
  return mutate(corpAppId, chatId, (q) => {
    const entry = q.entries.find((e) => e.entryId === entryId)
    if (!entry) return { ok: false, reason: 'not_found' }
    if (!isBlocking(entry)) return { ok: false, reason: `state_is_${entry.state}` }
    const msgid = entry.msgid ?? null
    entry.state = 'cancelled'
    entry.reason = reason
    entry.settledAt = new Date().toISOString()
    entry.quotaDate = null
    return { ok: true, msgid }
  })
}

export type ReapedEntry = {
  chatId: string
  entryId: string
  msgid: string | null
  expiresAt?: string
}

/**
 * Cancel entries that waited too long, judged ONLY by each entry's own
 * `expiresAt`.
 *
 * The threshold is set per entry at enqueue time, so hours and days are equally
 * expressible and different message types can differ — without this module ever
 * reading `meta`. Anything needing a business lookup belongs in `cancelEntry`.
 */
export async function reap(
  corpAppId: string,
  opts: { chatId?: string; now?: Date } = {},
): Promise<ReapedEntry[]> {
  const now = opts.now ?? new Date()
  const chatIds = opts.chatId ? [opts.chatId] : await listGroupChatIds(corpAppId)
  const reaped: ReapedEntry[] = []
  for (const chatId of chatIds) {
    const found = await mutate(corpAppId, chatId, (q) => {
      const out: ReapedEntry[] = []
      for (const e of q.entries) {
        if (!isBlocking(e) || !e.expiresAt) continue
        if (new Date(e.expiresAt).getTime() > now.getTime()) continue
        out.push({ chatId, entryId: e.entryId, msgid: e.msgid ?? null, expiresAt: e.expiresAt })
        e.state = 'cancelled'
        e.reason = 'expired'
        e.settledAt = now.toISOString()
        e.quotaDate = null
      }
      return out
    })
    reaped.push(...found)
  }
  return reaped
}

export type ReconcileOutcome = {
  chatId: string
  entryId: string
  msgid: string
  sender: string
  sendStatus: number
  state: QueueEntryState
  reason?: string
}

/** Entries awaiting reconciliation, with the sender each was assigned to. */
export async function pendingReconcile(
  corpAppId: string,
  chatId?: string,
): Promise<{ chatId: string; entryId: string; msgid: string; sender: string }[]> {
  const chatIds = chatId ? [chatId] : await listGroupChatIds(corpAppId)
  const out: { chatId: string; entryId: string; msgid: string; sender: string }[] = []
  for (const id of chatIds) {
    const q = await readGroupQueue(corpAppId, id)
    for (const e of q.entries) {
      if (e.state === 'sent' && e.msgid && e.sender) {
        out.push({ chatId: id, entryId: e.entryId, msgid: e.msgid, sender: e.sender })
      }
    }
  }
  return out
}

/**
 * Record what WeCom says actually happened to a sent entry.
 *
 * WeCom send-result status: 0 未发送 · 1 已发送 · 2 非好友失败 ·
 * 3 已收到其他群发失败.
 *
 * Status 3 is the important one: the task WAS confirmed by a human, yet the
 * group received nothing because its daily quota had already gone — often to
 * another team sending from the same enterprise. It becomes `failed` and the
 * slot is released, but it is deliberately NOT re-queued: whether a message is
 * still worth sending tomorrow is a business call the caller must make.
 */
export async function applyReconcile(
  corpAppId: string,
  chatId: string,
  entryId: string,
  sendStatus: number,
  sendTime?: number,
): Promise<ReconcileOutcome | null> {
  return mutate(corpAppId, chatId, (q) => {
    const entry = q.entries.find((e) => e.entryId === entryId)
    if (!entry || entry.state !== 'sent') return null
    const base = {
      chatId,
      entryId,
      msgid: entry.msgid ?? '',
      sender: entry.sender ?? '',
      sendStatus,
    }
    if (sendStatus === 1) {
      entry.state = 'delivered'
      const settledAt = sendTime ? new Date(sendTime * 1000) : new Date()
      entry.settledAt = settledAt.toISOString()
      // The quota is spent on the day WeCom actually sent, which is the day the
      // human confirmed — not the day we claimed the slot. Approval can land in
      // minutes, the next day, or never, so the two dates diverge routinely.
      // Recording the claim day here made the queue believe a group was still
      // free on the day its message actually went out, and it would then offer a
      // second entry that was certain to come back as status 3 — after a human
      // had spent a confirmation on it. send_time is the provider's own account
      // of when the quota went; fall back to the claim day only when it is
      // absent.
      q.lastSentDate = sendTime ? quotaToday(settledAt) : entry.quotaDate ?? quotaToday()
      q.lastDeliveredMsgid = entry.msgid ?? null
      return { ...base, state: 'delivered' as QueueEntryState }
    }
    if (sendStatus === 2 || sendStatus === 3) {
      entry.state = 'failed'
      entry.reason = sendStatus === 3 ? 'daily_cap' : 'not_a_contact'
      entry.settledAt = new Date().toISOString()
      entry.quotaDate = null // slot never actually spent — free it
      return { ...base, state: 'failed' as QueueEntryState, reason: entry.reason }
    }
    return null // status 0 — still awaiting confirmation, leave as sent
  })
}

/** Raw listing for inspection and for callers filtering on their own `meta`. */
export async function listEntries(
  corpAppId: string,
  opts: { chatId?: string; state?: QueueEntryState } = {},
): Promise<(QueueEntry & { chatId: string })[]> {
  const chatIds = opts.chatId ? [opts.chatId] : await listGroupChatIds(corpAppId)
  const out: (QueueEntry & { chatId: string })[] = []
  for (const chatId of chatIds) {
    const q = await readGroupQueue(corpAppId, chatId)
    for (const e of q.entries) {
      if (opts.state && e.state !== opts.state) continue
      out.push({ ...e, chatId })
    }
  }
  return out
}
