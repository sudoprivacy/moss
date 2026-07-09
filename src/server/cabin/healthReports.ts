import type {
  CabinConfig,
  CabinHealthMetricKey,
  CabinHealthMetricLevel,
  CabinHealthMetricResult,
  CabinHealthReport,
  CabinHealthReportSummary,
  CabinPassengerContext,
} from './types.js'
import { CabinStore } from './store.js'
import type { CabinLogger } from './logger.js'
import { fetchWithTimeout } from './http.js'

type FetchLike = typeof fetch

type HealthReportLogContext = {
  requestId?: string
}

type ActiveReport = {
  reportId: string
  aircraftNo?: string | null
  seatNo: string
  flightId: string
  flightDate: string
  samples: HealthSample[]
  lastFlushedCount: number
  timer?: NodeJS.Timeout
  flushTimer?: NodeJS.Timeout
}

type HealthSample = {
  received_at: number
  frame_count?: number
  heart_rate?: number
  respiratory_rate?: number
  spo2?: number
  body_temperature?: number
}

type HealthReportApiResponse = Record<string, unknown> & {
  report_id: string
  report_status: string
  sample_count?: number
  metrics?: Record<CabinHealthMetricKey, CabinHealthMetricResult>
  summary?: Record<string, unknown>
}

type CabinHealthReportServiceOptions = {
  config: CabinConfig
  store: CabinStore
  logger?: CabinLogger
  fetchImpl?: FetchLike
  scheduleFinalize?: boolean
}

const METRICS: Record<CabinHealthMetricKey, {
  unit: string
  min: number
  max: number
  normalMin: number
  normalMax: number
  decimals: number
}> = {
  heart_rate: { unit: 'bpm', min: 20, max: 180, normalMin: 60, normalMax: 100, decimals: 0 },
  respiratory_rate: { unit: 'breaths_per_min', min: 6, max: 30, normalMin: 16, normalMax: 20, decimals: 0 },
  spo2: { unit: 'percent', min: 80, max: 110, normalMin: 95, normalMax: 100, decimals: 0 },
  body_temperature: { unit: 'celsius', min: 20, max: 45, normalMin: 36.1, normalMax: 37.2, decimals: 1 },
}

const METRIC_KEYS = Object.keys(METRICS) as CabinHealthMetricKey[]
const SAMPLE_FLUSH_INTERVAL_MS = 1_000
const SAMPLE_FLUSH_BATCH_SIZE = 10

export class CabinHealthReportService {
  private readonly fetchImpl: FetchLike
  private readonly scheduleFinalize: boolean
  private readonly activeReportsByKey = new Map<string, ActiveReport>()

  constructor(private readonly options: CabinHealthReportServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.scheduleFinalize = options.scheduleFinalize !== false
  }

