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
  await new Promise(resolve => setTimeout(resolve, 30))
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'moss-cabin-flight-controls-test-'))
  tempDirs.push(dir)
  return dir
}

function createConfig(rootDir: string): ServerConfig {
  return {
    rootDir,
    workspace: join(rootDir, 'workspace'),
    defaultRuntime: 'host',
    cabin: {
      enabled: true,
      tokenSecret: 'test-secret',
      controlBaseUrl: 'http://cabin.test',
      controlAuth: 'control-auth',
      controlTimeoutMs: 500,
      automationEnabled: true,
      managedSeats: 'A',
      broadcastApiBaseUrl: 'http://cabin.test',
      broadcastApiKey: 'hardware-key',
      broadcastAuth: 'broadcast-auth',
      broadcastEnabled: false,
      ttsUrl: 'http://tts.test/speech',
      ttsModel: 'tts-test',
      ttsVoice: 'voice-test',
      ttsLanguage: 'zh',
      automationLogFile: join(rootDir, 'automation.jsonl'),
    },
  } as unknown as ServerConfig
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

type HardwareState = {
  bagLock?: boolean | string
  higherBag?: boolean | string
  lowerBag?: boolean | string
  posture?: number | string
  trayState?: string
  trayFlipped?: boolean | string
  readingLight?: boolean | string
  ceilingLight?: boolean | string
  omitBagFields?: boolean
  applyControls?: boolean
}

async function runPhase(phaseCode: number, state: HardwareState): Promise<{ store: CabinStore; calls: string[] }> {
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
  const calls: string[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    calls.push(`${url.pathname}${url.search}`)
    if (url.pathname === '/admin-api/tcp/hardware/status') {
      const key = url.searchParams.get('key')
      const data = key === 'bag'
        ? state.omitBagFields
          ? {}
          : { bagLock: state.bagLock ?? 'true', higherBag: state.higherBag ?? 'false', lowerBag: state.lowerBag ?? 'false' }
        : key === 'posture'
          ? { position: state.posture ?? '0' }
          : key === 'tray'
            ? { tray_state: state.trayState ?? 'closed', tray_flipped: state.trayFlipped ?? 'false' }
            : key === 'reading_light'
              ? { on: state.readingLight ?? 'false' }
              : key === 'ceiling_state'
                ? { on: state.ceilingLight ?? 'false' }
                : { presence: 'true', seatbelt: 'true' }
      return Response.json({ code: 0, data: { target: key === 'ceiling_state' ? 'cabin' : 'A', key, data, aircraftNo: 'B-WITHFLIGHT-01' } })
    }
    if (url.pathname.startsWith('/admin-api/tcp-client/cmd/')) {
      if (state.applyControls !== false) {
        if (url.pathname.endsWith('/seat/light')) state.readingLight = 'false'
        if (url.pathname.endsWith('/cabin/ceiling/light')) state.ceilingLight = 'false'
        if (url.pathname.endsWith('/seat/cushion')) state.posture = '0'
        if (url.pathname.endsWith('/seat/tray/close')) state.trayState = 'closed'
      }
      return Response.json({ code: 0, data: 'ok' })
    }
    return Response.json({ code: 0, data: 'ok' })
  }) as typeof fetch
  try {
    const automation = new CabinFlightAutomation(config, store)
    await (automation as unknown as { handleRawMessage(raw: string): Promise<void> }).handleRawMessage(flightMessage(phaseCode))
  } finally {
    globalThis.fetch = previousFetch
  }
  return { store, calls }
}

describe('CabinFlightAutomation baggage and hardware controls', () => {
  it('raises BAG_NOT_LOCKED for phase 1 when bagLock is false', async () => {
    const { store, calls } = await runPhase(1, { bagLock: 'false' })
    const alerts = store.listAlerts().alerts
    expect(alerts.some(alert => alert.alertType === 'BAG_NOT_LOCKED')).toBe(true)
    expect(calls.some(call => call.includes('/admin-api/tcp/hardware/status?target=A&key=bag'))).toBe(true)
  })

  it('does not raise a baggage alert for a locked phase 1 compartment', async () => {
    const { store } = await runPhase(1, { bagLock: 'true' })
    expect(store.listAlerts().alerts.some(alert => alert.alertType === 'BAG_NOT_LOCKED')).toBe(false)
  })

  it('raises BAG_LEFT_BEHIND_POSSIBLE for phase 15 when either bag layer is occupied', async () => {
    const { store } = await runPhase(15, { higherBag: 'true', lowerBag: 'false' })
    expect(store.listAlerts().alerts.some(alert => alert.alertType === 'BAG_LEFT_BEHIND_POSSIBLE')).toBe(true)
  })

  it('does not infer a baggage alert when the baggage fields are missing', async () => {
    const { store } = await runPhase(15, { omitBagFields: true })
    expect(store.listAlerts().alerts.some(alert => alert.alertType.startsWith('BAG_'))).toBe(false)
  })

  it('blocks tray close when tray_flipped is true', async () => {
    const { store, calls } = await runPhase(16, { trayState: 'opened', trayFlipped: 'true' })
    expect(store.listAlerts().alerts.some(alert => alert.alertType === 'TRAY_NOT_FOLDED')).toBe(true)
    expect(calls.some(call => call.includes('/admin-api/tcp-client/cmd/seat/tray/close'))).toBe(false)
  })

  it('turns off reading and ceiling lights and verifies their final state', async () => {
    const { store, calls } = await runPhase(16, { readingLight: 'true', ceilingLight: 'true' })
    expect(store.listAlerts().alerts.some(alert => alert.alertType === 'HARDWARE_STATE_NOT_REACHED')).toBe(false)
    expect(calls.filter(call => call.includes('/admin-api/tcp-client/cmd/seat/light')).length).toBe(1)
    expect(calls.filter(call => call.includes('/admin-api/tcp-client/cmd/cabin/ceiling/light')).length).toBe(1)
    expect(calls.filter(call => call.includes('/admin-api/tcp/hardware/status?target=cabin&key=ceiling_state')).length).toBe(2)
    expect(calls.filter(call => call.includes('/admin-api/tcp/hardware/status?target=A&key=reading_light')).length).toBe(2)
  })

  it('raises a state-not-reached alert when a successful control does not change hardware state', async () => {
    const { store } = await runPhase(16, { readingLight: 'true', ceilingLight: 'true', applyControls: false })
    expect(store.listAlerts().alerts.filter(alert => alert.alertType === 'HARDWARE_STATE_NOT_REACHED')).toHaveLength(2)
  })
})
