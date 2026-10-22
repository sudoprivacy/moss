/** Moss administration DTOs; these are not Agent execution protocol fields. */
export interface EndpointRequest {
  id: string
  endpoint: string
  status: 'pending' | 'approved' | 'rejected'
  revision: number
  requested_by: string
  requested_at: number
  reason: string
  reviewed_by: string | null
  reviewed_at: number | null
  review_note: string | null
}
export interface EndpointRequestsPage {
  items: EndpointRequest[]
  next_cursor: string | null
}
