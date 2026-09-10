/**
 * Workspace file access for pod-hosted sessions, over `kubectl exec`.
 *
 * A pod's workspace is an emptyDir: it exists only inside the pod, on whatever
 * node the pod landed on. moss cannot reach it through its own filesystem — the
 * host path of the same name is a different, empty directory. Every workspace
 * read and write for such a session therefore has to go through the pod.
 *
 * `exec` rather than `cp`: `kubectl cp` shells out to tar over the same exec
 * channel anyway, and staging a copy on moss would immediately be stale — the
 * agent keeps writing while the user browses.
 *
 * Paths are passed as argv, never interpolated into the shell command, so a
 * filename containing a quote or a space cannot alter the command that runs.
 */
import { spawn } from 'child_process'

/**
 * Reads and writes a session workspace as the *agent* sees it, for backends
 * where that is not moss's own filesystem.
 */
export type WorkspaceFileAccess = {
  /** Every entry under the workspace root, relative to it, `..`-free. */
  listTree(maxDepth: number): Promise<WorkspaceRemoteEntry[]>
  readFile(relativePath: string): Promise<Buffer>
  writeFile(relativePath: string, content: Buffer): Promise<void>
}

export type WorkspaceRemoteEntry = {
  /** Slash-separated, relative to the workspace root. */
  relativePath: string
  isDir: boolean
  size: number
}

/** Structurally the workspace node the HTTP layer serves; kept local so this module stays independent of it. */
export type WorkspaceTreeNode = {
  name: string
  relativePath: string
  fullPath: string
  isFile: boolean
  isDir: boolean
  size?: number
  mtime?: number
  children?: WorkspaceTreeNode[]
}

/** The listing limits are the HTTP layer's policy, passed in rather than repeated here. */
export type WorkspaceTreePolicy = {
  skipDirs: Set<string>
  maxEntriesPerDir: number
}

/** Guards against a pod that hangs; every call is a short interactive operation. */
const EXEC_TIMEOUT_MS = 30_000

export type PodWorkspaceTarget = {
  kubectlBase: string[]
  podName: string
  /** The workspace root *inside the pod*. */
  cwd: string
}

class PodExecError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(stderr.trim() ? `${message}: ${stderr.trim()}` : message)
    this.name = 'PodExecError'
  }
}

function execInPod(
  target: PodWorkspaceTarget,
  argv: string[],
  stdin?: Buffer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'kubectl',
      [...target.kubectlBase, 'exec', '-i', target.podName, '--', ...argv],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )

    const out: Buffer[] = []
    const err: Buffer[] = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`kubectl exec timed out after ${EXEC_TIMEOUT_MS}ms`))
    }, EXEC_TIMEOUT_MS)

    child.stdout.on('data', chunk => out.push(chunk as Buffer))
    child.stderr.on('data', chunk => err.push(chunk as Buffer))
    child.once('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve(Buffer.concat(out))
      else reject(new PodExecError(`kubectl exec exited ${code}`, Buffer.concat(err).toString()))
    })

    if (stdin) child.stdin.end(stdin)
    else child.stdin.end()
  })
}

/**
 * `stat -c` output is parsed rather than `ls`: it is a stable, field-delimited
 * format, whereas `ls` output varies by locale and pads columns. The runtime
 * image was checked to carry `find` and `stat`.
 */
const STAT_FORMAT = '%F|%s|%n'

export function parseStatLines(raw: string, root: string): WorkspaceRemoteEntry[] {
  const entries: WorkspaceRemoteEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    // Split on the first two separators only: a filename may contain '|'.
    const first = line.indexOf('|')
    const second = line.indexOf('|', first + 1)
    if (first < 0 || second < 0) continue
    const kind = line.slice(0, first)
    const size = Number(line.slice(first + 1, second))
    const path = line.slice(second + 1)

    const relative = toRelative(path, root)
    // The root itself comes back as '.' — it is the container, not an entry.
    if (relative === null || relative === '') continue
    entries.push({
      relativePath: relative,
      isDir: kind === 'directory',
      size: Number.isFinite(size) ? size : 0,
    })
  }
  return entries
}

function toRelative(path: string, root: string): string | null {
  let rest: string
  if (path.startsWith('./')) rest = path.slice(2)
  else if (path === '.') rest = ''
  else if (path === root) rest = ''
  else if (path.startsWith(`${root}/`)) rest = path.slice(root.length + 1)
  else return null
  // A '..' segment here would mean the pod returned something outside the root;
  // drop it rather than hand it to a caller that will resolve it.
  if (rest.split('/').includes('..')) return null
  return rest
}

