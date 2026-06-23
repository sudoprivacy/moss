import { describe, expect, it } from 'bun:test'
import { createHmac } from 'crypto'
import { issueCabinToken, verifyCabinTokenDetailed } from '../auth.js'
import { CabinServices } from '../service.js'

function signTokenBody(body: string, secret: string): string {
  return Buffer.from(createHmac('sha256', secret).update(body).digest())
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
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
})
