/**
 * Queue sweeper: expired entries are reaped and their WeCom tasks withdrawn on
 * the server's clock, failed withdrawals are retried until they stick, and a
 * transient settle failure never turns a delivered message into "cancelled".
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

const home = mkdtempSync(path.join(tmpdir(), 'moss-sweep-'))
process.env.MOSS_HOME = home
const q = await import('../corpapps/groupMsgQueue.js')
const sweep = await import('../corpapps/queueSweep.js')
const { QueueSweepWorker } = await import('../corpapps/queueSweepWorker.js')

afterAll(() => rmSync(home, { recursive: true, force: true }))

const HOUR = 3600_000
let appSeq = 0
let APP = ''

type Fake = {
  summary: Record<string, { status?: number; sendTime?: number; error?: string }>
  cancelErrors: string[]
  cancelled: string[]
}
let fake: Fake

function connector(): any {
  return {
    async summariseGroupMsgDelivery(msgid: string) {
      const s = fake.summary[msgid]
      if (!s) return { entries: [] }
      if (s.error) throw new Error(s.error)
      return { entries: [{ chatId: msgid.replace('msg_', 'wr_'), status: s.status ?? 0, sendTime: s.sendTime }] }
    },
    async cancelGroupMsgSend(msgid: string) {
      const e = fake.cancelErrors.shift()
      if (e) throw new Error(e)
      fake.cancelled.push(msgid)
      return { ok: true }
    },
  }
}

/** An entry sent `ageH` hours ago that expired `expiredH` hours ago. */
async function sentEntry(chat: string, expiredH: number, msgid = `msg_${chat.slice(3)}`) {
  const now = Date.now()
  const r = await q.enqueue(APP, {
    chatId: chat,
    meta: { type: 't' },
    expiresAt: new Date(now - expiredH * HOUR).toISOString(),
  })
  await q.claim(APP, chat, r.entry.entryId)
  await q.markSent(APP, chat, [r.entry.entryId], msgid, 'u1')
  return r.entry.entryId
}

async function entry(chat: string, id: string) {
  return (await q.readGroupQueue(APP, chat)).entries.find((e) => e.entryId === id)!
}

beforeEach(() => {
  APP = `app${++appSeq}`
  fake = { summary: {}, cancelErrors: [], cancelled: [] }
})

