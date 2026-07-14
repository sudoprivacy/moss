import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, readFile, rm } from 'fs/promises'
import net from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DatabaseSync } from 'node:sqlite'
import { WebSocketServer } from 'ws'

import { CabinFlightAutomation } from '../automation.js'
import { CabinBroadcastClient } from '../broadcastClient.js'
import { CabinStore } from '../store.js'
import type { ServerConfig } from '../../types.js'

const tempDirs: string[] = []
const wsServers: WebSocketServer[] = []
const netServers: net.Server[] = []
const netSockets = new Set<net.Socket>()

afterEach(async () => {
  for (const server of wsServers) {
    for (const client of server.clients) client.terminate()
    server.close()
  }
  wsServers.length = 0
  for (const socket of netSockets) socket.destroy()
  netSockets.clear()
  for (const server of netServers) server.close()
  netServers.length = 0
  await new Promise(resolve => setTimeout(resolve, 30))
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'moss-cabin-automation-test-'))
  tempDirs.push(dir)
  return dir
}

function flightMessage(phaseCode: number): string {
  return JSON.stringify({
    type: 'flight_data',
    content: JSON.stringify({
      mavpacktype: 'CE25_AUTO_GUIDE_DATA',
      afcs_status_data: [1, 1, 0, 0, 0, 0, 1, phaseCode, 1],
      id: 1021,
    }),
  })
}

function createConfig(rootDir: string): ServerConfig {
  return {
    rootDir,
    workspace: join(rootDir, 'workspace'),
    defaultRuntime: 'host',
    cabin: {
      enabled: true,
      tokenSecret: 'test-secret',
      tokenTtlSeconds: 7200,
      passengerInfoPrivacyLevel: 2,
      asrUrl: 'http://asr.test',
      asrModel: 'asr',
      ttsUrl: 'http://tts.test/speech',
      ttsModel: 'tts-test',
      ttsVoice: 'voice-test',
      ttsLanguage: 'zh',
      llmBaseUrl: 'http://llm.test/v1',
      llmModel: 'llm-test',
      controlBaseUrl: 'http://cabin.test',
      controlAuth: 'test1',
      controlTimeoutMs: 10_000,
      automationEnabled: true,
      managedSeats: 'A',
      broadcastApiBaseUrl: 'http://cabin.test',
      broadcastApiKey: 'hardware-key',
      broadcastAuth: 'test1',
      broadcastEnabled: true,
      assistantName: 'cabin-ai-flight-attendant',
      assistantDisplayName: '客舱 AI 乘务员',
      createMossSession: false,
      replyTimeoutMs: 45_000,
      sessionRecoveryEnabled: true,
      sessionRecoveryMaxAttempts: 1,
      contextReplayTurns: 20,
      flightStateDemoEnabled: false,
      logEnabled: true,
      automationLogFile: join(rootDir, 'automation.jsonl'),
      healthReportEnabled: true,
      healthReportCollectSeconds: 30,
      healthReportMinSamples: 1,
    },
  } as unknown as ServerConfig
}

function listenWs(server: WebSocketServer): Promise<string> {
  wsServers.push(server)
  return new Promise(resolve => {
    const finish = () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Unexpected server address')
      resolve(`ws://127.0.0.1:${address.port}`)
    }
    if (server.address()) finish()
    else server.once('listening', finish)
  })
}

function listenNet(server: net.Server): Promise<string> {
  netServers.push(server)
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Unexpected server address')
      resolve(`ws://127.0.0.1:${address.port}`)
    })
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(predicate()).toBe(true)
}