  startReport(context: CabinPassengerContext, input: HealthReportLogContext & { language?: string } = {}): HealthReportApiResponse {
    const seatNo = context.seatId
    if (!seatNo) throw new Error('MISSING_SEAT_CONTEXT')
    const now = Date.now()
    const collectSeconds = this.options.config.healthReportCollectSeconds ?? 30
    const collectUntil = now + collectSeconds * 1000
    const reportKey = activeReportKey({
      aircraftNo: context.aircraftNo,
      flightId: context.flightId,
      flightDate: context.flightDate,
      seatNo,
    })
    const existing = this.activeReportsByKey.get(reportKey)
    const cancelled = this.options.store.cancelUnfinishedHealthReports({
      flightId: context.flightId,
      flightDate: context.flightDate,
      seatNo,
    })
    if (existing) {
      this.clearActiveTimers(existing)
      this.activeReportsByKey.delete(reportKey)
    }

    const report = this.options.store.createHealthReport({
      aircraftNo: context.aircraftNo,
      flightId: context.flightId,
      flightDate: context.flightDate,
      seatNo,
      tabletId: context.tabletId,
      passengerId: context.passengerId,
      passengerRef: context.passengerRef,
      language: input.language || context.language || 'zh',
      startedAt: now,
      collectUntil,
    })

    for (const oldReport of cancelled) {
      this.log('health_report.cancel_previous', {
        request_id: input.requestId,
        report_id: report.id,
        previous_report_id: oldReport.id,
        tablet_id: context.tabletId,
        seat_no: seatNo,
        flight_id: context.flightId,
        flight_date: context.flightDate,
        report_status: 'cancelled',
        sample_count: oldReport.sampleCount,
        error_code: 'SUPERSEDED_BY_NEW_REPORT',
      })
    }

    const active: ActiveReport = {
      reportId: report.id,
      aircraftNo: context.aircraftNo,
      seatNo,
      flightId: context.flightId,
      flightDate: context.flightDate,
      samples: [],
      lastFlushedCount: 0,
    }
    if (this.scheduleFinalize) {
      active.timer = setTimeout(() => {
        void this.finalizeReport(report.id, { requestId: `health_${report.id}` })
      }, collectSeconds * 1000)
      active.timer.unref?.()
    }
    this.activeReportsByKey.set(reportKey, active)
    this.log('health_report.start', {
      request_id: input.requestId,
      report_id: report.id,
      tablet_id: context.tabletId,
      seat_no: seatNo,
      flight_id: context.flightId,
      flight_date: context.flightDate,
      report_status: report.status,
      collect_duration_seconds: collectSeconds,
      estimated_completed_at: collectUntil,
    })
    return this.toApiResponse(report)
  }

  getReport(reportId: string, context: CabinPassengerContext): HealthReportApiResponse {
    this.flushActiveReportById(reportId)
    const report = this.options.store.getHealthReport(reportId)
    if (!report) throw new Error('HEALTH_REPORT_NOT_FOUND')
    if (context.seatId && report.seatNo !== context.seatId) throw new Error('HEALTH_REPORT_FORBIDDEN')
    return this.toApiResponse(report)
  }

  handleWsEnvelope(envelope: unknown): void {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return
    const record = envelope as Record<string, unknown>
    if (record.type !== 'telemetry') return
    const content = parseContent(record.content)
    if (!content || content.topic !== 'health') return
    const seatNo = stringField(content, 'seatNo')
    if (!seatNo) return
    const active = this.findActiveReportForSample(content, seatNo)
    if (!active) {
      this.log('health_report.sample.ignored', { seat_no: seatNo, ignored_reason: 'no_active_report' })
      return
    }
    const report = this.options.store.getHealthReport(active.reportId)
    if (!report || report.status !== 'collecting') {
      this.log('health_report.sample.ignored', {
        report_id: active.reportId,
        seat_no: seatNo,
        ignored_reason: 'report_not_collecting',
      })
      return
    }
    const message = objectField(content, 'message')
    const sample = normalizeHealthSample(message)
    if (!sample) {
      this.log('health_report.sample.ignored', {
        report_id: active.reportId,
        seat_no: seatNo,
        ignored_reason: 'invalid_metric',
      })
      return
    }
    active.samples.push(sample)
    this.scheduleSampleFlush(active)
    if (active.samples.length - active.lastFlushedCount >= SAMPLE_FLUSH_BATCH_SIZE) {
      this.flushActiveReport(active)
    }
    if (active.samples.length === 1 || active.samples.length % 10 === 0) {
      this.log('health_report.sample.accepted', {
        report_id: active.reportId,
        seat_no: seatNo,
        flight_id: active.flightId,
        flight_date: active.flightDate,
        sample_count: active.samples.length,
        metrics: Object.fromEntries(METRIC_KEYS.map(key => [key, sample[key] !== undefined])),
      })
    }
  }