describe('queue sweep', () => {
  it('reaps an expired unconfirmed entry and withdraws its WeCom task', async () => {
    const id = await sentEntry('wr_a', 1)
    const r = await sweep.sweepQueue(APP, connector())
    expect(r.reaped.map((x) => [x.entryId, x.wecomCancelled])).toEqual([[id, true]])
    expect(fake.cancelled).toEqual(['msg_a'])
    expect((await entry('wr_a', id)).state).toBe('cancelled')
  })

  it('settles before reaping: a confirmed message is recorded delivered, not cancelled', async () => {
    const id = await sentEntry('wr_b', 1)
    fake.summary.msg_b = { status: 1, sendTime: Math.floor(Date.now() / 1000) }
    const r = await sweep.sweepQueue(APP, connector())
    expect(r.reaped).toEqual([])
    expect((await entry('wr_b', id)).state).toBe('delivered')
    expect(fake.cancelled).toEqual([])
  })

  it('spares an entry whose settle failed transiently, but only within the grace period', async () => {
    const fresh = await sentEntry('wr_c', 1)
    const old = await sentEntry('wr_d', 30)
    fake.summary.msg_c = { error: 'fetch failed' }
    fake.summary.msg_d = { error: 'fetch failed' }
    const r = await sweep.sweepQueue(APP, connector())
    expect(r.reaped.map((x) => x.entryId)).toEqual([old])
    expect((await entry('wr_c', fresh)).state).toBe('sent')
  })

  it('does not spare an entry whose settle failed with a hard WeCom error', async () => {
    const id = await sentEntry('wr_e', 1)
    fake.summary.msg_e = { error: 'get_groupmsg_send_result errcode=41093 group message canceled' }
    const r = await sweep.sweepQueue(APP, connector())
    expect(r.reaped.map((x) => x.entryId)).toEqual([id])
  })

  it('retries a withdrawal that failed transiently until it sticks', async () => {
    const id = await sentEntry('wr_f', 1)
    fake.cancelErrors = ['cancel_groupmsg_send errcode=45009 api freq out of limit']
    let r = await sweep.sweepQueue(APP, connector())
    expect(r.reaped[0].wecomCancelled).toBe(false)
    expect((await entry('wr_f', id)).wecomCancelPending).toBe(true)
    r = await sweep.sweepQueue(APP, connector())
    expect(r.retried).toEqual([{ chatId: 'wr_f', entryId: id, msgid: 'msg_f', ok: true }])
    expect((await entry('wr_f', id)).wecomCancelPending).toBeUndefined()
    r = await sweep.sweepQueue(APP, connector())
    expect(r.retried).toEqual([])
  })

  it('does not retry forever on a hard WeCom error', async () => {
    const id = await sentEntry('wr_g', 1)
    fake.cancelErrors = ['cancel_groupmsg_send errcode=41092 invalid msgid']
    await sweep.sweepQueue(APP, connector())
    expect((await entry('wr_g', id)).wecomCancelPending).toBeUndefined()
  })

  it('withdraws by the bare msgid when an old entry stored a prose line', async () => {
    const r0 = await q.enqueue(APP, { chatId: 'wr_h', meta: {}, expiresAt: new Date(Date.now() - HOUR).toISOString() })
    await q.claim(APP, 'wr_h', r0.entry.entryId)
    // Written directly: mark-sent now refuses prose, but 2026-10-15 entries hold it.
    const g = await q.readGroupQueue(APP, 'wr_h')
    const e = g.entries[0]
    e.state = 'sent'
    e.msgid = 'group message task created  msgid=msg_h'
    e.sender = 'u1'
    const fs = await import('fs/promises')
    await fs.writeFile(path.join(home, 'wecom-queue', APP, 'wr_h.json'), JSON.stringify(g))
    await sweep.sweepQueue(APP, connector())
    expect(fake.cancelled).toEqual(['msg_h'])
  })

  it('leaves unexpired entries alone', async () => {
    const r0 = await q.enqueue(APP, { chatId: 'wr_i', meta: {}, expiresAt: new Date(Date.now() + HOUR).toISOString() })
    const r = await sweep.sweepQueue(APP, connector())
    expect(r.reaped).toEqual([])
    expect((await entry('wr_i', r0.entry.entryId)).state).toBe('pending')
  })

  it('still reaps when the connector cannot be built, and owes the withdrawal', async () => {
    const id = await sentEntry('wr_j', 30)
    const r = await sweep.sweepQueue(APP, null)
    expect(r.reaped.map((x) => x.entryId)).toEqual([id])
    expect((await entry('wr_j', id)).wecomCancelPending).toBe(true)
  })
})

describe('QueueSweepWorker', () => {
  it('sweeps every corp app it can resolve and skips the rest', async () => {
    const id = await sentEntry('wr_k', 1)
    const mine = APP
    const worker = new QueueSweepWorker(
      (corpAppId) => (corpAppId === mine ? { corpAppId, connector: async () => connector() } : null),
      { intervalMin: 0 },
    )
    const out = await worker.tickOnce()
    expect(Object.keys(out)).toEqual([mine])
    expect(out[mine].reaped.map((x) => x.entryId)).toEqual([id])
    expect(fake.cancelled).toContain('msg_k')
  })

  it('does not start a timer when disabled', () => {
    const worker = new QueueSweepWorker(() => null, { intervalMin: 0 })
    worker.start()
    expect((worker as any).timer).toBeNull()
  })
})
