import { describe, expect, it } from 'bun:test'
import { buildRemoteWorkspaceTree, joinInPod, parseStatLines } from '../backends/podWorkspace.js'

const POLICY = { skipDirs: new Set(['.git', 'node_modules']), maxEntriesPerDir: 500 }

/**
 * A pod-hosted session writes into the pod's emptyDir. moss cannot reach that
 * through its own filesystem — the host path of the same name is a different,
 * empty directory — so before this existed the workspace file tree showed
 * nothing the agent produced and an upload landed where the agent could not
 * read it. Neither failed loudly: both paths exist, so both calls succeeded and
 * returned the wrong filesystem.
 *
 * These cover the parts that translate between the pod's view and the UI's.
 */

const ROOT = '/workspace/session-1'

describe('pod stat output', () => {
  it('reads type, size and path out of the listing', () => {
    const entries = parseStatLines(
      [
        'directory|4096|.',
        'directory|4096|./src',
        'regular file|128|./src/main.ts',
        'regular file|0|./empty.txt',
      ].join('\n'),
      ROOT,
    )

    // '.' is the workspace root itself — the container, not an entry in it.
    expect(entries).toEqual([
      { relativePath: 'src', isDir: true, size: 4096 },
      { relativePath: 'src/main.ts', isDir: false, size: 128 },
      { relativePath: 'empty.txt', isDir: false, size: 0 },
    ])
  })

  it('keeps a filename that contains the field separator', () => {
    // Only the first two separators delimit fields; the rest belong to the name.
    const entries = parseStatLines('regular file|7|./a|b.txt', ROOT)
    expect(entries).toEqual([{ relativePath: 'a|b.txt', isDir: false, size: 7 }])
  })

  it('accepts absolute paths as well as dot-relative ones', () => {
    const entries = parseStatLines(`regular file|3|${ROOT}/notes.md`, ROOT)
    expect(entries[0]?.relativePath).toBe('notes.md')
  })

  it('drops anything that resolves outside the workspace root', () => {
    const entries = parseStatLines(
      ['regular file|1|./../escape.txt', 'regular file|1|/etc/passwd'].join('\n'),
      ROOT,
    )
    expect(entries).toEqual([])
  })
})

describe('pod path joining', () => {
  it('builds POSIX paths regardless of the host OS', () => {
    expect(joinInPod(ROOT, 'src/main.ts')).toBe(`${ROOT}/src/main.ts`)
    expect(joinInPod(`${ROOT}/`, '/leading.txt')).toBe(`${ROOT}/leading.txt`)
  })

  it('refuses to build a path that escapes the root', () => {
    expect(() => joinInPod(ROOT, '../../etc/passwd')).toThrow(/escapes workspace root/)
  })
})

describe('remote workspace tree', () => {
  const entries = [
    { relativePath: 'report.md', isDir: false, size: 10 },
    { relativePath: 'src', isDir: true, size: 4096 },
    { relativePath: 'src/main.ts', isDir: false, size: 128 },
    { relativePath: 'src/util.ts', isDir: false, size: 64 },
    { relativePath: 'node_modules', isDir: true, size: 4096 },
    { relativePath: 'node_modules/pkg/index.js', isDir: false, size: 1 },
  ]

  it('nests children under their directory and lists directories first', () => {
    const root = buildRemoteWorkspaceTree(entries, ROOT, '', '', POLICY)
    const names = (root.children ?? []).map(c => c.name)
    // 'src' before 'report.md': directories sort ahead of files.
    expect(names).toEqual(['src', 'report.md'])

    const src = root.children?.find(c => c.name === 'src')
    expect((src?.children ?? []).map(c => c.name)).toEqual(['main.ts', 'util.ts'])
    expect(src?.children?.[0]?.size).toBe(128)
  })

  it('omits the directories the workspace tree always skips', () => {
    const root = buildRemoteWorkspaceTree(entries, ROOT, '', '', POLICY)
    expect((root.children ?? []).some(c => c.name === 'node_modules')).toBe(false)
  })

  it('reports paths inside the pod, not on the moss host', () => {
    const root = buildRemoteWorkspaceTree(entries, ROOT, '', '', POLICY)
    const src = root.children?.find(c => c.name === 'src')
    expect(src?.fullPath).toBe(`${ROOT}/src`)
    expect(src?.relativePath).toBe('src')
  })

  it('scopes the tree to a subdirectory when one is asked for', () => {
    const root = buildRemoteWorkspaceTree(entries, ROOT, 'src', '', POLICY)
    expect((root.children ?? []).map(c => c.name)).toEqual(['main.ts', 'util.ts'])
  })

  it('keeps only matches and the directories leading to them when searching', () => {
    const root = buildRemoteWorkspaceTree(entries, ROOT, '', 'util', POLICY)
    const src = root.children?.find(c => c.name === 'src')
    expect(root.children?.length).toBe(1)
    expect((src?.children ?? []).map(c => c.name)).toEqual(['util.ts'])
  })
})