describe('CabinFlightAutomation external broadcasts', () => {
  it('generates reusable TTS audio, broadcasts it to all tablets, and pushes aggregated seat alerts', async () => {
    const rootDir = await makeTempDir()
    const config = createConfig(rootDir)
    const db = new Database(':memory:') as unknown as DatabaseSync
    const store = new CabinStore(db)
    store.upsertManagedSeat({
      aircraftNo: 'B-WITHFLIGHT-01',
      flightId: 'CA1234',
      flightDate: '2026-07-07',
      seatNo: 'A',
      columnNo: 'A',
    })

    let ttsRequests = 0
    let seatNormalized = false
    const broadcastRequests: Array<{ pathname: string; headers: Headers; body: string }> = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/speech') {
        ttsRequests += 1
        const body = JSON.parse(String(init?.body)) as { input?: string }
        expect(body.input).toContain('飞机已经开始滑行')
        expect(body.input).toContain('the aircraft is now taxiing')
        return new Response(Buffer.from('RIFF_TEST_WAVE'), { status: 200, headers: { 'content-type': 'audio/wav' } })
      }
      if (url.pathname === '/admin-api/cabin/broadcast/audio-all') {
        const request = new Request(input, init)
        const body = await request.text()
        broadcastRequests.push({ pathname: url.pathname, headers: request.headers, body })
        return Response.json({
          code: 0,
          msg: 'success',
          data: { requestId: 'BC-audio-1', matchedCount: 5, sentCount: 5, audioUrl: 'http://minio/audio.wav' },
        })
      }
      if (url.pathname === '/admin-api/cabin/broadcast/error-seat') {
        const request = new Request(input, init)
        broadcastRequests.push({ pathname: url.pathname, headers: request.headers, body: await request.text() })
        seatNormalized = true
        return Response.json({
          code: 0,
          msg: 'success',
          data: { requestId: 'BC-error-1', matchedCount: 1, sentCount: 1 },
        })
      }
      if (url.pathname === '/admin-api/tcp/hardware/status') {
        const key = url.searchParams.get('key')
        const data = seatNormalized
          ? key === 'safety'
            ? { presence: 'true', seatbelt: 'true' }
            : key === 'posture'
              ? { position: '0' }
              : { tray_state: 'closed' }
          : key === 'safety'
          ? { presence: 'true', seatbelt: 'false' }
          : key === 'posture'
            ? { position: '20' }
            : { tray_state: 'opened' }
        return Response.json({ code: 0, data: { target: 'A', key, data, aircraftNo: 'B-WITHFLIGHT-01' } })
      }
      if (url.pathname.startsWith('/admin-api/tcp-client/cmd/')) {
        return Response.json({ code: 0, data: 'ok' })
      }
      return Response.json({ code: 404, msg: 'not found' }, { status: 404 })
    }) as typeof fetch

    const previousFetch = globalThis.fetch
    globalThis.fetch = fetchImpl
    try {
      const automation = new CabinFlightAutomation(config, store)
      await (automation as unknown as { handleRawMessage(raw: string): Promise<void> }).handleRawMessage(flightMessage(16))
      await (automation as unknown as { handleRawMessage(raw: string): Promise<void> }).handleRawMessage(flightMessage(2))
      await (automation as unknown as { handleRawMessage(raw: string): Promise<void> }).handleRawMessage(flightMessage(16))
    } finally {
      globalThis.fetch = previousFetch
    }

    expect(ttsRequests).toBe(1)
    const audioRequest = broadcastRequests.find(request => request.pathname === '/admin-api/cabin/broadcast/audio-all')
    expect(audioRequest?.headers.get('x-hardware-api-key')).toBe('hardware-key')
    expect(audioRequest?.headers.get('authorization')).toBe('test1')
    expect(audioRequest?.body).toContain('name="aircraftNo"')
    expect(audioRequest?.body).toContain('B-WITHFLIGHT-01')
    expect(audioRequest?.body).toContain('name="title"')
    expect(audioRequest?.body).toContain('滑行阶段广播')
    expect(audioRequest?.body).toContain('RIFF_TEST_WAVE')

    const seatErrorRequests = broadcastRequests.filter(request => request.pathname === '/admin-api/cabin/broadcast/error-seat')
    expect(seatErrorRequests).toHaveLength(1)
    const seatError = JSON.parse(seatErrorRequests[0].body) as Record<string, unknown>
    expect(seatError).toMatchObject({
      title: '座位告警',
      aircraftNo: 'B-WITHFLIGHT-01',
      seatNo: 'A',
    })
    expect(String(seatError.content)).toContain('安全带未扣合')
    expect(String(seatError.content)).toContain('座椅未归位')
    expect(String(seatError.content)).toContain('小桌板未收起')
    expect(String(seatError.contentEN)).toContain('seat belt is not fastened')
    expect(String(seatError.contentEN)).toContain('seat back is not upright')
    expect(String(seatError.contentEN)).toContain('tray table is not stowed')
  })

  it('sends protocol ping frames while the flight state websocket is open', async () => {
    const rootDir = await makeTempDir()
    const config = createConfig(rootDir)
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    let pings = 0
    server.on('connection', socket => {
      socket.on('ping', () => {
        pings += 1
      })
    })
    config.cabin.flightStateWsUrl = await listenWs(server)
    config.cabin.flightStateWsHeartbeatIntervalMs = 20
    config.cabin.flightStateWsIdleTimeoutMs = 500
    config.cabin.flightStateWsConnectTimeoutMs = 200
    const automation = new CabinFlightAutomation(config, new CabinStore(new Database(':memory:') as unknown as DatabaseSync))

    try {
      automation.start()
      await waitFor(() => pings > 0)
    } finally {
      automation.stop()
    }
  })

  it('uses the configured reconnect delay after the flight state websocket closes', async () => {
    const rootDir = await makeTempDir()
    const config = createConfig(rootDir)
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    let connections = 0
    server.on('connection', socket => {
      connections += 1
      if (connections === 1) {
        setTimeout(() => socket.close(1012, 'restart'), 20)
      }
    })
    config.cabin.flightStateWsUrl = await listenWs(server)
    config.cabin.flightStateWsReconnectMinMs = 20
    config.cabin.flightStateWsReconnectMaxMs = 20
    config.cabin.flightStateWsHeartbeatIntervalMs = 200
    config.cabin.flightStateWsIdleTimeoutMs = 500
    const automation = new CabinFlightAutomation(config, new CabinStore(new Database(':memory:') as unknown as DatabaseSync))

    try {
      automation.start()
      await waitFor(() => connections >= 2)
    } finally {
      automation.stop()
    }
  })

  it('times out stalled flight state websocket handshakes and retries', async () => {
    const rootDir = await makeTempDir()
    const config = createConfig(rootDir)
    let connections = 0
    const server = net.createServer(socket => {
      netSockets.add(socket)
      connections += 1
      socket.on('close', () => netSockets.delete(socket))
      socket.on('error', () => {})
    })
    config.cabin.flightStateWsUrl = await listenNet(server)
    config.cabin.flightStateWsConnectTimeoutMs = 30
    config.cabin.flightStateWsReconnectMinMs = 20
    config.cabin.flightStateWsReconnectMaxMs = 20
    const automation = new CabinFlightAutomation(config, new CabinStore(new Database(':memory:') as unknown as DatabaseSync))

    try {
      automation.start()
      await waitFor(() => connections >= 2, 800)
    } finally {
      automation.stop()
    }
  })

  it('serializes overlapping phase tasks from concurrent websocket messages', async () => {
    const rootDir = await makeTempDir()
    const config = createConfig(rootDir)
    config.cabin.broadcastEnabled = false
    const db = new Database(':memory:') as unknown as DatabaseSync
    const store = new CabinStore(db)
    store.upsertManagedSeat({
      aircraftNo: 'B-WITHFLIGHT-01',
      flightId: 'CA1234',
      flightDate: '2026-07-07',
      seatNo: 'A',
      columnNo: 'A',
    })

    let activeStatusRequests = 0
    let maxActiveStatusRequests = 0
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/admin-api/tcp/hardware/status') {
        activeStatusRequests += 1
        maxActiveStatusRequests = Math.max(maxActiveStatusRequests, activeStatusRequests)
        await new Promise(resolve => setTimeout(resolve, 25))
        activeStatusRequests -= 1
        const key = url.searchParams.get('key')
        return Response.json({
          code: 0,
          data: {
            target: 'A',
            key,
            aircraftNo: 'B-WITHFLIGHT-01',
            data: key === 'safety'
              ? { presence: 'true', seatbelt: 'true' }
              : key === 'posture'
                ? { position: '0' }
                : { tray_state: 'closed' },
          },
        })
      }
      return Response.json({ code: 0, data: 'ok' })
    }) as typeof fetch

    const previousFetch = globalThis.fetch
    globalThis.fetch = fetchImpl
    try {
      const automation = new CabinFlightAutomation(config, store)
      await Promise.all([
        (automation as unknown as { handleRawMessage(raw: string): Promise<void> }).handleRawMessage(flightMessage(16)),
        (automation as unknown as { handleRawMessage(raw: string): Promise<void> }).handleRawMessage(flightMessage(2)),
      ])
    } finally {
      globalThis.fetch = previousFetch
    }

    expect(maxActiveStatusRequests).toBe(1)
  })

  it('times out stalled broadcast API requests', async () => {
    const rootDir = await makeTempDir()
    const config = createConfig(rootDir)
    config.cabin.controlTimeoutMs = 20
    const audioFile = join(rootDir, 'audio.wav')
    await Bun.write(audioFile, Buffer.from('RIFF_TEST_WAVE'))
    const previousFetch = globalThis.fetch
    globalThis.fetch = (async () => new Promise<Response>(() => {})) as typeof fetch
    try {
      const client = new CabinBroadcastClient(config.cabin)
      const startedAt = Date.now()
      const result = await client.sendAudioAll({
        aircraftNo: 'B-WITHFLIGHT-01',
        title: '测试广播',
        filePath: audioFile,
      })
      expect(result.ok).toBe(false)
      expect(result.elapsedMs).toBeLessThan(500)
      expect(Date.now() - startedAt).toBeLessThan(500)
      expect(result.error).toContain('timeout')
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('persists raw health telemetry in automation logs for troubleshooting', async () => {
    const rootDir = await makeTempDir()
    const config = createConfig(rootDir)
    const automation = new CabinFlightAutomation(config, new CabinStore(new Database(':memory:') as unknown as DatabaseSync))
    await (automation as unknown as { handleRawMessage(raw: string): Promise<void> }).handleRawMessage(JSON.stringify({
      type: 'telemetry',
      content: {
        topic: 'health',
        seatNo: 'B',
        message: { heart_rate: 120, spo2: 94, respiratory_rate: 22, body_temperature: 37.8 },
      },
    }))
    await new Promise(resolve => setTimeout(resolve, 30))
    const logs = await readFile(config.cabin.automationLogFile!, 'utf8')
    expect(logs).toContain('health')
    expect(logs).toContain('heart_rate')
    expect(logs).toContain('120')
    expect(logs).toContain('body_temperature')
    expect(logs).toContain('37.8')
  })
})
