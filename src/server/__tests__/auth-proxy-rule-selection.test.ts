import { describe, it, expect, spyOn } from 'bun:test'
import { selectRuleForUrl, type AuthProxyRule } from '../authProxy/authProxyServer.js'

// Credential-selection precedence for the auth proxy: among all rules whose URL
// pattern matches the target (and whose org matches, or is a global user-scope
// rule), pick the winner by:
//   1. longest urlPattern (most specific),
//   2. scope: user > department > system,
//   3. latest created (highest configItemId).
// A same-(length, scope) tie is arbitrary, so it warns and keeps the latest id.

const ORG = 'org-1'

function rule(partial: Partial<AuthProxyRule> & { configItemId: number }): AuthProxyRule {
  return {
    name: `rule-${partial.configItemId}`,
    urlPattern: 'https://api.example.com/*',
    scheme: 'bearer',
    bearerPrefix: '',
    scope: 'system',
    orgId: ORG,
    secretNamespace: `system:${partial.configItemId}`,
    entries: [],
    ...partial,
  }
}

describe('selectRuleForUrl precedence', () => {
  const url = 'https://api.example.com/v2/thing'

  it('returns null when nothing matches', () => {
    const r = rule({ configItemId: 1, urlPattern: 'https://other.com/*' })
    expect(selectRuleForUrl([r], url, ORG)).toBeNull()
  })

  it('longer URL pattern beats scope precedence', () => {
    // A system cred with a MORE specific pattern beats a user cred with a
    // broader one — length dominates scope.
    const broadUser = rule({
      configItemId: 10,
      scope: 'user',
      orgId: null,
      urlPattern: 'https://api.example.com/*',
    })
    const specificSystem = rule({
      configItemId: 11,
      scope: 'system',
      urlPattern: 'https://api.example.com/v2/*',
    })
    const winner = selectRuleForUrl([broadUser, specificSystem], url, ORG)
    expect(winner?.configItemId).toBe(11)
  })

  it('same length: user beats department beats system', () => {
    const sys = rule({ configItemId: 1, scope: 'system' })
    const dept = rule({ configItemId: 2, scope: 'department' })
    const usr = rule({ configItemId: 3, scope: 'user', orgId: null })
    // Provide them out of order to prove it is not just "last wins".
    expect(selectRuleForUrl([usr, sys, dept], url, ORG)?.scope).toBe('user')
    expect(selectRuleForUrl([sys, dept], url, ORG)?.scope).toBe('department')
    expect(selectRuleForUrl([sys], url, ORG)?.scope).toBe('system')
  })

  it('same length AND scope: latest created (highest id) wins, and it warns', () => {
    const older = rule({ configItemId: 5, scope: 'user', orgId: null, name: 'Foo API' })
    const newer = rule({ configItemId: 9, scope: 'user', orgId: null, name: 'Foo API alt' })
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const winner = selectRuleForUrl([older, newer], url, ORG)
      expect(winner?.configItemId).toBe(9)
      expect(warn).toHaveBeenCalledTimes(1)
      const msg = String(warn.mock.calls[0]?.[0])
      expect(msg).toContain('Ambiguous credential match')
      expect(msg).toContain('#5')
      expect(msg).toContain('#9')
    } finally {
      warn.mockRestore()
    }
  })

  it('does not warn when the top two differ by scope (unambiguous)', () => {
    const sys = rule({ configItemId: 5, scope: 'system' })
    const usr = rule({ configItemId: 2, scope: 'user', orgId: null })
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(selectRuleForUrl([sys, usr], url, ORG)?.scope).toBe('user')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('org isolation: a foreign org rule is ignored, global user rule is not', () => {
    const foreign = rule({ configItemId: 1, scope: 'system', orgId: 'org-2' })
    const globalUser = rule({ configItemId: 2, scope: 'user', orgId: null })
    const winner = selectRuleForUrl([foreign, globalUser], url, ORG)
    expect(winner?.configItemId).toBe(2)
    // And with only the foreign rule present, nothing matches for this org.
    expect(selectRuleForUrl([foreign], url, ORG)).toBeNull()
  })

  it('skips rules with an empty urlPattern', () => {
    const empty = rule({ configItemId: 1, urlPattern: '' })
    expect(selectRuleForUrl([empty], url, ORG)).toBeNull()
  })
})
