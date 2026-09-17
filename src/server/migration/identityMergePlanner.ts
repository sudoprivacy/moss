export interface LegacyOrganizationIdentity {
  legacyId: number
  name: string
  code: string | null
  codeVerified: boolean
}

export interface LegacyProviderIdentity {
  provider: string
  issuer: string
  subject: string
}

export interface LegacyUserIdentity {
  legacyId: number
  enterpriseId: number
  username: string
  displayName: string | null
  phone: string | null
  phoneVerified: boolean
  email: string | null
  emailVerified: boolean
  passwordHash: string | null
  role: string
  status: string
  providerIdentity?: LegacyProviderIdentity | null
  providerIdentities?: LegacyProviderIdentity[]
}

export interface LegacyIdentitySnapshot {
  organizations: LegacyOrganizationIdentity[]
  users: LegacyUserIdentity[]
}

export interface TargetOrganizationIdentity {
  id: string
  code: string
  codeVerified: boolean
  name?: string
  legacyAlias?: number | null
}

export interface TargetUserIdentity {
  id: string
  orgId: string
  email: string | null
  emailVerified: boolean
  phone: string | null
  phoneVerified: boolean
  username?: string
  displayName?: string | null
  legacyAlias?: number | null
  providerIdentities: LegacyProviderIdentity[]
}

export interface TargetIdentitySnapshot {
  organizations: TargetOrganizationIdentity[]
  users: TargetUserIdentity[]
}

export interface ManualResolution {
  kind: 'organization' | 'user'
  sourceId: string
  targetId: string
}

export type IdentityMatchMethod = 'legacy_alias' | 'explicit' | 'verified_code' | 'provider' | 'verified_phone' | 'verified_email' | 'new'

export interface OrganizationMergeDecision {
  legacyId: number
  action: 'reuse' | 'create'
  targetId: string | null
  matchedBy: IdentityMatchMethod
}

export interface UserMergeDecision {
  legacyId: number
  enterpriseId: number
  action: 'reuse' | 'create'
  targetId: string | null
  targetOrgId: string | null
  matchedBy: IdentityMatchMethod
}

export type IdentityMergeIssueCode =
  | 'INVALID_MANUAL_RESOLUTION'
  | 'AMBIGUOUS_VERIFIED_CODE'
  | 'AMBIGUOUS_PROVIDER_IDENTITY'
  | 'AMBIGUOUS_VERIFIED_PHONE'
  | 'AMBIGUOUS_VERIFIED_EMAIL'
  | 'CROSS_ORGANIZATION_IDENTITY'
  | 'SOURCE_ORGANIZATION_MISSING'
  | 'TARGET_USER_REUSED'
  | 'NUMERIC_ALIAS_CONFLICT'
  | 'DETERMINISTIC_ID_CONFLICT'

export interface IdentityMergeIssue {
  code: IdentityMergeIssueCode
  resourceType: 'organization' | 'user'
  sourceId: string
  message: string
  candidateTargetIds: string[]
}

export interface IdentityMergePlan {
  status: 'ready' | 'blocked'
  organizations: OrganizationMergeDecision[]
  users: UserMergeDecision[]
  issues: IdentityMergeIssue[]
}

export class IdentityMergePlanner {
  constructor(private readonly target: TargetIdentitySnapshot) {}

