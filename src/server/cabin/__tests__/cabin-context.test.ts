import { afterEach, describe, expect, it } from 'bun:test'
import { createHmac } from 'crypto'
import http from 'http'
import { Database } from 'bun:sqlite'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DatabaseSync } from 'node:sqlite'
import { issueCabinToken, verifyCabinTokenDetailed } from '../auth.js'
import { createCabinApi } from '../api.js'
import { CabinServices, normalizeCabinHardwareReply, normalizeCabinPassengerReply } from '../service.js'
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
      assistantDisplayName: '客舱 AI 乘务员',
      createMossSession: false,
      flightStateDemoEnabled: false,
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
  it('writes structured cabin request logs', async () => {
    const upstream = http.createServer((req, res) => {
      if (req.url === '/passenger') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          code: 0,
          data: {
            flightId: '2',
            flightDate: '2026-06-05',
            flightNo: 'MU001',
            seatNo: 'A',
            flightSeatId: '20',
            passengerRef: 'REF-A-2',
            passengerName: '刘女士',
            language: 'zh',
          },
        }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    const upstreamBaseUrl = await listen(upstream)
    const tempDir = await mkdtemp(join(tmpdir(), 'moss-cabin-log-test-'))
    const logFile = join(tempDir, 'cabin.jsonl')
    try {
      const runtime = {
        store: { db: new Database(':memory:') },
        authService: { listAllOrganizations: () => ({ organizations: [{ id: 'org-1' }] }) },
      } as unknown as RuntimeService
      const config = createCabinTestConfig(upstreamBaseUrl)
      config.rootDir = tempDir
      config.cabin.logFile = logFile
      const api = createCabinApi({ config, runtime })
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
          'x-cabin-tablet-id': 'PAX-PAD-0003',
        },
        body: JSON.stringify({
          seatNo: 'A',
          columnNo: 'A',
          flightSeatId: '20',
        }),
      })
      expect(tokenResponse.status).toBe(200)
      const requestId = tokenResponse.headers.get('x-request-id')
      expect(requestId).toStartWith('req_')

      await new Promise(resolve => setTimeout(resolve, 50))
      const lines = (await readFile(logFile, 'utf8')).trim().split('\n')
      const events = lines.map(line => JSON.parse(line) as Record<string, unknown>)
      expect(events).toContainEqual(expect.objectContaining({
        type: 'inbound',
        request_id: requestId,
        method: 'POST',
        path: '/v1/auth/token',
        status: 200,
        ok: true,
      }))
      expect(events).toContainEqual(expect.objectContaining({
        type: 'outbound',
        request_id: requestId,
        upstream: 'cabin-token',
        tablet_id: 'PAX-PAD-0003',
        ok: true,
      }))
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

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

  it('preserves site-specific hardware seat codes without normalizing them', () => {
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
        flightSeatId: '21',
        aircraftSeatId: '121',
        seatId: 'A',
        columnNo: 'A',
        tabletId: 'PAX-PAD-0003',
      },
    })

    expect(inferred?.toolCall.arguments).toMatchObject({
      seat_id: 'A',
      seat_no: 'A',
      column_no: 'A',
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
            gender: 'female',
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
    expect(events.at(-1)?.data.reply_text).toBe('刘女士，已为您下发关闭读书灯的指令，请稍候。')

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
        content: '刘女士，已为您下发关闭读书灯的指令，请稍候。',
      },
    ])
  })

  it('passes cabin assistant display name without replacing assistant id', async () => {
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
      res.writeHead(404)
      res.end()
    })
    const upstreamBaseUrl = await listen(upstream)
    const db = new Database(':memory:') as unknown as DatabaseSync
    const createSessionCalls: Array<Record<string, unknown>> = []
    const runtime = {
      store: { db },
      authService: { listAllOrganizations: () => ({ organizations: [{ id: 'org-1' }] }) },
      createSession: async (input: Record<string, unknown>) => {
        createSessionCalls.push(input)
        return { sessionId: 'moss-session-1' }
      },
    } as unknown as RuntimeService
    const config = createCabinTestConfig(upstreamBaseUrl)
    config.cabin.createMossSession = true
    const api = createCabinApi({ config, runtime })
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

    const response = await fetch(`${cabinBaseUrl}/v1/ai-chat/history?limit=1`, {
      headers: {
        authorization: `Bearer ${tokenPayload.access_token}`,
        'x-cabin-tablet-token': 'tablet-token',
        'x-cabin-tablet-id': 'PAX-PAD-0001',
      },
    })

    expect(response.status).toBe(200)
    expect(createSessionCalls).toHaveLength(1)
    expect(createSessionCalls[0]).toMatchObject({
      assistantName: 'cabin-ai-flight-attendant',
      assistantDisplayName: '客舱 AI 乘务员',
    })
  })

  it('normalizes accepted hardware replies without claiming completion', () => {
    const reply = normalizeCabinHardwareReply({
      userText: '请打开小桌板',
      reply: '好的，已为您打开小桌板，请稍后。请问还有其他需要帮助的吗？',
      context: { flightId: '2', flightDate: '2026-06-05', tabletId: 'PAX-PAD-0003', passengerName: '刘淑芬', passengerGender: 'female' },
    })

    expect(reply).toBe('刘女士，已为您下发打开小桌板的指令，请稍候。')

    expect(normalizeCabinHardwareReply({
      userText: '请打开小桌板',
      reply: '好的，已为您打开小桌板，请稍后。请问还有其他需要帮助的吗？',
      context: { flightId: '2', flightDate: '2026-06-05', tabletId: 'PAX-PAD-0001', passengerName: '陈建国' },
    })).toBe('已为您下发打开小桌板的指令，请稍候。')
  })

  it('adds passenger salutation to short greetings only', () => {
    const context = {
      flightId: '2',
      flightDate: '2026-06-05',
      tabletId: 'PAX-PAD-0003',
      passengerName: '刘淑芬',
      passengerGender: 'female',
    }

    expect(normalizeCabinPassengerReply({
      userText: '你好',
      reply: '您好！我是客舱 AI 乘务员，有什么可以帮助您的吗？',
      context,
    })).toBe('刘女士，您好，请问有什么可以帮您？')

    expect(normalizeCabinPassengerReply({
      userText: '你好',
      reply: '刘女士，您好，请问有什么可以帮您？',
      context,
    })).toBe('刘女士，您好，请问有什么可以帮您？')

    expect(normalizeCabinPassengerReply({
      userText: '介绍一下客舱服务',
      reply: '您好，客舱可为您提供餐饮、灯光和座椅相关服务，请告诉我您的具体需求。',
      context,
    })).toBe('您好，客舱可为您提供餐饮、灯光和座椅相关服务，请告诉我您的具体需求。')
  })

  it('removes internal skill boundary text from flight info replies', () => {
    const context = {
      flightId: '2',
      flightDate: '2026-06-05',
      flightNo: 'CA8888',
      seatId: '01B',
      columnNo: 'B',
      tabletId: 'PAX-PAD-0003',
      passengerName: '刘淑芬',
      passengerGender: 'female',
    }

    const reply = normalizeCabinPassengerReply({
      userText: '查询下航班信息',
      reply: [
        '这个技能主要用于硬件控制，航班信息查询不在其功能范围内。',
        '',
        '刘淑芬女士，您好！您目前乘坐的是中国国际航空 CA8888 航班，航班日期为 2026 年 6 月 5 日，您的座位是 01B 排 B 座。',
      ].join('\n'),
      context,
    })

    expect(reply).toBe('刘淑芬女士，您好！您目前乘坐的是中国国际航空 CA8888 航班，航班日期为 2026 年 6 月 5 日，您的座位是 01B 排 B 座。')

    expect(normalizeCabinPassengerReply({
      userText: '查询下航班信息',
      reply: '这个技能主要用于硬件控制，航班信息查询不在其功能范围内。',
      context,
    })).toBe('刘女士，您目前乘坐的是 CA8888 航班，航班日期为 2026 年 6 月 5 日，您的座位是 01B 排 B 座。')
  })

  it('runs taxiing flight-state demo broadcast, alerts, and control commands', async () => {
    const controlRequests: string[] = []
    let ttsRequests = 0
    const upstream = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      if (url.pathname === '/tts') {
        ttsRequests += 1
        res.writeHead(200, { 'content-type': 'audio/wav' })
        res.end(Buffer.from('RIFF....WAVE'))
        return
      }
      if (url.pathname === '/playback') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'accepted' }))
        return
      }
      if (url.pathname === '/alert') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'accepted' }))
        return
      }
      if (url.pathname.startsWith('/admin-api/tcp-client/cmd/')) {
        controlRequests.push(`${url.pathname}?${url.searchParams.toString()}`)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'accepted', code: 0, message: 'ok' }))
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
    const tempDir = await mkdtemp(join(tmpdir(), 'moss-cabin-taxiing-test-'))
    const config = createCabinTestConfig(upstreamBaseUrl)
    config.rootDir = tempDir
    config.cabin.flightStateDemoEnabled = true
    config.cabin.ttsUrl = `${upstreamBaseUrl}/tts`
    config.cabin.controlBaseUrl = upstreamBaseUrl
    config.cabin.controlAuth = 'test1'
    config.cabin.demoPlaybackUrl = `${upstreamBaseUrl}/playback`
    config.cabin.demoAlertUrl = `${upstreamBaseUrl}/alert`
    const api = createCabinApi({ config, runtime })
    const cabinServer = http.createServer(async (req, res) => {
      const pathname = new URL(req.url || '/', 'http://localhost').pathname
      const handled = await api.handle(req, res, pathname)
      if (!handled) {
        res.writeHead(404)
        res.end()
      }
    })
    const cabinBaseUrl = await listen(cabinServer)

    const response = await fetch(`${cabinBaseUrl}/v1/cabin-demo/flight-state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        flightId: '2',
        flightNo: 'CA8888',
        flightPhase: 'TAXIING',
        seats: [
          { seatNo: '01B', position: 20, trayState: 'open' },
        ],
      }),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as {
      broadcast?: { playback?: { ok?: boolean }; reused?: boolean }
      alerts?: Array<{ seatNo: string; type: string }>
      commands?: Array<{ command: string; ok: boolean }>
    }
    expect(payload.broadcast?.playback?.ok).toBe(true)
    expect(payload.broadcast?.reused).toBe(false)
    expect(payload.alerts?.[0]).toMatchObject({
      seatNo: '01B',
      type: 'CABIN_DEVICE_NOT_READY',
    })
    expect(payload.commands?.map(command => command.command)).toEqual([
      'seat.cushion',
      'seat.tray.close',
    ])
    expect(payload.commands?.every(command => command.ok)).toBe(true)
    expect(controlRequests).toContain('/admin-api/tcp-client/cmd/seat/cushion?seatNo=01B&position=0')
    expect(controlRequests).toContain('/admin-api/tcp-client/cmd/seat/tray/close?seatNo=01B')

    const secondResponse = await fetch(`${cabinBaseUrl}/v1/cabin-demo/flight-state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        flightId: '2',
        flightNo: 'CA8888',
        flightPhase: 'TAXIING',
        seats: [
          { seatNo: '01B', position: 0, trayState: 'close' },
        ],
      }),
    })
    const secondPayload = await secondResponse.json() as {
      broadcast?: { reused?: boolean; elapsedMs?: number }
      alerts?: unknown[]
      commands?: unknown[]
    }
    expect(secondPayload.broadcast?.reused).toBe(true)
    expect(secondPayload.broadcast?.elapsedMs).toBe(0)
    expect(secondPayload.alerts).toEqual([])
    expect(secondPayload.commands).toEqual([])
    expect(ttsRequests).toBe(1)
    await rm(tempDir, { recursive: true, force: true })
  })
})
