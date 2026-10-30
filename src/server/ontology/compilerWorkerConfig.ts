import { z } from 'zod'

const reference = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
const configuration = z.object({
  binding: z.object({ authorityRef: reference, modelRef: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    sourceRefs: z.array(reference).max(1000) }).strict(),
  runtime: z.object({
    python: z.string().min(1), compilerRoot: z.string().min(1), modelDirectory: z.string().min(1),
    source: z.object({
      dsn: z.string().regex(/^registered:\/\/[a-zA-Z0-9_-]{1,128}$/),
      connector: z.object({
        sourceType: z.enum(['postgresql', 'mysql']), host: z.string().min(1),
        port: z.number().int().min(1).max(65535).optional(),
        database: z.string().min(1), username: z.string().min(1),
        params: z.object({ schema: z.string().min(1).optional() }).strict().optional(),
      }).strict(),
    }).strict().refine(source => source.connector.sourceType === 'postgresql' || source.connector.params === undefined,
      'Schema selection is PostgreSQL-only; MySQL scope is connector.database').optional(),
  }).strict(),
  actor: z.string().trim().min(1).max(128),
  host: z.string().min(1).default('127.0.0.1'), port: z.number().int().min(0).max(65535),
}).strict()

/** Deployment input only. Source credentials are injected by the existing secret manager. */
export function compilerWorkerConfiguration(value: unknown, environment: NodeJS.ProcessEnv) {
  const config = configuration.parse(value)
  if (config.runtime.source) {
    const password = environment.SUDOGRAPH_SOURCE_PASSWORD
    if (!password) throw new Error('Registered source requires an injected SUDOGRAPH_SOURCE_PASSWORD')
    return { ...config, runtime: { ...config.runtime,
      source: { ...config.runtime.source, connector: { ...config.runtime.source.connector, password } } } }
  }
  return config
}
