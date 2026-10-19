/**
 * Settle → reap → withdraw for the 群发 queue, shared by the agent-facing
 * queue route and the background sweeper.
 *
 * Why a background sweeper at all: `reap` used to run only when an agent
 * called it. An agent that skipped the step (a day with nothing to send) or a
 * run whose model never answered left expired entries in place, and their
 * WeCom tasks kept waiting for confirmation. WeCom never expires an
 * unconfirmed task, so a stale message could still go out days later and use
 * up that day's quota. The sweeper makes expiry happen on the server's clock,
 * not on whether some agent happened to run.
 */
import * as q from './groupMsgQueue.js'
import type { CorpAppConnector } from './types.js'

/**
 * How long past expiry an entry whose settlement keeps failing transiently is
 * spared. Long enough to ride out a WeCom outage; short enough that a provider
 * that never answers cannot hold a group's slot indefinitely.
 */
export const SETTLE_GRACE_MS = 24 * 60 * 60 * 1000

/** A failure worth retrying: no WeCom errcode (network, HTTP status, timeout) or throttling. */
export function isTransientProviderError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  const m = msg.match(/errcode=(-?\d+)/)
  if (!m) return true
  return m[1] === '45009' || m[1] === '-1'
}

/** The bare msgid. Entries written before mark-sent validated input may hold a prose line around it. */
export function bareMsgid(raw: string | null | undefined): string | null {
  const m = String(raw ?? '').match(/msg_[A-Za-z0-9_-]+/)
  return m ? m[0] : null
}

/**
 * Settle every `sent` entry against what WeCom actually did. Failures are
 * logged and skipped, never fatal. Entries whose settlement failed transiently
 * come back in `unsettled` so a reap in the same pass can spare them.
 */
export async function reconcileQueue(
  corpAppId: string,
  connector: CorpAppConnector | null,
  chatId?: string,
): Promise<{ reconciled: q.ReconcileOutcome[]; unsettled: Set<string> }> {
  const reconciled: q.ReconcileOutcome[] = []
  const unsettled = new Set<string>()
  const pending = await q.pendingReconcile(corpAppId, chatId)
  if (pending.length === 0 || !connector?.summariseGroupMsgDelivery) {
    for (const p of pending) unsettled.add(p.entryId)
    return { reconciled, unsettled }
  }
  for (const p of pending) {
    try {
      // Each entry records the sender it was assigned to, because WeCom scopes
      // send results per sender and a shared queue may hold entries from several.
      const sum = await connector.summariseGroupMsgDelivery(bareMsgid(p.msgid) ?? p.msgid, p.sender)
      const hit = sum.entries.find((e) => e.chatId === p.chatId)
      if (!hit) continue
      const outcome = await q.applyReconcile(corpAppId, p.chatId, p.entryId, hit.status, hit.sendTime)
      if (outcome) reconciled.push(outcome)
    } catch (err) {
      // A cancelled task answers 41093; that is information, not a failure,
      // and must not abort the whole pass.
      if (isTransientProviderError(err)) unsettled.add(p.entryId)
      console.warn(`[queue] reconcile ${p.msgid}: ${String(err)}`)
    }
  }
  return { reconciled, unsettled }
}

/**
 * Withdraw an entry's WeCom task and record whether a retry is owed. Best
 * effort: the entry is already cancelled locally, and a task that cannot be
 * withdrawn is strictly less harmful than a stuck queue. Only transient
 * failures are retried; a hard WeCom error (e.g. the task already went out)
 * will not change on retry.
 */
export async function withdrawTask(
  corpAppId: string,
  connector: CorpAppConnector | null,
  chatId: string,
  entryId: string,
  rawMsgid: string | null | undefined,
): Promise<boolean> {
  const msgid = bareMsgid(rawMsgid)
  if (!msgid) return false
  let ok = false
  let retry = false
  try {
    if (connector?.cancelGroupMsgSend) {
      ok = (await connector.cancelGroupMsgSend(msgid)).ok
    } else {
      retry = true
    }
  } catch (err) {
    retry = isTransientProviderError(err)
    console.warn(`[queue] cancel_groupmsg_send failed for ${msgid}: ${String(err)}`)
  }
  await q.setWecomCancelPending(corpAppId, chatId, entryId, !ok && retry)
  return ok
}

export type ReapResult = {
  reaped: (q.ReapedEntry & { wecomCancelled: boolean })[]
  reconciled: q.ReconcileOutcome[]
}

/**
 * Settle first, then reap. reap's rule is "not delivered by its deadline", and
 * an entry stays `sent` until someone asks the provider — reaping before
 * settling could cancel a message a human already confirmed, losing the
 * delivery for good. An entry whose settlement just failed transiently is
 * spared for up to SETTLE_GRACE_MS past expiry for the same reason.
 */
export async function reapQueue(
  corpAppId: string,
  connector: CorpAppConnector | null,
  opts: { chatId?: string; cancelWecom?: boolean; now?: Date } = {},
): Promise<ReapResult> {
  const { reconciled, unsettled } = await reconcileQueue(corpAppId, connector, opts.chatId)
  const reaped = await q.reap(corpAppId, {
    chatId: opts.chatId,
    now: opts.now,
    skipEntryIds: unsettled,
    skipGraceMs: SETTLE_GRACE_MS,
  })
  const out: ReapResult['reaped'] = []
  for (const r of reaped) {
    const wecomCancelled = opts.cancelWecom
      ? await withdrawTask(corpAppId, connector, r.chatId, r.entryId, r.msgid)
      : false
    out.push({ ...r, wecomCancelled })
  }
  return { reaped: out, reconciled }
}

export type SweepResult = ReapResult & {
  retried: { chatId: string; entryId: string; msgid: string; ok: boolean }[]
}

/**
 * One background pass for one corp app: settle, reap with withdrawal, then
 * retry withdrawals that failed earlier (here or from an agent's cancel/reap).
 */
export async function sweepQueue(
  corpAppId: string,
  connector: CorpAppConnector | null,
  opts: { now?: Date; cancelWecom?: boolean } = {},
): Promise<SweepResult> {
  const r = await reapQueue(corpAppId, connector, { cancelWecom: opts.cancelWecom ?? true, now: opts.now })
  const justTried = new Set(r.reaped.map((x) => x.entryId))
  const retried: SweepResult['retried'] = []
  for (const p of await q.listWecomCancelPending(corpAppId)) {
    if (justTried.has(p.entryId)) continue
    const ok = await withdrawTask(corpAppId, connector, p.chatId, p.entryId, p.msgid)
    retried.push({ ...p, ok })
  }
  return { ...r, retried }
}
