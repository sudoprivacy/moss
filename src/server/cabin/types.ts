import type { ServerConfig } from '../types.js'

export type CabinConfig = ServerConfig['cabin']

export type CabinPassengerContext = {
  passengerId?: string
  passengerRef?: string
  passengerName?: string
  passengerGender?: string
  passengerTitle?: string
  flightId: string
  flightDate: string
  flightNo?: string
  flightSeatId?: string
  aircraftSeatId?: string
  aircraftId?: string
  aircraftNo?: string
  seatId?: string
  columnNo?: string
  tabletId: string
  tabletToken?: string
  tabletType?: string
  bindingId?: string
  contextStatus?: string
  language?: string
}

export type CabinMessageRole = 'user' | 'assistant' | 'system'
export type CabinMessageSource = 'text' | 'voice' | 'agent' | 'tool'

export type CabinConversation = {
  id: string
  conversationKey: string
  passengerId: string | null
  passengerRef: string | null
  passengerName: string | null
  flightId: string
  flightDate: string
  seatId: string | null
  tabletId: string
  mossSessionId: string
  status: 'active' | 'reset'
  summary: string | null
  createdAt: number
  updatedAt: number
}

export type CabinMessage = {
  id: string
  conversationId: string
  role: CabinMessageRole
  source: CabinMessageSource
  content: string
  intent: string | null
  slots: Record<string, unknown> | null
  toolCalls: CabinToolCall[] | null
  createdAt: number
}

export type CabinToolCall = {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type CabinManagedSeat = {
  id: string
  aircraftNo: string | null
  flightId: string
  flightDate: string
  seatNo: string
  columnNo: string | null
  flightSeatId: string | null
  aircraftSeatId: string | null
  tabletId: string | null
  tabletType: string | null
  status: 'active' | 'inactive'
  lastSeenAt: number
  createdAt: number
  updatedAt: number
}

export type CabinAlert = {
  id: string
  aircraftNo: string | null
  flightId: string
  flightDate: string | null
  phaseCode: number | null
  phaseName: string
  seatNo: string | null
  alertType: string
  severity: 'info' | 'warning' | 'critical'
  message: string
  status: 'active' | 'resolved'
  sourceEventId: string | null
  details: Record<string, unknown> | null
  createdAt: number
  resolvedAt: number | null
}

export type CabinHealthReportStatus = 'collecting' | 'generating' | 'completed' | 'failed' | 'cancelled' | 'expired'

export type CabinHealthMetricLevel = 'low' | 'normal' | 'high' | 'invalid' | 'missing'

export type CabinHealthMetricKey = 'heart_rate' | 'respiratory_rate' | 'spo2' | 'body_temperature'

export type CabinHealthMetricResult = {
  value: number | null
  unit: string
  level: CabinHealthMetricLevel
  range: {
    min: number
    max: number
    normal_min: number
    normal_max: number
  }
}

export type CabinHealthReportSummary = {
  score: number
  scoreLevel: 'good' | 'pass' | 'fail'
  physiologyStatus: 'normal' | 'abnormal' | 'unknown'
  metricLevels: Record<CabinHealthMetricKey, CabinHealthMetricLevel>
  overview: string
  interpretations: string[]
  suggestions: string[]
  disclaimer: string
}

export type CabinHealthReport = {
  id: string
  aircraftNo: string | null
  flightId: string
  flightDate: string
  seatNo: string
  tabletId: string | null
  passengerId: string | null
  passengerRef: string | null
  status: CabinHealthReportStatus
  language: string | null
  sampleCount: number
  samples: Record<string, unknown>[] | null
  metrics: Record<CabinHealthMetricKey, CabinHealthMetricResult> | null
  summary: CabinHealthReportSummary | null
  errorCode: string | null
  errorMessage: string | null
  cancelledAt: number | null
  startedAt: number
  collectUntil: number
  generatedAt: number | null
  createdAt: number
  updatedAt: number
}

export type CabinTokenPayload = {
  tabletToken: string
  tabletId: string
  seatNo?: string
  columnNo?: string
  flightSeatId?: string
  aircraftSeatId?: string
  aircraftId?: string
  aircraftNo?: string
  tabletType?: string
  bindingId?: string
  contextStatus?: string
  passengerGender?: string
  passengerTitle?: string
  issuedAt: number
  expiresAt: number
}
