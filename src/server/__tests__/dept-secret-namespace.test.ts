import { describe, it, expect } from 'bun:test'
import {
  deptSecretNamespace,
  legacyDeptSecretNamespace,
  namespaceDeptId,
  deptNamespacePinyin,
  namespaceOrgId,
  stripOrgPrefix,
  orgScopedNamespace,
  secretSubject,
  DEPT_SECRET_SUBJECT,
} from '../secrets/secretSubject.js'

// Per-department credential values introduce a second department-namespace
// shape (`role:@{deptId}:{pinyin}`) alongside the legacy org-wide one
// (`role:{pinyin}`). The `@` marker keeps them unambiguous because a pinyin is
// validated to ^[a-z0-9_-]+$ (never `@`, never `:`) and a deptId is a UUID
// (no `:`). These helpers must round-trip both shapes, with or without an
// `org:{orgId}:` prefix.

const DEPT = '56dbd607-db21-40dc-a2ac-b495cbf01371'
const ORG = '749d5f97-2f2f-4b97-bde5-fb440712f32f'

describe('department secret namespace shapes', () => {
  it('builds a per-dept namespace with the @ marker', () => {
    expect(deptSecretNamespace(DEPT, 'wechat')).toBe(`role:@${DEPT}:wechat`)
  })

  it('builds the legacy org-wide namespace', () => {
    expect(legacyDeptSecretNamespace('wechat')).toBe('role:wechat')
  })

  it('extracts deptId only from the per-dept shape', () => {
    expect(namespaceDeptId(`role:@${DEPT}:wechat`)).toBe(DEPT)
    expect(namespaceDeptId('role:wechat')).toBeNull()
    expect(namespaceDeptId('system:foo')).toBeNull()
  })

  it('extracts deptId through an org prefix', () => {
    const ns = orgScopedNamespace(deptSecretNamespace(DEPT, 'wechat'), ORG)
    expect(ns).toBe(`org:${ORG}:role:@${DEPT}:wechat`)
    expect(namespaceDeptId(ns)).toBe(DEPT)
    expect(namespaceOrgId(ns)).toBe(ORG)
  })

  it('recovers the pinyin from both shapes (org-prefixed or not)', () => {
    expect(deptNamespacePinyin(`role:@${DEPT}:wechat`)).toBe('wechat')
    expect(deptNamespacePinyin('role:wechat')).toBe('wechat')
    expect(deptNamespacePinyin(`org:${ORG}:role:@${DEPT}:wechat`)).toBe('wechat')
    expect(deptNamespacePinyin(`org:${ORG}:role:wechat`)).toBe('wechat')
  })

  it('handles pinyins with a hyphen/underscore (still colon-free)', () => {
    expect(deptNamespacePinyin(`role:@${DEPT}:we-chat_v2`)).toBe('we-chat_v2')
    expect(namespaceDeptId(`role:@${DEPT}:we-chat_v2`)).toBe(DEPT)
  })

  it('keeps the subject department-agnostic (keyed by org) for both shapes', () => {
    // The namespace carries the department, so the Nexus subject stays org-wide;
    // migration and cross-shape fallback rely on this.
    const perDept = orgScopedNamespace(deptSecretNamespace(DEPT, 'wechat'), ORG)
    const legacy = orgScopedNamespace(legacyDeptSecretNamespace('wechat'), ORG)
    expect(secretSubject(perDept, 'someuser')).toBe(`${DEPT_SECRET_SUBJECT}:${ORG}`)
    expect(secretSubject(legacy, 'someuser')).toBe(`${DEPT_SECRET_SUBJECT}:${ORG}`)
  })

  it('stripOrgPrefix leaves a bare namespace unchanged', () => {
    expect(stripOrgPrefix(`role:@${DEPT}:wechat`)).toBe(`role:@${DEPT}:wechat`)
    expect(stripOrgPrefix(`org:${ORG}:role:@${DEPT}:wechat`)).toBe(`role:@${DEPT}:wechat`)
  })
})
