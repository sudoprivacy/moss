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
