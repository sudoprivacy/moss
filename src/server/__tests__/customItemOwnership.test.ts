import { describe, expect, it } from 'bun:test'
import {
  customItemOwnerId,
  isVisibleTo,
  withOwnerVisibility,
  type VisibilityFilter,
} from '../visibilityFilter.js'

/**
 * Custom skills/agents (created from the SudoWork client) belong to their
 * creator, who may now change their visibility. Ownership therefore can't be
 * read from visible_to alone, and narrowing visibility must never hide an item
 * from its own creator.
 */

const OWNER = 'owner-1'
const viewer = (userId: string, departmentIds: string[] = []): VisibilityFilter => ({
  isAdmin: false,
  userId,
  departmentId: departmentIds[0] ?? null,
  visibleDepartmentIds: new Set(departmentIds),
})

describe('customItemOwnerId', () => {
  it('prefers author_id', () => {
    expect(customItemOwnerId({ source_type: 'custom', author_id: OWNER, visible_to: null })).toBe(OWNER)
  })

  it('falls back to the lone visible_to user for legacy items', () => {
    expect(customItemOwnerId({ source_type: 'custom', visible_to: { user_ids: [OWNER], department_ids: null } })).toBe(OWNER)
  })

  it('has no owner when legacy visibility is not a single user', () => {
    expect(customItemOwnerId({ source_type: 'custom', visible_to: null })).toBeNull()
    expect(customItemOwnerId({ source_type: 'custom', visible_to: { user_ids: ['a', 'b'] } })).toBeNull()
    expect(customItemOwnerId({ source_type: 'custom', visible_to: { user_ids: ['admin'] } })).toBeNull()
  })

  it('is null for non-custom items even with author_id', () => {
    expect(customItemOwnerId({ source_type: 'tenant', author_id: OWNER })).toBeNull()
    expect(customItemOwnerId({ source_type: 'hub', author_id: OWNER })).toBeNull()
    expect(customItemOwnerId(null)).toBeNull()
  })
})

describe('withOwnerVisibility', () => {
  it('keeps "everyone" as everyone', () => {
    expect(withOwnerVisibility(null, OWNER)).toBeNull()
  })

  it('keeps the owner visible under an admin-only scope, and no one else', () => {
    const v = withOwnerVisibility({ department_ids: [], user_ids: [] }, OWNER)
    expect(isVisibleTo(v, viewer(OWNER))).toBe(true)
    expect(isVisibleTo(v, viewer('other', ['d1']))).toBe(false)
  })

  it('adds the owner to a department scope without dropping the department', () => {
    const v = withOwnerVisibility({ department_ids: ['d1'], user_ids: null }, OWNER)
    expect(isVisibleTo(v, viewer(OWNER, ['d2']))).toBe(true)
    expect(isVisibleTo(v, viewer('member', ['d1']))).toBe(true)
    expect(isVisibleTo(v, viewer('outsider', ['d2']))).toBe(false)
  })

  it('adds the owner to a user list that omits them', () => {
    const v = withOwnerVisibility({ department_ids: null, user_ids: ['friend'] }, OWNER)
    expect(isVisibleTo(v, viewer(OWNER))).toBe(true)
    expect(isVisibleTo(v, viewer('friend'))).toBe(true)
    expect(isVisibleTo(v, viewer('stranger'))).toBe(false)
  })

  it('is a no-op without an owner', () => {
    const scope = { department_ids: ['d1'], user_ids: null }
    expect(withOwnerVisibility(scope, null)).toEqual(scope)
  })
})
