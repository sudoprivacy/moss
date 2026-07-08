import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DatabaseSync } from 'node:sqlite'

import { CabinFlightAutomation } from '../automation.js'
import { CabinStore } from '../store.js'
import type { ServerConfig } from '../../types.js'

const tempDirs: string[] = []

afterEach(async () => {
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
  })
})
