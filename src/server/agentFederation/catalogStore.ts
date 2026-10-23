import { randomUUID } from 'node:crypto'
import { escapeLike, type DbDriver, type SqlParam } from '../db/driver.js'
import {
  AGENT_CATALOG_API,
  type CatalogAuditEvent,
  type CatalogPage,
  type CatalogSource,
  type CatalogVersionState,
  type ImportCandidate,
  type SourceSyncResult,
} from '../../../contracts/agent-catalog/v1alpha1/contract.js'
import type { Binding, ExternalActor } from '../externalProviders/store.js'
import { ExternalProviderError } from '../externalProviders/policy.js'
import { validateCatalogDocument } from './catalogContract.js'

export interface CatalogFilters {
  approval_status?: string; provider?: string
  zone?: string
  execution_mode?: string
  source_state?: string
  drift?: string
  search?: string
  protocol?: string
  status?: string
  owner?: string
  warning?: string
  capability?: string
  observability?: string
}

export interface SourceRecord {
  view: CatalogSource
  definition: string | null
  proposed: Pick<
    Binding,
    'name' | 'endpoint' | 'allowed_user_ids' | 'review_note'
  >
}
export interface CandidateRecord {
  view: ImportCandidate
  binding: Binding
  key: string
  approved_until: number | null
}

