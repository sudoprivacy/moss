import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  assertTrustedCommandContext,
  migrationCommandContext,
  onlineCommandContext,
  replayCommandContext,
  type CommandContext,
} from '../application/commandContext.js'
import { runInTransaction } from '../storage/sqliteUnitOfWork.js'
import type { DifyOrganizationContext } from './difyConnectionService.js'
import { DifyHttpAdapter, DifyProviderError } from './difyHttpAdapter.js'
import { DifyRepository, type DifyProviderOperation } from './difyRepository.js'

interface OrganizationConnectionResolver {
  resolveOrganizationContext(orgId: string): Promise<DifyOrganizationContext>
}

interface DatasetInput {
  name: string
  description?: string
  indexingTechnique?: string
  permission?: string
}

interface TextDocumentInput {
  name: string
  text: string
  indexingTechnique?: string
}

interface FileDocumentInput {
  fileName: string
  contentType: string
  bytes: Uint8Array | ArrayBuffer | Blob
  indexingTechnique?: string
}

type JsonObject = Record<string, unknown>

export class DifyDatasetService {
  private readonly idFactory: () => string

  constructor(private readonly options: {
    db: DatabaseSync
    repository: DifyRepository
    adapter: DifyHttpAdapter
    connections: OrganizationConnectionResolver
    ensureConnection?: (orgId: string, context: CommandContext) => Promise<unknown>
    idFactory?: () => string
  }) {
    this.idFactory = options.idFactory ?? randomUUID
  }

  async list(orgId: string, paging: { page?: number; limit?: number; keyword?: string }): Promise<unknown> {
    return await this.read(orgId, 'GET', `/v1/datasets${queryString(paging)}`, undefined, 'list datasets failed')
  }

  async get(orgId: string, datasetId: string): Promise<unknown> {
    return await this.read(orgId, 'GET', `/v1/datasets/${segment(datasetId)}`, undefined, 'get dataset failed')
  }

