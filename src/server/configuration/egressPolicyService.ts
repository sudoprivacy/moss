import {
  EgressPolicyRepository,
  parseEgressPolicy,
  policyApplicationStatus,
  type EgressPolicy,
  type EgressPolicyStatus,
} from '@sudo/egress-policy'

export interface EgressRuntimeTarget {
  ownerId: string
  organizationId: string
}
export interface EgressRuntimeReceipt {
  ownerId: string
  allocationId: string
  status?: EgressPolicyStatus
  error?: string
  isPresent: boolean
}

interface EgressRuntimeOperations {
  targets(organizationId?: string): Promise<EgressRuntimeTarget[]>
  observe(
    target: EgressRuntimeTarget,
    policy?: EgressPolicy,
  ): Promise<EgressRuntimeReceipt[]>
}

/** Authenticated routes select the scope; shared storage and runtime receipts stay independent. */
export class EgressPolicyService {
  private initialization?: Promise<void>

  constructor(
    private readonly repository: EgressPolicyRepository,
    private readonly runtimes: EgressRuntimeOperations,
  ) {}

  private async ready(): Promise<void> {
    this.initialization ??= this.repository.initialize().catch((error) => {
      this.initialization = undefined
      throw error
    })
    await this.initialization
  }

  async policy(organizationId?: string): Promise<EgressPolicy> {
    await this.ready()
    return this.repository.get(organizationId)
  }

  async view(organizationId?: string, isApply = false) {
    const policy = await this.policy(organizationId)
    const targets = await this.runtimes.targets(organizationId)
    const receipts: Array<
      EgressRuntimeReceipt & ReturnType<typeof policyApplicationStatus>
    > = []
    // Bound control-plane work independently of the number of organizations.
    for (let offset = 0; offset < targets.length; offset += 4) {
      const rows = await Promise.all(
        targets.slice(offset, offset + 4).map(async (target) => {
          const desired = await this.policy(target.organizationId)
          const actual = await this.runtimes.observe(
            target,
            isApply ? desired : undefined,
          )
          return actual.map((receipt) => ({
            ...receipt,
            ...policyApplicationStatus(desired, receipt.status),
            ...(receipt.error ? { state: 'error' as const } : {}),
          }))
        }),
      )
      receipts.push(...rows.flat())
    }
    return {
      scopeType: organizationId ? 'organization' : 'platform',
      organizationId,
      policy,
      isInherited: organizationId
        ? !(await this.repository.hasOverride(organizationId))
        : false,
      runtimes: receipts,
    }
  }

  async save(
    organizationId: string | undefined,
    input: unknown,
    expectedRevision: number,
    actorId: string,
  ) {
    await this.ready()
    await this.repository.put(
      organizationId,
      parseEgressPolicy(input),
      expectedRevision,
      actorId,
    )
    return this.view(organizationId, true)
  }

  async inherit(organizationId: string, expectedRevision: number) {
    await this.ready()
    await this.repository.inherit(organizationId, expectedRevision)
    return this.view(organizationId, true)
  }
}
