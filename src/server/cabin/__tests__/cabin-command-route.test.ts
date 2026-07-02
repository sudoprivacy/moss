import { describe, expect, it } from 'bun:test'
import { CabinServices, buildRouteFromCommand } from '../service.js'
import type { CabinConfig, CabinPassengerContext } from '../types.js'

const context: CabinPassengerContext = {
  flightId: 'F1',
  flightDate: '2026-07-01',
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
})
