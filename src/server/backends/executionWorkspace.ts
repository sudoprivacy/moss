import { posix, win32 } from 'node:path'

export interface ExecutionWorkspace {
  repository: string
  workingRoot: string
  shellRoot?: string
}

/** Read the engine's actual roots from additive ACP session response metadata. */
export function readAcpExecutionWorkspace(result: unknown, repository?: string): ExecutionWorkspace | undefined {
  const workspace = (result as { _meta?: { sudocode?: { workspace?: unknown } } } | null)?._meta?.sudocode?.workspace
  if (workspace === undefined) return undefined
  const { fileRoot, shellRoot } = (workspace ?? {}) as { fileRoot?: unknown; shellRoot?: unknown }
  const isAbsolutePath = (value: unknown): value is string => typeof value === 'string' &&
    !value.includes('\0') && (posix.isAbsolute(value) || win32.isAbsolute(value))
  if (!isAbsolutePath(fileRoot) || !isAbsolutePath(shellRoot)) {
    throw new Error('Invalid ACP execution workspace metadata')
  }
  return { repository: fileRoot === shellRoot ? fileRoot : repository ?? fileRoot, workingRoot: fileRoot, shellRoot }
}
