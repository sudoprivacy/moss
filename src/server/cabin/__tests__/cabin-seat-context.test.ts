import { afterEach, describe, expect, it } from 'bun:test'
import http from 'http'
import { Database } from 'bun:sqlite'
import type { DatabaseSync } from 'node:sqlite'

import { createCabinApi } from '../api.js'
import { buildConversationKey } from '../auth.js'
import { CabinStore } from '../store.js'
import type { CabinPassengerContext } from '../types.js'
import type { RuntimeService } from '../../runtimeService.js'
import type { ServerConfig } from '../../types.js'

const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  servers.length = 0
})

function listen(server: http.Server): Promise<string> {
  servers.push(server)
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Unexpected server address')
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

async function readJsonRequest(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function createConfig(baseUrl: string): ServerConfig {
  return {
    rootDir: '/tmp/moss-cabin-seat-context-test',
    workspace: '/tmp/moss-cabin-seat-context-test/workspace',
    defaultRuntime: 'host',
    cabin: {
      enabled: true,
      contextMode: 'seat',
      tokenSecret: 'unused-in-seat-mode',
      tokenTtlSeconds: 7200,
      passengerInfoPrivacyLevel: 2,
      passengerInfoUrl: `${baseUrl}/admin-api/cabin/tablet-login/get-seat-context`,
      passengerInfoAuth: 'test1',
      asrUrl: `${baseUrl}/asr`,
      asrModel: 'asr',
      ttsUrl: `${baseUrl}/tts`,
      ttsModel: 'tts',
      ttsVoice: 'voice',
      ttsLanguage: 'zh',
      llmBaseUrl: `${baseUrl}/v1`,
      llmModel: 'llm',
      controlBaseUrl: baseUrl,
      controlTimeoutMs: 1_000,
      automationEnabled: false,
      healthReportEnabled: true,
      healthReportCollectSeconds: 30,
      healthReportMinSamples: 1,
      assistantName: 'cabin-ai-flight-attendant',
      createMossSession: false,
      replyTimeoutMs: 45_000,
      sessionRecoveryEnabled: true,
      sessionRecoveryMaxAttempts: 1,
      contextReplayTurns: 20,
      flightStateDemoEnabled: false,
      logEnabled: false,
    },
  } as unknown as ServerConfig
}

async function startCabinServer(baseUrl: string): Promise<{
  cabinBaseUrl: string
  db: DatabaseSync
}> {
  const db = new Database(':memory:') as unknown as DatabaseSync
  const runtime = {
    store: { db },
    authService: { listAllOrganizations: () => ({ organizations: [{ id: 'org-1' }] }) },
  } as unknown as RuntimeService
  const api = createCabinApi({ config: createConfig(baseUrl), runtime })
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname
    const handled = await api.handle(req, res, pathname)
    if (!handled) {
      res.writeHead(404)
      res.end()
    }
  })
  return { cabinBaseUrl: await listen(server), db }
}

const seatHeaders = {
  'x-cabin-aircraft-no': 'B-WITHFLIGHT-01',
  'x-cabin-seat-no': '01A',
}

