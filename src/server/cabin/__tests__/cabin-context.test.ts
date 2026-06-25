import { afterEach, describe, expect, it } from 'bun:test'
import { createHmac } from 'crypto'
import http from 'http'
import { Database } from 'bun:sqlite'
import type { DatabaseSync } from 'node:sqlite'
import { issueCabinToken, verifyCabinTokenDetailed } from '../auth.js'
import { createCabinApi } from '../api.js'
import { CabinServices } from '../service.js'
import type { RuntimeService } from '../../runtimeService.js'
import type { ServerConfig } from '../../types.js'

function signTokenBody(body: string, secret: string): string {
  return Buffer.from(createHmac('sha256', secret).update(body).digest())
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

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

function createCabinTestConfig(baseUrl: string): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    authMode: 'local',
    tokenTtlSec: 3600,
    bootstrapAdmin: { username: 'admin' },
    defaultRuntime: 'host',
    engine: 'scode',
    idleTimeoutMs: 0,
    maxSessions: 10,
    rootDir: '/tmp/moss-cabin-test',
    dbPath: ':memory:',
    transcriptDir: '/tmp/moss-cabin-test/transcripts',
    runtimeDir: '/tmp/moss-cabin-test/runtime',
    dockerStopTimeoutSec: 10,
    dockerLabels: {},
    docker: {
      containerMode: 'session',
      maxSessionsPerUser: 5,
      userContainerIdleTimeoutMs: 20 * 60_000,
      execKillGraceMs: 5_000,
      user: {
        pidsLimit: 512,
        memory: '4g',
        cpus: '2',
        nofile: 4096,
      },
    },
    recovery: {
      startupPolicy: 'reattach-or-resume',
      heartbeatTimeoutMs: 30_000,
      reattachProbeTimeoutMs: 3_000,
      resumeOnMissingRuntime: true,
    },
    logging: { level: 'info' },
    hub: {},
    wikiIndex: {
      enabled: false,
      modelId: 'Xenova/multilingual-e5-small',
      maxPassagesPerWiki: 20_000,
      topKVector: 50,
    },
    workspace: '/tmp/moss-cabin-test/workspace',
    cabin: {
      enabled: true,
      tokenSecret: 'test-secret',
      tokenTtlSeconds: 7200,
      passengerInfoUrl: `${baseUrl}/passenger`,
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
      controlTimeoutMs: 10_000,
      assistantName: 'cabin-ai-flight-attendant',
      createMossSession: false,
    },
  }
}

async function readSse(response: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const body = await response.text()
  return body
    .trim()
    .split(/\n\n+/)
    .filter(Boolean)
    .map(chunk => {
      const event = chunk.match(/^event:\s*(.+)$/m)?.[1] || ''
      const data = chunk.match(/^data:\s*(.+)$/m)?.[1] || '{}'
      return { event, data: JSON.parse(data) as Record<string, unknown> }
    })
}

