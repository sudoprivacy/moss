import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { createHmac } from 'crypto'
import http from 'http'
import { Database } from 'bun:sqlite'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DatabaseSync } from 'node:sqlite'
import { issueCabinToken, verifyCabinTokenDetailed } from '../auth.js'
import { createCabinApi } from '../api.js'
import { CabinServices, formatCabinSessionPrompt, normalizeCabinHardwareReply, normalizeCabinPassengerReply } from '../service.js'
import type { RuntimeService } from '../../runtimeService.js'
import type { ServerConfig } from '../../types.js'
import { message } from '../commandLanguage.js'
import type { Language } from '../language.js'

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

describe('ASR deadline', () => {
  for (const phase of ['headers', 'success body', 'error body'] as const) {
    it(`times out a stalled ${phase} even when upstream ignores abort`, async () => {
      const config = createCabinTestConfig('http://asr.invalid').cabin
      config.asrTimeoutMs = 15
      config.controlTimeoutMs = 100_000
      let signal: AbortSignal | undefined
      let body: ReadableStreamDefaultController<Uint8Array> | undefined
      const services = new CabinServices({ config, store: {} as never, fetchImpl: (async (_url, init) => {
        signal = init?.signal as AbortSignal
        if (phase === 'headers') return new Promise<Response>(() => {})
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller } }), {
          status: phase === 'error body' ? 503 : 200,
        })
      }) as typeof fetch })
      try {
        await expect(services.transcribe({ audio: Buffer.from('audio'), filename: 'test.wav' }))
          .rejects.toThrow('ASR timeout after 15ms')
        expect(signal?.aborted).toBe(true)
      } finally {
        body?.close()
      }
    })
  }

  it('defaults to 30000ms independently of control timeout and clears the deadline on success', async () => {
    const config = createCabinTestConfig('http://asr.invalid').cabin
    config.asrTimeoutMs = undefined
    config.controlTimeoutMs = 1
    const services = new CabinServices({ config, store: {} as never, fetchImpl: (async (_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return Response.json({ text: '  你好  ', language: 'Chinese' })
    }) as typeof fetch })
    const schedule = spyOn(globalThis, 'setTimeout')
    const clear = spyOn(globalThis, 'clearTimeout')
    try {
      await expect(services.transcribe({ audio: Buffer.from('audio'), filename: 'test.wav', detectLanguage: true }))
        .resolves.toMatchObject({ text: '你好', language: 'zh' })
      expect(schedule).toHaveBeenCalledTimes(1)
      expect(schedule.mock.calls[0]?.[1]).toBe(30_000)
      expect(clear).toHaveBeenCalledWith(schedule.mock.results[0]?.value)
    } finally {
      schedule.mockRestore()
      clear.mockRestore()
    }
  })
})