describe('cabin seat context mode', () => {
  it('uses UE aircraft and seat headers across the complete local workflow', async () => {
    const contextRequests: Array<{
      method: string
      aircraftNo: string | null
      seatNo: string | null
      query: string
      authorization: string | undefined
      contentType: string | undefined
      tabletToken: string | undefined
    }> = []
    const controlTargets: string[] = []
    const upstream = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      if (url.pathname === '/admin-api/cabin/tablet-login/get-seat-context') {
        const body = await readJsonRequest(req)
        contextRequests.push({
          method: req.method || '',
          aircraftNo: typeof body.aircraftNo === 'string' ? body.aircraftNo : null,
          seatNo: typeof body.seatNo === 'string' ? body.seatNo : null,
          query: url.search,
          authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
          contentType: typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined,
          tabletToken: typeof req.headers['x-cabin-tablet-token'] === 'string'
            ? req.headers['x-cabin-tablet-token']
            : undefined,
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          code: 0,
          msg: '',
          data: {
            bindingId: 3936,
            tabletId: 'PAX-PAD-001',
            tabletType: 'passenger',
            aircraftId: 2,
            aircraftNo: 'SHOULD-NOT-OVERRIDE-HEADER',
            aircraftSeatId: 20,
            seatNo: 'SHOULD-NOT-OVERRIDE-HEADER',
            columnNo: 'A',
            contextStatus: 'IGNORED',
            flightId: 2,
            flightSeatId: 20,
            flight: {
              flightId: 2,
              flightNo: 'CA8888',
              flightDate: '2026-06-05',
            },
            passenger: {
              passengerRef: 'REF-01A-2',
              displayName: '  ',
              gender: 'MALE',
              language: 'zh-CN',
            },
            tabletAccessToken: 'must-not-be-used',
          },
        }))
        return
      }
      if (url.pathname === '/asr') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ text: '请帮我打开阅读灯' }))
        return
      }
      if (url.pathname === '/tts') {
        res.writeHead(200, { 'content-type': 'audio/wav' })
        res.end(Buffer.from('RIFF....WAVE'))
        return
      }
      if (url.pathname === '/admin-api/tcp-client/cmd/seat/light') {
        controlTargets.push(url.searchParams.get('seatNo') || '')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0, msg: '' }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    const upstreamBaseUrl = await listen(upstream)
    const { cabinBaseUrl, db } = await startCabinServer(upstreamBaseUrl)

    const authResponse = await fetch(`${cabinBaseUrl}/v1/auth/token`, { method: 'POST' })
    expect(authResponse.status).toBe(404)
    expect(await authResponse.json()).toMatchObject({ code: 'AUTH_TOKEN_DISABLED' })

    const form = new FormData()
    form.set('audio', new Blob([Buffer.from('RIFF....WAVE')], { type: 'audio/wav' }), 'passenger.wav')
    form.set('language', 'auto')
    const voiceResponse = await fetch(`${cabinBaseUrl}/v1/voice/query`, {
      method: 'POST',
      headers: seatHeaders,
      body: form,
    })
    expect(voiceResponse.status).toBe(200)
    expect(await voiceResponse.json()).toMatchObject({
      status: 'ok',
      seat_id: '01A',
      language: 'zh',
      text: '请帮我打开阅读灯',
    })

    const chatResponse = await fetch(`${cabinBaseUrl}/v1/ai-chat/send`, {
      method: 'POST',
      headers: { ...seatHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ content: '请帮我打开阅读灯', source: 'voice', language: 'zh' }),
    })
    expect(chatResponse.status).toBe(200)
    expect(await chatResponse.text()).toContain('event: done')
    expect(controlTargets).toEqual(['01A'])

    const historyResponse = await fetch(`${cabinBaseUrl}/v1/ai-chat/history?limit=10`, {
      headers: seatHeaders,
    })
    expect(historyResponse.status).toBe(200)
    const history = await historyResponse.json() as { messages: unknown[] }
    expect(history.messages.length).toBeGreaterThanOrEqual(2)

    const speechResponse = await fetch(`${cabinBaseUrl}/v1/tts/speech`, {
      method: 'POST',
      headers: { ...seatHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '已为您打开阅读灯。' }),
    })
    expect(speechResponse.status).toBe(200)
    expect(speechResponse.headers.get('content-type')).toBe('audio/wav')

    const startResponse = await fetch(`${cabinBaseUrl}/v1/health-reports/start`, {
      method: 'POST',
      headers: { ...seatHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'zh' }),
    })
    expect(startResponse.status).toBe(200)
    const started = await startResponse.json() as { report_id: string; seat_no: string }
    expect(started.seat_no).toBe('01A')

    const reportResponse = await fetch(`${cabinBaseUrl}/v1/health-reports/${started.report_id}`, {
      headers: seatHeaders,
    })
    expect(reportResponse.status).toBe(200)
    expect(await reportResponse.json()).toMatchObject({
      report_id: started.report_id,
      report_status: 'collecting',
      seat_no: '01A',
    })

    const resetResponse = await fetch(`${cabinBaseUrl}/v1/ai-chat/reset`, {
      method: 'POST',
      headers: seatHeaders,
    })
    expect(resetResponse.status).toBe(200)
    expect(await resetResponse.json()).toEqual({ status: 'ok', cleared: true })

    expect(contextRequests.length).toBeGreaterThanOrEqual(7)
    expect(contextRequests).toEqual(contextRequests.map(() => ({
      method: 'POST',
      aircraftNo: 'B-WITHFLIGHT-01',
      seatNo: '01A',
      query: '',
      authorization: 'test1',
      contentType: 'application/json',
      tabletToken: undefined,
    })))

    const seats = new CabinStore(db).listManagedSeats()
    expect(seats).toHaveLength(1)
    expect(seats[0]).toMatchObject({
      aircraftNo: 'B-WITHFLIGHT-01',
      flightId: '2',
      flightDate: '2026-06-05',
      seatNo: '01A',
      tabletId: 'PAX-PAD-001',
    })
  })

  it('returns explicit seat header and upstream response errors', async () => {
    const upstream = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      if (url.pathname !== '/admin-api/cabin/tablet-login/get-seat-context') {
        res.writeHead(404)
        res.end()
        return
      }
      const body = await readJsonRequest(req)
      const seatNo = typeof body.seatNo === 'string' ? body.seatNo : undefined
      res.writeHead(200, { 'content-type': 'application/json' })
      if (seatNo === 'REJECT') {
        res.end(JSON.stringify({ code: 41001, msg: 'seat is not bound', data: null }))
        return
      }
      res.end(JSON.stringify({
        code: 0,
        data: {
          flightId: 2,
          flight: { flightDate: '2026-06-05' },
          passenger: {},
        },
      }))
    })
    const upstreamBaseUrl = await listen(upstream)
    const { cabinBaseUrl } = await startCabinServer(upstreamBaseUrl)

    const missingHeaderResponse = await fetch(`${cabinBaseUrl}/v1/ai-chat/history`, {
      headers: { 'x-cabin-aircraft-no': 'B-WITHFLIGHT-01' },
    })
    expect(missingHeaderResponse.status).toBe(400)
    expect(await missingHeaderResponse.json()).toMatchObject({ code: 'MISSING_SEAT_NO' })

    const rejectedResponse = await fetch(`${cabinBaseUrl}/v1/ai-chat/history`, {
      headers: { ...seatHeaders, 'x-cabin-seat-no': 'REJECT' },
    })
    expect(rejectedResponse.status).toBe(502)
    expect(await rejectedResponse.json()).toMatchObject({
      code: 'SEAT_CONTEXT_FAILED',
      message: 'seat is not bound',
    })

    const invalidResponse = await fetch(`${cabinBaseUrl}/v1/ai-chat/history`, {
      headers: { ...seatHeaders, 'x-cabin-seat-no': 'INVALID' },
    })
    expect(invalidResponse.status).toBe(502)
    expect(await invalidResponse.json()).toMatchObject({
      code: 'SEAT_CONTEXT_INVALID',
      message: 'Seat context response missing passengerRef',
    })
  })

  it('keeps 16 concurrent tablet seats and conversations isolated', async () => {
    const seenSeats: string[] = []
    const upstream = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      if (url.pathname !== '/admin-api/cabin/tablet-login/get-seat-context') {
        res.writeHead(404)
        res.end()
        return
      }
      const body = await readJsonRequest(req)
      const seatNo = typeof body.seatNo === 'string' ? body.seatNo : ''
      seenSeats.push(seatNo)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        code: 0,
        data: {
          tabletId: `PAD-${seatNo}`,
          seatNo: 'IGNORED',
          flightId: 2,
          flight: { flightDate: '2026-06-05' },
          passenger: { passengerRef: `REF-${seatNo}-2`, language: 'zh-CN' },
        },
      }))
    })
    const upstreamBaseUrl = await listen(upstream)
    const { cabinBaseUrl, db } = await startCabinServer(upstreamBaseUrl)
    const seats = Array.from({ length: 16 }, (_, index) => `SEAT-${String(index + 1).padStart(2, '0')}`)

    const responses = await Promise.all(seats.map(seatNo => fetch(`${cabinBaseUrl}/v1/ai-chat/history?limit=1`, {
      headers: {
        'x-cabin-aircraft-no': 'B-WITHFLIGHT-01',
        'x-cabin-seat-no': seatNo,
      },
    })))
    expect(responses.map(response => response.status)).toEqual(seats.map(() => 200))
    expect(seenSeats.sort()).toEqual([...seats].sort())

    const managedSeats = new CabinStore(db).listManagedSeats()
    expect(managedSeats).toHaveLength(16)
    expect(managedSeats.map(seat => seat.seatNo).sort()).toEqual([...seats].sort())
    const conversationCount = db.prepare('SELECT COUNT(*) AS count FROM cabin_conversations').get() as { count: number }
    expect(conversationCount.count).toBe(16)
  })

  it('isolates seat-mode conversations by aircraft, flight date, seat, and passenger', () => {
    const base: CabinPassengerContext = {
      contextMode: 'seat',
      aircraftNo: 'B-WITHFLIGHT-01',
      flightId: '2',
      flightDate: '2026-06-05',
      seatId: 'A',
      passengerRef: 'REF-A-2',
      tabletId: 'PAX-PAD-001',
    }
    const key = buildConversationKey(base)
    expect(buildConversationKey({ ...base })).toBe(key)
    expect(buildConversationKey({ ...base, aircraftNo: 'B-WITHFLIGHT-02' })).not.toBe(key)
    expect(buildConversationKey({ ...base, flightDate: '2026-06-06' })).not.toBe(key)
    expect(buildConversationKey({ ...base, seatId: 'B' })).not.toBe(key)
    expect(buildConversationKey({ ...base, passengerRef: 'REF-B-2' })).not.toBe(key)

    const legacy = { ...base, contextMode: 'tablet-token' as const }
    expect(buildConversationKey({ ...legacy, seatId: 'B' })).toBe(buildConversationKey(legacy))
  })
})