describe('cabin binding context', () => {
  it('preserves seat binding fields in cabin access tokens', () => {
    const token = issueCabinToken({
      tabletToken: 'tablet-token',
      tabletId: 'PAX-PAD-0001',
      seatNo: '01A',
      columnNo: 'A',
      flightSeatId: '20',
      aircraftSeatId: '120',
      aircraftId: '2',
      aircraftNo: 'B-WITHFLIGHT-01',
      tabletType: 'passenger',
      bindingId: '39',
      contextStatus: 'FLIGHT_LOADED',
    }, {
      secret: 'test-secret',
      ttlSeconds: 7200,
      nowMs: 1_000,
    })

    const result = verifyCabinTokenDetailed(token, {
      secret: 'test-secret',
      nowMs: 2_000,
    })

    expect(result.reason).toBeUndefined()
    expect(result.payload).toMatchObject({
      tabletToken: 'tablet-token',
      tabletId: 'PAX-PAD-0001',
      seatNo: '01A',
      columnNo: 'A',
      flightSeatId: '20',
      aircraftSeatId: '120',
      aircraftId: '2',
      aircraftNo: 'B-WITHFLIGHT-01',
      tabletType: 'passenger',
      bindingId: '39',
      contextStatus: 'FLIGHT_LOADED',
    })
  })

  it('keeps columnNo extensible instead of limiting it to A/B', () => {
    const token = issueCabinToken({
      tabletToken: 'tablet-token',
      tabletId: 'PAX-PAD-0002',
      seatNo: '01C',
      columnNo: 'C',
      flightSeatId: '21',
    }, {
      secret: 'test-secret',
      ttlSeconds: 7200,
      nowMs: 1_000,
    })

    const result = verifyCabinTokenDetailed(token, {
      secret: 'test-secret',
      nowMs: 2_000,
    })

    expect(result.payload?.columnNo).toBe('C')
  })

  it('rejects malformed token payload types', () => {
    const valid = issueCabinToken({
      tabletToken: 'tablet-token',
      tabletId: 'PAX-PAD-0003',
      seatNo: '01A',
      columnNo: 'A',
      flightSeatId: '20',
    }, {
      secret: 'test-secret',
      ttlSeconds: 7200,
      nowMs: 1_000,
    })
    const [body] = valid.slice('ai_'.length).split('.')
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    payload.columnNo = ['A']
    const tamperedBody = Buffer.from(JSON.stringify(payload))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')

    const result = verifyCabinTokenDetailed(`ai_${tamperedBody}.${signTokenBody(tamperedBody, 'test-secret')}`, {
      secret: 'test-secret',
      nowMs: 2_000,
    })

    expect(result.reason).toBe('invalid')
    expect(result.payload).toBeNull()
  })

  it('adds server-side seat binding context to inferred tool calls', () => {
    const services = new CabinServices({
      config: {
        enabled: true,
        asrUrl: 'http://127.0.0.1/asr',
        asrModel: 'asr',
        ttsUrl: 'http://127.0.0.1/tts',
        ttsModel: 'tts',
        ttsVoice: 'voice',
        ttsLanguage: 'zh',
        llmBaseUrl: 'http://127.0.0.1/v1',
        llmModel: 'llm',
        passengerInfoUrl: 'http://127.0.0.1/passenger',
        passengerInfoPrivacyLevel: 2,
        tokenSecret: 'test-secret',
        tokenTtlSeconds: 7200,
        createMossSession: false,
        assistantName: 'cabin-ai-flight-attendant',
      },
      store: null as never,
    })

    const inferred = services.inferToolCall({
      text: '帮我关闭读书灯',
      context: {
        flightId: '2',
        flightDate: '2026-06-02',
        flightSeatId: '20',
        aircraftSeatId: '120',
        seatId: '01A',
        columnNo: 'A',
        tabletId: 'PAX-PAD-0001',
      },
    })

    expect(inferred?.toolCall.arguments).toMatchObject({
      seat_id: '01A',
      seat_no: '01A',
      column_no: 'A',
      seat_side: 'A',
      flight_seat_id: '20',
      aircraft_seat_id: '120',
      action: 'off',
    })
  })

  it('streams ASR text before agent reply in voice chat and stores one user message', async () => {
    const upstream = http.createServer((req, res) => {
      if (req.url === '/passenger') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          code: 0,
          data: {
            flightId: '2',
            flightDate: '2026-06-05',
            flightNo: 'MU001',
            seatNo: '01A',
            flightSeatId: '20',
            passengerRef: 'REF-01A-2',
            passengerName: '刘女士',
            language: 'zh',
          },
        }))
        return
      }
      if (req.url === '/asr') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ text: '请帮我关闭读书灯' }))
        return
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          choices: [
            { message: { content: '已为您下发关闭读书灯的指令，请稍候。' } },
          ],
        }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    const upstreamBaseUrl = await listen(upstream)
    const db = new Database(':memory:') as unknown as DatabaseSync
    const runtime = {
      store: { db },
      authService: { listAllOrganizations: () => ({ organizations: [{ id: 'org-1' }] }) },
    } as unknown as RuntimeService
    const api = createCabinApi({
      config: createCabinTestConfig(upstreamBaseUrl),
      runtime,
    })
    const cabinServer = http.createServer(async (req, res) => {
      const pathname = new URL(req.url || '/', 'http://localhost').pathname
      const handled = await api.handle(req, res, pathname)
      if (!handled) {
        res.writeHead(404)
        res.end()
      }
    })
    const cabinBaseUrl = await listen(cabinServer)

    const tokenResponse = await fetch(`${cabinBaseUrl}/v1/auth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cabin-tablet-token': 'tablet-token',
        'x-cabin-tablet-id': 'PAX-PAD-0001',
      },
      body: JSON.stringify({
        seatNo: '01A',
        columnNo: 'A',
        flightSeatId: '20',
      }),
    })
    const tokenPayload = await tokenResponse.json() as { access_token: string }
    const form = new FormData()
    form.set('audio', new Blob([Buffer.from('RIFF....WAVE')], { type: 'audio/wav' }), 'passenger.wav')
    form.set('language', 'auto')
    const voiceChatResponse = await fetch(`${cabinBaseUrl}/v1/voice-chat/send`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenPayload.access_token}`,
        'x-cabin-tablet-token': 'tablet-token',
        'x-cabin-tablet-id': 'PAX-PAD-0001',
      },
      body: form,
    })
    expect(voiceChatResponse.status).toBe(200)
    const events = await readSse(voiceChatResponse)
    expect(events.map(event => event.event)).toEqual(['start', 'asr_result', 'tool_call', 'delta', 'done'])
    expect(events[1].data).toMatchObject({
      status: 'ok',
      seat_id: '01A',
      language: 'zh',
      text: '请帮我关闭读书灯',
    })
    expect(events.at(-1)?.data.reply_text).toBe('已为您下发关闭读书灯的指令，请稍候。')

    const historyResponse = await fetch(`${cabinBaseUrl}/v1/ai-chat/history?limit=10`, {
      headers: {
        authorization: `Bearer ${tokenPayload.access_token}`,
        'x-cabin-tablet-token': 'tablet-token',
        'x-cabin-tablet-id': 'PAX-PAD-0001',
      },
    })
    const history = await historyResponse.json() as {
      messages: Array<{ role: string; source: string; content: string }>
    }
    expect(history.messages).toHaveLength(2)
    expect(history.messages.map(message => ({
      role: message.role,
      source: message.source,
      content: message.content,
    }))).toEqual([
      {
        role: 'user',
        source: 'voice',
        content: '请帮我关闭读书灯',
      },
      {
        role: 'assistant',
        source: 'agent',
        content: '已为您下发关闭读书灯的指令，请稍候。',
      },
    ])
  })
})
