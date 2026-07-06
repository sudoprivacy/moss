import { describe, it, expect } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'http'
import type { URL } from 'url'
import { handleSecretsRequest, setSecretsApiDependencies } from '../secretsApi.js'
import { secretSubject, orgNamespacePrefix } from '../../secrets/secretSubject.js'

// Exercises the department-credential listing in handleSecretsRequest's GET
// /secrets path. Admins/super_admins hold all privileges within the org, so
// they list every department config item regardless of their own (or absent)
// department membership; non-admins are filtered by their department's policy.
// This mirrors the auth-proxy request-time department gate.

const ORG = 'org-1'
const ORG_PREFIX = orgNamespacePrefix(ORG) // "org:org-1:"

// Two department config items live in the org. Only item 1 is whitelisted for
// the non-admin's department (see policyProvider below).
const CONFIG_ITEMS = [
  { id: 1, scope: 'department', pinyin: 'deptalpha', org_id: ORG },
  { id: 2, scope: 'department', pinyin: 'deptbeta', org_id: ORG },
  { id: 3, scope: 'system', pinyin: 'entfoo', org_id: ORG },
]

// Nexus fake: returns dept secrets only when queried under this org's role
// subject; everything else (personal, enterprise) is empty so the test isolates
// the department branch.
function makeNexus() {
  const roleSubject = secretSubject(`${ORG_PREFIX}role:`, 'ignored-user')
  return {
    async listSecrets(_namespace: string | undefined, subject?: string) {
      if (subject === roleSubject) {
        return [
          { namespace: `${ORG_PREFIX}role:deptalpha`, key: 'password', value: null, status: 'set', version: 1 },
          { namespace: `${ORG_PREFIX}role:deptbeta`, key: 'password', value: null, status: 'set', version: 1 },
        ]
      }
      return []
    },
  }
}

// Policy: the non-admin's department authorizes only config item 1 (deptalpha).
const policyProvider = {
  getAuthorizedConfigItemIds(_departmentId: string) {
    return [1]
  },
}

function setup() {
  // secretSubject(role:) ignores the userId component, so the subject the fake
  // matches on is stable regardless of caller identity.
  setSecretsApiDependencies(
    makeNexus() as never,
    policyProvider as never,
    () => CONFIG_ITEMS as never,
  )
}

interface Captured {
  status: number
  body: { success?: boolean; data?: Array<{ namespace: string; key: string }> }
}

function fakeRes(captured: Captured): ServerResponse {
  return {
    writeHead(status: number) {
      captured.status = status
      return this
    },
    end(payload?: string) {
      if (payload) captured.body = JSON.parse(payload)
      return this
    },
  } as unknown as ServerResponse
}

async function listFor(context: {
  userId: string
  orgId: string
  departmentId: string | null
  isAdmin: boolean
}): Promise<string[]> {
  setup()
  const captured: Captured = { status: 0, body: {} }
  const req = { method: 'GET' } as IncomingMessage
  await handleSecretsRequest(req, fakeRes(captured), '/secrets', {} as URL, context)
  expect(captured.status === 0 || captured.status === 200).toBe(true)
  const data = captured.body.data ?? []
  return data
    .map(s => s.namespace)
    .filter(ns => ns.includes('role:'))
    .sort()
}

