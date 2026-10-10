import { describe, expect, it } from 'bun:test'
import {
  PodExecError,
  withPodReadinessRetry,
} from '../backends/podWorkspace.js'
import { normalizeWorkspaceRelativePath, resolveSessionWorkspaceAccess } from '../sessionWorkspace.js'
import type { ServerConfig, SessionRecord } from '../types.js'

describe('workspace path validation', () => {
  for (const path of [
    '../outside',
    'a/../../outside',
    '..\\outside',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    'C:outside',
    '\\\\host\\share',
    'a\0.txt',
  ]) {
    it(`rejects ${JSON.stringify(path)} before file access`, () => {
      expect(() => normalizeWorkspaceRelativePath(path)).toThrow()
      try {
        normalizeWorkspaceRelativePath(path)
      } catch (error) {
        expect((error as { statusCode: number }).statusCode).toBe(400)
      }
    })
  }
  it('keeps ordinary paths and normalizes safe relative segments', () => {
    expect(normalizeWorkspaceRelativePath(null)).toBe('')
    expect(normalizeWorkspaceRelativePath('./reports\\draft.txt')).toBe('reports/draft.txt')
    expect(normalizeWorkspaceRelativePath('reports/../draft.txt')).toBe('draft.txt')
  })
})

describe('workspace access during runtime startup', () => {
  const config = { k8s: { namespace: 'moss-sessions' } } as ServerConfig
  const session = {
    sessionId: 'starting-session',
    cwd: '/workspace/starting-session',
    runtime: { type: 'k8s' },
    status: 'creating',
  } as SessionRecord

  it('waits for an ephemeral runtime to become ready before returning its files', async () => {
    let isReady = false
    let isReadFinished = false
    let onReady!: () => void
    let onStartupJoined!: () => void
    const ready = new Promise<void>((resolve) => {
      onReady = resolve
    })
    const joined = new Promise<void>((resolve) => {
      onStartupJoined = resolve
    })
    const expected = [{ relativePath: 'report.txt', isDir: false, size: 12 }]
    const access = resolveSessionWorkspaceAccess(
      session,
      config,
      {
        ensureSessionReady: async (id) => {
          expect(id).toBe(session.sessionId)
          onStartupJoined()
          await ready
          isReady = true
          return { session, attempt: {} } as never
        },
      },
      (target) => ({
        listTree: async () => {
          const result = await withPodReadinessRetry(async () => {
            if (!isReady)
              throw new PodExecError(
                'exec failed',
                1,
                'unable to upgrade connection: container not found ("scode")',
              )
            return Buffer.from(JSON.stringify(expected))
          }, target.onPodUnavailable)
          isReadFinished = true
          return JSON.parse(result.toString())
        },
        readFile: async () => Buffer.from('report bytes'),
        writeFile: async () => {},
      }),
    )!
    const reading = access.listTree(2)
    await joined
    expect(isReadFinished).toBe(false)
    onReady()
    expect(await reading).toEqual(expected)
  })

  it('does not recreate an ended ephemeral workspace when files are unavailable', async () => {
    let restores = 0
    const failure = new PodExecError(
      'exec failed',
      1,
      'pods "scode-ended" not found',
    )
    const access = resolveSessionWorkspaceAccess(
      { ...session, status: 'ended' },
      config,
      {
        ensureSessionReady: async () => {
          restores++
          return { session, attempt: {} } as never
        },
      },
      (target) => ({
        listTree: async () => {
          await withPodReadinessRetry(async () => {
            throw failure
          }, target.onPodUnavailable)
          return []
        },
        readFile: async () => Buffer.alloc(0),
        writeFile: async () => {},
      }),
    )!
    await expect(access.listTree(2)).rejects.toBe(failure)
    expect(restores).toBe(0)
  })
})
