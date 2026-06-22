import { dcClient } from './client'

export interface CabinConversation {
  id: string
  passenger_id: string | null
  passenger_ref: string | null
  passenger_name: string | null
  flight_id: string
  flight_date: string
  seat_id: string | null
  tablet_id: string
  moss_session_id: string
  status: 'active' | 'reset'
  summary: string | null
  created_at: number
  updated_at: number
}

export interface CabinMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  source: 'text' | 'voice' | 'agent' | 'tool'
  content: string
  intent: string | null
  slots: Record<string, unknown> | null
  created_at: number
}

export interface CabinConversationListResponse {
  conversations: CabinConversation[]
  total: number
  limit: number
  offset: number
}

export interface CabinConversationDetailResponse {
  conversation: CabinConversation
  messages: CabinMessage[]
}

export function getCabinConversations(params: {
  flightId?: string
  flightDate?: string
  seatId?: string
  passenger?: string
  status?: 'active' | 'reset' | 'all'
  limit?: number
  offset?: number
}): Promise<CabinConversationListResponse> {
  const search = new URLSearchParams()
  if (params.flightId) search.set('flight_id', params.flightId)
  if (params.flightDate) search.set('flight_date', params.flightDate)
  if (params.seatId) search.set('seat_id', params.seatId)
  if (params.passenger) search.set('passenger', params.passenger)
  if (params.status && params.status !== 'all') search.set('status', params.status)
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  if (params.offset !== undefined) search.set('offset', String(params.offset))
  const query = search.toString()
  return dcClient.get<CabinConversationListResponse>(
    `/api/v1/cabin/conversations${query ? `?${query}` : ''}`,
  )
}

export function getCabinConversation(conversationId: string): Promise<CabinConversationDetailResponse> {
  return dcClient.get<CabinConversationDetailResponse>(
    `/api/v1/cabin/conversations/${encodeURIComponent(conversationId)}`,
  )
}
