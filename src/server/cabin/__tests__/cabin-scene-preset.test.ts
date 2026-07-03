import { describe, expect, it } from 'bun:test'
import { buildRouteFromCommand } from '../service.js'
import type { CabinPassengerContext } from '../types.js'

const context: CabinPassengerContext = {
  flightId: 'F1',
  flightDate: '2026-07-01',
  seatId: 'A',
  columnNo: 'A',
  tabletId: 'T1',
}

describe('cabin.scene preset is constrained to the hardware enum', () => {
  it('accepts the four supported presets', () => {
    for (const preset of ['boarding', 'cruise', 'night', 'landing']) {
      const route = buildRouteFromCommand(context, 'cabin.scene', { preset })
      expect(route?.command).toBe('cabin.scene')
      expect(route?.params.preset).toBe(preset)
    }
  })

  it('normalizes case to the canonical preset', () => {
    const route = buildRouteFromCommand(context, 'cabin.scene', { preset: 'NIGHT' })
    expect(route?.params.preset).toBe('night')
  })

  it('rejects an out-of-catalog preset instead of dispatching it', () => {
    for (const preset of ['sleep', 'rest', 'dining', 'reading', 'welcome', 'none']) {
      expect(buildRouteFromCommand(context, 'cabin.scene', { preset })).toBeNull()
    }
  })

  it('rejects a missing preset', () => {
    expect(buildRouteFromCommand(context, 'cabin.scene', {})).toBeNull()
  })
})
