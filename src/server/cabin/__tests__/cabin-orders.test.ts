import { describe, expect, it } from 'bun:test'
import http from 'http'
import { Database } from 'bun:sqlite'
import type { DatabaseSync } from 'node:sqlite'
import { createCabinApi } from '../api.js'
import { CabinServices } from '../service.js'
import { CabinStore } from '../store.js'
import {
  CabinOrderClient,
  looksLikeCabinOrderRequest,
  parseModelCabinOrderIntent,
  parseCabinOrderIntent,
} from '../orders.js'
import type { CabinConfig, CabinPassengerContext } from '../types.js'
import type { RuntimeService } from '../../runtimeService.js'
import type { ServerConfig } from '../../types.js'

const context: CabinPassengerContext = {
  contextMode: 'seat',
  flightId: 'F1',
  flightDate: '2026-10-26',
  aircraftNo: 'B-TEST',
  seatId: '1A',
  tabletId: 'PAX-1',
  tabletAccessToken: 'cabin-access-token',
  passengerRef: 'REF-1A',
}

function config(): CabinConfig {
  return {
    controlBaseUrl: 'http://control.local',
    controlAuth: 'test-auth',
    controlTimeoutMs: 500,
  } as unknown as CabinConfig
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('cabin order intent parsing', () => {
  it('maps Chinese quantities to a single blanket order', () => {
    expect(parseCabinOrderIntent('请给我两条毛毯')).toEqual({
      kind: 'create',
      serviceTypeId: 1,
      subItemIds: [],
      quantities: [2],
    })
  })

  it('maps multiple drinks and quantities by sub-item position', () => {
    expect(parseCabinOrderIntent('我要两杯可乐和一杯橙汁')).toEqual({
      kind: 'create',
      serviceTypeId: 3,
      subItemIds: [1, 2],
      quantities: [2, 1],
    })
  })

  it('recognizes query and cancel intents before create intent', () => {
    expect(parseCabinOrderIntent('查一下我的订单')).toEqual({ kind: 'query' })
    expect(parseCabinOrderIntent('取消我的可乐')).toEqual({
      kind: 'cancel',
      serviceTypeId: 3,
      subItemIds: [1],
    })
  })

  it('validates the structured model intent and keeps non-order chat out of the classifier', () => {
    expect(looksLikeCabinOrderRequest('我有点渴，想喝点东西')).toBe(true)
    expect(looksLikeCabinOrderRequest('北京今天的天气怎么样')).toBe(false)
    expect(parseModelCabinOrderIntent({
      choices: [{ message: { content: JSON.stringify({
        kind: 'create',
        serviceTypeId: 3,
        subItemIds: [1],
        quantities: [2],
      }) } }],
    })).toEqual({
      kind: 'create',
      serviceTypeId: 3,
      subItemIds: [1],
      quantities: [2],
    })
    expect(parseModelCabinOrderIntent({
      kind: 'create',
      serviceTypeId: 3,
      subItemIds: [99],
      quantities: [1],
    })).toBeNull()
  })
})

describe('CabinOrderClient', () => {
  it('sends tablet-token, Authorization, quantity and the documented endpoint', async () => {
    let request: { url: string; init: RequestInit } | null = null
    const client = new CabinOrderClient(config(), async (url, init) => {
      request = { url: String(url), init: init || {} }
      return response({ code: 0, data: 123 })
    })

    const result = await client.create({
      context,
      serviceTypeId: 3,
      subItemIds: [1, 2],
      quantities: [2, 1],
    })

    expect(result.ok).toBe(true)
    expect(request?.url).toBe('http://control.local/admin-api/cabin/service-order/create')
    expect(request?.init.headers).toMatchObject({
      authorization: 'test-auth',
      'tablet-token': 'cabin-access-token',
    })
    expect(JSON.parse(String(request?.init.body))).toEqual({
      serviceTypeId: 3,
      subItemIds: [1, 2],
      quantities: [2, 1],
    })
  })
})

describe('fuzzy cabin order intent classification', () => {
  it('asks the model for a structured intent only after deterministic parsing misses', async () => {
    let modelCalls = 0
    const services = new CabinServices({
      config: {
        ...config(),
        llmBaseUrl: 'http://llm.local/v1',
        llmModel: 'gpt-5.5',
        llmApiKey: 'test-key',
        replyTimeoutMs: 500,
      } as unknown as CabinConfig,
      store: new CabinStore(new Database(':memory:') as unknown as DatabaseSync),
      fetchImpl: async (url, init) => {
        if (!String(url).endsWith('/chat/completions')) return response({ code: 404 }, 404)
        modelCalls += 1
        expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key' })
        return response({
          choices: [{ message: { content: JSON.stringify({
            kind: 'create',
            serviceTypeId: 3,
            subItemIds: [2],
            quantities: [1],
          }) } }],
        })
      },
    })

    const fuzzy = await services.resolveOrderIntent({ context, text: '我有点渴，想喝点东西' })
    const explicit = await services.resolveOrderIntent({ context, text: '请给我一杯橙汁' })
    expect(modelCalls).toBe(1)
    expect(fuzzy).toEqual({ kind: 'create', serviceTypeId: 3, subItemIds: [2], quantities: [1] })
    expect(explicit).toEqual({ kind: 'create', serviceTypeId: 3, subItemIds: [2], quantities: [1] })
  })
})

describe('CabinServices order lifecycle', () => {
  it('asks which order to cancel when multiple active orders match, then cancels the selected candidate', async () => {
    const cancelRequests: number[] = []
    const store = new CabinStore(new Database(':memory:') as unknown as DatabaseSync)
    const services = new CabinServices({
      config: config(),
      store,
      fetchImpl: async (url, init) => {
        const parsed = new URL(String(url))
        if (parsed.pathname.endsWith('/list-by-seat')) {
          return response({
            code: 0,
            data: [
              {
                id: 101,
                orderNo: 'SV-101',
                serviceTypeId: 3,
                serviceTypeName: '饮品',
                status: 1,
                statusName: '已接单',
                items: [{ subItemId: 1, itemName: '可乐', quantity: 2 }],
                createTime: '2026-10-26 10:15:00',
              },
              {
                id: 102,
                orderNo: 'SV-102',
                serviceTypeId: 3,
                serviceTypeName: '饮品',
                status: 2,
                statusName: '配送中',
                items: [{ subItemId: 1, itemName: '可乐', quantity: 1 }],
                createTime: '2026-10-26 10:20:00',
              },
            ],
          })
        }
        cancelRequests.push(JSON.parse(String(init?.body)).orderId)
        return response({ code: 0, data: true })
      },
    })
    const conversation = await services.ensureConversation(context)

    const confirmation = await services.executeOrderIntent({
      context,
      conversationId: conversation.id,
      text: '取消我的可乐',
    })
    expect(confirmation.intent).toBe('service_order_cancel_confirmation')
    expect(confirmation.reply).toContain('请问要取消哪一笔')
    expect(cancelRequests).toHaveLength(0)

    const cancelled = await services.executeOrderIntent({
      context,
      conversationId: conversation.id,
      text: '第2笔',
    })
    expect(cancelled.ok).toBe(true)
    expect(cancelled.slots.order_id).toBe('102')
    expect(cancelRequests).toEqual([102])
    expect(store.getPendingOrderCancellation(conversation.id)).toBeNull()
  })

  it('queries all documented order statuses and returns actual order data', async () => {
    let queryUrl = ''
    const store = new CabinStore(new Database(':memory:') as unknown as DatabaseSync)
    const services = new CabinServices({
      config: config(),
      store,
      fetchImpl: async url => {
        queryUrl = String(url)
        return response({ code: 0, data: [{ id: 1, serviceTypeId: 1, status: 3, statusName: '已送达', items: [] }] })
      },
    })
    const conversation = await services.ensureConversation(context)
    const result = await services.executeOrderIntent({
      context,
      conversationId: conversation.id,
      text: '查一下我的订单',
    })
    expect(result.ok).toBe(true)
    expect(queryUrl).toContain('/list-by-seat?status=1%2C2%2C3%2C4')
    expect(result.reply).toContain('已送达')
  })
})

describe('seat context order API integration', () => {
  it('uses tabletAccessToken returned by seat context for the create request', async () => {
    const received: { auth?: string; tabletToken?: string; body?: Record<string, unknown> } = {}
    const upstream = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      if (url.pathname === '/seat-context') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          code: 0,
          data: {
            flightId: 2,
            flightDate: '2026-10-26',
            flightNo: 'CA8888',
            seatNo: '1A',
            passenger: { passengerRef: 'REF-1A', language: 'zh-CN' },
            tabletId: 'PAX-1',
            tabletAccessToken: 'cabin-access-token-from-context',
          },
        }))
        return
      }
      if (url.pathname === '/admin-api/cabin/service-order/create') {
        received.auth = req.headers.authorization
        received.tabletToken = req.headers['tablet-token'] as string | undefined
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        received.body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0, data: 99, msg: '' }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    const baseUrl = await new Promise<string>(resolve => {
      upstream.listen(0, '127.0.0.1', () => {
        const address = upstream.address() as { port: number }
        resolve(`http://127.0.0.1:${address.port}`)
      })
    })
    const config = {
      rootDir: '/tmp/moss-cabin-order-test',
      workspace: '/tmp/moss-cabin-order-test',
      cabin: {
        enabled: true,
        contextMode: 'seat',
        passengerInfoUrl: `${baseUrl}/seat-context`,
        controlBaseUrl: baseUrl,
        controlAuth: 'control-auth',
        controlTimeoutMs: 500,
        tokenSecret: 'test-secret',
        tokenTtlSeconds: 3600,
        passengerInfoPrivacyLevel: 2,
        createMossSession: false,
        llmModel: 'test',
      },
    } as unknown as ServerConfig
    const runtime = {
      store: { db: new Database(':memory:') },
    } as unknown as RuntimeService
    const api = createCabinApi({ config, runtime })
    const app = http.createServer(async (req, res) => {
      const pathname = new URL(req.url || '/', 'http://localhost').pathname
      if (!(await api.handle(req, res, pathname))) {
        res.writeHead(404)
        res.end()
      }
    })
    const appUrl = await new Promise<string>(resolve => {
      app.listen(0, '127.0.0.1', () => {
        const address = app.address() as { port: number }
        resolve(`http://127.0.0.1:${address.port}`)
      })
    })

    try {
      const responseBody = await fetch(`${appUrl}/v1/ai-chat/send`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-cabin-aircraft-no': 'B-TEST',
          'x-cabin-seat-no': '1A',
        },
        body: JSON.stringify({ content: '请给我两条毛毯', source: 'text' }),
      })
      const body = await responseBody.text()
      expect(responseBody.status).toBe(200)
      expect(body).toContain('quantities')
      expect(received).toMatchObject({
        auth: 'control-auth',
        tabletToken: 'cabin-access-token-from-context',
        body: { serviceTypeId: 1, subItemIds: [], quantities: [2] },
      })
    } finally {
      await new Promise<void>(resolve => app.close(() => resolve()))
      await new Promise<void>(resolve => upstream.close(() => resolve()))
    }
  })
})