  plan(source: LegacyIdentitySnapshot, resolutions: readonly ManualResolution[]): IdentityMergePlan {
    const issues: IdentityMergeIssue[] = []
    const manualOrganizations = resolutionMap(resolutions, 'organization', issues)
    const manualUsers = resolutionMap(resolutions, 'user', issues)
    const targetOrganizations = new Map(this.target.organizations.map(item => [item.id, item]))
    const targetUsers = new Map(this.target.users.map(item => [item.id, item]))

    const organizations = [...source.organizations]
      .sort((left, right) => left.legacyId - right.legacyId)
      .map(item => {
        const sourceId = String(item.legacyId)
        const explicit = manualOrganizations.get(sourceId)
        const aliasCandidates = this.target.organizations.filter(target => target.legacyAlias === item.legacyId)
        if (aliasCandidates.length === 1) {
          const target = aliasCandidates[0]!
          if (explicit && explicit !== target.id) {
            issue(issues, 'INVALID_MANUAL_RESOLUTION', 'organization', sourceId, '人工 Organization 映射与永久数字别名冲突', [target.id, explicit].sort())
          }
          return reuseOrganizationDecision(item.legacyId, target.id, 'legacy_alias')
        }
        if (aliasCandidates.length > 1) {
          issue(issues, 'NUMERIC_ALIAS_CONFLICT', 'organization', sourceId, '旧企业数字别名对应多个 Organization', aliasCandidates.map(target => target.id).sort())
          return createOrganizationDecision(item.legacyId)
        }
        if (explicit) {
          const target = targetOrganizations.get(explicit)
          if (!target) {
            issue(issues, 'INVALID_MANUAL_RESOLUTION', 'organization', sourceId, '人工 Organization 映射目标不存在', [explicit])
            return createOrganizationDecision(item.legacyId)
          }
          checkNumericAlias(issues, 'organization', sourceId, item.legacyId, target)
          return reuseOrganizationDecision(item.legacyId, explicit, 'explicit')
        }
        if (!item.codeVerified || !item.code?.trim()) return createOrganizationDecision(item.legacyId)
        const code = normalizeCode(item.code)
        const candidates = this.target.organizations
          .filter(target => target.codeVerified && normalizeCode(target.code) === code)
          .map(target => target.id)
          .sort()
        if (candidates.length === 1) {
          const target = targetOrganizations.get(candidates[0])!
          checkNumericAlias(issues, 'organization', sourceId, item.legacyId, target)
          return reuseOrganizationDecision(item.legacyId, candidates[0], 'verified_code')
        }
        if (candidates.length > 1) {
          issue(issues, 'AMBIGUOUS_VERIFIED_CODE', 'organization', sourceId, '已验证企业 code 对应多个 Organization', candidates)
        }
        return createOrganizationDecision(item.legacyId)
      })

    const organizationsByLegacyId = new Map(organizations.map(item => [item.legacyId, item]))
    for (const organization of organizations) {
      if (organization.action === 'create' && organization.targetId && targetOrganizations.has(organization.targetId)) {
        issue(issues, 'DETERMINISTIC_ID_CONFLICT', 'organization', String(organization.legacyId), '确定性 Organization ID 已被其他记录占用', [organization.targetId])
      }
    }
    const users = [...source.users]
      .sort((left, right) => left.legacyId - right.legacyId)
      .map(item => {
        const sourceId = String(item.legacyId)
        const organization = organizationsByLegacyId.get(item.enterpriseId)
        if (!organization) {
          issue(issues, 'SOURCE_ORGANIZATION_MISSING', 'user', sourceId, `旧用户引用不存在的企业 ${item.enterpriseId}`, [])
          return createUserDecision(item)
        }
        const targetOrgId = organization.targetId
        const explicit = manualUsers.get(sourceId)
        const aliasCandidates = this.target.users.filter(target => target.legacyAlias === item.legacyId)
        if (aliasCandidates.length === 1) {
          const targetUser = aliasCandidates[0]!
          if (explicit && explicit !== targetUser.id) {
            issue(issues, 'INVALID_MANUAL_RESOLUTION', 'user', sourceId, '人工 User 映射与永久数字别名冲突', [targetUser.id, explicit].sort())
          }
          if (!targetOrgId || targetUser.orgId !== targetOrgId) {
            issue(issues, 'CROSS_ORGANIZATION_IDENTITY', 'user', sourceId, '永久数字别名指向其他 Organization 的 User', [targetUser.id])
          }
          return reuseUserDecision(item, targetUser, 'legacy_alias')
        }
        if (aliasCandidates.length > 1) {
          issue(issues, 'NUMERIC_ALIAS_CONFLICT', 'user', sourceId, '旧用户数字别名对应多个 Moss User', aliasCandidates.map(target => target.id).sort())
          return createUserDecision(item, targetOrgId)
        }
        if (explicit) {
          const targetUser = targetUsers.get(explicit)
          if (!targetUser) {
            issue(issues, 'INVALID_MANUAL_RESOLUTION', 'user', sourceId, '人工 User 映射目标不存在', [explicit])
            return createUserDecision(item, targetOrgId)
          }
          if (targetOrgId && targetUser.orgId !== targetOrgId) {
            issue(issues, 'CROSS_ORGANIZATION_IDENTITY', 'user', sourceId, '人工 User 映射跨越 Organization', [explicit])
            return createUserDecision(item, targetOrgId)
          }
          checkNumericAlias(issues, 'user', sourceId, item.legacyId, targetUser)
          return reuseUserDecision(item, targetUser, 'explicit')
        }

        const sourceProviders = item.providerIdentities
          ?? (item.providerIdentity ? [item.providerIdentity] : [])
        const providerCandidates = sourceProviders.length > 0
          ? this.target.users.filter(target => sourceProviders.some(sourceIdentity => (
              target.providerIdentities.some(identity => sameProvider(identity, sourceIdentity))
            )))
          : []
        const provider = this.chooseCandidate(
          item, targetOrgId, providerCandidates, 'provider', 'AMBIGUOUS_PROVIDER_IDENTITY', issues,
        )
        if (provider) return provider
        if (providerCandidates.length > 0) return createUserDecision(item, targetOrgId)

        const phoneCandidates = item.phoneVerified && item.phone?.trim()
          ? this.target.users.filter(target => target.phoneVerified && normalizePhone(target.phone) === normalizePhone(item.phone))
          : []
        const phone = this.chooseCandidate(
          item, targetOrgId, phoneCandidates, 'verified_phone', 'AMBIGUOUS_VERIFIED_PHONE', issues,
        )
        if (phone) return phone
        if (phoneCandidates.length > 0) return createUserDecision(item, targetOrgId)

        const emailCandidates = item.emailVerified && item.email?.trim()
          ? this.target.users.filter(target => target.emailVerified && normalizeEmail(target.email) === normalizeEmail(item.email))
          : []
        const email = this.chooseCandidate(
          item, targetOrgId, emailCandidates, 'verified_email', 'AMBIGUOUS_VERIFIED_EMAIL', issues,
        )
        if (email) return email
        return createUserDecision(item, targetOrgId)
      })

    const assignedTargets = new Map<string, number>()
    for (const user of users) {
      if (user.action === 'create' && user.targetId && targetUsers.has(user.targetId)) {
        issue(issues, 'DETERMINISTIC_ID_CONFLICT', 'user', String(user.legacyId), '确定性 User ID 已被其他记录占用', [user.targetId])
      }
      if (user.action !== 'reuse' || !user.targetId) continue
      const prior = assignedTargets.get(user.targetId)
      if (prior !== undefined && prior !== user.legacyId) {
        issue(
          issues, 'TARGET_USER_REUSED', 'user', String(user.legacyId),
          `多个旧用户映射到同一 Moss User，已被旧用户 ${prior} 使用`, [user.targetId],
        )
      } else {
        assignedTargets.set(user.targetId, user.legacyId)
      }
    }

    return { status: issues.length === 0 ? 'ready' : 'blocked', organizations, users, issues }
  }

