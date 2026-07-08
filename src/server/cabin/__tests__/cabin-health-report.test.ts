import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import http from 'http'
import type { DatabaseSync } from 'node:sqlite'

import { createCabinApi } from '../api.js'
import { CabinHealthReportService } from '../healthReports.js'
import { CabinStore } from '../store.js'
import type { CabinConfig, CabinPassengerContext } from '../types.js'
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

function createConfig(): CabinConfig {
  return {
    enabled: true,
    tokenSecret: 'test-secret',
    tokenTtlSeconds: 7200,
    passengerInfoPrivacyLevel: 2,
    asrUrl: 'http://asr.test',
    asrModel: 'asr',
    ttsUrl: 'http://tts.test',
    ttsModel: 'tts',
    ttsVoice: 'voice',
    ttsLanguage: 'zh',
    llmBaseUrl: 'http://llm.test/v1',
    llmModel: 'llm-test',
    controlTimeoutMs: 10_000,
    automationEnabled: true,
    assistantName: 'cabin-ai-flight-attendant',
    assistantDisplayName: '客舱 AI 乘务员',
    createMossSession: false,
    replyTimeoutMs: 45_000,
    sessionRecoveryEnabled: true,
    sessionRecoveryMaxAttempts: 1,
    contextReplayTurns: 20,
    flightStateDemoEnabled: false,
    logEnabled: true,
    healthReportEnabled: true,
    healthReportCollectSeconds: 30,
    healthReportMinSamples: 1,
  }
}

function createContext(seatNo: string): CabinPassengerContext {
  return {
    passengerId: `passenger-${seatNo}`,
    passengerName: '测试乘客',
    flightId: 'CA1234',
    flightDate: '2026-07-07',
    seatId: seatNo,
    tabletId: `tablet-${seatNo}`,
    tabletToken: `tablet-token-${seatNo}`,
    language: 'zh',
  }
}

function createService(fetchImpl?: typeof fetch): { service: CabinHealthReportService; store: CabinStore } {
  const db = new Database(':memory:') as unknown as DatabaseSync
  const store = new CabinStore(db)
  const service = new CabinHealthReportService({
    config: createConfig(),
    store,
    fetchImpl,
    scheduleFinalize: false,
  })
  return { service, store }
}

function createServerConfig(baseUrl: string): ServerConfig {
  return {
    rootDir: '/tmp/moss-cabin-health-api-test',
    workspace: '/tmp/moss-cabin-health-api-test/workspace',
    defaultRuntime: 'host',
    cabin: {
      ...createConfig(),
      passengerInfoUrl: `${baseUrl}/passenger`,
      logEnabled: false,
    },
  } as unknown as ServerConfig
}

