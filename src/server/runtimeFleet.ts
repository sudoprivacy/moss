import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { totalmem } from 'node:os'
import pMap from 'p-map'
import { hasScope, type AuthContext } from './auth/token.js'
import { ResourceAccessError } from './catalog/resourceError.js'

export type RuntimeOwner = { orgId: string; orgName?: string; name: string; status: string }

export type RuntimeState = {
  isPresent: boolean
  isDrifted: boolean
  phase: string
  releaseId?: string | null
  upgradeLock?: { createdAt: string | null } | null
}

export type RuntimeAuditEvent = {
  /** Null when the controller acts on its own, e.g. retiring a disabled owner's runtime. */
  actor: AuthContext | null
  action: 'RUNTIME_UPGRADED' | 'RUNTIME_RETIRED' | 'RUNTIME_LOCK_RECOVERED' | 'RUNTIME_ROLLOUT_STARTED' | 'RUNTIME_ROLLOUT_FINISHED'
  ownerId: string | null
  /** The owner's organization, or the actor's for fleet-wide events. */
  orgId: string
  details?: Record<string, unknown>
}

export interface RuntimeFleetDependencies {
  /** Owners that currently have a Pod, one entry per allocation. */
  placements(): Promise<Array<{ ownerId: string }>>
  inspect(ownerId: string): Promise<RuntimeState>
  /** The owner's account in any status; null when no account exists. */
  owner(ownerId: string): Promise<RuntimeOwner | null>
  upgrade(ownerId: string, orgId: string): Promise<RuntimeState>
  /** Stop every allocation of an owner; true when a Pod was removed. */
  retire(ownerId: string, orgId: string | null): Promise<boolean>
  /** Remove upgrade locks an interrupted controller left behind; true when one was removed. */
  recoverLock(ownerId: string): Promise<boolean>
  /** Controller anonymous memory and host memory in bytes, or null when unobservable. */
  memory(): { used: number; total: number } | null
  audit(event: RuntimeAuditEvent): Promise<void>
  sleep?(milliseconds: number): Promise<void>
}

export type RuntimeRow = RuntimeState & {
  ownerId: string
  ownerName: string | null
  orgId: string | null
  orgName: string | null
  ownerStatus: string
  allocations: number
  canUpgrade: boolean
  canRetire: boolean
  canRecoverLock: boolean
}

type RolloutOutcome = 'pending' | 'upgraded' | 'busy' | 'failed'

export type RuntimeRollout = {
  id: string
  actorUserId: string
  startedAt: number
  finishedAt: number | null
  owners: Array<{ ownerId: string; ownerName: string; orgId: string; outcome: RolloutOutcome; error?: string; controllerMemory?: number | null }>
  stopped: { beforeOwnerId: string; controllerMemory: number | null } | null
}

/** Pacing that kept back-to-back upgrades from exhausting the controller host. */
export const ROLLOUT_MEMORY = { pause: 0.35, stop: 0.6, settleSeconds: 300 }

/** The controller service's anonymous memory from its cgroup, beside host memory. */
export function controllerMemory(): { used: number; total: number } | null {
  try {
    const group = readFileSync('/proc/self/cgroup', 'utf8').split('::', 2)[1]?.trim()
    if (!group) return null
    const anon = /^anon (\d+)$/m.exec(readFileSync(`/sys/fs/cgroup${group}/memory.stat`, 'utf8'))
    return anon ? { used: Number(anon[1]), total: totalmem() } : null
  } catch {
    return null
  }
}

/**
 * Owner runtimes as one fleet. Organization admins manage the owners in their
 * organization; the deployment's super admin sees every organization and runs
 * paced rollouts. Every change goes through the runtime's owner lock and is
 * recorded in the operation audit.
 */
export class RuntimeFleet {
  private rollout: RuntimeRollout | null = null
  private readonly reconciling = new Map<string, Promise<boolean>>()

  constructor(private readonly deps: RuntimeFleetDependencies) {}

  private static requireAdmin(auth: AuthContext, scope: 'org' | 'all'): void {
    if (!hasScope(auth.scopes, 'admin:settings')) throw new ResourceAccessError(403, 'Runtime management requires settings administration')
    if (scope === 'all' && auth.role !== 'super_admin') throw new ResourceAccessError(403, 'Every organization requires the platform administrator')
  }

