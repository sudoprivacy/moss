import { describe, it, expect } from 'bun:test'
import { configItemToRule } from '../authProxy/authProxyServer.js'

// Guards the row → AuthProxyRule projection, in particular that the mint /
// re-mint fields (including the opt-in body_auth_check recipe) are carried
// through so the retry path can honor them.

const noEntries = () => []

describe('configItemToRule', () => {
  it('projects body_auth_check onto the rule', () => {
    const rule = configItemToRule(
      {
        id: 7,
        name: '锐锢rbox',
        pinyin: 'ruigurbox',
        scope: 'system',
        url_pattern: 'http://rbox.ruigushop.com/*',
        auth_type: 'script',
        body_auth_check: '{"field":"code","unauthorizedValues":[401]}',
      },
      noEntries,
    )
    expect(rule.bodyAuthCheck).toBe('{"field":"code","unauthorizedValues":[401]}')
    expect(rule.authType).toBe('script')
    expect(rule.pinyin).toBe('ruigurbox')
    expect(rule.urlPattern).toBe('http://rbox.ruigushop.com/*')
  })

  it('defaults body_auth_check to null when the column is absent', () => {
    const rule = configItemToRule(
      { id: 1, name: 'x', pinyin: 'x', scope: 'system', url_pattern: 'https://x/*' },
      noEntries,
    )
    expect(rule.bodyAuthCheck).toBeNull()
  })
})
