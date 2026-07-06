import { appendFile, mkdir, writeFile, access } from 'fs/promises'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import WebSocket from 'ws'

import type { ServerConfig } from '../types.js'
import { CabinStore } from './store.js'
import type { CabinManagedSeat } from './types.js'

type FlightDataMessage = {
  mavpacktype?: string
  afcs_status_data?: unknown[]
  control_mode?: number
  current_leg_index?: number
  id?: number
  Time?: string
}

type PhaseName =
  | 'taxi_in'
  | 'taxiing'
  | 'takeoff_prepare'
  | 'takeoff'
  | 'climb'
  | 'cruise'
  | 'descent'
  | 'landing_approach'
  | 'go_around'
  | 'unknown'

type HardwareStatusKey = 'posture' | 'tray' | 'safety' | 'glass_state'

type HardwareStatus = {
  aircraftNo?: string
  target: string
  key: string
  data: Record<string, unknown>
  lastUpdateTime?: number
}

type AutomationLogEvent = {
  event: string
  requestId?: string
  aircraftNo?: string | null
  flightId?: string
  flightDate?: string | null
  phaseCode?: number | null
  phaseName?: string
  seatNo?: string | null
  method?: string
  url?: string
  status?: number
  ok?: boolean
  elapsedMs?: number
  error?: string
  details?: Record<string, unknown>
}

const PHASE_LABELS: Record<number, string> = {
  1: '滑入',
  2: '起飞前准备',
  3: '起飞滑跑',
  4: '起飞抬轮',
  5: '初始爬升',
  6: '爬升',
  7: '巡航',
  8: '下降',
  9: '初始进近',
  10: '最终进近',
  11: '拉平',
  12: '跑道对准',
  13: '低机头',
  14: '着陆滑跑',
  15: '着陆滑跑结束',
  16: '划出',
  17: '复飞',
}

const BROADCAST_TEXT: Record<string, string> = {
  'taxiing.zh': '女士们，先生们：飞机已经开始滑行。为了您的安全，请您尽快在座位上坐好，系紧安全带。同时，请您收起小桌板，调正座椅靠背，将调光窗保持在全开状态。在“系好安全带”信号灯熄灭前，请勿离开座位。谢谢您的配合。',
  'climb.zh': '女士们，先生们：飞机正处于爬升阶段。在此期间可能伴有颠簸，请您在座位上坐好并全程系紧安全带。现在您可以调低座椅靠背或使用小桌板。当飞机达到巡航高度后，我们将为您提供客舱服务。谢谢。',
  'descent.zh': '女士们，先生们：飞机已经开始下降。请您回到座位坐好，系紧安全带。为了确保洗手间锁扣状态安全，即刻起客舱洗手间将停止使用，请您配合。谢谢。',
  'landing_approach.zh': '女士们，先生们：飞机已进入最终进近阶段，即将着陆。请您再次确认安全带已扣好并系紧。现在请您收起小桌板和脚踏板，调正座椅靠背，并将调光窗保持在全开状态。为了安全起见，所有的电子设备请调至飞行模式或关闭。谢谢。',
}

export class CabinFlightAutomation {
  private ws: WebSocket | null = null
  private stopped = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private lastPhaseCode: number | null = null
  private readonly logFile: string

  constructor(
    private readonly config: ServerConfig,
    private readonly store: CabinStore,
  ) {
    this.logFile = config.cabin.automationLogFile || join(config.rootDir, 'logs', 'cabin-automation.jsonl')
  }

  start(): void {
    if (!this.config.cabin.automationEnabled || !this.config.cabin.flightStateWsUrl) {
      this.log({ event: 'automation.disabled', ok: true })
      return
    }
    this.seedConfiguredSeats()
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.ws?.close()
    this.ws = null
  }