  private static visible(auth: AuthContext, owner: RuntimeOwner | null): boolean {
    return auth.role === 'super_admin' || owner?.orgId === auth.orgId
  }

  async list(auth: AuthContext, scope: 'org' | 'all'): Promise<RuntimeRow[]> {
    RuntimeFleet.requireAdmin(auth, scope)
    const allocations = new Map<string, number>()
    for (const { ownerId } of await this.deps.placements()) allocations.set(ownerId, (allocations.get(ownerId) ?? 0) + 1)
    const rows = await pMap([...allocations], async ([ownerId, count]) => {
      const owner = await this.deps.owner(ownerId)
      if (scope === 'org' ? owner?.orgId !== auth.orgId : !RuntimeFleet.visible(auth, owner)) return null
      const state = await this.deps.inspect(ownerId)
      const isActive = owner?.status === 'active'
      return { ...state, ownerId, ownerName: owner?.name ?? null, orgId: owner?.orgId ?? null, orgName: owner?.orgName ?? null,
        ownerStatus: owner?.status ?? 'unknown', allocations: count,
        canUpgrade: isActive && state.isPresent && !state.upgradeLock,
        canRetire: !isActive && state.isPresent && !state.upgradeLock,
        canRecoverLock: Boolean(state.upgradeLock) } satisfies RuntimeRow
    }, { concurrency: 4 })
    return rows.filter(row => row !== null)
      .sort((left, right) => `${left.orgName ?? left.orgId}:${left.ownerName}`.localeCompare(`${right.orgName ?? right.orgId}:${right.ownerName}`))
  }

  private async manageable(auth: AuthContext, ownerId: string): Promise<RuntimeOwner | null> {
    RuntimeFleet.requireAdmin(auth, 'org')
    const owner = await this.deps.owner(ownerId)
    if (!RuntimeFleet.visible(auth, owner)) throw new ResourceAccessError(404, 'Runtime owner is not visible')
    return owner
  }

  /** Replace an active owner's runtime with the controller's release and resume their sessions. */
  async upgrade(auth: AuthContext, ownerId: string): Promise<{ runtime: RuntimeState }> {
    const owner = await this.manageable(auth, ownerId)
    if (owner?.status !== 'active') throw new ResourceAccessError(409, 'Agent owner is unavailable')
    const runtime = await this.deps.upgrade(ownerId, owner.orgId)
    await this.deps.audit({ actor: auth, action: 'RUNTIME_UPGRADED', ownerId, orgId: owner.orgId })
    return { runtime }
  }

  /** Stop a runtime its owner can no longer use. The owner's volume and identity remain. */
  async retire(auth: AuthContext, ownerId: string): Promise<{ isRetired: boolean }> {
    const owner = await this.manageable(auth, ownerId)
    if (owner?.status === 'active') throw new ResourceAccessError(409, 'An active owner keeps their runtime; disable the owner first')
    const isRetired = await this.deps.retire(ownerId, owner?.orgId ?? null)
    await this.deps.audit({ actor: auth, action: 'RUNTIME_RETIRED', ownerId, orgId: owner?.orgId ?? auth.orgId, details: { isRetired } })
    return { isRetired }
  }

  async recoverLock(auth: AuthContext, ownerId: string): Promise<{ isRecovered: boolean }> {
    const owner = await this.manageable(auth, ownerId)
    const isRecovered = await this.deps.recoverLock(ownerId)
    await this.deps.audit({ actor: auth, action: 'RUNTIME_LOCK_RECOVERED', ownerId, orgId: owner?.orgId ?? auth.orgId, details: { isRecovered } })
    return { isRecovered }
  }

  /** Retire the runtime of an owner whose account exists and is no longer active. */
  reconcileOwner(ownerId: string): Promise<boolean> {
    const pending = this.reconciling.get(ownerId)
    if (pending) return pending
    const next = (async () => {
      const owner = await this.deps.owner(ownerId)
      // An owner without an account may belong to another deployment's
      // directory; only the platform administrator retires it, explicitly.
      if (!owner || owner.status === 'active') return false
      const isRetired = await this.deps.retire(ownerId, owner?.orgId ?? null)
      if (isRetired) {
        await this.deps.audit({ actor: null, action: 'RUNTIME_RETIRED', ownerId, orgId: owner.orgId,
          details: { reason: `owner ${owner.status}` } })
      }
      return isRetired
    })().finally(() => this.reconciling.delete(ownerId))
    this.reconciling.set(ownerId, next)
    return next
  }

