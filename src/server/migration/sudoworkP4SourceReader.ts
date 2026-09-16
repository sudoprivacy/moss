import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

type SqlRow = Record<string, unknown>

export interface SudoworkDifyConnectionSource {
  enterpriseId: number
  tenantId: string
  systemAccountId: string | null
  apiKey: string
  createdAt: number
  updatedAt: number
}

export interface SudoworkDifyAppSource {
  id: number
  enterpriseId: number
  assistantId: string
  tenantId: string
  appId: string
  appApiKey: string | null
  mode: string
  createdAt: number
  updatedAt: number
}

export interface SudoworkDifyDatasetBindingSource {
  id: number
  enterpriseId: number
  assistantId: string
  tenantId: string
  datasetId: string
  createdAt: number
}

export interface SudoworkAssistantAclSource {
  id: number
  enterpriseId: number
  assistantId: string
  subjectType: 'user' | 'department' | 'role' | 'all'
  subjectId: string | null
  createdAt: number
}

export interface SudoworkAssistantMetadataSource {
  id: number
  enterpriseId: number
  assistantId: string
  name: string
  profession: string
  description: string | null
  defaultInitPrompt: string | null
  promptsI18n: Record<string, string[]> | null
  categories: string[]
  skills: string[]
  promptFile: string | null
  avatar: string | null
  version: string | null
  createdAt: number
  updatedAt: number
}

export interface SudoworkP4Snapshot {
  connections: SudoworkDifyConnectionSource[]
  apps: SudoworkDifyAppSource[]
  datasets: SudoworkDifyDatasetBindingSource[]
  acl: SudoworkAssistantAclSource[]
  metadata: SudoworkAssistantMetadataSource[]
  checksum: string
}

export class SudoworkP4SourceError extends Error {
  constructor(readonly code: 'INVALID_SOURCE', message: string) {
    super(message)
    this.name = 'SudoworkP4SourceError'
  }
}

export class SudoworkP4SourceReader {
  private readonly databasePath: string

  constructor(snapshotDir: string) {
    this.databasePath = resolve(snapshotDir, 'sudowork.sqlite')
  }

