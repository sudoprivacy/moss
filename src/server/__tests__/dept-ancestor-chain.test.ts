import { describe, it, expect } from 'bun:test'
import { getDepartmentAncestorChain } from '../visibilityFilter.js'

// Hierarchical department-credential inheritance resolves a consumer's value by
// walking the ORDERED department chain (self first, then parents up to the
// root). getDepartmentAncestorChain produces that order; a cycle must not loop.

const DEPTS = [
  { id: 'company', parentId: null },
  { id: 'sales', parentId: 'company' },
  { id: 'sales-eu', parentId: 'sales' },
  { id: 'sales-us', parentId: 'sales' },
  { id: 'eng', parentId: 'company' },
]
const list = () => DEPTS

describe('getDepartmentAncestorChain', () => {
  it('returns self-first, then each parent up to the root', () => {
    expect(getDepartmentAncestorChain('org', 'sales-eu', list)).toEqual(['sales-eu', 'sales', 'company'])
  })

  it('a top-level department is just itself', () => {
    expect(getDepartmentAncestorChain('org', 'company', list)).toEqual(['company'])
  })

  it('a mid-level department stops at the root', () => {
    expect(getDepartmentAncestorChain('org', 'sales', list)).toEqual(['sales', 'company'])
  })

  it('null department yields an empty chain', () => {
    expect(getDepartmentAncestorChain('org', null, list)).toEqual([])
  })

  it('an unknown department yields an empty chain', () => {
    expect(getDepartmentAncestorChain('org', 'ghost', list)).toEqual([])
  })

  it('guards against a parent cycle (no infinite loop)', () => {
    const cyclic = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ]
    const chain = getDepartmentAncestorChain('org', 'a', () => cyclic)
    expect(chain).toEqual(['a', 'b'])
  })
})