describe('compact result integrity', () => {
  const samples: Array<{ language: Language; text: string; completed: string; promised: string; introduction: string; consultation: string; variants?: string[] }> = [
    { language: 'zh', text: '不要打开阅读灯', completed: '好的，已为您关闭阅读灯。', promised: '我会为您打开阅读灯。', introduction: '您好，我是客舱助手，可以介绍服务。', consultation: '阅读灯可以用来阅读，您想了解哪个功能？' },
    { language: 'en', text: "Don't turn on the reading light", completed: 'I turned on the reading light.', promised: 'I will turn on the reading light.', introduction: 'Hello, I am your cabin assistant. I can help with cabin services.', consultation: 'You can use the reading light to read. What would you like to know?', variants: ['The reading light has been turned on.'] },
    { language: 'de', text: 'Schalte das Leselicht nicht ein.', completed: 'Ich habe die Leselampe eingeschaltet.', promised: 'Ich werde die Leselampe einschalten.', introduction: 'Hallo, ich bin Ihr Kabinenassistent und kann Ihnen helfen.', consultation: 'Die Leselampe ist zum Lesen gedacht. Welche Funktion möchten Sie kennenlernen?' },
    { language: 'ja', text: '読書灯をつけないでください', completed: '読書灯を点灯しました', promised: '読書灯を点灯します。', introduction: 'こんにちは。客室アシスタントです。サービスをご案内できます。', consultation: '読書灯は読書に使えます。どの機能について知りたいですか？', variants: ['読書灯をつけました。', '読書灯をつけます。', '読書灯を消しておきます。'] },
    { language: 'ko', text: '독서등을 켜지 마세요', completed: '독서등을 켰습니다.', promised: '독서등을 켜겠습니다.', introduction: '안녕하세요. 객실 도우미입니다. 서비스를 안내할 수 있습니다.', consultation: '독서등은 책을 읽을 때 사용합니다. 어떤 기능이 궁금하세요?', variants: ['독서등을 켜 드렸습니다.', '독서등을 켜 드리겠습니다.'] },
    { language: 'fr', text: "N’allumez pas la liseuse.", completed: 'J’ai allumé la liseuse.', promised: 'Je vais allumer la liseuse.', introduction: 'Bonjour, je suis votre assistant de cabine. Je peux vous aider.', consultation: 'La liseuse sert à lire. Quelle fonction voulez-vous connaître ?' },
    { language: 'es', text: 'No enciendas la luz de lectura.', completed: 'He encendido la luz de lectura.', promised: 'Voy a encender la luz de lectura.', introduction: 'Hola, soy su asistente de cabina y puedo ayudarle.', consultation: 'La luz de lectura sirve para leer. ¿Qué función desea conocer?' },
    { language: 'pt', text: 'Não acenda a luz de leitura.', completed: 'Acendi a luz de leitura.', promised: 'Vou acender a luz de leitura.', introduction: 'Olá, sou o seu assistente de cabine e posso ajudar.', consultation: 'A luz de leitura serve para ler. Qual função deseja conhecer?' },
    { language: 'it', text: 'Non accendere la luce di lettura.', completed: 'Ho acceso la luce di lettura.', promised: 'Accenderò la luce di lettura.', introduction: 'Ciao, sono il suo assistente di cabina e posso aiutarla.', consultation: 'La luce di lettura serve per leggere. Quale funzione vuole conoscere?' },
    { language: 'ru', text: 'Не включайте лампу для чтения.', completed: 'Я включил лампу для чтения.', promised: 'Я включу лампу для чтения.', introduction: 'Здравствуйте, я ваш помощник в салоне. Могу рассказать об услугах.', consultation: 'Лампа предназначена для чтения. Какая функция вас интересует?' },
  ]
  for (const sample of samples) {
    it(`blocks unexecuted completion/promise in ${sample.language} and preserves introductions/consultation`, async () => {
      let content = ''
      const config = createCabinTestConfig('http://compact.invalid').cabin
      const services = new CabinServices({ config, store: {} as never, fetchImpl: (async url => {
        expect(String(url)).toBe('http://compact.invalid/v1/chat/completions')
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] })
      }) as typeof fetch })
      const input = { context: { flightId: 'F1', flightDate: '2026-11-24', tabletId: 'pad', seatId: '01A', replyLanguage: sample.language }, messages: [], text: sample.text }
      for (content of [sample.completed, sample.promised, ...sample.variants ?? []]) {
        expect(await services.generateCompactReply(input)).toEqual({ reply: message(sample.language as Parameters<typeof message>[0], 'noAction') })
      }
      for (content of [sample.introduction, sample.consultation]) {
        expect(await services.generateCompactReply(input)).toEqual({ reply: content })
      }
    })
  }

  it('uses current-intent authorization for polite control/mode requests and retains real status/failure/block results', async () => {
    const config = createCabinTestConfig('http://compact.invalid').cabin
    config.controlBaseUrl = 'http://hardware.invalid'
    config.broadcastApiBaseUrl = 'http://hardware.invalid'
    const context = { flightId: 'F1', flightDate: '2026-11-24', aircraftNo: 'B-TEST', tabletId: 'pad', seatId: '01A' }
    let name = 'cabin_control'
    let args: Record<string, unknown> = { command: 'seat.light', params: { on: true } }
    let businessCode = 0
    let statusData: Record<string, unknown> = { on: false, pwm: 0 }
    const hardware: Array<{ url: string; body?: unknown }> = []
    const services = new CabinServices({ config, store: {} as never, fetchImpl: (async (url, init) => {
      if (String(url).endsWith('/chat/completions')) {
        const body = JSON.parse(String(init?.body))
        if (!body.tools) throw new Error('Chinese status should use the actual protocol formatter')
        return Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
          content: '设备已经执行成功。', tool_calls: [{ id: 'selected', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        } }] })
      }
      hardware.push({ url: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
      return Response.json({ code: businessCode, data: { data: statusData } })
    }) as typeof fetch })
    const run = (text: string) => services.generateCompactReply({ context, text, messages: [] })
    const control = await run('Could you please turn on the reading light?')
    expect(control.slots).toMatchObject({ command: 'seat.light', execution_status: 'dispatched' })
    expect(control.reply).toContain('下发')
    expect(hardware.at(-1)?.url).toBe('http://hardware.invalid/admin-api/tcp-client/cmd/seat/light?seatNo=01A&on=true')
    name = 'cabin_mode'; args = { mode: 'sleep' }
    const mode = await run('Could you switch to sleep mode?')
    expect(mode.slots).toMatchObject({ mode: 'sleep', execution_status: 'dispatched' })
    expect(mode.reply).toContain('睡眠模式')
    expect(hardware.at(-1)).toMatchObject({ url: 'http://hardware.invalid/admin-api/cabin/broadcast/mode-seat', body: { mode: 3, seatNo: '01A', aircraftNo: 'B-TEST' } })
    name = 'cabin_status'; args = { target_type: 'seat', status_key: 'reading_light' }
    const status = await run('阅读灯现在开着吗？')
    expect(status.slots).toMatchObject({ execution_status: 'succeeded', status_data: { on: false, pwm: 0 } })
    expect(status.reply).toBe('当前阅读灯为关闭状态。')
    businessCode = 500
    name = 'cabin_control'; args = { command: 'seat.light', params: { on: true } }
    const failed = await run('Could you turn on the reading light?')
    expect(failed.slots?.execution_status).toBe('failed')
    expect(failed.reply).toContain('失败')
    businessCode = 0; statusData = {}; args = { command: 'seat.tray.close', params: {} }
    const blocked = await run('Could you close the tray table?')
    expect(blocked.slots?.execution_status).toBe('blocked')
    expect(blocked.reply).not.toContain('已为您下发')
    expect(hardware.filter(call => call.url.includes('/cmd/'))).toHaveLength(2)
    const before = hardware.length
    args = { command: 'seat.light', params: { on: true } }
    await expect(run('Do not turn on the reading light')).resolves.toEqual({ reply: '请再具体说明您的需求。' })
    expect(hardware).toHaveLength(before)
  })
})

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
  it('tells the model to display only seat_no as the passenger seat number', () => {
    const prompt = formatCabinSessionPrompt({
      flightId: '2',
      flightDate: '2026-06-05',
      flightNo: 'CA8888',
      flightSeatId: '22',
      aircraftSeatId: '22',
      bindingId: '2823',
      seatId: 'C',
      columnNo: 'B',
      tabletId: 'PAX-PAD-003',
      passengerName: '穆巴佩',
    }, '我的座位号是多少？')

    expect(prompt).toContain('seat_no 是唯一面向乘客展示的座位号')
    expect(prompt).toContain('只回答 cabin_context.seat_no')
    expect(prompt).toContain('flight_seat_id、aircraft_seat_id、binding_id 只是内部绑定 ID，不是排号')
    expect(prompt).toContain('不得解释成“第几排”或与 seat_no 拼成“X排Y座”')
    expect(prompt).toContain('"flight_seat_id":"22"')
    expect(prompt).toContain('"seat_no":"C"')
  })

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
    const controlRequests: string[] = []
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
            { finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'light-off', type: 'function', function: {
              name: 'cabin_control', arguments: JSON.stringify({ command: 'seat.light', params: { on: false } }),
            } }] } },
          ],
        }))
        return
      }
      if (req.url?.startsWith('/admin-api/tcp-client/cmd/')) {
        controlRequests.push(req.url)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0 }))
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
    const config = createCabinTestConfig(upstreamBaseUrl)
    config.cabin.controlBaseUrl = upstreamBaseUrl
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
    expect(events.at(-1)?.data.slots).toMatchObject({ command: 'seat.light', execution_status: 'dispatched' })
    expect(controlRequests).toEqual(['/admin-api/tcp-client/cmd/seat/light?seatNo=01A&on=false'])

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
    config.cabin.dialogueMode = 'agent'
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

  it('routes high-confidence hardware commands before moss session generation', async () => {
    const controlRequests: string[] = []
    const upstream = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      if (url.pathname === '/passenger') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          code: 0,
          data: {
            flightId: '2',
            flightDate: '2026-06-05',
            flightNo: 'MU001',
            seatNo: 'A',
            columnNo: 'A',
            flightSeatId: '20',
            passengerRef: 'REF-A-2',
            passengerName: '陈建国',
            gender: 'male',
            language: 'zh',
          },
        }))
        return
      }
      if (url.pathname.startsWith('/admin-api/tcp-client/cmd/')) {
        controlRequests.push(`${url.pathname}?${url.searchParams.toString()}`)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'dispatched', code: 0, message: 'ok' }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    const upstreamBaseUrl = await listen(upstream)
    const db = new Database(':memory:') as unknown as DatabaseSync
    let socketCalls = 0
    const runtime = {
      store: { db },
      authService: { listAllOrganizations: () => ({ organizations: [{ id: 'org-1' }] }) },
      createSession: async () => ({ sessionId: 'moss-session-1' }),
      ensureSessionReady: async () => {
        socketCalls += 1
        return { attempt: {} }
      },
    } as unknown as RuntimeService
    const config = createCabinTestConfig(upstreamBaseUrl)
    config.cabin.createMossSession = true
    config.cabin.controlBaseUrl = upstreamBaseUrl
    config.cabin.controlAuth = 'test1'
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
        'x-cabin-tablet-id': 'PAX-PAD-0002',
      },
      body: JSON.stringify({
        seatNo: 'A',
        columnNo: 'A',
        flightSeatId: '20',
      }),
    })
    const tokenPayload = await tokenResponse.json() as { access_token: string }

    const response = await fetch(`${cabinBaseUrl}/v1/ai-chat/send`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenPayload.access_token}`,
        'content-type': 'application/json',
        'x-cabin-tablet-token': 'tablet-token',
        'x-cabin-tablet-id': 'PAX-PAD-0002',
      },
      body: JSON.stringify({ content: '请帮我打开小桌板。', source: 'text' }),
    })
    expect(response.status).toBe(200)
    const events = await readSse(response)
    expect(events.map(event => event.event)).toEqual(['start', 'tool_call', 'delta', 'done'])
    expect(events[1].data).toMatchObject({
      name: 'cabin.hardware.control',
      arguments: {
        command: 'seat.tray.open',
        seat_no: 'A',
      },
    })
    expect(events.at(-1)?.data).toMatchObject({
      intent: 'tray_open',
      reply_text: '陈先生，已为您下发打开小桌板的指令，请稍候。',
    })
    expect(controlRequests).toEqual([
      '/admin-api/tcp-client/cmd/seat/tray/open?seatNo=A',
    ])
    expect(socketCalls).toBe(0)
  })

  it('routes reading light percent brightness to 0-1000 pwm', async () => {
    const controlRequests: string[] = []
    const upstream = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      if (url.pathname === '/passenger') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          code: 0,
          data: {
            flightId: '2',
            flightDate: '2026-06-05',
            seatNo: 'B',
            columnNo: 'B',
            flightSeatId: '21',
            passengerRef: 'REF-B-2',
            passengerName: '刘淑芬',
            gender: 'female',
            language: 'zh',
          },
        }))
        return
      }
      if (url.pathname.startsWith('/admin-api/tcp-client/cmd/')) {
        controlRequests.push(`${url.pathname}?${url.searchParams.toString()}`)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'dispatched', code: 0, message: 'ok' }))
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
    const config = createCabinTestConfig(upstreamBaseUrl)
    config.cabin.createMossSession = false
    config.cabin.controlBaseUrl = upstreamBaseUrl
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
        seatNo: 'B',
        columnNo: 'B',
        flightSeatId: '21',
      }),
    })
    const tokenPayload = await tokenResponse.json() as { access_token: string }

    const response = await fetch(`${cabinBaseUrl}/v1/ai-chat/send`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenPayload.access_token}`,
        'content-type': 'application/json',
        'x-cabin-tablet-token': 'tablet-token',
        'x-cabin-tablet-id': 'PAX-PAD-0003',
      },
      body: JSON.stringify({ content: '把阅读灯亮度调到50%', source: 'text' }),
    })
    expect(response.status).toBe(200)
    const events = await readSse(response)
    expect(events[1].data).toMatchObject({
      arguments: {
        command: 'seat.light.brightness',
        seat_no: 'B',
        pwm: 500,
      },
    })
    expect(events.at(-1)?.data).toMatchObject({
      intent: 'reading_light_brightness',
      reply_text: '刘女士，已为您下发调整阅读灯亮度的指令，请稍候。',
    })
    expect(controlRequests).toEqual([
      '/admin-api/tcp-client/cmd/seat/light/brightness?seatNo=B&pwm=500',
    ])
  })

  it('normalizes dispatched hardware replies without claiming completion', () => {
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

  it('requires dispatch evidence before normalizing a hardware request into an execution receipt', () => {
    const context = { flightId: '2', flightDate: '2026-06-05', tabletId: 'pad' }
    for (const reply of ['', '此工具无法执行操作。', '请确认您要调整的座椅角度。', '下发失败，请稍后重试。']) {
      for (const hardwareDispatched of [undefined, false]) {
        expect(normalizeCabinPassengerReply({ userText: '请打开小桌板', reply, context, hardwareDispatched })).toBe(reply)
      }
    }
    expect(normalizeCabinPassengerReply({
      userText: '请打开小桌板', reply: '已打开小桌板。', context, hardwareDispatched: true,
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

  it('omits masked passenger placeholders from spoken greetings', () => {
    for (const passengerName of ['XX', 'xx', 'XX先生', '***', '张**', '匿名', '未知', 'null']) {
      expect(normalizeCabinPassengerReply({
        userText: '你好。', reply: '您好，请问有什么可以帮您？',
        context: { passengerName, passengerGender: 'male' } as never,
      })).toBe('您好，请问有什么可以帮您？')
    }
    expect(normalizeCabinPassengerReply({
      userText: '你好。', reply: '您好，请问有什么可以帮您？',
      context: { passengerName: 'Xavier', passengerGender: 'male' } as never,
    })).toBe('Xavier，您好，请问有什么可以帮您？')
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
        res.end(JSON.stringify({ status: 'dispatched', code: 0, message: 'ok' }))
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
