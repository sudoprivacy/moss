import { describe, expect, it } from 'bun:test'
import http from 'http'
import { Database } from 'bun:sqlite'
import type { DatabaseSync } from 'node:sqlite'

import { createCabinApi } from '../api.js'
import { CabinServices } from '../service.js'
import { CabinStore } from '../store.js'
import type { CabinConfig, CabinPassengerContext } from '../types.js'
import type { RuntimeService } from '../../runtimeService.js'
import type { ServerConfig } from '../../types.js'

const context: CabinPassengerContext = {
  contextMode: 'seat',
  flightId: 'F1',
  flightDate: '2026-10-26',
  flightNo: 'CA8888',
  aircraftNo: 'B-TEST',
  seatId: '01A',
  tabletId: 'PAX-1',
  passengerRef: 'REF-1A',
}

function config(overrides: Partial<CabinConfig> = {}): CabinConfig {
  return {
    enabled: true,
    contextMode: 'seat',
    ttsUrl: 'http://tts.test/v1/audio/speech',
    ttsModel: 'tts-test',
    ttsVoice: 'voice-test',
    ttsLanguage: 'chinese',
    broadcastApiBaseUrl: 'http://broadcast.test',
    broadcastApiKey: 'hardware-key',
    broadcastAuth: 'test1',
    broadcastEnabled: true,
    conversationSeatAudioEnabled: true,
    controlTimeoutMs: 1000,
    ...overrides,
  } as CabinConfig
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function servicesWith(fetchImpl: typeof fetch, overrides: Partial<CabinConfig> = {}): CabinServices {
  return new CabinServices({
    config: config(overrides),
    store: new CabinStore(new Database(':memory:') as unknown as DatabaseSync),
    fetchImpl,
  })
}

describe('conversation seat audio', () => {
  it('generates TTS and uploads the audio to the requested seat', async () => {
    let ttsCalls = 0
    let broadcastCalls = 0
    let received: Record<string, string> = {}
    let receivedFileSize = 0
    const services = servicesWith(async (input, init) => {
      const url = String(input)
      if (url === 'http://tts.test/v1/audio/speech') {
        ttsCalls += 1
        expect(init?.headers).toMatchObject({ 'content-type': 'application/json' })
        return new Response(Buffer.from('RIFF-test-wave'), {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        })
      }
      if (url === 'http://broadcast.test/admin-api/cabin/broadcast/audio-seat') {
        broadcastCalls += 1
        const headers = new Headers(init?.headers)
        expect(headers.get('x-hardware-api-key')).toBe('hardware-key')
        expect(headers.get('authorization')).toBe('test1')
        const form = await new Response(init?.body).formData()
        for (const key of ['title', 'aircraftNo', 'seatNo']) {
          received[key] = String(form.get(key))
        }
        const file = form.get('file')
        receivedFileSize = file instanceof File ? file.size : 0
        return response({
          code: 0,
          data: {
            requestId: 'BC-conversation-1',
            matchedCount: 1,
            sentCount: 1,
            audioUrl: 'http://broadcast.test/audio/conversation.wav',
          },
        })
      }
      throw new Error(`unexpected URL: ${url}`)
    })

    const result = await services.speakToSeat({
      context,
      text: '已为您打开阅读灯。',
      logContext: { requestId: 'req_audio_1', seatNo: context.seatId },
    })

    expect(result).toMatchObject({
      status: 'sent',
      requestId: 'BC-conversation-1',
      matchedCount: 1,
      sentCount: 1,
      audioUrl: 'http://broadcast.test/audio/conversation.wav',
    })
    expect(ttsCalls).toBe(1)
    expect(broadcastCalls).toBe(1)
    expect(received).toEqual({
      title: 'AI 对话',
      aircraftNo: 'B-TEST',
      seatNo: '01A',
    })
    expect(receivedFileSize).toBeGreaterThan(0)
  })

  it('reports no_online_client when the API accepted the request but sent no audio', async () => {
    const services = servicesWith(async (input, init) => {
      if (String(input) === 'http://tts.test/v1/audio/speech') {
        return new Response(Buffer.from('RIFF-test-wave'), { headers: { 'content-type': 'audio/wav' } })
      }
      expect(String(input)).toBe('http://broadcast.test/admin-api/cabin/broadcast/audio-seat')
      expect(init?.method).toBe('POST')
      return response({ code: 0, data: { matchedCount: 0, sentCount: 0 } })
    })

    await expect(services.speakToSeat({ context, text: '测试' })).resolves.toMatchObject({
      status: 'no_online_client',
      matchedCount: 0,
      sentCount: 0,
    })
  })

  it('does not mark a response without sentCount as delivered', async () => {
    const services = servicesWith(async input => {
      if (String(input) === 'http://tts.test/v1/audio/speech') {
        return new Response(Buffer.from('RIFF-test-wave'), { headers: { 'content-type': 'audio/wav' } })
      }
      return response({ code: 0, data: { matchedCount: 1 } })
    })

    await expect(services.speakToSeat({ context, text: '测试' })).resolves.toMatchObject({
      status: 'failed',
      error: 'broadcast response missing a positive sentCount',
    })
  })

  it('skips both TTS and broadcast when automatic seat audio is disabled', async () => {
    let calls = 0
    const services = servicesWith(async () => {
      calls += 1
      throw new Error('must not call upstream')
    }, { conversationSeatAudioEnabled: false })

    await expect(services.speakToSeat({ context, text: '测试' })).resolves.toMatchObject({
      status: 'skipped',
      error: 'conversation seat audio is disabled',
    })
    expect(calls).toBe(0)
  })

  it('adds seat playback result to the SSE done event for a normal chat reply', async () => {
    const requests: Array<{ pathname: string; aircraftNo?: string; seatNo?: string }> = []
    let ttsCalls = 0
    let broadcastCalls = 0
    const upstream = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      if (url.pathname === '/admin-api/cabin/tablet-login/get-seat-context') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { aircraftNo?: string; seatNo?: string }
        requests.push({ pathname: url.pathname, aircraftNo: body.aircraftNo, seatNo: body.seatNo })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          code: 0,
          data: {
            aircraftNo: 'B-TEST',
            seatNo: '01A',
            flightId: 'F1',
            flight: { flightNo: 'CA8888', flightDate: '2026-10-26' },
            passenger: { passengerRef: 'REF-1A', language: 'zh-CN' },
            tabletAccessToken: 'tablet-access-token',
          },
        }))
        return
      }
      if (url.pathname === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: '您好，已收到您的请求。' } }] }))
        return
      }
      if (url.pathname === '/tts') {
        ttsCalls += 1
        res.writeHead(200, { 'content-type': 'audio/wav' })
        res.end(Buffer.from('RIFF-test-wave'))
        return
      }
      if (url.pathname === '/admin-api/cabin/broadcast/audio-seat') {
        broadcastCalls += 1
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const multipart = Buffer.concat(chunks).toString('utf8')
        expect(multipart).toContain('name="aircraftNo"')
        expect(multipart).toContain('B-TEST')
        expect(multipart).toContain('name="seatNo"')
        expect(multipart).toContain('01A')
        expect(multipart).toContain('name="file"')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0, data: { requestId: 'BC-sse-1', matchedCount: 1, sentCount: 1 } }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('Unexpected upstream address')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const db = new Database(':memory:') as unknown as DatabaseSync
    const runtime = {
      store: { db },
      authService: { listAllOrganizations: () => ({ organizations: [{ id: 'org-1' }] }) },
    } as unknown as RuntimeService
    const config = {
      rootDir: '/tmp/moss-cabin-conversation-audio-api-test',
      cabin: {
        enabled: true,
        contextMode: 'seat',
        passengerInfoUrl: `${baseUrl}/admin-api/cabin/tablet-login/get-seat-context`,
        passengerInfoAuth: 'test1',
        passengerInfoPrivacyLevel: 2,
        asrUrl: `${baseUrl}/asr`,
        asrModel: 'asr',
        ttsUrl: `${baseUrl}/tts`,
        ttsModel: 'tts',
        ttsVoice: 'voice',
        ttsLanguage: 'zh',
        llmBaseUrl: `${baseUrl}/v1`,
        llmModel: 'llm',
        broadcastApiBaseUrl: baseUrl,
        broadcastApiKey: 'hardware-key',
        broadcastAuth: 'test1',
        broadcastEnabled: true,
        conversationSeatAudioEnabled: true,
        controlTimeoutMs: 1000,
        automationEnabled: false,
        healthReportEnabled: false,
        assistantName: 'cabin-ai-flight-attendant',
        createMossSession: false,
        replyTimeoutMs: 1000,
        sessionRecoveryEnabled: true,
        sessionRecoveryMaxAttempts: 1,
        contextReplayTurns: 20,
        flightStateDemoEnabled: false,
        logEnabled: false,
      },
    } as unknown as ServerConfig
    const api = createCabinApi({ config, runtime })
    const cabinServer = http.createServer(async (req, res) => {
      const pathname = new URL(req.url || '/', 'http://localhost').pathname
      const handled = await api.handle(req, res, pathname)
      if (!handled) {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>(resolve => cabinServer.listen(0, '127.0.0.1', resolve))
    const cabinAddress = cabinServer.address()
    if (!cabinAddress || typeof cabinAddress === 'string') throw new Error('Unexpected cabin address')
    try {
      const result = await fetch(`http://127.0.0.1:${cabinAddress.port}/v1/ai-chat/send`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-cabin-aircraft-no': 'B-TEST',
          'x-cabin-seat-no': '01A',
        },
        body: JSON.stringify({ content: '你好', source: 'text' }),
      })
      expect(result.status).toBe(200)
      const body = await result.text()
      expect(body).toContain('event: done')
      expect(body).toContain('"status":"sent"')
      expect(body).toContain('"request_id":"BC-sse-1"')
      expect(body).toContain('"sent_count":1')
      expect(requests).toEqual([{ pathname: '/admin-api/cabin/tablet-login/get-seat-context', aircraftNo: 'B-TEST', seatNo: '01A' }])
      expect(ttsCalls).toBe(1)
      expect(broadcastCalls).toBe(1)
    } finally {
      await new Promise<void>(resolve => cabinServer.close(() => resolve()))
      await new Promise<void>(resolve => upstream.close(() => resolve()))
    }
  })
})
