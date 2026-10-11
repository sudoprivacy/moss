import {
  buildKubectlBaseArgs,
  buildResourceNames,
} from './backends/k8sBackend.js'
import {
  createPodWorkspaceAccess,
  type WorkspaceFileAccess,
} from './backends/podWorkspace.js'
import type { RuntimeService } from './runtimeService.js'
import type { ServerConfig, SessionRecord } from './types.js'
import { posix } from 'node:path'
import { ResourceAccessError } from './catalog/resourceError.js'
import { createCohostWorkspaceAccess } from './backends/cohostWorkspace.js'

/** Reject paths outside the workspace before either filesystem is accessed. */
export function normalizeWorkspaceRelativePath(value: string | null): string {
  if (!value) return ''
  if (value.includes('\0')) throw new ResourceAccessError(400, 'Invalid path')
  const normalized = value.replace(/\\/g, '/').replace(/^\.\/+/, '')
  if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/')) {
    throw new ResourceAccessError(400, 'Path must be relative')
  }
  const relativePath = posix.normalize(normalized)
  if (relativePath === '..' || relativePath.startsWith('../')) {
    throw new ResourceAccessError(400, 'Path escapes workspace root')
  }
  return relativePath
}

/**
 * Resolve workspace I/O in the runtime that owns the session's files.
 * Host and Docker sessions use the direct filesystem path and return null.
 * Derive the pod name from the session ID because the backend handle belongs
 * to the runner process, which may differ from the HTTP server process.
 */
export function resolveSessionWorkspaceAccess(
  session: SessionRecord,
  config: ServerConfig,
  runtime: Pick<RuntimeService, 'ensureSessionReady' | 'connectInternalChannel'>,
  createAccess = createPodWorkspaceAccess,
): WorkspaceFileAccess | null {
  if (session.runtime?.type === 'cohost') return createCohostWorkspaceAccess(session, runtime)
  if (session.runtime?.type !== 'k8s') return null
  return createAccess({
    kubectlBase: buildKubectlBaseArgs(
      config.k8s?.namespace || 'moss-sessions',
      config.k8s?.kubeconfig,
    ),
    podName: buildResourceNames(session.sessionId).podName,
    cwd: session.cwd,
    // A fresh ephemeral runtime may need longer than the short exec retries.
    // Join its pending startup instead of failing the first workspace request.
    // Only persistent workspaces can safely restart after their runtime exits.
    onPodUnavailable:
      config.k8s?.workspaceStorageClass || session.status === 'creating'
        ? async () => {
            await runtime.ensureSessionReady(session.sessionId)
          }
        : undefined,
  })
}
