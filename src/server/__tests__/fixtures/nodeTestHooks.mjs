// Node test loader for src/server tests whose import chains transitively reach
// `bun:bundle` (e.g. config.ts -> utils/path.ts -> utils/platform.ts ->
// utils/log.ts). That module only exists inside the bun bundler; the runtime
// build (bin/moss-server.mjs) has it replaced at bundle time. For unit tests
// under `tsx --test` we stub it with the conservative default: every feature
// flag off. Register with:
//   node --import ./src/server/__tests__/fixtures/nodeTestHooks.register.mjs
export function resolve(specifier, context, next) {
  if (specifier.startsWith('bun:')) {
    // feature() is a compile-time feature flag; runtime default = disabled.
    const stub = 'export const feature = () => false;'
    return {
      shortCircuit: true,
      url: `data:text/javascript,${encodeURIComponent(stub)}`,
    }
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  // Pre-existing repo defect, NOT touched by the LB work: claudeAiLimits.ts
  // re-exports `getRateLimitErrorMessage` from rateLimitMessages.js, which
  // only defines getRateLimitWarning/getUsingOverageText. The bun bundler
  // tolerates this; Node's strict ESM named-export check fails on it and
  // blocks loading server.ts (whose transitive chain reaches that module).
  // Append the missing export at the test-loader level so the LB unit tests
  // can import server.ts. Production code is left untouched.
  if (/rateLimitMessages\.(ts|js)$/.test(url)) {
    const result = await next(url, context)
    if (result.format === 'module-typescript' || result.format === 'module') {
      return {
        ...result,
        source: `${result.source}\nexport function getRateLimitErrorMessage() { return null }\n`,
      }
    }
    return result
  }
  return next(url, context)
}
