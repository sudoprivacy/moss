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

/**
 * Resolve workspace I/O in the runtime that owns the session's files.
 * Host and Docker sessions use the direct filesystem path and return null.
 * Derive the pod name from the session ID because the backend handle belongs
 * to the runner process, which may differ from the HTTP server process.
 */
export function resolveSessionWorkspaceAccess(
  session: SessionRecord,
  config: ServerConfig,
  runtime: Pick<RuntimeService, 'ensureSessionReady'>,
  createAccess = createPodWorkspaceAccess,
): WorkspaceFileAccess | null {
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
