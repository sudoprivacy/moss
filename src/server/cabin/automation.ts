import { appendFile, mkdir, writeFile, access } from 'fs/promises'
import { dirname, join } from 'path'
import { createHash, randomUUID } from 'crypto'
import WebSocket from 'ws'

import type { ServerConfig } from '../types.js'
import { CabinStore } from './store.js'
import type { CabinManagedSeat } from './types.js'
import type { CabinHealthReportService } from './healthReports.js'
import { CabinBroadcastClient } from './broadcastClient.js'

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

type SeatProblem = {
  type: string
  severity: 'warning' | 'critical'
  message: string
  details?: Record<string, unknown>
}

type BroadcastAsset = {
  file: string
  url: string
  text: string
  title: string
  cacheKey: string
  cacheHit: boolean
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

const BROADCAST_SPECS: Partial<Record<PhaseName, { title: string; zh: string; en: string }>> = {
  taxiing: {
    title: '滑行阶段广播',
    zh: '女士们，先生们：飞机已经开始滑行。为了您的安全，请您尽快在座位上坐好，系紧安全带。同时，请您收起小桌板，调正座椅靠背，将调光窗保持在全开状态。在“系好安全带”信号灯熄灭前，请勿离开座位。谢谢您的配合。',
    en: 'Ladies and gentlemen, the aircraft is now taxiing. For your safety, please be seated and fasten your seat belt. Please ensure your tray table is closed, your seat back is in the full upright position, and your window shade is fully open. Please remain seated until the seat belt sign is turned off. Thank you for your cooperation.',
  },
  climb: {
    title: '爬升阶段广播',
    zh: '女士们，先生们：飞机正处于爬升阶段。在此期间可能伴有颠簸，请您在座位上坐好并全程系紧安全带。现在您可以调低座椅靠背或使用小桌板。当飞机达到巡航高度后，我们将为您提供客舱服务。谢谢。',
    en: 'Ladies and gentlemen, we are currently climbing to our cruise altitude. As we may encounter turbulence, please remain seated with your seat belt securely fastened. You may now adjust your seat back and use your tray table. Our cabin service will begin shortly once we reach our cruising altitude. Thank you.',
  },
  descent: {
    title: '下降阶段广播',
    zh: '女士们，先生们：飞机已经开始下降，预计稍后着陆。请您回到座位坐好，系紧安全带。为了确保洗手间锁扣状态安全，即刻起客舱洗手间将停止使用，请您配合。谢谢。',
    en: 'Ladies and gentlemen, the aircraft has started its descent and we expect to land shortly. Please return to your seat and fasten your seat belt securely. For safety reasons, the lavatories are now closed for the remainder of the flight. Thank you for your cooperation.',
  },
  landing_approach: {
    title: '降落进近阶段广播',
    zh: '女士们，先生们：飞机已进入最终进近阶段，即将着陆。请您再次确认安全带已扣好并系紧。现在请您收起小桌板和脚踏板，调正座椅靠背，并将调光窗保持在全开状态。为了安全起见，所有的电子设备请调至飞行模式或关闭。谢谢。',
    en: 'Ladies and gentlemen, we are on our final approach for landing. Please ensure that your seat belt is securely fastened. At this time, please stow your tray table, return your seat back to the full upright position, and open your window shade. All electronic devices must be set to flight mode or turned off for landing. Thank you.',
  },
}

export class CabinFlightAutomation {
  private ws: WebSocket | null = null
  private stopped = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private lastPhaseCode: number | null = null
  private readonly logFile: string
  private readonly broadcastClient: CabinBroadcastClient
  private readonly ttsInflight = new Map<string, Promise<BroadcastAsset>>()

  constructor(
    private readonly config: ServerConfig,
    private readonly store: CabinStore,
    private readonly healthReports?: CabinHealthReportService,
  ) {
    this.logFile = config.cabin.automationLogFile || join(config.rootDir, 'logs', 'cabin-automation.jsonl')
    this.broadcastClient = new CabinBroadcastClient(config.cabin)
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
    this.healthReports?.handleWsEnvelope(envelope)
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
    const aircraftNo = seats[0]?.aircraftNo || this.config.cabin.aircraftNo || null
    const summary = {
      seats: seats.length,
      alerts: 0,
      controls: 0,
      controlFailures: 0,
      statusFailures: 0,
      broadcasts: 0,
      broadcastFailures: 0,
      alertPushes: 0,
      alertPushFailures: 0,
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

    let broadcast: BroadcastAsset | null = null
    try {
      broadcast = await this.ensureBroadcast(phaseName, requestId)
    } catch (error) {
      summary.broadcastFailures += 1
      this.log({
        event: 'broadcast.ready.failed',
        requestId,
        aircraftNo,
        flightId,
        flightDate,
        phaseCode,
        phaseName,
        ok: false,
        error: stringifyError(error),
      })
    }
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
      summary.broadcasts += 1
      const sent = await this.sendAudioAllBroadcast({
        requestId,
        aircraftNo,
        flightId,
        flightDate,
        phaseCode,
        phaseName,
        broadcast,
      })
      if (!sent) summary.broadcastFailures += 1
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
      if (checks.problems.length) {
        summary.alertPushes += 1
        const pushed = await this.sendSeatErrorBroadcast({
          seat,
          problems: checks.problems,
          requestId,
          phaseCode,
          phaseName,
        })
        if (!pushed) summary.alertPushFailures += 1
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
          aircraftNo: this.config.cabin.aircraftNo,
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
        aircraftNo: this.config.cabin.aircraftNo,
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
    problems: SeatProblem[]
    controls: Array<{ command: 'seat.cushion' | 'seat.tray.close'; params: Record<string, string> }>
    statusFailures: number
  }> {
    const { seat, requestId, phaseCode, phaseName } = input
    const problems: SeatProblem[] = []
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

  private async ensureBroadcast(phaseName: PhaseName, requestId: string): Promise<BroadcastAsset | null> {
    const spec = BROADCAST_SPECS[phaseName]
    if (!spec) return null
    const text = `${spec.zh}\n\n${spec.en}`
    const cacheKey = createBroadcastCacheKey({
      phaseName,
      title: spec.title,
      text,
      model: this.config.cabin.ttsModel,
      voice: this.config.cabin.ttsVoice,
      language: this.config.cabin.ttsLanguage,
      version: this.config.cabin.broadcastTtsVersion || 'flight-phase-v1',
    })
    const existing = this.ttsInflight.get(cacheKey)
    if (existing) return existing
    const promise = this.ensureBroadcastAudioFile({
      phaseName,
      title: spec.title,
      text,
      cacheKey,
      requestId,
    })
    this.ttsInflight.set(cacheKey, promise)
    try {
      return await promise
    } finally {
      this.ttsInflight.delete(cacheKey)
    }
  }

  private async ensureBroadcastAudioFile(input: {
    phaseName: PhaseName
    title: string
    text: string
    cacheKey: string
    requestId: string
  }): Promise<BroadcastAsset> {
    const { phaseName, title, text, cacheKey, requestId } = input
    const filename = `${phaseName}_${cacheKey.slice(0, 12)}.wav`
    const dir = this.config.cabin.broadcastTtsCacheDir || join(this.config.rootDir, 'cabin-broadcasts')
    const file = join(dir, filename)
    const baseUrl = this.config.cabin.broadcastBaseUrl?.replace(/\/+$/, '')
    const url = baseUrl
      ? `${baseUrl}/${filename}`
      : `/v1/cabin/broadcasts/${filename}`
    try {
      await access(file)
      this.log({
        event: 'broadcast.tts.cache_hit',
        requestId,
        phaseName,
        ok: true,
        details: { file, url, cache_key: cacheKey, text_hash: cacheKey.slice(0, 12), title },
      })
      return { file, url, text, title, cacheKey, cacheHit: true }
    } catch {}

    await mkdir(dir, { recursive: true })
    const start = Date.now()
    this.log({
      event: 'broadcast.tts.request',
      requestId,
      phaseName,
      method: 'POST',
      url: this.config.cabin.ttsUrl,
      ok: true,
      details: {
        model: this.config.cabin.ttsModel,
        voice: this.config.cabin.ttsVoice,
        language: this.config.cabin.ttsLanguage,
        cache_key: cacheKey,
        input_chars: text.length,
      },
    })
    try {
      const response = await fetch(this.config.cabin.ttsUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.cabin.ttsApiKey
            ? { authorization: `Bearer ${this.config.cabin.ttsApiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: this.config.cabin.ttsModel,
          voice: this.config.cabin.ttsVoice,
          input: text,
          response_format: 'wav',
          language: this.config.cabin.ttsLanguage,
        }),
      })
      if (!response.ok) {
        const errorText = await response.text()
        this.log({
          event: 'broadcast.tts.failed',
          requestId,
          phaseName,
          method: 'POST',
          url: this.config.cabin.ttsUrl,
          status: response.status,
          ok: false,
          elapsedMs: Date.now() - start,
          error: errorText,
          details: { cache_key: cacheKey },
        })
        throw new Error(`TTS request failed: ${response.status} ${errorText}`)
      }
      const audio = Buffer.from(await response.arrayBuffer())
      await writeFile(file, audio)
      await writeFile(join(dir, `${phaseName}_${cacheKey.slice(0, 12)}.json`), JSON.stringify({
        title,
        text,
        cacheKey,
        model: this.config.cabin.ttsModel,
        voice: this.config.cabin.ttsVoice,
        language: this.config.cabin.ttsLanguage,
        version: this.config.cabin.broadcastTtsVersion || 'flight-phase-v1',
        contentType: response.headers.get('content-type') || 'audio/wav',
        generatedAt: new Date().toISOString(),
      }, null, 2), 'utf8')
      this.log({
        event: 'broadcast.tts.generated',
        requestId,
        phaseName,
        method: 'POST',
        url: this.config.cabin.ttsUrl,
        status: response.status,
        ok: true,
        elapsedMs: Date.now() - start,
        details: { file, cache_key: cacheKey, audio_bytes: audio.length, title },
      })
      return { file, url, text, title, cacheKey, cacheHit: false }
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith('TTS request failed:'))) {
        this.log({
          event: 'broadcast.tts.error',
          requestId,
          phaseName,
          method: 'POST',
          url: this.config.cabin.ttsUrl,
          ok: false,
          elapsedMs: Date.now() - start,
          error: stringifyError(error),
          details: { cache_key: cacheKey },
        })
      }
      throw error
    }
  }

  private async sendAudioAllBroadcast(input: {
    requestId: string
    aircraftNo: string | null
    flightId: string
    flightDate: string | null
    phaseCode: number
    phaseName: PhaseName
    broadcast: BroadcastAsset
  }): Promise<boolean> {
    const { requestId, aircraftNo, flightId, flightDate, phaseCode, phaseName, broadcast } = input
    if (!aircraftNo) {
      this.log({
        event: 'broadcast.audio_all.skipped',
        requestId,
        flightId,
        flightDate,
        phaseCode,
        phaseName,
        ok: false,
        error: 'aircraftNo is required',
        details: { title: broadcast.title, cache_key: broadcast.cacheKey },
      })
      return false
    }
    this.log({
      event: 'broadcast.audio_all.request',
      requestId,
      aircraftNo,
      flightId,
      flightDate,
      phaseCode,
      phaseName,
      method: 'POST',
      ok: true,
      details: { title: broadcast.title, file: broadcast.file, cache_key: broadcast.cacheKey },
    })
    const result = await this.broadcastClient.sendAudioAll({
      aircraftNo,
      title: broadcast.title,
      filePath: broadcast.file,
    })
    this.log({
      event: result.ok ? 'broadcast.audio_all.success' : result.skipped ? 'broadcast.audio_all.skipped' : 'broadcast.audio_all.failed',
      requestId,
      aircraftNo,
      flightId,
      flightDate,
      phaseCode,
      phaseName,
      method: 'POST',
      url: result.url,
      status: result.status,
      ok: result.ok,
      elapsedMs: result.elapsedMs,
      error: result.error,
      details: {
        title: broadcast.title,
        file: broadcast.file,
        cache_key: broadcast.cacheKey,
        payload: result.payload,
      },
    })
    return result.ok
  }

  private async sendSeatErrorBroadcast(input: {
    seat: CabinManagedSeat
    problems: SeatProblem[]
    requestId: string
    phaseCode: number
    phaseName: PhaseName
  }): Promise<boolean> {
    const { seat, problems, requestId, phaseCode, phaseName } = input
    const aircraftNo = seat.aircraftNo || this.config.cabin.aircraftNo || null
    if (!aircraftNo) {
      this.log({
        event: 'broadcast.error_seat.skipped',
        requestId,
        flightId: seat.flightId,
        flightDate: seat.flightDate,
        phaseCode,
        phaseName,
        seatNo: seat.seatNo,
        ok: false,
        error: 'aircraftNo is required',
        details: { alert_types: problems.map(problem => problem.type) },
      })
      return false
    }
    const content = `${seat.seatNo} 座位安全检查异常：${problems.map(describeSeatProblem).join('；')}。`
    this.log({
      event: 'broadcast.error_seat.request',
      requestId,
      aircraftNo,
      flightId: seat.flightId,
      flightDate: seat.flightDate,
      phaseCode,
      phaseName,
      seatNo: seat.seatNo,
      method: 'POST',
      ok: true,
      details: { title: '座位告警', content, alert_types: problems.map(problem => problem.type) },
    })
    const result = await this.broadcastClient.sendErrorSeat({
      aircraftNo,
      seatNo: seat.seatNo,
      title: '座位告警',
      content,
    })
    this.log({
      event: result.ok ? 'broadcast.error_seat.success' : result.skipped ? 'broadcast.error_seat.skipped' : 'broadcast.error_seat.failed',
      requestId,
      aircraftNo,
      flightId: seat.flightId,
      flightDate: seat.flightDate,
      phaseCode,
      phaseName,
      seatNo: seat.seatNo,
      method: 'POST',
      url: result.url,
      status: result.status,
      ok: result.ok,
      elapsedMs: result.elapsedMs,
      error: result.error,
      details: {
        title: '座位告警',
        alert_types: problems.map(problem => problem.type),
        payload: result.payload,
      },
    })
    return result.ok
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

function describeSeatProblem(problem: SeatProblem): string {
  switch (problem.type) {
    case 'PASSENGER_NOT_PRESENT':
      return '乘客未在席'
    case 'SEATBELT_NOT_FASTENED':
      return '安全带未扣合'
    case 'SEAT_NOT_UPRIGHT':
      return '座椅未归位'
    case 'TRAY_NOT_CLOSED':
      return '小桌板未收起'
    default:
      return problem.message
  }
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

function createBroadcastCacheKey(input: {
  phaseName: string
  title: string
  text: string
  model: string
  voice: string
  language: string
  version: string
}): string {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
}
