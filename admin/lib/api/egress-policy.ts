import type { EgressPolicy, EgressPolicyStatus } from '@sudo/egress-policy'
import { authClient } from './client'
import type { ConfigScope } from './types'

export interface EgressPolicyView {
  scopeType: ConfigScope
  organizationId?: string
  policy: EgressPolicy
  isInherited: boolean
  runtimes: Array<{
    ownerId: string
    allocationId: string
    isPresent: boolean
    state: 'pending' | 'error' | 'applied'
    desiredRevision: number
    appliedRevision: number | null
    status?: EgressPolicyStatus
    error?: string
  }>
}

export function getEgressPolicy(scope: ConfigScope): Promise<EgressPolicyView> {
  return authClient.get(`/api/v1/settings/egress?scope=${scope}`)
}
export function saveEgressPolicy(
  scope: ConfigScope,
  policy: EgressPolicy,
): Promise<EgressPolicyView> {
  return authClient.put(`/api/v1/settings/egress?scope=${scope}`, {
    policy,
    expectedRevision: policy.revision,
  })
}
export function applyEgressPolicy(
  scope: ConfigScope,
): Promise<EgressPolicyView> {
  return authClient.post(`/api/v1/settings/egress/apply?scope=${scope}`)
}
export function inheritEgressPolicy(
  expectedRevision: number,
): Promise<EgressPolicyView> {
  return authClient.post(`/api/v1/settings/egress/inherit?scope=organization`, {
    expectedRevision,
  })
}