  private chooseCandidate(
    source: LegacyUserIdentity,
    targetOrgId: string | null,
    candidates: TargetUserIdentity[],
    matchedBy: Extract<IdentityMatchMethod, 'provider' | 'verified_phone' | 'verified_email'>,
    ambiguousCode: Extract<IdentityMergeIssueCode, `AMBIGUOUS_${string}`>,
    issues: IdentityMergeIssue[],
  ): UserMergeDecision | null {
    const ids = candidates.map(item => item.id).sort()
    if (candidates.length > 1) {
      issue(issues, ambiguousCode, 'user', String(source.legacyId), `${matchedBy} 对应多个 Moss User`, ids)
      return null
    }
    const candidate = candidates[0]
    if (!candidate) return null
    if (!targetOrgId || candidate.orgId !== targetOrgId) {
      issue(
        issues, 'CROSS_ORGANIZATION_IDENTITY', 'user', String(source.legacyId),
        `${matchedBy} 匹配到其他 Organization 的 User`, [candidate.id],
      )
      return null
    }
    checkNumericAlias(issues, 'user', String(source.legacyId), source.legacyId, candidate)
    return reuseUserDecision(source, candidate, matchedBy)
  }
}

function resolutionMap(
  resolutions: readonly ManualResolution[],
  kind: ManualResolution['kind'],
  issues: IdentityMergeIssue[],
): Map<string, string> {
  const result = new Map<string, string>()
  for (const resolution of resolutions.filter(item => item.kind === kind)) {
    const existing = result.get(resolution.sourceId)
    if (existing && existing !== resolution.targetId) {
      issue(issues, 'INVALID_MANUAL_RESOLUTION', kind, resolution.sourceId, '同一源记录存在多个不同人工映射', [existing, resolution.targetId].sort())
      continue
    }
    result.set(resolution.sourceId, resolution.targetId)
  }
  return result
}

