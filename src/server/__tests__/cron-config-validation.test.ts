import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { CronService, type CronServiceConfig } from '../services/cron/CronService.js'

// Regression: CronService was constructed in server.ts without runtimeDir (also
// defaultRuntime / dockerContainerMode), even though CronServiceConfig marks
// them required. With no type-check step in the build, the omission compiled
// fine and only surfaced as `path.join(undefined, …)` ->
// `The "path" argument must be of type string. Received undefined` when a
// 'new'-mode job created a session via resolveCronWorkspace. The constructor
// now fails loud instead.

type DatabaseSync = ConstructorParameters<typeof CronService>[0]

function makeDb(): DatabaseSync {
  return new Database(':memory:') as unknown as DatabaseSync
}

function baseConfig(overrides: Partial<CronServiceConfig> = {}): CronServiceConfig {
  return {
    // runtimeService is only touched at run time, not in the constructor.
    runtimeService: {} as CronServiceConfig['runtimeService'],
    runtimeDir: '/app/data/runtime',
    defaultRuntime: 'docker',
    dockerContainerMode: 'session',
    workspace: undefined,
    getUserAuth: async () => null,
    ...overrides,
  }
}

describe('CronService config validation', () => {
  it('throws a clear error when runtimeDir is missing', () => {
    expect(
      () => new CronService(makeDb(), baseConfig({ runtimeDir: undefined as unknown as string })),
    ).toThrow('CronService misconfigured: runtimeDir is required')
  })

  it('constructs when runtimeDir is provided', () => {
    expect(() => new CronService(makeDb(), baseConfig())).not.toThrow()
  })
})
