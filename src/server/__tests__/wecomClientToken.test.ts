/**
 * WeComApiClient token handling: connectors are built per request, so the
 * access_token cache must outlive any one client — otherwise every `corpapp`
 * call pays a gettoken and WeCom throttles the corp with 45009.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { WeComApiClient } from '../corpapps/wecomClient.js'

type Reply = Record<string, unknown>

const realFetch = globalThis.fetch
const calls: string[] = []
let gettokenReplies: Reply[] = []
let apiReplies: Reply[] = []
let issued = 0

function nextOf(list: Reply[], fallback: () => Reply): Reply {
  return list.length > 0 ? (list.shift() as Reply) : fallback()
}

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input)
  calls.push(url)
  const body = url.includes('/cgi-bin/gettoken')
    ? nextOf(gettokenReplies, () => ({ errcode: 0, access_token: `tok${++issued}`, expires_in: 7200 }))
    : nextOf(apiReplies, () => ({ errcode: 0, ok: true }))
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

const savedDelays = WeComApiClient.throttleRetryDelaysMs
let corpSeq = 0

beforeEach(() => {
  calls.length = 0
  gettokenReplies = []
  apiReplies = []
  WeComApiClient.throttleRetryDelaysMs = [0, 0]
})
afterAll(() => {
  globalThis.fetch = realFetch
  WeComApiClient.throttleRetryDelaysMs = savedDelays
})

/** A corp id unused by earlier tests, so the process-wide cache starts cold. */
const freshCorp = () => `corp${++corpSeq}`
const gettokens = () => calls.filter((u) => u.includes('/cgi-bin/gettoken')).length
const tokenOf = (u: string) => new URL(u).searchParams.get('access_token')

describe('WeComApiClient token cache', () => {
  it('shares one token across clients of the same app', async () => {
    const corp = freshCorp()
    for (let i = 0; i < 5; i++) await new WeComApiClient(corp, 's').post('/cgi-bin/x', {})
    expect(gettokens()).toBe(1)
  })

  it('makes one gettoken for a concurrent burst on a cold cache', async () => {
    const corp = freshCorp()
    await Promise.all(Array.from({ length: 8 }, () => new WeComApiClient(corp, 's').post('/cgi-bin/x', {})))
    expect(gettokens()).toBe(1)
  })

  it('keeps different secrets apart', async () => {
    const corp = freshCorp()
    await new WeComApiClient(corp, 'secret-a').post('/cgi-bin/x', {})
    await new WeComApiClient(corp, 'secret-b').post('/cgi-bin/x', {})
    expect(gettokens()).toBe(2)
    const used = calls.filter((u) => !u.includes('gettoken')).map(tokenOf)
    expect(used[0]).not.toBe(used[1])
  })

  it('refreshes after WeCom rejects the token, and keeps the new one', async () => {
    const corp = freshCorp()
    await new WeComApiClient(corp, 's').post('/cgi-bin/x', {})
    apiReplies = [{ errcode: 42001, errmsg: 'access_token expired' }]
    await new WeComApiClient(corp, 's').post('/cgi-bin/x', {})
    await new WeComApiClient(corp, 's').post('/cgi-bin/x', {})
    expect(gettokens()).toBe(2)
    const used = calls.filter((u) => !u.includes('gettoken')).map(tokenOf)
    expect(used[1]).not.toBe(used[2])
    expect(used[2]).toBe(used[3])
  })

  it('forceRefresh bypasses the cache (testConnection must prove the secret now)', async () => {
    const corp = freshCorp()
    const client = new WeComApiClient(corp, 's')
    await client.getAccessToken()
    await client.getAccessToken({ forceRefresh: true })
    expect(gettokens()).toBe(2)
  })

  it('does not cache a failed gettoken', async () => {
    const corp = freshCorp()
    gettokenReplies = [{ errcode: 40001, errmsg: 'invalid credential' }]
    await expect(new WeComApiClient(corp, 's').post('/cgi-bin/x', {})).rejects.toThrow('errcode=40001')
    await new WeComApiClient(corp, 's').post('/cgi-bin/x', {})
    expect(gettokens()).toBe(2)
  })
})

describe('WeComApiClient 45009 throttling', () => {
  it('repeats a throttled call and returns its result', async () => {
    apiReplies = [{ errcode: 45009, errmsg: 'freq out of limit' }, { errcode: 0, msgid: 'm1' }]
    const json = await new WeComApiClient(freshCorp(), 's').post('/cgi-bin/x', {})
    expect(json.msgid).toBe('m1')
  })

  it('repeats a throttled gettoken', async () => {
    gettokenReplies = [{ errcode: 45009, errmsg: 'Too many requests' }]
    const json = await new WeComApiClient(freshCorp(), 's').post('/cgi-bin/x', {})
    expect(json.errcode).toBe(0)
    expect(gettokens()).toBe(2)
  })

  it('gives up after the configured retries and reports 45009', async () => {
    apiReplies = [
      { errcode: 45009, errmsg: 'a' },
      { errcode: 45009, errmsg: 'b' },
      { errcode: 45009, errmsg: 'c' },
    ]
    await expect(new WeComApiClient(freshCorp(), 's').post('/cgi-bin/x', {})).rejects.toThrow('errcode=45009')
    expect(calls.filter((u) => !u.includes('gettoken')).length).toBe(3)
  })

  it('does not repeat other errors', async () => {
    apiReplies = [{ errcode: 41048, errmsg: 'no customer to send' }]
    await expect(new WeComApiClient(freshCorp(), 's').post('/cgi-bin/x', {})).rejects.toThrow('errcode=41048')
    expect(calls.filter((u) => !u.includes('gettoken')).length).toBe(1)
  })
})