  private findActiveReportForSample(content: Record<string, unknown>, seatNo: string): ActiveReport | null {
    const aircraftNo = stringField(content, 'aircraftNo')
    const flightId = stringField(content, 'flightId', 'flight_id')
    const flightDate = stringField(content, 'flightDate', 'flight_date')
    const matches = Array.from(this.activeReportsByKey.values()).filter(active => {
      if (active.seatNo !== seatNo) return false
      if (aircraftNo && active.aircraftNo && active.aircraftNo !== aircraftNo) return false
      if (flightId && active.flightId !== flightId) return false
      if (flightDate && active.flightDate !== flightDate) return false
      return true
    })
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) {
      this.log('health_report.sample.ignored', {
        seat_no: seatNo,
        ignored_reason: 'ambiguous_active_report',
        active_report_count: matches.length,
      })
    }
    return null
  }

  private scheduleSampleFlush(active: ActiveReport): void {
    if (active.flushTimer) return
    active.flushTimer = setTimeout(() => {
      active.flushTimer = undefined
      this.flushActiveReport(active)
    }, SAMPLE_FLUSH_INTERVAL_MS)
    active.flushTimer.unref?.()
  }

  private flushActiveReportById(reportId: string): void {
    const active = Array.from(this.activeReportsByKey.values()).find(item => item.reportId === reportId)
    if (active) this.flushActiveReport(active)
  }

  private flushActiveReport(active: ActiveReport): void {
    if (active.samples.length === active.lastFlushedCount) return
    const updated = this.options.store.updateHealthReportSamples(active.reportId, active.samples)
    if (updated) active.lastFlushedCount = active.samples.length
  }

  private clearActiveTimers(active: ActiveReport): void {
    if (active.timer) clearTimeout(active.timer)
    if (active.flushTimer) clearTimeout(active.flushTimer)
    active.timer = undefined
    active.flushTimer = undefined
  }

  async finalizeReport(reportId: string, input: HealthReportLogContext = {}): Promise<HealthReportApiResponse> {
    this.flushActiveReportById(reportId)
    const report = this.options.store.getHealthReport(reportId)
    if (!report) throw new Error('HEALTH_REPORT_NOT_FOUND')
    if (report.status !== 'collecting') return this.toApiResponse(report)
    this.options.store.markHealthReportGenerating(reportId)
    this.removeActiveReport(report)
    this.log('health_report.finalize.start', {
      request_id: input.requestId,
      report_id: reportId,
      seat_no: report.seatNo,
      sample_count: report.sampleCount,
      report_status: 'generating',
    })

    const samples = report.samples || []
    const minSamples = this.options.config.healthReportMinSamples ?? 1
    if (samples.length < minSamples) {
      const failed = this.options.store.failHealthReport({
        reportId,
        errorCode: 'INSUFFICIENT_SAMPLES',
        errorMessage: '未采集到足够的有效生理检测数据，请重新检测。',
      })
      this.log('health_report.finalize.failed', {
        request_id: input.requestId,
        report_id: reportId,
        seat_no: report.seatNo,
        sample_count: samples.length,
        error_code: 'INSUFFICIENT_SAMPLES',
      })
      return this.toApiResponse(failed || this.options.store.getHealthReport(reportId)!)
    }

    const metrics = computeMetrics(samples)
    const deterministicSummary = buildSummary(metrics)
    const text = await this.generateModelText(metrics, deterministicSummary.score, report.language || 'zh', input)
    const summary: CabinHealthReportSummary = {
      ...deterministicSummary,
      ...text,
    }
    const completed = this.options.store.completeHealthReport({ reportId, metrics, summary })
    this.log('health_report.finalize.completed', {
      request_id: input.requestId,
      report_id: reportId,
      seat_no: report.seatNo,
      sample_count: samples.length,
      score: summary.score,
      metric_levels: summary.metricLevels,
      report_status: 'completed',
    })
    return this.toApiResponse(completed || this.options.store.getHealthReport(reportId)!)
  }

  private removeActiveReport(report: CabinHealthReport): void {
    const active = this.activeReportsByKey.get(activeReportKey(report))
    if (active?.reportId === report.id) {
      this.clearActiveTimers(active)
      this.activeReportsByKey.delete(activeReportKey(report))
    }
  }

  private async generateModelText(
    metrics: Record<CabinHealthMetricKey, CabinHealthMetricResult>,
    score: number,
    language: string,
    input: HealthReportLogContext,
  ): Promise<Pick<CabinHealthReportSummary, 'overview' | 'interpretations' | 'suggestions' | 'disclaimer'>> {
    const fallback = buildFallbackText(metrics)
    const url = `${this.options.config.llmBaseUrl.replace(/\/+$/, '')}/chat/completions`
    const prompt = [
      '你是客舱健康报告文案生成器。',
      '只输出严格 JSON，不要 Markdown，不要多余文本。',
      '只能包含 overview、interpretations、suggestions、disclaimer 四个字段。',
      '字段格式必须为：overview 字符串；interpretations 字符串数组；suggestions 字符串数组；disclaimer 字符串。',
      'interpretations 每项为一条分项解读文本，不要输出对象、嵌套结构或额外字段。',
      'suggestions 每项为一条建议文本，不要输出对象、嵌套结构或额外字段。',
      '不得修改、推断或重新计算任何指标值、等级、分数。',
      '不得输出诊断结论，只能给客舱健康状态辅助提示。',
      JSON.stringify({ metrics: compactMetrics(metrics), score, language }),
    ].join('\n')
    const start = Date.now()
    try {
      this.log('health_report.model.request', { request_id: input.requestId, url, model: this.options.config.llmModel })
      const response = await fetchWithTimeout(this.fetchImpl, url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.config.llmApiKey ? { authorization: `Bearer ${this.options.config.llmApiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.options.config.llmModel,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          stream: false,
        }),
      }, this.options.config.controlTimeoutMs ?? 10_000, 'health report model')
      const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
      const content = extractModelContent(payload)
      const parsed = parseModelJson(content)
      const validated = parsed.value ? validateModelText(parsed.value) : null
      this.log('health_report.model.response', {
        request_id: input.requestId,
        status: response.status,
        ok: response.ok && !!validated,
        elapsed_ms: Date.now() - start,
        model: this.options.config.llmModel,
        ...(!validated ? {
          invalid_reason: parsed.reason || 'schema_validation_failed',
          content_preview: typeof content === 'string' ? truncate(content, 400) : undefined,
        } : {}),
      })
      if (response.ok && validated) return validated
    } catch (error) {
      this.log('health_report.model.response', {
        request_id: input.requestId,
        ok: false,
        elapsed_ms: Date.now() - start,
        model: this.options.config.llmModel,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    this.log('health_report.model.fallback', { request_id: input.requestId, model: this.options.config.llmModel })
    return fallback
  }

  private toApiResponse(report: CabinHealthReport): HealthReportApiResponse {
    const base: HealthReportApiResponse = {
      status: 'ok',
      report_id: report.id,
      report_status: report.status,
      seat_no: report.seatNo,
      sample_count: report.sampleCount,
    }
    if (report.status === 'collecting' || report.status === 'generating') {
      return {
        ...base,
        progress: {
          duration_seconds: Math.max(1, Math.round((report.collectUntil - report.startedAt) / 1000)),
          elapsed_seconds: Math.max(0, Math.min(
            Math.round((Date.now() - report.startedAt) / 1000),
            Math.max(1, Math.round((report.collectUntil - report.startedAt) / 1000)),
          )),
          sample_count: report.sampleCount,
        },
        started_at: report.startedAt,
        estimated_completed_at: report.collectUntil,
      }
    }
    if (report.status === 'completed' && report.metrics && report.summary) {
      return {
        ...base,
        flight_id: report.flightId,
        flight_date: report.flightDate,
        generated_at: report.generatedAt,
        metrics: report.metrics,
        summary: {
          score: report.summary.score,
          score_level: report.summary.scoreLevel,
          emotion_status: report.summary.emotionStatus,
          physiology_status: report.summary.physiologyStatus,
          metric_levels: report.summary.metricLevels,
          overview: report.summary.overview,
          interpretations: report.summary.interpretations,
          suggestions: report.summary.suggestions,
          disclaimer: report.summary.disclaimer,
        },
      }
    }
    if (report.status === 'failed' || report.status === 'cancelled') {
      return {
        ...base,
        error_code: report.errorCode,
        error_message: report.errorMessage,
      }
    }
    return base
  }

  private log(event: string, details: Record<string, unknown>): void {
    this.options.logger?.log({
      type: 'outbound',
      upstream: 'health-report',
      method: event,
      ok: typeof details.ok === 'boolean' ? details.ok : !String(event).includes('failed'),
      elapsedMs: typeof details.elapsed_ms === 'number' ? details.elapsed_ms : 0,
      requestId: typeof details.request_id === 'string' ? details.request_id : undefined,
      tabletId: typeof details.tablet_id === 'string' ? details.tablet_id : undefined,
      details,
    })
  }
}

function extractModelContent(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const choices = (payload as Record<string, unknown>).choices
  if (!Array.isArray(choices)) return null
  const first = choices[0]
  if (!first || typeof first !== 'object' || Array.isArray(first)) return null
  const message = (first as Record<string, unknown>).message
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null
  const content = (message as Record<string, unknown>).content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && !Array.isArray(part)) {
          const record = part as Record<string, unknown>
          return typeof record.text === 'string' ? record.text : ''
        }
        return ''
      })
      .join('')
  }
  return content
}

function parseModelJson(content: unknown): { value: unknown | null; reason?: string } {
  if (!content) return { value: null, reason: 'empty_content' }
  if (typeof content === 'object' && !Array.isArray(content)) return { value: content }
  if (typeof content !== 'string') return { value: null, reason: `unsupported_content_type:${typeof content}` }
  const raw = content.trim()
  if (!raw) return { value: null, reason: 'empty_content' }
  const candidates = [raw]
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim()
  if (fenced) candidates.push(fenced)
  const objectStart = raw.indexOf('{')
  const objectEnd = raw.lastIndexOf('}')
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(raw.slice(objectStart, objectEnd + 1))
  for (const candidate of candidates) {
    try {
      return { value: JSON.parse(candidate) as unknown }
    } catch {
      // try the next representation
    }
  }
  return { value: null, reason: 'json_parse_failed' }
}

function parseContent(content: unknown): Record<string, unknown> | null {
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null
    } catch {
      return null
    }
  }
  return content && typeof content === 'object' && !Array.isArray(content)
    ? content as Record<string, unknown>
    : null
}

function objectField(input: unknown, key: string): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = (input as Record<string, unknown>)[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringField(input: unknown, ...keys: string[]): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const record = input as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return undefined
}

function numberField(input: unknown, key: string): number | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = (input as Record<string, unknown>)[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function normalizeHealthSample(message: Record<string, unknown> | null): HealthSample | null {
  if (!message) return null
  const sample: HealthSample = { received_at: Date.now() }
  const frameCount = numberField(message, 'frame_count')
  if (frameCount !== null) sample.frame_count = frameCount
  for (const key of METRIC_KEYS) {
    const value = numberField(message, key)
    if (value === null) continue
    const config = METRICS[key]
    if (value < config.min || value > config.max) continue
    sample[key] = value
  }
  return METRIC_KEYS.some(key => sample[key] !== undefined) ? sample : null
}

function activeReportKey(input: {
  aircraftNo?: string | null
  flightId: string
  flightDate: string
  seatNo: string
}): string {
  return [
    input.aircraftNo || '',
    input.flightId,
    input.flightDate,
    input.seatNo,
  ].join('|')
}

function computeMetrics(samples: Record<string, unknown>[]): Record<CabinHealthMetricKey, CabinHealthMetricResult> {
  const result = {} as Record<CabinHealthMetricKey, CabinHealthMetricResult>
  for (const key of METRIC_KEYS) {
    const config = METRICS[key]
    const values = samples
      .map(sample => typeof sample[key] === 'number' ? sample[key] as number : null)
      .filter((value): value is number => value !== null && value >= config.min && value <= config.max)
    const value = values.length
      ? round(values.reduce((sum, item) => sum + item, 0) / values.length, config.decimals)
      : null
    result[key] = {
      value,
      unit: config.unit,
      level: value === null ? 'missing' : metricLevel(value, config),
      range: {
        min: config.min,
        max: config.max,
        normal_min: config.normalMin,
        normal_max: config.normalMax,
      },
    }
  }
  return result
}

function metricLevel(value: number, config: { normalMin: number; normalMax: number }): CabinHealthMetricLevel {
  if (value < config.normalMin) return 'low'
  if (value > config.normalMax) return 'high'
  return 'normal'
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function buildSummary(metrics: Record<CabinHealthMetricKey, CabinHealthMetricResult>): Pick<CabinHealthReportSummary, 'score' | 'scoreLevel' | 'emotionStatus' | 'physiologyStatus' | 'metricLevels'> {
  const metricLevels = Object.fromEntries(METRIC_KEYS.map(key => [key, metrics[key].level])) as Record<CabinHealthMetricKey, CabinHealthMetricLevel>
  const score = calculateCustomerHealthScore(metrics)
  const scoreLevel = score >= 80 ? 'good' : score >= 60 ? 'pass' : 'fail'
  return {
    score,
    scoreLevel,
    emotionStatus: scoreLevel,
    physiologyStatus: METRIC_KEYS.every(key => metrics[key].level === 'normal') ? 'normal' : 'abnormal',
    metricLevels,
  }
}

function calculateCustomerHealthScore(metrics: Record<CabinHealthMetricKey, CabinHealthMetricResult>): number {
  const heartRate = metrics.heart_rate.value
  const respiratoryRate = metrics.respiratory_rate.value
  const spo2 = metrics.spo2.value
  const bodyTemperature = metrics.body_temperature.value
  let score =
    singleMetricScore(spo2, scoreSpo2) * 0.4
    + singleMetricScore(heartRate, scoreHeartRate) * 0.3
    + singleMetricScore(respiratoryRate, scoreRespiratoryRate) * 0.15
    + singleMetricScore(bodyTemperature, scoreBodyTemperature) * 0.15

  if (spo2 !== null && spo2 < 90) score = Math.min(score, 30)
  if (heartRate !== null && (heartRate > 150 || heartRate < 40)) score = Math.min(score, 35)
  return round(Math.max(0, Math.min(100, score)), 2)
}

function singleMetricScore(value: number | null, scorer: (value: number) => number): number {
  return value === null ? 0 : Math.max(0, Math.min(100, scorer(value)))
}

function scoreHeartRate(value: number): number {
  if (value >= 60 && value <= 100) return 100
  if (value > 100 && value <= 120) return 100 - ((value - 100) / 20) ** 2 * 40
  if (value > 120) return Math.max(10, 60 - ((value - 120) / 30) ** 2 * 50)
  if (value >= 50 && value < 60) return 100 - ((60 - value) / 10) ** 2 * 40
  return Math.max(10, 60 - ((50 - value) / 10) ** 2 * 50)
}

function scoreRespiratoryRate(value: number): number {
  if (value >= 16 && value <= 20) return 100
  if (value > 20 && value <= 24) return 100 - ((value - 20) / 4) ** 2 * 40
  if (value > 24) return Math.max(10, 60 - ((value - 24) / 6) ** 2 * 50)
  if (value >= 12 && value < 16) return 100 - ((16 - value) / 4) ** 2 * 40
  return Math.max(10, 60 - ((12 - value) / 4) ** 2 * 50)
}

function scoreSpo2(value: number): number {
  if (value >= 95 && value <= 100) return 100
  if (value > 100) return 100
  if (value >= 93 && value < 95) return 100 - ((95 - value) / 2) ** 2 * 40
  if (value >= 90 && value < 93) return 60 - ((93 - value) / 3) ** 2 * 50
  return Math.max(0, 10 - ((90 - value) / 5) * 10)
}

function scoreBodyTemperature(value: number): number {
  if (value >= 36.1 && value <= 37.2) return 100
  if (value > 37.2 && value <= 37.8) return 100 - ((value - 37.2) / 0.6) ** 2 * 40
  if (value > 37.8) return Math.max(10, 60 - ((value - 37.8) / 0.7) ** 2 * 50)
  if (value >= 35.5 && value < 36.1) return 100 - ((36.1 - value) / 0.6) ** 2 * 40
  return Math.max(10, 60 - ((35.5 - value) / 0.5) ** 2 * 50)
}

function compactMetrics(metrics: Record<CabinHealthMetricKey, CabinHealthMetricResult>): Record<string, unknown> {
  return Object.fromEntries(METRIC_KEYS.map(key => [key, {
    value: metrics[key].value,
    level: metrics[key].level,
    unit: metrics[key].unit,
  }]))
}

function validateModelText(input: unknown): Pick<CabinHealthReportSummary, 'overview' | 'interpretations' | 'suggestions' | 'disclaimer'> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  const overview = typeof record.overview === 'string' ? record.overview.trim() : ''
  const interpretations = normalizeTextList(record.interpretations)
  const suggestions = normalizeTextList(record.suggestions)
  const disclaimer = typeof record.disclaimer === 'string' ? record.disclaimer.trim() : ''
  if (!overview || !interpretations.length || !suggestions.length || !disclaimer) return null
  return { overview, interpretations, suggestions, disclaimer }
}

function normalizeTextList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter(item => typeof item === 'string' && item.trim())
      .map(item => String(item).trim())
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const orderedKeys = [
      ...METRIC_KEYS.filter(key => Object.prototype.hasOwnProperty.call(record, key)),
      ...Object.keys(record).filter(key => !METRIC_KEYS.includes(key as CabinHealthMetricKey)),
    ]
    return orderedKeys
      .map(key => record[key])
      .flatMap(item => normalizeTextList(item))
  }
  if (typeof value !== 'string' || !value.trim()) return []
  const text = value.trim()
  const parts = text
    .split(/(?:^|\s)[1-9]\d*[\.\u3001\)]\s*|[;\uff1b]\s*|\n+/)
    .map(item => item.trim().replace(/^[1-9]\d*[\.\u3001\)]\s*/, '').trim())
    .filter(Boolean)
  return parts.length ? parts : [text]
}

function buildFallbackText(metrics: Record<CabinHealthMetricKey, CabinHealthMetricResult>): Pick<CabinHealthReportSummary, 'overview' | 'interpretations' | 'suggestions' | 'disclaimer'> {
  const abnormal = METRIC_KEYS.filter(key => metrics[key].level !== 'normal')
  const names: Record<CabinHealthMetricKey, string> = {
    heart_rate: '心率',
    respiratory_rate: '呼吸率',
    spo2: '血氧饱和度',
    body_temperature: '体温',
  }
  const levelText: Record<CabinHealthMetricLevel, string> = {
    low: '偏低',
    normal: '正常',
    high: '偏高',
    invalid: '无效',
    missing: '缺失',
  }
  return {
    overview: abnormal.length
      ? `${abnormal.map(key => `${names[key]}${levelText[metrics[key].level]}`).join('，')}。`
      : '本次检测四项生理指标均在正常范围内。',
    interpretations: METRIC_KEYS.map(key => {
      const metric = metrics[key]
      return `${names[key]} ${metric.value ?? '--'} ${metric.unit}，${levelText[metric.level]}。`
    }),
    suggestions: abnormal.length
      ? ['建议先静坐休息 5-10 分钟后重新测量。', '如持续不适或指标继续异常，请联系乘务人员。']
      : ['建议保持放松，如有不适请及时联系乘务人员。'],
    disclaimer: '本报告仅用于客舱健康状态辅助提示，不作为医疗诊断依据。',
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value
}