  private connect(): void {
    if (this.stopped || !this.config.cabin.flightStateWsUrl) return
    const url = this.config.cabin.flightStateWsUrl
    this.log({ event: 'ws.connect', url, ok: true })
    const ws = new WebSocket(url)
    this.ws = ws

    ws.on('open', () => {
      this.log({ event: 'ws.open', url, ok: true })
    })
    ws.on('message', data => {
      void this.handleRawMessage(data.toString())
    })
    ws.on('error', error => {
      this.log({ event: 'ws.error', url, ok: false, error: error instanceof Error ? error.message : String(error) })
    })
    ws.on('close', (code, reason) => {
      this.log({
        event: 'ws.close',
        url,
        ok: code === 1000,
        status: code,
        details: { reason: reason.toString() },
      })
      this.ws = null
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.connect(), 3000)
        this.reconnectTimer.unref?.()
      }
    })
  }

  private async handleRawMessage(raw: string): Promise<void> {
    const requestId = `auto_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    this.log({ event: 'ws.message.raw', requestId, ok: true, details: { raw: truncate(raw, 4000) } })

    let envelope: unknown
    try {
      envelope = JSON.parse(raw)
    } catch (error) {
      this.log({ event: 'ws.message.invalid_json', requestId, ok: false, error: stringifyError(error) })
      return
    }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      this.log({ event: 'ws.message.invalid_envelope', requestId, ok: false, details: { envelope } })
      return
    }
    const type = String((envelope as Record<string, unknown>).type || '')
    if (type !== 'flight_data') {
      this.log({ event: 'ws.message.ignored', requestId, ok: true, details: { type } })
      return
    }
    const rawContent = (envelope as Record<string, unknown>).content
    if (typeof rawContent !== 'string') {
      this.log({ event: 'flight_data.invalid_content', requestId, ok: false, details: { contentType: typeof rawContent } })
      return
    }
    let content: FlightDataMessage
    try {
      content = JSON.parse(rawContent) as FlightDataMessage
    } catch (error) {
      this.log({ event: 'flight_data.invalid_content_json', requestId, ok: false, error: stringifyError(error) })
      return
    }
    this.log({ event: 'ws.message.parsed', requestId, ok: true, details: { content } })
    await this.handleFlightData(content, requestId)
  }

  private async handleFlightData(content: FlightDataMessage, requestId: string): Promise<void> {
    if (content.id !== 1021 || content.mavpacktype !== 'CE25_AUTO_GUIDE_DATA') {
      this.log({
        event: 'flight_data.ignored',
        requestId,
        ok: true,
        details: { id: content.id, mavpacktype: content.mavpacktype },
      })
      return
    }
    const phaseCode = readPhaseCode(content)
    if (phaseCode === null) {
      this.log({ event: 'flight_data.missing_phase', requestId, ok: false, details: { afcs_status_data: content.afcs_status_data } })
      return
    }
    const phaseName = mapPhaseName(phaseCode)
    if (this.lastPhaseCode === phaseCode) {
      this.log({ event: 'flight.phase.duplicate', requestId, phaseCode, phaseName, ok: true })
      return
    }
    const previousPhaseCode = this.lastPhaseCode
    this.lastPhaseCode = phaseCode
    this.log({
      event: 'flight.phase.changed',
      requestId,
      phaseCode,
      phaseName,
      ok: true,
      details: { previous_phase_code: previousPhaseCode, label: PHASE_LABELS[phaseCode] || '未知' },
    })
    await this.runPhaseTask({ requestId, phaseCode, phaseName, content })
  }

  private async runPhaseTask(input: {
    requestId: string
    phaseCode: number
    phaseName: PhaseName
    content: FlightDataMessage
  }): Promise<void> {
    const { requestId, phaseCode, phaseName } = input
    if (!shouldRunTask(phaseName)) {
      this.log({ event: 'phase.task.skipped', requestId, phaseCode, phaseName, ok: true })
      return
    }

    const seats = this.resolveSeats()
    const flightId = seats[0]?.flightId || 'AUTO'
    const flightDate = seats[0]?.flightDate || today()
    const aircraftNo = seats[0]?.aircraftNo ?? null
    const summary = {
      seats: seats.length,
      alerts: 0,
      controls: 0,
      controlFailures: 0,
      statusFailures: 0,
    }
    this.log({
      event: 'seat.registry.loaded',
      requestId,
      aircraftNo,
      flightId,
      flightDate,
      phaseCode,
      phaseName,
      ok: true,
      details: { seats: seats.map(seat => seat.seatNo) },
    })

    const broadcast = await this.ensureBroadcast(phaseName, requestId)
    if (broadcast) {
      this.log({
        event: 'broadcast.ready',
        requestId,
        aircraftNo,
        flightId,
        flightDate,
        phaseCode,
        phaseName,
        ok: true,
        details: broadcast,
      })
    }

    for (const seat of seats) {
      const checks = await this.checkSeat({ seat, requestId, phaseCode, phaseName })
      summary.statusFailures += checks.statusFailures
      for (const problem of checks.problems) {
        summary.alerts += 1
        this.store.createAlert({
          aircraftNo: seat.aircraftNo,
          flightId: seat.flightId,
          flightDate: seat.flightDate,
          phaseCode,
          phaseName,
          seatNo: seat.seatNo,
          alertType: problem.type,
          severity: problem.severity,
          message: problem.message,
          sourceEventId: requestId,
          details: problem.details,
        })
        this.log({
          event: 'alert.created',
          requestId,
          aircraftNo: seat.aircraftNo,
          flightId: seat.flightId,
          flightDate: seat.flightDate,
          phaseCode,
          phaseName,
          seatNo: seat.seatNo,
          ok: true,
          details: { alert_type: problem.type, message: problem.message },
        })
      }
      for (const control of checks.controls) {
        const result = await this.sendControl(seat, control, requestId, phaseCode, phaseName)
        summary.controls += 1
        if (!result) summary.controlFailures += 1
      }
    }

    this.log({
      event: 'phase.task.summary',
      requestId,
      aircraftNo,
      flightId,
      flightDate,
      phaseCode,
      phaseName,
      ok: summary.controlFailures === 0 && summary.statusFailures === 0,
      details: summary,
    })
  }

  private resolveSeats(): CabinManagedSeat[] {
    const managed = this.store.listManagedSeats({ activeOnly: true })
    if (managed.length) return dedupeSeats(managed)
    const configured = parseManagedSeats(this.config.cabin.managedSeats)
    for (const seatNo of configured) {
      this.store.upsertManagedSeat({
        flightId: 'AUTO',
        flightDate: today(),
        seatNo,
        columnNo: seatNo,
      })
    }
    return this.store.listManagedSeats({ flightId: 'AUTO', flightDate: today(), activeOnly: true })
  }

  private seedConfiguredSeats(): void {
    for (const seatNo of parseManagedSeats(this.config.cabin.managedSeats)) {
      this.store.upsertManagedSeat({
        flightId: 'AUTO',
        flightDate: today(),
        seatNo,
        columnNo: seatNo,
      })
    }
  }

  private async checkSeat(input: {
    seat: CabinManagedSeat
    requestId: string
    phaseCode: number
    phaseName: PhaseName
  }): Promise<{
    problems: Array<{ type: string; severity: 'warning' | 'critical'; message: string; details?: Record<string, unknown> }>
    controls: Array<{ command: 'seat.cushion' | 'seat.tray.close'; params: Record<string, string> }>
    statusFailures: number
  }> {
    const { seat, requestId, phaseCode, phaseName } = input
    const problems: Array<{ type: string; severity: 'warning' | 'critical'; message: string; details?: Record<string, unknown> }> = []
    const controls: Array<{ command: 'seat.cushion' | 'seat.tray.close'; params: Record<string, string> }> = []
    let statusFailures = 0

    const needsSafety = ['taxiing', 'taxi_in', 'takeoff_prepare', 'takeoff', 'climb', 'descent', 'landing_approach'].includes(phaseName)
    const needsPostureTray = ['taxiing', 'taxi_in', 'takeoff_prepare', 'takeoff', 'landing_approach'].includes(phaseName)

    if (needsSafety) {
      const safety = await this.getHardwareStatus(seat, 'safety', requestId, phaseCode, phaseName)
      if (!safety) {
        statusFailures += 1
      } else {
        if (!toBool(safety.data.presence)) {
          problems.push({ type: 'PASSENGER_NOT_PRESENT', severity: 'warning', message: `${seat.seatNo} 座位乘客未在席`, details: safety.data })
        }
        if (!toBool(safety.data.seatbelt)) {
          problems.push({ type: 'SEATBELT_NOT_FASTENED', severity: 'critical', message: `${seat.seatNo} 座位安全带未扣合`, details: safety.data })
        }
      }
    }

    if (needsPostureTray) {
      const posture = await this.getHardwareStatus(seat, 'posture', requestId, phaseCode, phaseName)
      if (!posture) {
        statusFailures += 1
      } else if (toNumber(posture.data.position) !== 0) {
        problems.push({ type: 'SEAT_NOT_UPRIGHT', severity: 'critical', message: `${seat.seatNo} 座椅未归位`, details: posture.data })
        controls.push({ command: 'seat.cushion', params: { position: '0' } })
      }
      const tray = await this.getHardwareStatus(seat, 'tray', requestId, phaseCode, phaseName)
      if (!tray) {
        statusFailures += 1
      } else if (!isTrayClosed(tray.data.tray_state)) {
        problems.push({ type: 'TRAY_NOT_CLOSED', severity: 'critical', message: `${seat.seatNo} 小桌板未收起`, details: tray.data })
        controls.push({ command: 'seat.tray.close', params: {} })
      }
    }

    return { problems, controls, statusFailures }
  }

  private async getHardwareStatus(
    seat: CabinManagedSeat,
    key: HardwareStatusKey,
    requestId: string,
    phaseCode: number,
    phaseName: PhaseName,
  ): Promise<HardwareStatus | null> {
    const baseUrl = this.config.cabin.controlBaseUrl?.replace(/\/+$/, '')
    if (!baseUrl) {
      this.log({ event: 'hardware.status.not_configured', requestId, phaseCode, phaseName, seatNo: seat.seatNo, ok: false })
      return null
    }
    const target = key === 'glass_state' ? 'cabin' : seat.seatNo
    const url = new URL(`${baseUrl}/admin-api/tcp/hardware/status`)
    url.searchParams.set('target', target)
    url.searchParams.set('key', key)
    const start = Date.now()
    this.log({
      event: 'hardware.status.request',
      requestId,
      aircraftNo: seat.aircraftNo,
      flightId: seat.flightId,
      flightDate: seat.flightDate,
      phaseCode,
      phaseName,
      seatNo: seat.seatNo,
      method: 'GET',
      url: url.toString(),
      ok: true,
    })
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.config.cabin.controlAuth ? { Authorization: this.config.cabin.controlAuth } : {},
      })
      const payload = await parseResponse(response)
      this.log({
        event: 'hardware.status.response',
        requestId,
        aircraftNo: seat.aircraftNo,
        flightId: seat.flightId,
        flightDate: seat.flightDate,
        phaseCode,
        phaseName,
        seatNo: seat.seatNo,
        method: 'GET',
        url: url.toString(),
        status: response.status,
        ok: response.ok && isOkEnvelope(payload),
        elapsedMs: Date.now() - start,
        details: { payload },
      })
      if (!response.ok || !isOkEnvelope(payload)) return null
      const data = objectField(payload, 'data')
      if (!data) return null
      return {
        aircraftNo: stringField(data, 'aircraftNo'),
        target: stringField(data, 'target') || target,
        key: stringField(data, 'key') || key,
        data: objectField(data, 'data') || {},
        lastUpdateTime: toNumber((data as Record<string, unknown>).lastUpdateTime) ?? undefined,
      }
    } catch (error) {
      this.log({
        event: 'hardware.status.error',
        requestId,
        aircraftNo: seat.aircraftNo,
        flightId: seat.flightId,
        flightDate: seat.flightDate,
        phaseCode,
        phaseName,
        seatNo: seat.seatNo,
        method: 'GET',
        url: url.toString(),
        ok: false,
        elapsedMs: Date.now() - start,
        error: stringifyError(error),
      })
      return null
    }
  }

  private async sendControl(
    seat: CabinManagedSeat,
    control: { command: 'seat.cushion' | 'seat.tray.close'; params: Record<string, string> },
    requestId: string,
    phaseCode: number,
    phaseName: PhaseName,
  ): Promise<boolean> {
    const baseUrl = this.config.cabin.controlBaseUrl?.replace(/\/+$/, '')
    if (!baseUrl) return false
    const path = control.command === 'seat.cushion'
      ? '/admin-api/tcp-client/cmd/seat/cushion'
      : '/admin-api/tcp-client/cmd/seat/tray/close'
    const url = new URL(`${baseUrl}${path}`)
    url.searchParams.set('seatNo', seat.seatNo)
    for (const [key, value] of Object.entries(control.params)) {
      url.searchParams.set(key, value)
    }
    const start = Date.now()
    this.log({
      event: 'hardware.control.request',
      requestId,
      aircraftNo: seat.aircraftNo,
      flightId: seat.flightId,
      flightDate: seat.flightDate,
      phaseCode,
      phaseName,
      seatNo: seat.seatNo,
      method: 'POST',
      url: url.toString(),
      ok: true,
      details: { command: control.command },
    })
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.config.cabin.controlAuth ? { Authorization: this.config.cabin.controlAuth } : {},
      })
      const payload = await parseResponse(response)
      const ok = response.ok && isOkEnvelope(payload)
      this.log({
        event: 'hardware.control.response',
        requestId,
        aircraftNo: seat.aircraftNo,
        flightId: seat.flightId,
        flightDate: seat.flightDate,
        phaseCode,
        phaseName,
        seatNo: seat.seatNo,
        method: 'POST',
        url: url.toString(),
        status: response.status,
        ok,
        elapsedMs: Date.now() - start,
        details: { command: control.command, payload },
      })
      if (!ok) {
        this.store.createAlert({
          aircraftNo: seat.aircraftNo,
          flightId: seat.flightId,
          flightDate: seat.flightDate,
          phaseCode,
          phaseName,
          seatNo: seat.seatNo,
          alertType: 'HARDWARE_CONTROL_FAILED',
          severity: 'critical',
          message: `${seat.seatNo} ${control.command} 指令下发失败`,
          sourceEventId: requestId,
          details: { payload },
        })
      }
      return ok
    } catch (error) {
      this.log({
        event: 'hardware.control.error',
        requestId,
        aircraftNo: seat.aircraftNo,
        flightId: seat.flightId,
        flightDate: seat.flightDate,
        phaseCode,
        phaseName,
        seatNo: seat.seatNo,
        method: 'POST',
        url: url.toString(),
        ok: false,
        elapsedMs: Date.now() - start,
        error: stringifyError(error),
        details: { command: control.command },
      })
      return false
    }
  }

  private async ensureBroadcast(phaseName: PhaseName, requestId: string): Promise<{ file: string; url: string; text: string } | null> {
    const key = `${phaseName}.zh`
    const text = BROADCAST_TEXT[key]
    if (!text) return null
    const filename = `${key}.wav`
    const dir = join(this.config.rootDir, 'cabin-broadcasts')
    const file = join(dir, filename)
    try {
      await access(file)
    } catch {
      await mkdir(dir, { recursive: true })
      await writeFile(file, createSilentWav())
      await writeFile(join(dir, `${key}.txt`), text, 'utf8')
    }
    const baseUrl = this.config.cabin.broadcastBaseUrl?.replace(/\/+$/, '')
    const url = baseUrl
      ? `${baseUrl}/${filename}`
      : `/v1/cabin/broadcasts/${filename}`
    this.log({ event: 'broadcast.asset.ensure', requestId, phaseName, ok: true, details: { file, url } })
    return { file, url, text }
  }

  private log(event: AutomationLogEvent): void {
    const payload = {
      time: new Date().toISOString(),
      ...event,
    }
    void appendJsonLine(this.logFile, payload)
  }
}

export function mapPhaseName(code: number): PhaseName {
  if (code === 1) return 'taxi_in'
  if (code === 16) return 'taxiing'
  if (code === 2) return 'takeoff_prepare'
  if (code === 3 || code === 4) return 'takeoff'
  if (code === 5 || code === 6) return 'climb'
  if (code === 7) return 'cruise'
  if (code === 8) return 'descent'
  if (code >= 9 && code <= 15) return 'landing_approach'
  if (code === 17) return 'go_around'
  return 'unknown'
}

function shouldRunTask(phaseName: PhaseName): boolean {
  return ['taxi_in', 'taxiing', 'takeoff_prepare', 'takeoff', 'climb', 'descent', 'landing_approach'].includes(phaseName)
}

function readPhaseCode(content: FlightDataMessage): number | null {
  const raw = Array.isArray(content.afcs_status_data) ? content.afcs_status_data[7] : undefined
  const code = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10)
  return Number.isFinite(code) ? code : null
}

function parseManagedSeats(value?: string): string[] {
  if (!value) return []
  return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))]
}

function dedupeSeats(seats: CabinManagedSeat[]): CabinManagedSeat[] {
  const seen = new Set<string>()
  const result: CabinManagedSeat[] = []
  for (const seat of seats) {
    const key = seat.seatNo
    if (seen.has(key)) continue
    seen.add(key)
    result.push(seat)
  }
  return result
}

function objectField(input: unknown, key: string): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = (input as Record<string, unknown>)[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isOkEnvelope(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return true
  const code = (payload as Record<string, unknown>).code
  return code === undefined || code === 0 || code === '0'
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return /^(true|1|yes|on|扣合|已扣|在席)$/i.test(value.trim())
  return false
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function isTrayClosed(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return ['closed', 'close', '0', '收起', '关闭'].includes(value.trim().toLowerCase())
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

async function appendJsonLine(file: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, `${JSON.stringify(payload)}\n`, 'utf8')
  } catch (error) {
    console.warn('[CabinFlightAutomation] Failed to write automation log:', error)
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function createSilentWav(): Buffer {
  const sampleRate = 8000
  const seconds = 1
  const samples = sampleRate * seconds
  const dataSize = samples * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  return buffer
}