export async function initializeCatalogGovernance(db: DbDriver): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS agent_catalog_sources (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, catalog_id TEXT NOT NULL, document TEXT NOT NULL,
      UNIQUE(org_id, catalog_id)
    );
    CREATE INDEX IF NOT EXISTS agent_catalog_sources_org ON agent_catalog_sources(org_id, id);
    CREATE TABLE IF NOT EXISTS agent_import_candidates (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, source_id TEXT NOT NULL, candidate_key TEXT NOT NULL,
      status TEXT NOT NULL, document TEXT NOT NULL, UNIQUE(source_id, candidate_key)
    );
    CREATE INDEX IF NOT EXISTS agent_import_candidates_org ON agent_import_candidates(org_id, id);
    CREATE INDEX IF NOT EXISTS agent_import_candidates_source ON agent_import_candidates(source_id, id);
    CREATE TABLE IF NOT EXISTS agent_source_syncs (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, source_id TEXT NOT NULL, document TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_source_syncs_org ON agent_source_syncs(org_id, id);
    CREATE TABLE IF NOT EXISTS agent_catalog_versions (
      org_id TEXT NOT NULL, catalog_id TEXT NOT NULL, version TEXT NOT NULL, document TEXT NOT NULL,
      PRIMARY KEY(org_id, catalog_id, version)
    );
    CREATE TABLE IF NOT EXISTS agent_catalog_audit (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, catalog_id TEXT, action TEXT NOT NULL, document TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_catalog_audit_org ON agent_catalog_audit(org_id, id);
    CREATE INDEX IF NOT EXISTS agent_catalog_audit_catalog ON agent_catalog_audit(org_id, catalog_id, id);
    CREATE TABLE IF NOT EXISTS agent_task_provenance (task_id TEXT PRIMARY KEY, document TEXT NOT NULL);
  `)
  // Immutable creation times support stable pagination on both storage backends.
  for (const [table, path] of [
    ['agent_catalog_sources', 'view.created_at'],
    ['agent_import_candidates', 'view.created_at'],
    ['agent_source_syncs', 'started_at'],
    ['agent_catalog_audit', 'at'],
  ]) {
    const expression =
      db.kind === 'postgres'
        ? `CAST(CAST(document AS jsonb) #>> '{${path.replaceAll('.', ',')}}' AS BIGINT)`
        : `CAST(json_extract(document, '$.${path}') AS BIGINT)`
    await db.exec(
      `CREATE INDEX IF NOT EXISTS ${table}_chronology ON ${table}(org_id, (${expression}), id)`,
    )
  }
}

export class CatalogGovernanceStore {
  constructor(
    readonly db: DbDriver,
    readonly ready: Promise<void>,
  ) {}
  async source(actor: ExternalActor, id: string): Promise<SourceRecord> {
    await this.ready
    const row = await this.db.get(
      'SELECT document FROM agent_catalog_sources WHERE id = ? AND org_id = ?',
      [id, actor.orgId],
    )
    if (!row) throw new ExternalProviderError(404, 'CATALOG_SOURCE_NOT_FOUND')
    return JSON.parse(String(row.document))
  }
  async managed(
    actor: ExternalActor,
    catalogId: string,
  ): Promise<SourceRecord | undefined> {
    await this.ready
    const row = await this.db.get(
      'SELECT document FROM agent_catalog_sources WHERE catalog_id = ? AND org_id = ?',
      [catalogId, actor.orgId],
    )
    return row ? JSON.parse(String(row.document)) : undefined
  }
  async candidate(actor: ExternalActor, id: string): Promise<CandidateRecord> {
    await this.ready
    const row = await this.db.get(
      'SELECT document FROM agent_import_candidates WHERE id = ? AND org_id = ?',
      [id, actor.orgId],
    )
    if (!row) throw new ExternalProviderError(404, 'IMPORT_CANDIDATE_NOT_FOUND')
    return JSON.parse(String(row.document))
  }
  async saveSource(record: SourceRecord) {
    validateCatalogDocument('CatalogSource', record.view)
    record.view.updated_at = Date.now()
    await this.db.run(
      'UPDATE agent_catalog_sources SET document = ? WHERE id = ? AND org_id = ?',
      [JSON.stringify(record), record.view.id, record.view.org_id],
    )
  }
  async saveCandidate(record: CandidateRecord) {
    validateCatalogDocument('ImportCandidate', record.view)
    await this.db.run(
      'UPDATE agent_import_candidates SET status = ?, document = ? WHERE id = ? AND org_id = ?',
      [
        record.view.status,
        JSON.stringify(record),
        record.view.id,
        record.view.org_id,
      ],
    )
  }
  async lock(actor: ExternalActor, catalogId: string) {
    await this.ready
    const changed = await this.db.run(
      'UPDATE external_pilot_bindings SET document = document WHERE id = ? AND org_id = ?',
      [catalogId, actor.orgId],
    )
    if (!changed) throw new ExternalProviderError(404, 'AGENT_NOT_FOUND')
  }
  async page<T>(
    actor: ExternalActor,
    kind: 'sources' | 'candidates' | 'syncs' | 'audit',
    after = '',
    filter = '',
    query: CatalogFilters = {},
  ): Promise<CatalogPage<T>> {
    await this.ready
    if (
      !/^[a-zA-Z0-9_-]{0,400}$/.test(after) ||
      !/^[a-zA-Z0-9_-]{0,200}$/.test(filter) ||
      Object.values(query).some((v) => typeof v !== 'string' || v.length > 200)
    )
      throw new ExternalProviderError(400, 'INVALID_CURSOR')
    const tables = {
      sources: 'agent_catalog_sources',
      candidates: 'agent_import_candidates',
      syncs: 'agent_source_syncs',
      audit: 'agent_catalog_audit',
    }
    const json = (path: string, document = 'd.document') =>
      this.db.kind === 'postgres'
        ? `(CAST(${document} AS jsonb) #>> '{${path.split('.').join(',')}}')`
        : `json_extract(${document}, '$.${path}')`
    const root = kind === 'sources' || kind === 'candidates' ? 'view.' : ''
    const field = (name: string) => json(root + name)
    const time = `CAST(${field(kind === 'audit' ? 'at' : kind === 'syncs' ? 'started_at' : 'created_at')} AS BIGINT)`
    const where = ['d.org_id = ?'],
      params: SqlParam[] = [actor.orgId]
    if (filter) {
      where.push(
        `d.${kind === 'candidates' || kind === 'syncs' ? 'source_id' : 'catalog_id'} = ?`,
      )
      params.push(filter)
    }
    if (after) {
      let cursor: unknown
      try {
        cursor = JSON.parse(Buffer.from(after, 'base64url').toString())
      } catch {
        throw new ExternalProviderError(400, 'INVALID_CURSOR')
      }
      if (
        !Array.isArray(cursor) ||
        cursor.length !== 2 ||
        !Number.isSafeInteger(cursor[0]) ||
        typeof cursor[1] !== 'string' ||
        !/^[\w-]{1,200}$/.test(cursor[1])
      )
        throw new ExternalProviderError(400, 'INVALID_CURSOR')
      where.push(`(${time} < ? OR (${time} = ? AND d.id < ?))`)
      params.push(cursor[0], cursor[0], cursor[1])
    }
    const exact = (expr: string, value?: string) => {
      if (value) {
        where.push(`${expr} = ?`)
        params.push(value)
      }
    }
    exact(
      field(
        kind === 'candidates'
          ? 'snapshot.protocol'
          : kind === 'audit'
            ? 'context.protocol'
            : 'protocol',
      ),
      query.protocol,
    )
    if (query.owner) {
      if (kind === 'sources') exact(field('owner_id'), query.owner)
      else if (kind === 'candidates') {
        where.push(
          `EXISTS (SELECT 1 FROM agent_catalog_sources s WHERE s.id = d.source_id AND s.org_id = d.org_id AND ${json('view.owner_id', 's.document')} = ?)`,
        )
        params.push(query.owner)
      } else exact(field('actor_id'), query.owner)
    }
    if (query.status) {
      if (kind === 'sources' && ['enabled', 'disabled'].includes(query.status))
        where.push(
          `${field('enabled')} = ${this.db.kind === 'postgres' ? `'${query.status === 'enabled' ? 'true' : 'false'}'` : query.status === 'enabled' ? '1' : '0'}`,
        )
      else
        exact(
          field(
            kind === 'sources'
              ? 'availability'
              : kind === 'audit'
                ? 'result'
                : 'status',
          ),
          query.status,
        )
    }
    if (query.warning === 'true') {
      if (kind === 'sources')
        where.push(`CAST(${field('warning_count')} AS BIGINT) > 0`)
      else if (kind === 'candidates')
        where.push(
          this.db.kind === 'postgres'
            ? `jsonb_array_length(CAST(${field('validation.warnings')} AS jsonb)) > 0`
            : `json_array_length(${field('validation.warnings')}) > 0`,
        )
    }
    const capability = (name: string) =>
      kind === 'sources'
        ? `(SELECT ${json('view.snapshot.capabilities.' + name, 'c.document')} FROM agent_import_candidates c WHERE c.source_id = d.id AND c.org_id = d.org_id ORDER BY CAST(${json('view.created_at', 'c.document')} AS BIGINT) DESC, c.id DESC LIMIT 1)`
        : field(
            (kind === 'candidates' ? 'snapshot.' : 'context.') +
              'capabilities.' +
              name,
          )
    if (query.capability) {
      if (
        ![
          'streaming',
          'cancel',
          'resume',
          'idempotency',
          'version_pin',
          'human_approval',
        ].includes(query.capability)
      )
        throw new ExternalProviderError(400, 'INVALID_CATALOG_FILTER')
      exact(capability(query.capability), 'supported')
    }
    if (query.observability)
      exact(capability('trace_export'), query.observability)
    if (query.search) {
      const names =
        kind === 'sources'
          ? ['name', 'external_agent_id', 'endpoint', 'catalog_id']
          : kind === 'candidates'
            ? [
                'snapshot.name',
                'snapshot.external_agent_id',
                'id',
                'catalog_id',
              ]
            : [
                'action',
                'catalog_id',
                'task_id',
                'actor_id',
                'provider_run_id',
                'provider_response_id',
              ]
      where.push(
        `(${names.map((name) => `LOWER(COALESCE(${field(name)}, '')) LIKE ? ESCAPE '\\'`).join(' OR ')})`,
      )
      params.push(
        ...names.map(() => `%${escapeLike(query.search!.toLowerCase())}%`),
      )
    }
    const rows = await this.db.all(
      `SELECT d.id, d.document, ${time} AS sort_at FROM ${tables[kind]} d WHERE ${where.join(' AND ')} ORDER BY ${time} DESC, d.id DESC LIMIT 51`,
      params,
    )
    return {
      api_version: AGENT_CATALOG_API,
      items: rows.slice(0, 50).map((row) => {
        const d = JSON.parse(String(row.document))
        return (d.view ?? d) as T
      }),
      next_cursor:
        rows.length > 50
          ? Buffer.from(
              JSON.stringify([Number(rows[49].sort_at), String(rows[49].id)]),
            ).toString('base64url')
          : null,
    }
  }
  async audit(
    actor: ExternalActor,
    action: string,
    catalogId: string | null,
    refs: Partial<
      Pick<
        CatalogAuditEvent,
        | 'source_id'
        | 'candidate_id'
        | 'version'
        | 'task_id'
        | 'result'
        | 'reason'
        | 'provider_run_id'
        | 'provider_response_id'
      >
    > = {},
    eventId?: string,
  ) {
    await this.ready
    // Only structured correlation and allowlisted reason codes. Never include input, output or credentials.
    const source = catalogId ? await this.managed(actor, catalogId) : undefined
    const item: CatalogAuditEvent = {
      api_version: AGENT_CATALOG_API,
      id: eventId ?? randomUUID(),
      org_id: actor.orgId,
      actor_id: actor.userId,
      zone_id: source?.view.zone_id ?? null,
      at: Date.now(),
      action,
      catalog_id: catalogId,
      source_id: source?.view.id ?? null,
      candidate_id: null,
      version: null,
      task_id: null,
      result: 'succeeded',
      reason: null,
      context: null,
      provider_run_id: null,
      provider_response_id: null,
      ...refs,
    }
    let context: CatalogAuditEvent['context'] = null
    if (item.candidate_id)
      context = (await this.candidate(actor, item.candidate_id)).view.snapshot
    if (item.task_id) {
      const row = await this.db.get(
        'SELECT p.document FROM agent_task_provenance p JOIN tasks t ON t.id = p.task_id WHERE p.task_id = ? AND t.org_id = ?',
        [item.task_id, actor.orgId],
      )
      if (row) context = JSON.parse(String(row.document))
    }
    if (context)
      item.context = {
        protocol: context.protocol,
        adapter_version: context.adapter_version,
        source_revision: context.source_revision,
        source_digest: context.source_digest,
        capabilities: context.capabilities,
      }
    if (item.reason && !/^[A-Z][A-Z0-9_]{0,99}$/.test(item.reason))
      item.reason = 'OPERATION_FAILED'
    validateCatalogDocument('CatalogAuditEvent', item)
    await this.db.run(
      'INSERT INTO agent_catalog_audit(id, org_id, catalog_id, action, document) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
      [item.id, actor.orgId, catalogId, action, JSON.stringify(item)],
    )
    return item
  }
  async version(
    actor: ExternalActor,
    catalogId: string,
    version: string,
  ): Promise<CatalogVersionState | undefined> {
    await this.ready
    const row = await this.db.get(
      'SELECT document FROM agent_catalog_versions WHERE org_id = ? AND catalog_id = ? AND version = ?',
      [actor.orgId, catalogId, version],
    )
    return row ? JSON.parse(String(row.document)) : undefined
  }
  async saveVersion(actor: ExternalActor, item: CatalogVersionState) {
    validateCatalogDocument('CatalogVersionState', item)
    await this.db.run(
      'INSERT INTO agent_catalog_versions(org_id, catalog_id, version, document) VALUES (?, ?, ?, ?) ON CONFLICT(org_id, catalog_id, version) DO NOTHING',
      [actor.orgId, item.catalog_id, item.version, JSON.stringify(item)],
    )
    const saved = await this.version(actor, item.catalog_id, item.version)
    if (JSON.stringify(saved) !== JSON.stringify(item))
      throw new ExternalProviderError(409, 'IMMUTABLE_VERSION_CONFLICT')
  }
  /** Freeze executable Catalog projections when their source identity changes.
   *  The release authority remains immutable; the local Catalog state records
   *  that every previously published projection needs a fresh candidate and
   *  approval before dispatch can use it again.
   */
  async deprecatePublishedVersions(actor: ExternalActor, catalogId: string): Promise<string[]> {
    await this.ready
    const rows = await this.db.all(
      'SELECT version, document FROM agent_catalog_versions WHERE org_id = ? AND catalog_id = ?',
      [actor.orgId, catalogId],
    )
    const changed: string[] = []
    for (const row of rows) {
      const item = JSON.parse(String(row.document)) as CatalogVersionState
      if (item.lifecycle !== 'published') continue
      item.lifecycle = 'deprecated'
      validateCatalogDocument('CatalogVersionState', item)
      await this.db.run(
        'UPDATE agent_catalog_versions SET document = ? WHERE org_id = ? AND catalog_id = ? AND version = ?',
        [JSON.stringify(item), actor.orgId, catalogId, item.version],
      )
      changed.push(item.version)
    }
    return changed
  }
  async saveSync(item: SourceSyncResult) {
    validateCatalogDocument('SourceSyncResult', item)
    await this.db.run(
      'INSERT INTO agent_source_syncs(id, org_id, source_id, document) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document',
      [item.id, item.org_id, item.source_id, JSON.stringify(item)],
    )
  }
}
