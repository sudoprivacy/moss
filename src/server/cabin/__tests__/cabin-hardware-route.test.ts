import { describe, expect, it } from 'bun:test'
import { CabinServices } from '../service.js'
import type { CabinConfig, CabinPassengerContext } from '../types.js'

const context: CabinPassengerContext = {
  flightId: 'F1',
  flightDate: '2026-07-01',
  seatId: 'A',
  columnNo: 'A',
  tabletId: 'T1',
}

function makeServices(): CabinServices {
  const config = { controlBaseUrl: 'http://control.local' } as unknown as CabinConfig
  return new CabinServices({ config, store: {} as never })
}

function route(text: string) {
  return makeServices().routeHardwareControl({ context, text })
}

describe('routeHardwareControl ceiling vs reading light', () => {
  it('routes 打开顶灯 to the cabin ceiling light endpoint, not the seat light', () => {
    const result = route('帮我打开顶灯')
    expect(result?.command).toBe('cabin.ceiling.light')
    expect(result?.path).toBe('/admin-api/tcp-client/cmd/cabin/ceiling/light')
    expect(result?.params.on).toBe(true)
  })

  it('still routes 阅读灯 to the seat light endpoint', () => {
    const result = route('打开阅读灯')
    expect(result?.command).toBe('seat.light')
    expect(result?.path).toBe('/admin-api/tcp-client/cmd/seat/light')
    expect(result?.params.on).toBe(true)
  })

  it('routes 顶灯蓝色 to ceiling color with mapped RGB and default brightness', () => {
    const result = route('把顶灯调成蓝色')
    expect(result?.command).toBe('cabin.ceiling.color')
    expect(result?.params).toMatchObject({ r: 0, g: 0, b: 255, brightness: 100 })
  })

  it('routes ceiling brightness-only requests to ceiling color with default white RGB', () => {
    const result = route('把顶灯调亮一点')
    expect(result?.command).toBe('cabin.ceiling.color')
    expect(result?.path).toBe('/admin-api/tcp-client/cmd/cabin/ceiling/color')
    expect(result?.params).toMatchObject({ r: 255, g: 255, b: 255, brightness: 80 })
  })

  it('routes ceiling explicit brightness percentage to ceiling color', () => {
    const result = route('把顶灯亮度调到50%')
    expect(result?.command).toBe('cabin.ceiling.color')
    expect(result?.params).toMatchObject({ r: 255, g: 255, b: 255, brightness: 50 })
  })
})

describe('routeHardwareControl seat recline defaults', () => {
  it('defaults 后仰一点 to 30', () => {
    expect(route('座椅后仰一点')?.params.position).toBe(30)
  })

  it('defaults 放倒 to 60', () => {
    expect(route('把座椅放倒')?.params.position).toBe(60)
  })

  it('honors an explicit percentage', () => {
    expect(route('座椅调到 45%')?.params.position).toBe(45)
  })
})

describe('routeHardwareControl newly covered endpoints', () => {
  it('routes 开始生理检测 to health start', () => {
    expect(route('开始生理检测采集')?.command).toBe('seat.health.start')
  })

  it('routes 停止生理检测 to health stop', () => {
    expect(route('停止生理检测')?.command).toBe('seat.health.stop')
  })

  it('routes 切换到登机场景 to a known preset', () => {
    const result = route('切换到登机场景')
    expect(result?.command).toBe('cabin.scene')
    expect(result?.params.preset).toBe('boarding')
  })

  it('routes 清除场景 to scene clear', () => {
    expect(route('清除客舱场景')?.command).toBe('cabin.scene.clear')
  })

  it('falls through to the LLM path for an unknown scene word', () => {
    expect(route('切换到某个奇怪场景')).toBeNull()
  })
})
