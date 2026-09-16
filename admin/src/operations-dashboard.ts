type Json = Record<string, unknown>

export interface OperationsSummary {
  organizations: number
  users: number
  pendingUsers: number
  points: number
  todayRechargeUsd: number
  todayOrders: number
  pendingOrders: number
  qualitySuccessRate: number
  conversations: number
}

export function buildOperationsSummary(identity: Json, billing: Json, quality: Json): OperationsSummary {
  const points = object(identity.points)
  const today = object(billing.today)
  const total = object(billing.total)
  return {
    organizations: number(identity.enterprises), users: number(identity.users), pendingUsers: number(identity.pending),
    points: number(points.total), todayRechargeUsd: number(today.amount_usd), todayOrders: number(today.orders),
    pendingOrders: number(total.pending_count), qualitySuccessRate: number(quality.success_rate),
    conversations: number(quality.total_conversations),
  }
}

function object(value: unknown): Json { return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {} }
function number(value: unknown): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0 }
