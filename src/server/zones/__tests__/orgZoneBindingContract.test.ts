import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  API_VERSION,
  KIND,
  PURPOSE_KNOWN,
  safeParse,
} from '../generated/org-zone-binding.gen.js'
import type { OrgZoneBinding } from '../generated/org-zone-binding.gen.js'

type Case = { name: string; why?: string; payload: unknown }

const FIXTURES_DIR = join(import.meta.dir, '..', '..', '..', '..', 'contracts', 'iam', 'v1', 'fixtures')

function loadCases(rel: string): Case[] {
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, rel), 'utf8'))
  return (raw.cases ?? []) as Case[]
}

describe('iam/v1 org-zone-binding contract', () => {
  it('exposes the frozen family constants', () => {
    expect(API_VERSION).toBe('iam.sudo.dev/v1')
    expect(KIND).toBe('OrgZoneBinding')
    expect([...PURPOSE_KNOWN]).toEqual(['default', 'office', 'core', 'shared'])
  })

  it('accepts every valid fixture', () => {
    const cases = loadCases(join('valid', 'cases.json'))
    expect(cases.length).toBeGreaterThan(0)
    for (const c of cases) {
      const result = safeParse(c.payload)
      expect(result.ok).toBeTrue()
    }
  })

  it('rejects every invalid fixture', () => {
    const cases = loadCases(join('invalid', 'cases.json'))
    expect(cases.length).toBeGreaterThan(0)
    for (const c of cases) {
      const result = safeParse(c.payload)
      expect(result.ok).toBeFalse()
    }
  })

  it('roundtrips a full payload with semantic equivalence', () => {
    for (const c of loadCases(join('roundtrip', 'cases.json'))) {
      const first = safeParse(c.payload)
      expect(first.ok).toBeTrue()
      if (!first.ok) continue
      const second = safeParse(JSON.parse(JSON.stringify(first.value)))
      expect(second.ok).toBeTrue()
      if (!second.ok) continue
      expect(second.value).toEqual(first.value as OrgZoneBinding)
    }
  })

  it('accepts unknown optional fields at the wire layer and drops them in the model', () => {
    for (const c of loadCases(join('unknown-optional', 'cases.json'))) {
      const result = safeParse(c.payload)
      expect(result.ok).toBeTrue()
      if (!result.ok) continue
      const keys = Object.keys(result.value)
      expect(keys).not.toContain('expiry_hint')
      expect(keys).not.toContain('x_internal_note')
    }
  })
})
