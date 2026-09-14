import { describe, expect, it } from 'bun:test'
import { buildNexusArgs } from '../nexus/nexusManager.js'

/**
 * moss is the first consumer outside the repository that owns the rule.
 *
 * What is under test is not the rule itself — that is tested where it is
 * defined, in nexus-vfs, and again in sudostack against vectors derived from
 * the same spec. What is under test here is that moss is actually *bound* by it:
 * that the validator is reached before a daemon is spawned, and that a
 * malformed id cannot get past this function.
 *
 * The distinction matters because the failure this whole exercise exists to
 * prevent is a rule that everybody agrees with and nothing enforces.
 */
describe('buildNexusArgs', () => {
  const base = [8080, '/data', '/plugins'] as const

  it('passes no zone when none is asked for, exactly as before', () => {
    const args = buildNexusArgs(...base)
    expect(args).not.toContain('--cluster-init')
    expect(args[0]).toBe('serve-local')
  })

  it('passes a conforming zone id through', () => {
    const args = buildNexusArgs(...base, 'cloud-user-1001')
    expect(args).toContain('--cluster-init')
    expect(args[args.indexOf('--cluster-init') + 1]).toBe('cloud-user-1001')
  })

  it('refuses a malformed id here rather than handing it to the daemon', () => {
    // The daemon would refuse this too — on a first boot. On a restart it warns
    // and continues, which is right for a node that already has state and wrong
    // for us: moss creating an id is never inheriting one.
    for (const [id, why] of [
      ['ab', 'shorter than the minimum'],
      ['-leading', 'leading hyphen'],
      ['trailing-', 'trailing hyphen'],
      ['Has-Upper', 'uppercase'],
      ['has_underscore', 'character outside the set'],
    ] as const) {
      expect(() => buildNexusArgs(...base, id), why).toThrow(/refusing to start nexusd/)
    }
  })

  it('says which character and where, so the caller can fix it', () => {
    expect(() => buildNexusArgs(...base, 'Has-Upper')).toThrow(/position 0/)
  })

  it('refuses the scheme this codebase nearly adopted', () => {
    // `org:<uuid>` was written into the tenancy design before the rule existed.
    // A colon is not in the charset. Kept as a case because it is the concrete
    // reason the rule is worth enforcing rather than documenting.
    expect(() => buildNexusArgs(...base, 'org:550e8400-e29b-41d4-a716-446655440000')).toThrow(
      /refusing to start nexusd/,
    )
    // The shape it became.
    expect(() => buildNexusArgs(...base, 'org-550e8400-e29b-41d4-a716-446655440000')).not.toThrow()
    // A bare UUID is already valid, which is why the prefix is a choice rather
    // than a requirement.
    expect(() => buildNexusArgs(...base, '550e8400-e29b-41d4-a716-446655440000')).not.toThrow()
  })
})