export function createPodWorkspaceAccess(target: PodWorkspaceTarget): WorkspaceFileAccess {
  return {
    async listTree(maxDepth: number): Promise<WorkspaceRemoteEntry[]> {
      // `-exec … +` batches, so this is one stat process for the whole tree
      // rather than one per file. A missing root is an empty workspace, not an
      // error: the pod may not have written anything yet.
      const script =
        'cd "$1" 2>/dev/null || exit 0; find . -maxdepth "$2" -exec stat -c "$3" {} + 2>/dev/null || true'
      const raw = await execInPod(target, [
        'sh', '-c', script, 'sh', target.cwd, String(maxDepth), STAT_FORMAT,
      ])
      return parseStatLines(raw.toString('utf8'), target.cwd)
    },

    async readFile(relativePath: string): Promise<Buffer> {
      // `cat` writes bytes straight to stdout; `exec` without a TTY keeps the
      // stream binary-clean, so this is safe for images and archives too.
      return execInPod(target, ['cat', '--', joinInPod(target.cwd, relativePath)])
    },

    async writeFile(relativePath: string, content: Buffer): Promise<void> {
      const script = 'mkdir -p "$(dirname "$1")" && cat > "$1"'
      await execInPod(
        target,
        ['sh', '-c', script, 'sh', joinInPod(target.cwd, relativePath)],
        content,
      )
    },
  }
}

/**
 * Joins inside the pod's filesystem, which is POSIX regardless of the OS moss
 * runs on — `path.join` would emit backslashes on Windows.
 */
export function joinInPod(root: string, relativePath: string): string {
  const clean = relativePath.replace(/^\/+/, '')
  if (clean.split('/').includes('..')) {
    throw new Error(`Path escapes workspace root: ${relativePath}`)
  }
  return `${root.replace(/\/+$/, '')}/${clean}`
}

/**
 * Assemble the tree the UI expects from the flat listing a remote workspace
 * returns. The direct-fs path walks directories as it goes; a pod listing costs
 * one exec, so it is fetched whole and shaped here instead.
 */
export function buildRemoteWorkspaceTree(
  entries: WorkspaceRemoteEntry[],
  root: string,
  subPath: string,
  search: string,
  policy: WorkspaceTreePolicy,
): WorkspaceTreeNode {
  const podPath = (relative: string) => (relative ? `${root}/${relative}` : root)
  const makeNode = (relative: string, isDir: boolean, size: number): WorkspaceTreeNode => ({
    name: relative ? relative.slice(relative.lastIndexOf('/') + 1) : root.slice(root.lastIndexOf("/") + 1) || root,
    relativePath: relative,
    fullPath: podPath(relative),
    isFile: !isDir,
    isDir,
    size,
  })

  const prefix = subPath ? `${subPath}/` : ''
  const nodes = new Map<string, WorkspaceTreeNode>()
  const rootNode = makeNode(subPath, true, 0)
  rootNode.children = []
  nodes.set(subPath, rootNode)

  const visible = entries
    .filter(e => (prefix ? e.relativePath.startsWith(prefix) : true))
    .filter(e => !e.relativePath.split('/').some(seg => policy.skipDirs.has(seg)))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))

  for (const entry of visible) {
    const node = makeNode(entry.relativePath, entry.isDir, entry.size)
    if (entry.isDir) node.children = []
    nodes.set(entry.relativePath, node)
  }

  // Parents are attached after every node exists, so an entry never has to wait
  // for its directory to appear later in the listing.
  for (const entry of visible) {
    const node = nodes.get(entry.relativePath)
    if (!node) continue
    const cut = entry.relativePath.lastIndexOf('/')
    const parentPath = cut < 0 ? '' : entry.relativePath.slice(0, cut)
    const parent = nodes.get(parentPath) ?? rootNode
    if (!parent.children) parent.children = []
    if (parent.children.length < policy.maxEntriesPerDir) parent.children.push(node)
  }

  for (const node of nodes.values()) {
    node.children?.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }

  if (!search) return rootNode
  return pruneToSearch(rootNode, search) ?? { ...rootNode, children: [] }
}

function pruneToSearch(node: WorkspaceTreeNode, search: string): WorkspaceTreeNode | null {
  const children = (node.children ?? [])
    .map(child => pruneToSearch(child, search))
    .filter((child): child is WorkspaceTreeNode => child !== null)
  const matches =
    node.name.toLowerCase().includes(search) || node.relativePath.toLowerCase().includes(search)
  if (!matches && children.length === 0) return null
  return node.children ? { ...node, children } : node
}
