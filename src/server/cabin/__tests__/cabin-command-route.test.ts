import { describe, expect, it } from 'bun:test'
import { CabinServices, buildRouteFromCommand } from '../service.js'
import type { CabinConfig, CabinPassengerContext } from '../types.js'

const context: CabinPassengerContext = {
  flightId: 'F1',
  flightDate: '2026-07-01',
  aircraftNo: 'B-WITHFLIGHT-01',
  seatId: 'A',
  columnNo: 'A',
  tabletId: 'T1',
}

describe('buildRouteFromCommand', () => {
  it('builds a route for a valid command with params and injects seatNo', () => {
    const route = buildRouteFromCommand(context, 'seat.light', { on: true, pwm: 800 })
    expect(route?.command).toBe('seat.light')
    expect(route?.path).toBe('/admin-api/tcp-client/cmd/seat/light')
    expect(route?.params).toMatchObject({ seatNo: 'A', on: true, pwm: 800 })
    expect(route?.toolCall.name).toBe('cabin.hardware.control')
  })

  it('builds a no-param command route', () => {
    const route = buildRouteFromCommand(context, 'seat.tray.open')
    expect(route?.command).toBe('seat.tray.open')
    expect(route?.params).toMatchObject({ seatNo: 'A' })
  })

  it('clamps out-of-range integer params', () => {
    expect(buildRouteFromCommand(context, 'seat.cushion', { position: 500 })?.params.position).toBe(100)
    expect(buildRouteFromCommand(context, 'seat.cushion', { position: -20 })?.params.position).toBe(0)
  })

  it('coerces string/number/boolean param inputs', () => {
    expect(buildRouteFromCommand(context, 'seat.ventilation', { level: '3' })?.params.level).toBe(3)
    expect(buildRouteFromCommand(context, 'seat.light', { on: 'false' })?.params.on).toBe(false)
  })

  it('returns null for an unknown command', () => {
    expect(buildRouteFromCommand(context, 'seat.recline', { position: 30 })).toBeNull()
  })

  it('returns null when a required param is missing', () => {
    expect(buildRouteFromCommand(context, 'seat.cushion', {})).toBeNull()
    expect(buildRouteFromCommand(context, 'cabin.scene', {})).toBeNull()
  })

  it('returns null without a seat identity', () => {
    expect(buildRouteFromCommand({ ...context, seatId: '' }, 'seat.tray.open')).toBeNull()
  })
})

function makeServices(fetchImpl: typeof fetch): CabinServices {
  const config = { controlBaseUrl: 'http://control.local', controlTimeoutMs: 50 } as unknown as CabinConfig
  return new CabinServices({ config, store: {} as never, fetchImpl })
}

describe('executeHardwareControl', () => {
  it('reports dispatched on http 200 with business code 0', async () => {
    const services = makeServices(async () => new Response(JSON.stringify({ code: 0 }), { status: 200 }))
    const route = buildRouteFromCommand(context, 'seat.tray.open')!
    const result = await services.executeHardwareControl({ route })
    expect(result.reply).toBe('已为您下发打开小桌板的指令，请稍候。')
    expect(result.slots.execution_status).toBe('dispatched')
  })

  it('reports failure on http 500', async () => {
    const services = makeServices(async () => new Response('err', { status: 500 }))
    const route = buildRouteFromCommand(context, 'seat.tray.open')!
    const result = await services.executeHardwareControl({ route })
    expect(result.reply).toBe('打开小桌板的指令下发失败，请稍后再试。')
    expect(result.slots.execution_status).toBe('failed')
  })

  it('reports failure on a non-zero business code', async () => {
    const services = makeServices(async () => new Response(JSON.stringify({ code: 1, msg: 'busy' }), { status: 200 }))
    const route = buildRouteFromCommand(context, 'seat.tray.open')!
    const result = await services.executeHardwareControl({ route })
    expect(result.slots.execution_status).toBe('failed')
  })

  it('aborts and reports failure when the control endpoint never responds', async () => {
    const services = makeServices((_url, init) => new Promise((_resolve, reject) => {
      const signal = (init as RequestInit | undefined)?.signal
      signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const route = buildRouteFromCommand(context, 'seat.tray.open')!
    const result = await services.executeHardwareControl({ route })
    expect(result.reply).toBe('打开小桌板的指令下发失败，请稍后再试。')
  })

  it('reports the control service is unreachable when no base url is configured', async () => {
    const config = {} as unknown as CabinConfig
    const services = new CabinServices({ config, store: {} as never })
    const route = buildRouteFromCommand(context, 'seat.tray.open')!
    const result = await services.executeHardwareControl({ route })
    expect(result.reply).toBe('当前暂时无法连接客舱设备控制服务，请稍后再试。')
  })

  it('blocks tray close and raises an alert when the tray is unfolded', async () => {
    const calls: Array<{ url: string; method?: string }> = []
    const alerts: unknown[] = []
    const services = new CabinServices({
      config: {
        controlBaseUrl: 'http://control.local',
        broadcastApiBaseUrl: 'http://broadcast.local',
        broadcastApiKey: 'test-key',
        controlAuth: 'test-auth',
        controlTimeoutMs: 50,
      } as unknown as CabinConfig,
      store: {
        createAlert: input => {
          alerts.push(input)
          return input
        },
      } as never,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), method: init?.method })
        if (String(url).includes('/admin-api/tcp/hardware/status')) {
          return new Response(JSON.stringify({
            code: 0,
            data: {
              target: 'A',
              key: 'tray',
              data: { tray_state: 'opened', tray_flipped: 'true' },
            },
          }), { status: 200 })
        }
        return new Response(JSON.stringify({ code: 0 }), { status: 200 })
      },
    })

    const route = buildRouteFromCommand(context, 'seat.tray.close')!
    const result = await services.executeHardwareControl({ route })

    expect(result.reply).toContain('先将桌板折叠')
    expect(result.slots.execution_status).toBe('blocked')
    expect(alerts).toHaveLength(1)
    expect(calls.some(call => call.url.includes('/admin-api/tcp-client/cmd/seat/tray/close'))).toBe(false)
    expect(calls.some(call => call.url.includes('/admin-api/cabin/broadcast/error-seat'))).toBe(true)
  })

  it('allows tray close when the tray is already folded', async () => {
    const calls: Array<{ url: string; method?: string }> = []
    const services = new CabinServices({
      config: { controlBaseUrl: 'http://control.local', controlTimeoutMs: 50 } as unknown as CabinConfig,
      store: {} as never,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), method: init?.method })
        if (String(url).includes('/admin-api/tcp/hardware/status')) {
          return new Response(JSON.stringify({
            code: 0,
            data: {
              target: 'A',
              key: 'tray',
              data: { tray_state: 'opened', tray_flipped: 'false' },
            },
          }), { status: 200 })
        }
        return new Response(JSON.stringify({ code: 0 }), { status: 200 })
      },
    })

    const route = buildRouteFromCommand(context, 'seat.tray.close')!
    const result = await services.executeHardwareControl({ route })

    expect(result.slots.execution_status).toBe('dispatched')
    expect(calls.some(call => call.url.includes('/admin-api/tcp-client/cmd/seat/tray/close'))).toBe(true)
  })
})