describe('CabinHealthReportService', () => {
  it('routes health telemetry by seat and completes a deterministic report with model text', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            overview: '心率、呼吸率偏快，血氧饱和度偏低，体温偏高。',
            interpretations: ['心率 120 bpm，偏快。'],
            suggestions: ['建议先静坐休息 5-10 分钟后重新测量。'],
            disclaimer: '本报告仅用于客舱健康状态辅助提示，不作为医疗诊断依据。',
            metrics: { should_not: 'leak' },
          }),
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const { service } = createService(fetchImpl)
    const started = service.startReport(createContext('B'), { requestId: 'req-start' })

    service.handleWsEnvelope({
      type: 'telemetry',
      content: {
        topic: 'health',
        seatNo: 'A',
        message: { heart_rate: 88, spo2: 99, respiratory_rate: 18, body_temperature: 36.6 },
      },
    })
    service.handleWsEnvelope({
      type: 'telemetry',
      content: JSON.stringify({
        topic: 'health',
        seatNo: 'B',
        message: { heart_rate: 120, spo2: 94, respiratory_rate: 22, body_temperature: 37.8 },
      }),
    })

    await service.finalizeReport(started.report_id, { requestId: 'req-finalize' })
    const report = service.getReport(started.report_id, createContext('B'))

    expect(report.report_status).toBe('completed')
    expect(report.sample_count).toBe(1)
    expect(report.metrics?.heart_rate).toMatchObject({
      value: 120,
      unit: 'bpm',
      level: 'high',
      range: { min: 20, max: 180, normal_min: 60, normal_max: 100 },
    })
    expect(report.metrics?.spo2).toMatchObject({ value: 94, level: 'low' })
    expect(report.summary?.score).toBe(76.5)
    expect(report.summary?.emotion_status).toBe('pass')
    expect(report.summary?.overview).toBe('心率、呼吸率偏快，血氧饱和度偏低，体温偏高。')
    expect(report.summary).not.toHaveProperty('metrics')
  })

  it('cancels an unfinished report when the same seat starts again', () => {
    const { service } = createService()
    const first = service.startReport(createContext('B'), { requestId: 'req-first' })
    const second = service.startReport(createContext('B'), { requestId: 'req-second' })

    expect(second.report_id).not.toBe(first.report_id)
    expect(service.getReport(first.report_id, createContext('B'))).toMatchObject({
      report_status: 'cancelled',
      error_code: 'SUPERSEDED_BY_NEW_REPORT',
    })

    service.handleWsEnvelope({
      type: 'telemetry',
      content: {
        topic: 'health',
        seatNo: 'B',
        message: { heart_rate: 72, spo2: 98, respiratory_rate: 16, body_temperature: 36.5 },
      },
    })

    expect(service.getReport(first.report_id, createContext('B')).sample_count).toBe(0)
    expect(service.getReport(second.report_id, createContext('B')).sample_count).toBe(1)
  })

  it('scores the customer document example with weighted single-metric scores', async () => {
    const { service } = createService()
    const started = service.startReport(createContext('A'), { requestId: 'req-start' })
    service.handleWsEnvelope({
      type: 'telemetry',
      content: {
        topic: 'health',
        seatNo: 'A',
        message: { heart_rate: 112, spo2: 94, respiratory_rate: 22, body_temperature: 37.5 },
      },
    })

    await service.finalizeReport(started.report_id, { requestId: 'req-finalize' })
    const report = service.getReport(started.report_id, createContext('A'))

    expect(report.summary?.score).toBe(88.68)
    expect(report.summary?.score_level).toBe('good')
    expect(report.summary?.emotion_status).toBe('good')
    expect(report.summary?.physiology_status).toBe('abnormal')
  })

  it('applies customer medical red-line score caps', async () => {
    const { service } = createService()
    const lowSpo2 = service.startReport(createContext('A'), { requestId: 'req-low-spo2' })
    service.handleWsEnvelope({
      type: 'telemetry',
      content: {
        topic: 'health',
        seatNo: 'A',
        message: { heart_rate: 72, spo2: 89, respiratory_rate: 16, body_temperature: 36.5 },
      },
    })
    await service.finalizeReport(lowSpo2.report_id, { requestId: 'req-finalize-low-spo2' })

    const highHeartRate = service.startReport(createContext('A'), { requestId: 'req-high-hr' })
    service.handleWsEnvelope({
      type: 'telemetry',
      content: {
        topic: 'health',
        seatNo: 'A',
        message: { heart_rate: 151, spo2: 98, respiratory_rate: 16, body_temperature: 36.5 },
      },
    })
    await service.finalizeReport(highHeartRate.report_id, { requestId: 'req-finalize-high-hr' })

    expect(service.getReport(lowSpo2.report_id, createContext('A')).summary?.score).toBe(30)
    expect(service.getReport(lowSpo2.report_id, createContext('A')).summary?.emotion_status).toBe('fail')
    expect(service.getReport(highHeartRate.report_id, createContext('A')).summary?.score).toBe(35)
  })

  it('falls back to deterministic text when model output is not valid JSON', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: '我不是 JSON' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const { service } = createService(fetchImpl)
    const started = service.startReport(createContext('A'), { requestId: 'req-start' })
    service.handleWsEnvelope({
      type: 'telemetry',
      content: {
        topic: 'health',
        seatNo: 'A',
        message: { heart_rate: 72, spo2: 98, respiratory_rate: 16, body_temperature: 36.5 },
      },
    })

    await service.finalizeReport(started.report_id, { requestId: 'req-finalize' })
    const report = service.getReport(started.report_id, createContext('A'))

    expect(report.report_status).toBe('completed')
    expect(report.summary?.overview).toBe('本次检测四项生理指标均在正常范围内。')
  })

  it('normalizes model string lists into report arrays', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            overview: '模型生成的小结。',
            interpretations: '1. 心率正常；2. 呼吸率正常',
            suggestions: '1. 保持放松；2. 按需复测',
            disclaimer: '本报告仅用于客舱健康状态辅助提示，不作为医疗诊断依据。',
          }),
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const { service } = createService(fetchImpl)
    const started = service.startReport(createContext('A'), { requestId: 'req-start' })
    service.handleWsEnvelope({
      type: 'telemetry',
      content: {
        topic: 'health',
        seatNo: 'A',
        message: { heart_rate: 72, spo2: 98, respiratory_rate: 16, body_temperature: 36.5 },
      },
    })

    await service.finalizeReport(started.report_id, { requestId: 'req-finalize' })
    const report = service.getReport(started.report_id, createContext('A'))

    expect(report.summary?.overview).toBe('模型生成的小结。')
    expect(report.summary?.interpretations).toEqual(['心率正常', '呼吸率正常'])
    expect(report.summary?.suggestions).toEqual(['保持放松', '按需复测'])
  })

  it('starts and returns a report through the Pad HTTP APIs', async () => {
    const upstream = http.createServer((req, res) => {
      if (req.url === '/passenger') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          code: 0,
          data: {
            flightId: 'CA1234',
            flightDate: '2026-07-07',
            seatNo: 'B',
            passenger: { passengerId: 'passenger-B', seatNo: 'B', language: 'zh' },
          },
        }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    const upstreamBaseUrl = await listen(upstream)
    const config = createServerConfig(upstreamBaseUrl)
    const db = new Database(':memory:') as unknown as DatabaseSync
    const runtime = {
      store: { db },
      authService: { listAllOrganizations: () => ({ organizations: [{ id: 'org-1' }] }) },
    } as unknown as RuntimeService
    const service = new CabinHealthReportService({
      config: config.cabin,
      store: new CabinStore(db),
      scheduleFinalize: false,
      fetchImpl: (async () => new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              overview: '本次采集指标处于正常范围。',
              interpretations: ['各项指标均正常。'],
              suggestions: ['保持当前状态，按需复测。'],
              disclaimer: '本报告仅用于客舱健康状态辅助提示，不作为医疗诊断依据。',
            }),
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
    })
    const api = createCabinApi({ config, runtime, healthReports: service })
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
        'x-cabin-tablet-id': 'PAD-B',
      },
      body: JSON.stringify({
        seatNo: 'B',
        columnNo: 'B',
        flightSeatId: '20',
      }),
    })
    const tokenBody = await tokenResponse.json() as { access_token: string }

    const startResponse = await fetch(`${cabinBaseUrl}/v1/health-reports/start`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenBody.access_token}`,
        'content-type': 'application/json',
        'x-cabin-tablet-token': 'tablet-token',
        'x-cabin-tablet-id': 'PAD-B',
      },
      body: JSON.stringify({ language: 'zh' }),
    })
    expect(startResponse.status).toBe(200)
    const started = await startResponse.json() as { report_id: string; report_status: string }
    expect(started.report_status).toBe('collecting')

    service.handleWsEnvelope({
      type: 'telemetry',
      content: {
        topic: 'health',
        seatNo: 'B',
        message: { heart_rate: 72, spo2: 98, respiratory_rate: 16, body_temperature: 36.5 },
      },
    })
    await service.finalizeReport(started.report_id, { requestId: 'req-finalize' })

    const getResponse = await fetch(`${cabinBaseUrl}/v1/health-reports/${started.report_id}`, {
      headers: {
        authorization: `Bearer ${tokenBody.access_token}`,
        'x-cabin-tablet-token': 'tablet-token',
        'x-cabin-tablet-id': 'PAD-B',
      },
    })
    expect(getResponse.status).toBe(200)
    const report = await getResponse.json() as Record<string, any>
    expect(report.report_status).toBe('completed')
    expect(report.metrics.heart_rate).toMatchObject({ value: 72, level: 'normal' })
    expect(report.summary).toMatchObject({
      score: 100,
      physiology_status: 'normal',
      metric_levels: {
        heart_rate: 'normal',
        respiratory_rate: 'normal',
        spo2: 'normal',
        body_temperature: 'normal',
      },
    })
  })
})
