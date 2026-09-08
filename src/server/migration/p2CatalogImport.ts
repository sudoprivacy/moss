import type { DatabaseSync } from 'node:sqlite'
import { migrationCommandContext } from '../application/commandContext.js'
import type { IdentityActor } from '../identity/organizationIdentityService.js'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'
import type { CatalogArtifactPort } from '../catalog/catalogUploadService.js'
import type { CatalogRepository } from '../catalog/catalogRepository.js'
import type { CatalogService } from '../catalog/catalogService.js'

type ImportedAgent = Omit<
  Parameters<CatalogService['importAgent']>[0],
  'actor' | 'orgId' | 'filePath' | 'sourceUrl' | 'checksum'
> & { checksum?: string | null }

type ImportedSkill = Omit<
  Parameters<CatalogService['importSkill']>[0],
  'actor' | 'orgId' | 'filePath' | 'sourceUrl' | 'checksum'
> & { checksum?: string | null }

export class P2CatalogImportError extends Error {
  constructor(readonly code: 'CHECKSUM_MISMATCH', message: string) {
    super(message)
    this.name = 'P2CatalogImportError'
  }
}

export class P2CatalogImportService {
  constructor(private readonly options: {
    db: DatabaseSync
    repository: CatalogRepository
    catalog: CatalogService
    artifacts: CatalogArtifactPort
    publicBaseUrl: string
  }) {}

  importAgent(input: {
    migrationRunId: string
    actor: IdentityActor
    orgId: string
    resource: ImportedAgent
    bytes: Buffer
  }) {
    return this.importArtifact('agent', input)
  }

  importSkill(input: {
    migrationRunId: string
    actor: IdentityActor
    orgId: string
    resource: ImportedSkill
    bytes: Buffer
  }) {
    return this.importArtifact('skill', input)
  }

  readArtifact(filePath: string, checksum: string): Promise<Buffer> {
    return this.options.artifacts.read(filePath, checksum)
  }

  private async importArtifact<T extends 'agent' | 'skill'>(
    kind: T,
    input: {
      migrationRunId: string
      actor: IdentityActor
      orgId: string
      resource: T extends 'agent' ? ImportedAgent : ImportedSkill
      bytes: Buffer
    },
  ) {
    const externalIdentity = input.resource.externalIdentity
    const providerId = externalIdentity?.providerId ?? 'default'
    const externalId = externalIdentity?.externalId ?? input.resource.id
    const commandType = `catalog.import_${kind}`
    const idempotencyKey = `p2:${kind}:${providerId}:${externalId}`
    const previous = this.options.repository.getCommandResult<{ resourceId: string }>(commandType, idempotencyKey)
    if (previous) {
      const existing = kind === 'agent'
        ? this.options.repository.getAgent(previous.resourceId, input.orgId)
        : this.options.repository.getSkill(previous.resourceId, input.orgId)
      if (existing) return existing
    }

    const staged = await this.options.artifacts.stage({
      kind,
      orgId: input.orgId,
      resourceId: input.resource.id,
      version: input.resource.version?.trim() || '1.0.0',
      bytes: input.bytes,
    })
    if (input.resource.checksum && normalizeChecksum(input.resource.checksum) !== staged.checksum) {
      await this.options.artifacts.discard(staged)
      throw new P2CatalogImportError('CHECKSUM_MISMATCH', `历史 ${kind} 制品 checksum 不一致`)
    }

    let created = false
    try {
      const common = {
        ...input.resource,
        actor: input.actor,
        orgId: input.orgId,
        checksum: staged.checksum,
        filePath: staged.finalPath,
        sourceUrl: this.sourceUrl(kind, input.resource.id),
      }
      const context = migrationCommandContext(input.migrationRunId, idempotencyKey)
      const resource = kind === 'agent'
        ? this.options.catalog.importAgent(common as Parameters<CatalogService['importAgent']>[0], context)
        : this.options.catalog.importSkill(common as Parameters<CatalogService['importSkill']>[0], context)
      created = true
      await this.options.artifacts.publish(staged)
      return resource
    } catch (error) {
      if (created) {
        runInTransaction(this.options.db, () => {
          if (kind === 'agent') this.options.repository.deleteAgent(input.resource.id, input.orgId)
          else this.options.repository.deleteSkill(input.resource.id, input.orgId)
          this.options.repository.clearCommandResult(commandType, idempotencyKey)
        })
      }
      await this.options.artifacts.discard(staged).catch(() => undefined)
      throw error
    }
  }

  private sourceUrl(kind: 'agent' | 'skill', id: string): string {
    return `${this.options.publicBaseUrl.replace(/\/+$/, '')}/api/catalog/artifacts/${kind}/${encodeURIComponent(id)}`
  }
}

function normalizeChecksum(value: string): string {
  return value.trim().toLowerCase().replace(/^sha256:/, '')
}