  async reconcile(): Promise<string[]> {
    const owners = [...new Set((await this.deps.placements()).map(placement => placement.ownerId))]
    const retired: string[] = []
    for (const ownerId of owners) if (await this.reconcileOwner(ownerId)) retired.push(ownerId)
    return retired
  }

  /** Active owners whose present runtime differs from the controller's release. */
  async plan(auth: AuthContext): Promise<RuntimeRow[]> {
    return (await this.list(auth, 'all')).filter(row => row.canUpgrade && row.isDrifted)
  }

  current(auth: AuthContext): RuntimeRollout | null {
    RuntimeFleet.requireAdmin(auth, 'all')
    return this.rollout
  }

  /**
   * Upgrade the reviewed owners one at a time. The caller confirms the exact
   * plan it showed; any change since then requires another review.
   */
  async startRollout(auth: AuthContext, reviewedOwnerIds: string[]): Promise<RuntimeRollout> {
    if (this.rollout && this.rollout.finishedAt === null) throw new ResourceAccessError(409, 'A runtime rollout is already running')
    const plan = await this.plan(auth)
    if (!plan.length) throw new ResourceAccessError(409, 'No runtime needs an upgrade')
    const planned = plan.map(row => row.ownerId).sort()
    if (planned.join('\n') !== [...new Set(reviewedOwnerIds)].sort().join('\n')) {
      throw new ResourceAccessError(409, 'The rollout plan changed; review it again')
    }
    // Another request may have started a rollout while this plan was read.
    if (this.rollout && this.rollout.finishedAt === null) throw new ResourceAccessError(409, 'A runtime rollout is already running')
    const rollout: RuntimeRollout = { id: randomUUID(), actorUserId: auth.userId, startedAt: Date.now(), finishedAt: null,
      owners: plan.map(row => ({ ownerId: row.ownerId, ownerName: row.ownerName ?? row.ownerId, orgId: row.orgId!, outcome: 'pending' })),
      stopped: null }
    this.rollout = rollout
    await this.deps.audit({ actor: auth, action: 'RUNTIME_ROLLOUT_STARTED', ownerId: null, orgId: auth.orgId,
      details: { rolloutId: rollout.id, owners: planned } })
    void this.run(auth, rollout)
    return rollout
  }

  private async settle(): Promise<{ settled: boolean; fraction: number | null }> {
    const deadline = Date.now() + ROLLOUT_MEMORY.settleSeconds * 1000
    for (;;) {
      const observed = this.deps.memory()
      if (!observed) return { settled: true, fraction: null }
      const fraction = Math.round(observed.used / observed.total * 1000) / 1000
      if (fraction < ROLLOUT_MEMORY.pause) return { settled: true, fraction }
      if (fraction >= ROLLOUT_MEMORY.stop || Date.now() >= deadline) return { settled: false, fraction }
      await (this.deps.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))))(5000)
    }
  }

  private async run(auth: AuthContext, rollout: RuntimeRollout): Promise<void> {
    try {
      for (const owner of rollout.owners) {
        const { settled, fraction } = await this.settle()
        if (!settled) {
          rollout.stopped = { beforeOwnerId: owner.ownerId, controllerMemory: fraction }
          break
        }
        owner.controllerMemory = fraction
        try {
          await this.deps.upgrade(owner.ownerId, owner.orgId)
          owner.outcome = 'upgraded'
        } catch (error) {
          owner.outcome = error instanceof ResourceAccessError && error.statusCode === 409 ? 'busy' : 'failed'
          owner.error = error instanceof Error ? error.message : String(error)
          continue
        }
        await this.deps.audit({ actor: auth, action: 'RUNTIME_UPGRADED', ownerId: owner.ownerId, orgId: owner.orgId,
          details: { rolloutId: rollout.id } }).catch(() => undefined)
      }
    } finally {
      rollout.finishedAt = Date.now()
      await this.deps.audit({ actor: auth, action: 'RUNTIME_ROLLOUT_FINISHED', ownerId: null, orgId: auth.orgId,
        details: { rolloutId: rollout.id, stopped: rollout.stopped,
          outcomes: Object.fromEntries(rollout.owners.map(owner => [owner.ownerId, owner.outcome])) } }).catch(() => undefined)
    }
  }
}
