import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { DatabaseSync } from 'node:sqlite'
import { interpretComfortReply } from '../comfortConfirmation.js'
import { CabinStore } from '../store.js'

describe('semantic comfort confirmation protocol', () => {
  const base = { action: 'recline' as const, text: '行，帮我调一下', baseUrl: 'http://model.invalid/v1', model: 'local', timeoutMs: 100 }
  it('uses one bounded tool-free classification with only the pending action and current reply', async () => {
    let request: Record<string, any> = {}
    const decision = await interpretComfortReply({ ...base, apiKey: 'test-key', fetchImpl: (async (_url, init) => {
      request = JSON.parse(String(init?.body))
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"decision":"confirm"}' } }] })
    }) as typeof fetch })
    expect(decision).toBe('confirm')
    expect(request.tools).toBeUndefined()
    expect(request).toMatchObject({ temperature: 0, max_tokens: 64, stream: false, chat_template_kwargs: { enable_thinking: false } })
    expect(request.messages).toHaveLength(2)
    expect(JSON.parse(request.messages[1].content)).toEqual({ pending_offer: '把座椅放倒到休息角度', passenger_reply: base.text })
    expect(JSON.stringify(request)).not.toMatch(/seat_no|tablet|test-key/)
  })
  it('accepts only one strict decision, never model-supplied tools or parameters', async () => {
    for (const decision of ['confirm', 'decline', 'modify', 'unclear', 'unrelated']) {
      expect(await interpretComfortReply({ ...base, fetchImpl: (async () => Response.json({ choices: [
        { finish_reason: 'stop', message: { content: JSON.stringify({ decision }) } },
      ] })) as typeof fetch })).toBe(decision)
    }
    for (const [content, extra = {}, finish = 'stop'] of [
      ['{"decision":"confirm","params":{"position":100}}'], ['{"decision":"confirm","seatNo":"8A"}'],
      ['{"decision":"execute"}'], ['yes'], ['```json\n{"decision":"confirm"}\n```'],
      ['{"decision":"confirm"}', { tool_calls: [] }], ['{"decision":"confirm"}', {}, 'length'],
    ] as Array<[string, Record<string, unknown>?, string?]>) {
      expect(await interpretComfortReply({ ...base, fetchImpl: (async () => Response.json({ choices: [
        { finish_reason: finish, message: { content, ...extra } },
      ] })) as typeof fetch })).toBe('unclear')
    }
  })
  it('times out through response body reads and diagnoses HTTP failures without their body', async () => {
    await expect(interpretComfortReply({ ...base, timeoutMs: 15, fetchImpl: (async () => new Response(new ReadableStream())) as typeof fetch }))
      .rejects.toThrow('Comfort confirmation timeout')
    await expect(interpretComfortReply({ ...base, fetchImpl: (async () => new Response('private-upstream-data', { status: 503 })) as typeof fetch }))
      .rejects.toThrow('Comfort confirmation HTTP 503')
  })
})

describe('pending comfort offer claims', () => {
  it('uses existing tables and binds a claim to one unexpired offer version', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE cabin_comfort_offers (scope TEXT PRIMARY KEY, action TEXT NOT NULL, expires INTEGER NOT NULL)')
    db.exec("INSERT INTO cabin_comfort_offers VALUES ('old', 'recline', 9999999999999)")
    const store = new CabinStore(db as unknown as DatabaseSync)
    expect((db.prepare('PRAGMA table_info(cabin_comfort_offers)').all() as unknown[]).length).toBe(3)
    expect(store.getComfortOffer('old', 1)).toBeUndefined()
    store.recordComfortOffer('7A', 'recline', 1)
    const first = store.getComfortOffer('7A', 2)!
    expect(store.consumeComfortOffer('8A', first, 3)).toBe(false)
    store.recordComfortOffer('7A', 'heating', 4)
    expect(store.consumeComfortOffer('7A', first, 5)).toBe(false)
    const second = store.getComfortOffer('7A', 6)!
    expect(store.consumeComfortOffer('7A', second, 7)).toBe(true)
    expect(store.consumeComfortOffer('7A', second, 8)).toBe(false)
    store.recordComfortOffer('7A', 'recline', 9)
    const expired = store.getComfortOffer('7A', 10)!
    expect(store.consumeComfortOffer('7A', expired, 120009)).toBe(false)
    expect(store.getComfortOffer('7A', 120010)).toBeUndefined()
  })
})