function createOrganizationDecision(legacyId: number): OrganizationMergeDecision {
  return { legacyId, action: 'create', targetId: migrationIdentityId('organization', legacyId), matchedBy: 'new' }
}

function reuseOrganizationDecision(
  legacyId: number,
  targetId: string,
  matchedBy: Extract<IdentityMatchMethod, 'legacy_alias' | 'explicit' | 'verified_code'>,
): OrganizationMergeDecision {
  return { legacyId, action: 'reuse', targetId, matchedBy }
}

function createUserDecision(source: LegacyUserIdentity, targetOrgId: string | null = null): UserMergeDecision {
  return {
    legacyId: source.legacyId,
    enterpriseId: source.enterpriseId,
    action: 'create',
    targetId: migrationIdentityId('user', source.legacyId),
    targetOrgId,
    matchedBy: 'new',
  }
}

export function migrationIdentityId(kind: 'organization' | 'user', legacyId: number): string {
  const digest = createHash('sha256').update(`moss:sudowork:${kind}:${legacyId}`).digest('hex')
  const variant = ((Number.parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

function reuseUserDecision(
  source: LegacyUserIdentity,
  target: TargetUserIdentity,
  matchedBy: Extract<IdentityMatchMethod, 'legacy_alias' | 'explicit' | 'provider' | 'verified_phone' | 'verified_email'>,
): UserMergeDecision {
  return {
    legacyId: source.legacyId,
    enterpriseId: source.enterpriseId,
    action: 'reuse',
    targetId: target.id,
    targetOrgId: target.orgId,
    matchedBy,
  }
}

function issue(
  issues: IdentityMergeIssue[],
  code: IdentityMergeIssueCode,
  resourceType: IdentityMergeIssue['resourceType'],
  sourceId: string,
  message: string,
  candidateTargetIds: string[],
): void {
  issues.push({ code, resourceType, sourceId, message, candidateTargetIds })
}

function checkNumericAlias(
  issues: IdentityMergeIssue[],
  resourceType: IdentityMergeIssue['resourceType'],
  sourceId: string,
  legacyId: number,
  target: { id: string; legacyAlias?: number | null },
): void {
  if (target.legacyAlias !== undefined && target.legacyAlias !== null && target.legacyAlias !== legacyId) {
    issue(
      issues,
      'NUMERIC_ALIAS_CONFLICT',
      resourceType,
      sourceId,
      `目标资源已有不同数字别名 ${target.legacyAlias}`,
      [target.id],
    )
  }
}

function sameProvider(left: LegacyProviderIdentity, right: LegacyProviderIdentity): boolean {
  return left.provider === right.provider
    && left.issuer === right.issuer
    && left.subject === right.subject
}

function normalizeCode(value: string | null): string {
  return value?.trim().toUpperCase() ?? ''
}

function normalizePhone(value: string | null): string {
  return value?.replaceAll(/[^\d+]/g, '') ?? ''
}

function normalizeEmail(value: string | null): string {
  return value?.trim().toLowerCase() ?? ''
}
import { createHash } from 'node:crypto'
