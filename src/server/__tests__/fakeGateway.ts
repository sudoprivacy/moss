/**
 * A stand-in `SudorouterClient` for tests that do not exercise the gateway.
 *
 * Written as one factory rather than an object literal per test on purpose:
 * every literal has to name all four methods, so adding a method to
 * `SudorouterClient` breaks each of them and the fix is the same boilerplate
 * four times over. That is exactly what happened when `provisionAccount` was
 * added. Here a new method needs a default in one place.
 *
 * The defaults are deliberately inert — no credits, no usage, no account — so a
 * test that means to depend on gateway behaviour has to say so by overriding.
 */
import type { GatewayAccount, SudorouterClient } from '../credits/sudorouter.js'

export function fakeGateway(overrides: Partial<SudorouterClient> = {}): SudorouterClient {
  return {
    getCredits: async () => ({ remainingPoints: 0, usedPoints: 0 }),
    getModelUsage: async () => [],
    addPoints: async () => {},
    provisionAccount: async (): Promise<GatewayAccount> => ({
      gatewayUserId: '0',
      gatewayKey: 'fake-key',
      created: true,
    }),
    ...overrides,
  }
}