describe('handleSecretsRequest GET /secrets — department listing', () => {
  it('lists every org department secret for an admin, ignoring department policy', async () => {
    const namespaces = await listFor({ userId: 'admin-1', orgId: ORG, departmentId: null, isAdmin: true })
    expect(namespaces).toEqual([`${ORG_PREFIX}role:deptalpha`, `${ORG_PREFIX}role:deptbeta`])
  })

  it('lists every org department secret for an admin who belongs to a department', async () => {
    const namespaces = await listFor({ userId: 'admin-2', orgId: ORG, departmentId: 'dept-x', isAdmin: true })
    expect(namespaces).toEqual([`${ORG_PREFIX}role:deptalpha`, `${ORG_PREFIX}role:deptbeta`])
  })

  it('filters department secrets by policy for a non-admin', async () => {
    const namespaces = await listFor({ userId: 'user-1', orgId: ORG, departmentId: 'dept-x', isAdmin: false })
    expect(namespaces).toEqual([`${ORG_PREFIX}role:deptalpha`])
  })

  it('lists no department secrets for a non-admin with no department', async () => {
    const namespaces = await listFor({ userId: 'user-2', orgId: ORG, departmentId: null, isAdmin: false })
    expect(namespaces).toEqual([])
  })
})

// Per-department credential values: the store may hold both a legacy org-wide
// value (`role:{pinyin}`) and per-department values (`role:@{deptId}:{pinyin}`).
// A non-admin sees their own department's per-dept value (which shadows the
// legacy one for the same pinyin) plus legacy values for pinyins where they have
// no per-dept value; a per-dept value for another department is hidden.
function makeNexusPerDept() {
  const roleSubject = secretSubject(`${ORG_PREFIX}role:`, 'ignored-user')
  return {
    async listSecrets(_namespace: string | undefined, subject?: string) {
      if (subject === roleSubject) {
        return [
          // deptalpha: legacy org default + a value specific to dept-x.
          { namespace: `${ORG_PREFIX}role:deptalpha`, key: 'password', value: null, status: 'set', version: 1 },
          { namespace: `${ORG_PREFIX}role:@dept-x:deptalpha`, key: 'password', value: null, status: 'set', version: 2 },
          // deptalpha: a value for a different department (must be hidden from dept-x).
          { namespace: `${ORG_PREFIX}role:@dept-y:deptalpha`, key: 'password', value: null, status: 'set', version: 1 },
        ]
      }
      return []
    },
  }
}

function setupPerDept() {
  setSecretsApiDependencies(
    makeNexusPerDept() as never,
    policyProvider as never,
    () => CONFIG_ITEMS as never,
  )
}

async function listPerDeptFor(context: {
  userId: string
  orgId: string
  departmentId: string | null
  isAdmin: boolean
}): Promise<string[]> {
  setupPerDept()
  const captured: Captured = { status: 0, body: {} }
  const req = { method: 'GET' } as IncomingMessage
  await handleSecretsRequest(req, fakeRes(captured), '/secrets', {} as URL, context)
  const data = captured.body.data ?? []
  return data.map(s => s.namespace).filter(ns => ns.includes('role:')).sort()
}

describe('handleSecretsRequest GET /secrets — per-department values', () => {
  it("shows a member their own department's value, shadowing the legacy one", async () => {
    const namespaces = await listPerDeptFor({ userId: 'u', orgId: ORG, departmentId: 'dept-x', isAdmin: false })
    // deptalpha is authorized; dept-x's per-dept value wins over the legacy one,
    // and dept-y's value is not visible.
    expect(namespaces).toEqual([`${ORG_PREFIX}role:@dept-x:deptalpha`])
  })

  it('falls back to the legacy value for a department with no per-dept value', async () => {
    const namespaces = await listPerDeptFor({ userId: 'u', orgId: ORG, departmentId: 'dept-z', isAdmin: false })
    // dept-z has no per-dept deptalpha value, so it inherits the org default.
    expect(namespaces).toEqual([`${ORG_PREFIX}role:deptalpha`])
  })

  it('an admin sees every value including all departments’ per-dept ones', async () => {
    const namespaces = await listPerDeptFor({ userId: 'a', orgId: ORG, departmentId: null, isAdmin: true })
    expect(namespaces).toEqual([
      `${ORG_PREFIX}role:@dept-x:deptalpha`,
      `${ORG_PREFIX}role:@dept-y:deptalpha`,
      `${ORG_PREFIX}role:deptalpha`,
    ])
  })
})