  async create(orgId: string, input: DatasetInput, context: CommandContext): Promise<unknown> {
    const body: JsonObject = {
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.indexingTechnique !== undefined ? { indexing_technique: input.indexingTechnique } : {}),
      permission: input.permission ?? 'all_team_members',
    }
    return await this.write(orgId, 'dataset.create', 'new', body, context, async connection => {
      const result = await this.options.adapter.serviceJson(connection.apiKey, 'POST', '/v1/datasets', body, undefined, 'create dataset failed')
      const dataset = objectValue(result)
      const externalId = stringValue(dataset.id)
      if (!externalId) throw new Error('Dify dataset create response is missing id')
      return {
        response: result,
        result: operationResult(result, { externalId }),
        finalize: () => this.options.repository.putResource({
          id: this.idFactory(), orgId, connectionId: connection.connectionId,
          resourceType: 'dataset', externalId, metadata: datasetMetadata(dataset),
        }),
      }
    })
  }

  async update(orgId: string, datasetId: string, input: Partial<DatasetInput>, context: CommandContext): Promise<unknown> {
    const body: JsonObject = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.indexingTechnique !== undefined ? { indexing_technique: input.indexingTechnique } : {}),
      ...(input.permission !== undefined ? { permission: input.permission } : {}),
    }
    return await this.write(orgId, 'dataset.update', datasetId, body, context, async connection => {
      const result = await this.options.adapter.serviceJson(
        connection.apiKey, 'PATCH', `/v1/datasets/${segment(datasetId)}`, body, undefined, 'update dataset failed',
      )
      const dataset = objectValue(result)
      return {
        response: result,
        result: operationResult(result, { externalId: datasetId }),
        finalize: () => {
          const existing = this.options.repository.getResourceByExternalId(
            orgId, connection.connectionId, 'dataset', datasetId,
          )
          this.options.repository.putResource({
            id: existing?.id ?? this.idFactory(), orgId, connectionId: connection.connectionId,
            resourceType: 'dataset', externalId: datasetId,
            metadata: { ...(existing?.metadata ?? {}), ...datasetMetadata(dataset) },
          })
        },
      }
    })
  }

  async delete(orgId: string, datasetId: string, context: CommandContext): Promise<unknown> {
    return await this.write(orgId, 'dataset.delete', datasetId, {}, context, async connection => {
      const response = await this.options.adapter.serviceJson(
        connection.apiKey, 'DELETE', `/v1/datasets/${segment(datasetId)}`, undefined, undefined, 'delete dataset failed',
      )
      return {
        response,
        result: operationResult(response, { externalId: datasetId }),
        finalize: () => this.options.repository.deleteResource(orgId, 'dataset', datasetId),
      }
    })
  }

  async listDocuments(
    orgId: string,
    datasetId: string,
    paging: { page?: number; limit?: number; keyword?: string },
  ): Promise<unknown> {
    return await this.read(
      orgId, 'GET', `/v1/datasets/${segment(datasetId)}/documents${queryString(paging)}`,
      undefined, 'list documents failed',
    )
  }

  async createDocumentByText(
    orgId: string,
    datasetId: string,
    input: TextDocumentInput,
    context: CommandContext,
  ): Promise<unknown> {
    const body = {
      indexing_technique: input.indexingTechnique ?? 'economy',
      process_rule: { mode: 'automatic' },
      name: input.name,
      text: input.text,
    }
    return await this.write(orgId, 'document.create_by_text', datasetId, body, context, async connection => {
      const response = await this.options.adapter.serviceJson(
        connection.apiKey, 'POST', `/v1/datasets/${segment(datasetId)}/document/create-by-text`, body,
        undefined, 'create-by-text failed',
      )
      return { response, result: operationResult(response, providerDocumentResult(response)) }
    })
  }

  async createDocumentByFile(
    orgId: string,
    datasetId: string,
    input: FileDocumentInput,
    context: CommandContext,
  ): Promise<unknown> {
    const data = {
      indexing_technique: input.indexingTechnique ?? 'economy',
      process_rule: { mode: 'automatic' },
    }
    const request = { ...data, fileName: input.fileName, contentType: input.contentType }
    return await this.write(orgId, 'document.create_by_file', datasetId, request, context, async connection => {
      const response = await this.options.adapter.serviceMultipart(
        connection.apiKey,
        `/v1/datasets/${segment(datasetId)}/document/create-by-file`,
        {
          fields: { data: JSON.stringify(data) },
          file: {
            fileName: input.fileName, contentType: input.contentType, bytes: input.bytes,
          },
        },
        'create-by-file failed',
      )
      return { response, result: operationResult(response, providerDocumentResult(response)) }
    })
  }

  async deleteDocument(
    orgId: string,
    datasetId: string,
    documentId: string,
    context: CommandContext,
  ): Promise<unknown> {
    return await this.write(orgId, 'document.delete', documentId, { datasetId }, context, async connection => {
      const response = await this.options.adapter.serviceJson(
        connection.apiKey,
        'DELETE',
        `/v1/datasets/${segment(datasetId)}/documents/${segment(documentId)}`,
        undefined,
        undefined,
        'delete document failed',
      )
      return { response, result: operationResult(response, { externalId: documentId }) }
    })
  }

  async retrieve(orgId: string, datasetId: string, input: {
    query: string
    retrievalModel?: Record<string, unknown>
  }): Promise<unknown> {
    return await this.read(orgId, 'POST', `/v1/datasets/${segment(datasetId)}/retrieve`, {
      query: input.query,
      retrieval_model: input.retrievalModel ?? {
        search_method: 'semantic_search', top_k: 5, reranking_enable: false,
        score_threshold_enabled: false,
      },
    })
  }

  private async read(
    orgId: string,
    method: 'GET' | 'POST',
    path: string,
    body?: JsonObject,
    providerErrorMessage?: string,
  ): Promise<unknown> {
    await this.options.ensureConnection?.(
      orgId,
      onlineCommandContext(`dify:dataset:auto-provision:${orgId}`),
    )
    const connection = await this.options.connections.resolveOrganizationContext(orgId)
    return await this.options.adapter.serviceJson(
      connection.apiKey, method, path, body, undefined, providerErrorMessage,
    )
  }

  private async write(
    orgId: string,
    operationType: string,
    aggregateId: string,
    request: JsonObject,
    context: CommandContext,
    invoke: (connection: DifyOrganizationContext) => Promise<{
      response: unknown
      result: JsonObject
      finalize?: () => unknown
    }>,
  ): Promise<unknown> {
    assertTrustedCommandContext(context)
    await this.options.ensureConnection?.(orgId, childCommandContext(context, 'tenant'))
    const prepared = runInTransaction(this.options.db, () => {
      const existing = this.options.repository.getOperationByIdempotencyKey(context.idempotencyKey)
      if (existing) {
        if (existing.orgId !== orgId
          || existing.operationType !== operationType
          || existing.aggregateId !== aggregateId
          || JSON.stringify(existing.request) !== JSON.stringify(request)) {
          throw new Error('idempotency key already used for a different Dify command')
        }
        return { operation: existing, created: existing.status === 'FAILED' }
      }
      const operation = this.options.repository.createOperation({
        id: `dify-operation:${context.idempotencyKey}`, orgId, operationType, aggregateId,
        idempotencyKey: context.idempotencyKey,
        status: context.externalEffects === 'suppress_external' ? 'SUPPRESSED' : 'PENDING',
        request, contextSource: context.source,
      })
      return { operation, created: true }
    })

    if (!prepared.created) return replayResult(prepared.operation)
    if (prepared.operation.status === 'SUPPRESSED') return { suppressed: true }

    runInTransaction(this.options.db, () => this.options.repository.updateOperation(prepared.operation.id, {
      status: 'PROCESSING', attempts: prepared.operation.attempts + 1,
    }))

    try {
      const connection = await this.options.connections.resolveOrganizationContext(orgId)
      const invoked = await invoke(connection)
      try {
        runInTransaction(this.options.db, () => {
          invoked.finalize?.()
          this.options.repository.updateOperation(prepared.operation.id, {
            status: 'SUCCEEDED', result: invoked.result, errorMessage: null,
          })
        })
      } catch (error) {
        runInTransaction(this.options.db, () => this.options.repository.updateOperation(prepared.operation.id, {
          status: 'UNKNOWN', errorMessage: errorMessage(error),
        }))
        throw error
      }
      return invoked.response
    } catch (error) {
      const current = this.options.repository.getOperation(prepared.operation.id)
      if (current?.status !== 'UNKNOWN') {
        runInTransaction(this.options.db, () => this.options.repository.updateOperation(prepared.operation.id, {
          status: error instanceof DifyProviderError ? 'FAILED' : 'UNKNOWN',
          errorMessage: errorMessage(error),
        }))
      }
      throw error
    }
  }
}

