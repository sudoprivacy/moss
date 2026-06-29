import { access, mkdir, writeFile } from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import type { ServerConfig } from '../types.js'
import type { CabinServices } from './service.js'

type DemoSeatState = {
  seatNo: string
  columnNo?: string
  position?: number
  trayState?: string
}

export type CabinDemoFlightStateInput = {
  flightId?: string
  flightNo?: string
  flightPhase?: string
  timestamp?: string
  seats?: DemoSeatState[]
}

type DemoAlert = {
  id: string
  flightId: string
  flightNo: string
  flightPhase: string
  seatNo: string
  type: string
  message: string
  createdAt: string
}

type DemoBroadcast = {
  id: string
  flightId: string
  flightNo: string
  flightPhase: string
  audioPath: string
  contentType: string
  elapsedMs: number
  reused: boolean
  playback: {
    configured: boolean
    ok: boolean
    status?: number
    error?: string
  }
  createdAt: string
}

type DemoCommand = {
  seatNo: string
  command: string
  ok: boolean
  status?: number
  error?: string
  response?: unknown
}

const TAXIING_BROADCAST_TEXT = [
  '女士们，先生们：飞机已经开始滑行。为了您的安全，请您尽快在座位上坐好，系紧安全带。同时，请您收起小桌板，调正座椅靠背，将调光窗保持在全开状态。在“系好安全带”信号灯熄灭前，请勿离开座位。谢谢您的配合。',
  'Ladies and gentlemen, the aircraft is now taxiing. For your safety, please be seated and fasten your seat belt. Please ensure your tray table is closed, your seat back is in the full upright position, and your window shade is fully open. Please remain seated until the seat belt sign is turned off. Thank you for your cooperation.',
].join('\n')

export class CabinDemoState {
  readonly alerts: DemoAlert[] = []
  readonly broadcasts: DemoBroadcast[] = []

  constructor(
    private readonly config: ServerConfig,
    private readonly services: CabinServices,
  ) {}

  async handleFlightState(input: CabinDemoFlightStateInput): Promise<Record<string, unknown>> {
    if (!this.config.cabin.flightStateDemoEnabled) {
      throw new Error('Cabin flight state demo is disabled')
    }
    const flightPhase = String(input.flightPhase || '').trim().toUpperCase()
    const flightId = String(input.flightId || '').trim() || 'UNKNOWN'
    const flightNo = String(input.flightNo || '').trim() || flightId
    const seats = Array.isArray(input.seats) ? input.seats : []
    const result = {
      status: 'ok',
      flight_id: flightId,
      flight_no: flightNo,
      flight_phase: flightPhase,
      broadcast: null as DemoBroadcast | null,
      alerts: [] as DemoAlert[],
      commands: [] as DemoCommand[],
      skipped: '',
    }

    if (flightPhase !== 'TAXIING') {
      result.skipped = 'flight_phase is not TAXIING'
      return result
    }

    result.broadcast = await this.createTaxiingBroadcast(flightId, flightNo, flightPhase)

    for (const seat of seats) {
      const seatNo = String(seat.seatNo || '').trim()
      if (!seatNo) continue
      const needsSeatReset = typeof seat.position === 'number' && seat.position !== 0
      const trayState = String(seat.trayState || '').trim().toLowerCase()
      const needsTrayClose = trayState && !['close', 'closed', '0'].includes(trayState)

      if (needsSeatReset || needsTrayClose) {
        const problems = [
          needsSeatReset ? '座椅未归位' : '',
          needsTrayClose ? '小桌板未关闭' : '',
        ].filter(Boolean)
        const alert = this.recordAlert({
          flightId,
          flightNo,
          flightPhase,
          seatNo,
          type: 'CABIN_DEVICE_NOT_READY',
          message: `滑行阶段${problems.join('，')}`,
        })
        result.alerts.push(alert)
        await this.postAlert(alert)
      }

      if (needsSeatReset) {
        result.commands.push(await this.sendControlCommand('/admin-api/tcp-client/cmd/seat/cushion', {
          seatNo,
          position: '0',
        }, 'seat.cushion'))
      }
      if (needsTrayClose) {
        result.commands.push(await this.sendControlCommand('/admin-api/tcp-client/cmd/seat/tray/close', {
          seatNo,
        }, 'seat.tray.close'))
      }
    }

    return result
  }

  private async createTaxiingBroadcast(flightId: string, flightNo: string, flightPhase: string): Promise<DemoBroadcast> {
    const dir = path.join(this.config.rootDir, 'cabin-demo', 'broadcasts')
    await mkdir(dir, { recursive: true })
    const audioPath = path.join(dir, 'taxiing-fixed.wav')
    const generated = await this.ensureTaxiingBroadcastAudio(audioPath)
    const id = randomUUID()
    const broadcast: DemoBroadcast = {
      id,
      flightId,
      flightNo,
      flightPhase,
      audioPath,
      contentType: generated.contentType,
      elapsedMs: generated.elapsedMs,
      reused: generated.reused,
      playback: await this.postPlayback({ flightId, flightNo, flightPhase, audioPath }),
      createdAt: new Date().toISOString(),
    }
    this.broadcasts.unshift(broadcast)
    this.broadcasts.splice(20)
    return broadcast
  }

  private async ensureTaxiingBroadcastAudio(audioPath: string): Promise<{
    contentType: string
    elapsedMs: number
    reused: boolean
  }> {
    try {
      await access(audioPath)
      return {
        contentType: 'audio/wav',
        elapsedMs: 0,
        reused: true,
      }
    } catch {
      const speech = await this.services.speech(TAXIING_BROADCAST_TEXT)
      await writeFile(audioPath, speech.audio)
      return {
        contentType: speech.contentType,
        elapsedMs: speech.elapsedMs,
        reused: false,
      }
    }
  }

  private recordAlert(input: Omit<DemoAlert, 'id' | 'createdAt'>): DemoAlert {
    const alert: DemoAlert = {
      id: randomUUID(),
      ...input,
      createdAt: new Date().toISOString(),
    }
    this.alerts.unshift(alert)
    this.alerts.splice(50)
    return alert
  }

  private async postPlayback(payload: Record<string, unknown>): Promise<DemoBroadcast['playback']> {
    const url = this.config.cabin.demoPlaybackUrl
    if (!url) return { configured: false, ok: true }
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      return { configured: true, ok: response.ok, status: response.status }
    } catch (error) {
      return {
        configured: true,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async postAlert(alert: DemoAlert): Promise<void> {
    const url = this.config.cabin.demoAlertUrl
    if (!url) return
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(alert),
      })
    } catch {
      // Demo alert delivery is best-effort until the customer provides the real API.
    }
  }

  private async sendControlCommand(pathname: string, query: Record<string, string>, command: string): Promise<DemoCommand> {
    const baseUrl = this.config.cabin.controlBaseUrl?.replace(/\/+$/, '')
    if (!baseUrl) {
      return { seatNo: query.seatNo, command, ok: false, error: 'cabin.controlBaseUrl is not configured' }
    }
    const url = new URL(`${baseUrl}${pathname}`)
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value)
    }
    const headers: Record<string, string> = {}
    if (this.config.cabin.controlAuth) headers.Authorization = this.config.cabin.controlAuth
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
      })
      const text = await response.text()
      let payload: unknown = text
      try {
        payload = text ? JSON.parse(text) : null
      } catch {
        payload = text
      }
      return {
        seatNo: query.seatNo,
        command,
        ok: response.ok,
        status: response.status,
        response: payload,
      }
    } catch (error) {
      return {
        seatNo: query.seatNo,
        command,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
