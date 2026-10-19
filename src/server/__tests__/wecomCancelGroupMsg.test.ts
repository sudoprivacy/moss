/**
 * WeComAppConnector.cancelGroupMsgSend: withdrawals are retried until they
 * stick, so cancelling a task that is already gone (errcode 41093) must come
 * back as success, while any other provider error must still throw so the
 * caller knows the task may still be live.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { WeComAppConnector } from '../corpapps/wecomApp.js'
import { WeComApiClient } from '../corpapps/wecomClient.js'

type Reply = Record<string, unknown>

const realFetch = globalThis.fetch
const savedDelays = WeComApiClient.throttleRetryDelaysMs
const cancelCalls: Reply[] = []
let cancelReply: Reply = { errcode: 0, errmsg: 'ok' }

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  let body: Reply
  if (url.includes('/cgi-bin/gettoken')) {
    body = { errcode: 0, access_token: 'tok', expires_in: 7200 }
  } else if (url.includes('/cgi-bin/externalcontact/cancel_groupmsg_send')) {
    cancelCalls.push(JSON.parse(String(init?.body ?? '{}')) as Reply)
    body = cancelReply
  } else {
    body = { errcode: 0 }
  }
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

let corpSeq = 0
async function connector(): Promise<WeComAppConnector> {
  const c = new WeComAppConnector()
  await c.init({ corpId: `cancelcorp${++corpSeq}`, agentId: '1000001' }, { secret: 's' })
  return c
}

beforeEach(() => {
  cancelCalls.length = 0
  WeComApiClient.throttleRetryDelaysMs = [0, 0]
})
afterAll(() => {
  globalThis.fetch = realFetch
  WeComApiClient.throttleRetryDelaysMs = savedDelays
})

describe('WeComAppConnector.cancelGroupMsgSend', () => {
  it('withdraws the task by msgid', async () => {
    cancelReply = { errcode: 0, errmsg: 'ok' }
    const r = await (await connector()).cancelGroupMsgSend('msg_a')
    expect(r).toEqual({ ok: true })
    expect(cancelCalls).toEqual([{ msgid: 'msg_a' }])
  })

  it('treats an already-cancelled task (41093) as done', async () => {
    cancelReply = { errcode: 41093, errmsg: 'group message canceled' }
    const r = await (await connector()).cancelGroupMsgSend('msg_b')
    expect(r).toEqual({ ok: true, alreadyCancelled: true })
  })

  it('still throws on any other provider error', async () => {
    cancelReply = { errcode: 41092, errmsg: 'invalid msgid' }
    await expect((await connector()).cancelGroupMsgSend('msg_c')).rejects.toThrow(/errcode=41092/)
  })
})
