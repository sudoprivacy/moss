import { randomUUID } from 'node:crypto'
import { onlineCommandContext } from '../application/commandContext.js'
import type { IdentityActor } from '../identity/organizationIdentityService.js'
import type { DbDriver } from '../db/driver.js'
import type { CatalogArtifactKind, CatalogArtifactStore, StagedCatalogArtifact } from './catalogArtifactStore.js'
import type { CatalogRepository } from './catalogRepository.js'
import type { CatalogService } from './catalogService.js'

export interface CatalogArtifactPort {
  stage(input: {
    kind: CatalogArtifactKind
    orgId: string
    resourceId: string
    version: string
    bytes: Buffer
  }): Promise<StagedCatalogArtifact>
  publish(staged: StagedCatalogArtifact): Promise<void>
  discard(staged: StagedCatalogArtifact): Promise<void>
  read(filePath: string, expectedChecksum: string): Promise<Buffer>
}

export class CatalogUploadService {
  constructor(private readonly options: {
    db: DbDriver
    repository: CatalogRepository
    catalog: CatalogService
    artifacts: CatalogArtifactPort | CatalogArtifactStore
    publicBaseUrl: string
  }) {}

  async uploadAgent(input: {
    actor: IdentityActor
    name: string
    profession: string
    description?: string | null
    defaultInitPrompt?: string | null
    categories?: string[]
    skills?: string[]
    version?: string
    bytes: Buffer
    idempotencyKey: string
  }) {
    const prior = await this.options.repository.getCommandResult<{ resourceId: string }>(
      'catalog.create_agent', input.idempotencyKey,
    )
    if (prior) {
      const existing = await this.options.repository.getAgent(prior.resourceId, input.actor.orgId)
      if (existing) return existing
    }
    const id = randomUUID()
    const version = input.version?.trim() || '1.0.0'
    const staged = await this.options.artifacts.stage({
      kind: 'agent', orgId: input.actor.orgId, resourceId: id, version, bytes: input.bytes,
    })
    let created = false
    try {
      const agent = await this.options.catalog.createAgent({
        actor: input.actor,
        id,
        name: input.name,
        displayName: input.name,
        profession: input.profession,
        description: input.description,
        defaultInitPrompt: input.defaultInitPrompt,
        categories: input.categories,
        skills: input.skills,
        version,
        checksum: staged.checksum,
        filePath: staged.finalPath,
        sourceUrl: this.sourceUrl('agent', id),
        providerType: 'local',
        supportedModes: 'local',
      }, onlineCommandContext(input.idempotencyKey))
      if (agent.id !== id) {
        await this.options.artifacts.discard(staged)
        return agent
      }
      created = true
      await this.options.artifacts.publish(staged)
      return agent
    } catch (error) {
      if (created) await this.compensate('agent', id, input.actor.orgId, 'catalog.create_agent', input.idempotencyKey)
      await this.options.artifacts.discard(staged).catch(() => undefined)
      throw error
    }
  }

  async uploadSkill(input: {
    actor: IdentityActor
    name: string
    displayName: string
    description?: string | null
    category?: string | null
    categories?: string[]
    emoji?: string | null
    icon?: string | null
    homepage?: string | null
    applicableScenarios?: string | null
    coreFeatures?: string | null
    version?: string
    bytes: Buffer
    idempotencyKey: string
  }) {
    const prior = await this.options.repository.getCommandResult<{ resourceId: string }>(
      'catalog.create_skill', input.idempotencyKey,
    )
    if (prior) {
      const existing = await this.options.repository.getSkill(prior.resourceId, input.actor.orgId)
      if (existing) return existing
    }
    const id = randomUUID()
    const version = input.version?.trim() || '1.0.0'
    const staged = await this.options.artifacts.stage({
      kind: 'skill', orgId: input.actor.orgId, resourceId: id, version, bytes: input.bytes,
    })
    let created = false
    try {
      const skill = await this.options.catalog.createSkill({
        actor: input.actor,
        id,
        name: input.name,
        displayName: input.displayName,
        description: input.description,
        category: input.category,
        categories: input.categories,
        emoji: input.emoji,
        icon: input.icon,
        homepage: input.homepage,
        applicableScenarios: input.applicableScenarios,
        coreFeatures: input.coreFeatures,
        version,
        checksum: staged.checksum,
        filePath: staged.finalPath,
        sourceUrl: this.sourceUrl('skill', id),
        supportedModes: 'local',
      }, onlineCommandContext(input.idempotencyKey))
      if (skill.id !== id) {
        await this.options.artifacts.discard(staged)
        return skill
      }
      created = true
      await this.options.artifacts.publish(staged)
      return skill
    } catch (error) {
      if (created) await this.compensate('skill', id, input.actor.orgId, 'catalog.create_skill', input.idempotencyKey)
      await this.options.artifacts.discard(staged).catch(() => undefined)
      throw error
    }
  }

  readArtifact(filePath: string, checksum: string): Promise<Buffer> {
    return this.options.artifacts.read(filePath, checksum)
  }

  private sourceUrl(kind: CatalogArtifactKind, id: string): string {
    return `${this.options.publicBaseUrl.replace(/\/+$/, '')}/api/catalog/artifacts/${kind}/${encodeURIComponent(id)}`
  }

  private async compensate(
    kind: CatalogArtifactKind,
    id: string,
    orgId: string,
    commandType: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.options.db.transaction(async () => {
      if (kind === 'agent') await this.options.repository.deleteAgent(id, orgId)
      else await this.options.repository.deleteSkill(id, orgId)
      await this.options.repository.clearCommandResult(commandType, idempotencyKey)
    })
  }
}