  readSnapshot(): SudoworkP4Snapshot {
    let db: DatabaseSync
    try {
      db = new DatabaseSync(this.databasePath, { readOnly: true })
      db.exec('PRAGMA query_only=ON')
    } catch (error) {
      throw new SudoworkP4SourceError('INVALID_SOURCE', `无法只读打开 Sudowork Dify 快照: ${message(error)}`)
    }
    try {
      const connections = rows(db, 'dify_tenant_binding').map(row => ({
        enterpriseId: positiveInteger(row.enterprise_id, 'dify_tenant_binding.enterprise_id'),
        tenantId: requiredText(row.dify_tenant_id, 'dify_tenant_binding.dify_tenant_id'),
        systemAccountId: nullableText(row.dify_system_account_id),
        apiKey: requiredText(row.api_key, 'dify_tenant_binding.api_key'),
        createdAt: timestamp(row.created_at),
        updatedAt: timestamp(row.updated_at),
      }))
      const apps = rows(db, 'dify_app_binding').map(row => ({
        id: positiveInteger(row.id, 'dify_app_binding.id'),
        enterpriseId: positiveInteger(row.enterprise_id, 'dify_app_binding.enterprise_id'),
        assistantId: requiredText(row.assistant_id, 'dify_app_binding.assistant_id'),
        tenantId: requiredText(row.dify_tenant_id, 'dify_app_binding.dify_tenant_id'),
        appId: requiredText(row.dify_app_id, 'dify_app_binding.dify_app_id'),
        appApiKey: nullableText(row.app_api_key),
        mode: requiredText(row.dify_app_mode, 'dify_app_binding.dify_app_mode'),
        createdAt: timestamp(row.created_at),
        updatedAt: timestamp(row.updated_at),
      }))
      const datasets = rows(db, 'dify_dataset_binding').map(row => ({
        id: positiveInteger(row.id, 'dify_dataset_binding.id'),
        enterpriseId: positiveInteger(row.enterprise_id, 'dify_dataset_binding.enterprise_id'),
        assistantId: requiredText(row.assistant_id, 'dify_dataset_binding.assistant_id'),
        tenantId: requiredText(row.dify_tenant_id, 'dify_dataset_binding.dify_tenant_id'),
        datasetId: requiredText(row.dify_dataset_id, 'dify_dataset_binding.dify_dataset_id'),
        createdAt: timestamp(row.created_at),
      }))
      const acl = rows(db, 'assistant_acl').map(row => {
        const subjectType = requiredText(row.subject_type, 'assistant_acl.subject_type')
        if (!['user', 'department', 'role', 'all'].includes(subjectType)) {
          throw invalid(`assistant_acl.subject_type 非法: ${subjectType}`)
        }
        return {
          id: positiveInteger(row.id, 'assistant_acl.id'),
          enterpriseId: positiveInteger(row.enterprise_id, 'assistant_acl.enterprise_id'),
          assistantId: requiredText(row.assistant_id, 'assistant_acl.assistant_id'),
          subjectType: subjectType as SudoworkAssistantAclSource['subjectType'],
          subjectId: nullableText(row.subject_id),
          createdAt: timestamp(row.created_at),
        }
      })
      const metadata = rows(db, 'assistant_metadata_overrides').map(row => ({
        id: positiveInteger(row.id, 'assistant_metadata_overrides.id'),
        enterpriseId: positiveInteger(row.enterprise_id, 'assistant_metadata_overrides.enterprise_id'),
        assistantId: requiredText(row.assistant_id, 'assistant_metadata_overrides.assistant_id'),
        name: requiredText(row.name, 'assistant_metadata_overrides.name'),
        profession: requiredText(row.profession, 'assistant_metadata_overrides.profession'),
        description: nullableText(row.description),
        defaultInitPrompt: nullableText(row.default_init_prompt),
        promptsI18n: stringArrayRecord(row.prompts_i18n, 'assistant_metadata_overrides.prompts_i18n'),
        categories: stringArray(row.categories, 'assistant_metadata_overrides.categories'),
        skills: stringArray(row.skills, 'assistant_metadata_overrides.skills'),
        promptFile: nullableText(row.prompt_file),
        avatar: nullableText(row.avatar),
        version: nullableText(row.skillhub_version),
        createdAt: timestamp(row.created_at),
        updatedAt: timestamp(row.updated_at),
      }))
      const value = { connections, apps, datasets, acl, metadata }
      return { ...value, checksum: createHash('sha256').update(JSON.stringify(value)).digest('hex') }
    } finally {
      db.close()
    }
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
}

function rows(db: DatabaseSync, table: string): SqlRow[] {
  return tableExists(db, table) ? db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as SqlRow[] : []
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${field} 不能为空`)
  return value.trim()
}

function nullableText(value: unknown): string | null {
  return value == null || value === '' ? null : String(value)
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw invalid(`${field} 必须是正整数`)
  return parsed
}

function timestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Date.parse(String(value ?? ''))
  if (!Number.isFinite(parsed)) throw invalid(`时间字段非法: ${String(value)}`)
  return parsed
}

function stringArray(value: unknown, field: string): string[] {
  if (value == null || value === '') return []
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error()
    return parsed
  } catch {
    throw invalid(`${field} 必须是字符串数组 JSON`)
  }
}

function stringArrayRecord(value: unknown, field: string): Record<string, string[]> | null {
  if (value == null || value === '') return null
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    for (const item of Object.values(parsed as Record<string, unknown>)) {
      if (!Array.isArray(item) || item.some(value => typeof value !== 'string')) throw new Error()
    }
    return parsed as Record<string, string[]>
  } catch {
    throw invalid(`${field} 必须是字符串数组映射 JSON`)
  }
}

function invalid(message: string): SudoworkP4SourceError {
  return new SudoworkP4SourceError('INVALID_SOURCE', message)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
