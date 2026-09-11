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

  it('routes ceiling explicit brightness number without falling back to the default', () => {
    const result = route('把顶灯调亮到70')
    expect(result?.command).toBe('cabin.ceiling.color')
    expect(result?.params).toMatchObject({ r: 255, g: 255, b: 255, brightness: 70 })
  })

  it('routes ceiling color with explicit numeric brightness', () => {
    const result = route('把顶灯调成蓝色亮度80')
    expect(result?.command).toBe('cabin.ceiling.color')
    expect(result?.params).toMatchObject({ r: 0, g: 0, b: 255, brightness: 80 })
  })

  it('does not ignore an unparsed ceiling numeric parameter by treating it as a switch', () => {
    expect(route('打开顶灯80')).toBeNull()
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

  it('honors an explicit position number without a percent sign', () => {
    expect(route('座椅后仰到40')?.params.position).toBe(40)
  })

  it('honors an explicit Chinese position number', () => {
    expect(route('靠背后仰到四十')?.params.position).toBe(40)
  })

  it('does not route seat state questions as seat control', () => {
    expect(route('当前座椅角度是多少')).toBeNull()
    expect(route('座椅是不是放倒了')).toBeNull()
  })
})

describe('routeHardwareControl status query guard', () => {
  it('does not route tray state questions as tray control', () => {
    expect(route('小桌板收好了吗')).toBeNull()
    expect(route('现在小桌板是展开的吗')).toBeNull()
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

  it('routes common tray-table typo 小桌版 as tray control', () => {
    expect(route('打开小桌版')?.command).toBe('seat.tray.open')
  })

  it('falls through to the LLM path for an unknown scene word', () => {
    expect(route('切换到某个奇怪场景')).toBeNull()
  })
})

describe('routeHardwareControl parameter extraction guardrails', () => {
  it('routes reading light 调亮到800 as pwm 800 instead of the brighter default', () => {
    const result = route('灯光调亮到800')
    expect(result?.command).toBe('seat.light.brightness')
    expect(result?.params.pwm).toBe(800)
  })

  it('routes reading light Chinese-number brightness values from field ASR text', () => {
    expect(route('把阅读灯亮度调到八百。')?.params.pwm).toBe(800)
    expect(route('把阅读灯亮度调到两百。')?.params.pwm).toBe(200)
    expect(route('把阅读灯亮度调到五百。')?.params.pwm).toBe(500)
    expect(route('阅读灯亮度调到一千。')?.params.pwm).toBe(1000)
    expect(route('把阅读灯调到两百。')?.params.pwm).toBe(200)
    expect(route('阅读灯亮度调至五十。')?.params.pwm).toBe(50)
    expect(route('调节阅读灯五百亮度。')?.params.pwm).toBe(500)
    expect(route('调节阅读灯亮度为零。')?.params.pwm).toBe(0)
    expect(route('阅读灯亮度为一千。')?.params.pwm).toBe(1000)
    expect(route('阅读灯亮度调节到三百。')?.params.pwm).toBe(300)
  })

  it('keeps the reading light default only when no explicit parameter is present', () => {
    expect(route('灯光调亮一点')?.params.pwm).toBe(700)
  })

  it('does not ignore an unparsed reading light numeric parameter by treating it as a switch', () => {
    expect(route('打开阅读灯800')).toBeNull()
  })

  it('routes ventilation level from directional numeric wording', () => {
    const result = route('通风开大到3')
    expect(result?.command).toBe('seat.ventilation')
    expect(result?.params.level).toBe(3)
  })

  it('routes heating level before the generic seat position branch', () => {
    const result = route('座椅加热到3')
    expect(result?.command).toBe('seat.heating')
    expect(result?.params.level).toBe(3)
  })

  it('routes massage Chinese level wording', () => {
    const result = route('按摩二档')
    expect(result?.command).toBe('seat.massage')
    expect(result?.params.level).toBe(2)
  })

  it('keeps the comfort default only when no explicit parameter is present', () => {
    expect(route('打开通风')?.params.level).toBe(2)
  })

  it('does not default comfort level when a numeric signal cannot be parsed as a level', () => {
    expect(route('打开通风300')).toBeNull()
    expect(route('通风开大到300')).toBeNull()
  })
})