function queryString(input: { page?: number; limit?: number; keyword?: string }): string {
  const query = new URLSearchParams()
  if (input.page !== undefined) query.set('page', String(input.page))
  if (input.limit !== undefined) query.set('limit', String(input.limit))
  if (input.keyword !== undefined) query.set('keyword', input.keyword)
  const value = query.toString()
  return value ? `?${value}` : ''
}

function segment(value: string): string {
  return encodeURIComponent(value)
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function datasetMetadata(dataset: JsonObject): JsonObject {
  return Object.fromEntries(
    ['name', 'description', 'permission', 'indexing_technique', 'created_at', 'updated_at']
      .flatMap(key => dataset[key] === undefined ? [] : [[key, dataset[key]]]),
  )
}

function providerDocumentResult(response: unknown): JsonObject {
  const document = objectValue(objectValue(response).document)
  const externalId = stringValue(document.id)
  return externalId ? { externalId } : {}
}

function operationResult(response: unknown, recovery: JsonObject): JsonObject {
  return { response: objectValue(response), ...recovery }
}

function replayResult(operation: DifyProviderOperation): unknown {
  if (operation.status === 'SUPPRESSED') return { suppressed: true }
  if (operation.status === 'SUCCEEDED') return operation.result?.response ?? {}
  throw new Error(`Dify operation ${operation.idempotencyKey} is ${operation.status}`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function childCommandContext(context: CommandContext, suffix: string): CommandContext {
  const idempotencyKey = `${context.idempotencyKey}:${suffix}`
  if (context.source === 'migration') return migrationCommandContext(context.migrationRunId!, idempotencyKey)
  if (context.source === 'replay') return replayCommandContext(context.originalEventId!, idempotencyKey)
  return onlineCommandContext(idempotencyKey)
}
