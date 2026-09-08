import postgres, { type Sql } from 'postgres'

import { initializeQmsSchema, type QmsAggregateMode, type QmsSchemaState, type QmsSqlPort } from './qmsSchema.js'

export interface QmsDatabaseClient extends QmsSqlPort {
  transaction<T>(operation: (client: QmsSqlPort) => Promise<T>): Promise<T>
  close(): Promise<void>
}

export type QmsDatabaseClientFactory = (url: string) => QmsDatabaseClient

class PostgresJsClient implements QmsDatabaseClient {
  constructor(private readonly sql: Sql) {}

  async execute(query: string, parameters: readonly unknown[] = []): Promise<readonly Record<string, unknown>[]> {
    return await this.sql.unsafe(query, [...parameters] as never[]) as unknown as readonly Record<string, unknown>[]
  }

  transaction<T>(operation: (client: QmsSqlPort) => Promise<T>): Promise<T> {
    return this.sql.begin(async sql => operation({
      execute: async (query, parameters = []) =>
        await sql.unsafe(query, [...parameters] as never[]) as unknown as readonly Record<string, unknown>[],
    })) as Promise<T>
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 })
  }
}

function createClient(url: string): QmsDatabaseClient {
  return new PostgresJsClient(postgres(url, {
    max: 20,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: true,
  }))
}

export class QmsPostgresStore implements QmsSqlPort {
  private client?: QmsDatabaseClient
  private startPromise?: Promise<QmsSchemaState>
  private state?: QmsSchemaState

  constructor(
    private readonly url: string,
    private readonly factory: QmsDatabaseClientFactory = createClient,
    private readonly schemaOptions: { aggregateMode?: QmsAggregateMode } = {},
  ) {}

  start(): Promise<QmsSchemaState> {
    if (this.state) return Promise.resolve(this.state)
    if (this.startPromise) return this.startPromise
    this.startPromise = this.startInternal()
    return this.startPromise
  }

  private async startInternal(): Promise<QmsSchemaState> {
    const client = this.factory(this.url)
    this.client = client
    try {
      await client.execute('SELECT 1 AS healthy')
      this.state = await initializeQmsSchema(client, this.schemaOptions)
      return this.state
    } catch (error) {
      this.client = undefined
      this.startPromise = undefined
      await client.close()
      throw error
    }
  }

  async execute(sql: string, parameters: readonly unknown[] = []): Promise<readonly Record<string, unknown>[]> {
    if (!this.client || !this.state) throw new Error('QMS PostgreSQL store is not started')
    return this.client.execute(sql, parameters)
  }

  async transaction<T>(operation: (client: QmsSqlPort) => Promise<T>): Promise<T> {
    if (!this.client || !this.state) throw new Error('QMS PostgreSQL store is not started')
    return this.client.transaction(operation)
  }

  async stop(): Promise<void> {
    const client = this.client
    this.client = undefined
    this.state = undefined
    this.startPromise = undefined
    if (client) await client.close()
  }
}
