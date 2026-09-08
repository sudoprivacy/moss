const trustedCommandContext = Symbol('trusted-command-context')

export type CommandSource = 'online' | 'migration' | 'replay'
export type ExternalEffectsPolicy = 'enqueue' | 'suppress_external'

export interface CommandContext {
  readonly source: CommandSource
  readonly externalEffects: ExternalEffectsPolicy
  readonly idempotencyKey: string
  readonly migrationRunId?: string
  readonly originalEventId?: string
  readonly [trustedCommandContext]: true
}

function createContext(input: Omit<CommandContext, typeof trustedCommandContext>): CommandContext {
  const idempotencyKey = input.idempotencyKey.trim()
  if (!idempotencyKey) throw new Error('Command idempotency key is required')
  return Object.freeze({ ...input, idempotencyKey, [trustedCommandContext]: true })
}

export function onlineCommandContext(idempotencyKey: string): CommandContext {
  return createContext({ source: 'online', externalEffects: 'enqueue', idempotencyKey })
}

export function migrationCommandContext(migrationRunId: string, idempotencyKey: string): CommandContext {
  if (!migrationRunId.trim()) throw new Error('Migration run id is required')
  return createContext({
    source: 'migration',
    externalEffects: 'suppress_external',
    idempotencyKey,
    migrationRunId: migrationRunId.trim(),
  })
}

export function replayCommandContext(originalEventId: string, idempotencyKey: string): CommandContext {
  if (!originalEventId.trim()) throw new Error('Original event id is required')
  return createContext({
    source: 'replay',
    externalEffects: 'suppress_external',
    idempotencyKey,
    originalEventId: originalEventId.trim(),
  })
}

export function assertTrustedCommandContext(context: CommandContext): void {
  if (!context || context[trustedCommandContext] !== true) {
    throw new Error('Command context must be created by a trusted server entry point')
  }
  if (context.source !== 'online' && context.externalEffects !== 'suppress_external') {
    throw new Error(`${context.source} commands must suppress external effects`)
  }
}
