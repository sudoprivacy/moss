import { describe, expect, it } from 'bun:test'
import {
  CabinServices,
  buildCabinComfortOffer,
  isAffirmationReply,
  looksLikeHardwareOffer,
  normalizeCabinHardwareReply,
} from '../service.js'
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

describe('isAffirmationReply', () => {
  it('accepts bare confirmations', () => {
    for (const text of ['好', '好的', '好呀', '行', '可以', '嗯', '要', '需要', '来吧', '麻烦你了', 'ok', 'yes']) {
      expect(isAffirmationReply(text)).toBe(true)
    }
  })

  it('rejects negations and declines', () => {
    for (const text of ['不用', '不要', '别了', '算了', '再说吧', 'no', '我不困了']) {
      expect(isAffirmationReply(text)).toBe(false)
    }
  })

  it('rejects utterances that carry their own concrete request', () => {
    for (const text of ['好，帮我放倒座椅', '打开小桌板', '有点冷']) {
      expect(isAffirmationReply(text)).toBe(false)
    }
  })
})

describe('looksLikeHardwareOffer', () => {
  it('recognizes an assistant offer phrased as a yes/no question', () => {
    expect(looksLikeHardwareOffer('您辛苦了，需要我为您把座椅放倒到休息角度吗？')).toBe(true)
    expect(looksLikeHardwareOffer('好的，需要我为您开启座椅加热吗？')).toBe(true)
    expect(looksLikeHardwareOffer('要不要我为您开启座椅通风？')).toBe(true)
  })

  it('rejects a completed dispatch confirmation so "好" does not re-fire', () => {
    expect(looksLikeHardwareOffer('已为您下发座椅控制指令，请稍候。')).toBe(false)
    expect(looksLikeHardwareOffer('正在为您调节座椅。')).toBe(false)
  })

  it('rejects plain chat that is not an offer', () => {
    expect(looksLikeHardwareOffer('您好，请问有什么可以帮您？')).toBe(false)
    expect(looksLikeHardwareOffer('祝您旅途愉快。')).toBe(false)
  })
})

describe('buildCabinComfortOffer', () => {
  it('offers one hardware adjustment for comfort-state-only messages', () => {
    expect(buildCabinComfortOffer({ context, text: '我困了' })).toContain('座椅放倒')
    expect(buildCabinComfortOffer({ context, text: '有点冷' })).toContain('座椅加热')
    expect(buildCabinComfortOffer({ context, text: '这里好闷啊' })).toContain('座椅通风')
    expect(buildCabinComfortOffer({ context, text: '坐久了腰有点酸' })).toContain('座椅按摩')
  })

  it('does not offer when the message is explicit control or ordinary chat', () => {
    expect(buildCabinComfortOffer({ context, text: '打开座椅加热' })).toBeNull()
    expect(buildCabinComfortOffer({ context, text: '我有点无聊，能聊聊天吗？' })).toBeNull()
  })
})

describe('confirmed suggestion resolves through the deterministic router', () => {
  const resolve = (offer: string) => makeServices().routeHardwareControl({ context, text: offer })

  it('maps a seat-recline offer to seat.cushion at the rest default', () => {
    const route = resolve('需要我为您把座椅放倒到休息角度吗？')
    expect(route?.command).toBe('seat.cushion')
    expect(route?.params.position).toBe(60)
  })

  it('maps a seat-heating offer to seat.heating', () => {
    const route = resolve('需要我为您开启座椅加热吗？')
    expect(route?.command).toBe('seat.heating')
  })

  it('maps a seat-ventilation offer to seat.ventilation', () => {
    const route = resolve('需要我为您开启座椅通风吗？')
    expect(route?.command).toBe('seat.ventilation')
  })

  it('maps a seat-massage offer to seat.massage', () => {
    const route = resolve('需要我为您开启座椅按摩吗？')
    expect(route?.command).toBe('seat.massage')
  })

  it('keeps seat-rest confirmations labeled as seat control, not cabin scene control', () => {
    expect(normalizeCabinHardwareReply({
      userText: '需要我为您把座椅放倒到休息角度吗？',
      reply: '已为您下发座椅位置调整到 60%的指令，请稍候。',
      context,
    })).toContain('座椅')
  })
})
