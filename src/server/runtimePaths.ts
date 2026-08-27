import { createHash } from 'crypto'
import { dirname, join, resolve } from 'path'
import type { ServerConfig } from './types.js'

export function isNamedPipePath(path: string): boolean {
  return path.startsWith('\\\\.\\pipe\\')
}

export function getAttemptDir(
  config: ServerConfig,
  sessionId: string,
  generation: number,
): string {
  return join(
    config.runtimeDir,
    'sessions',
    sessionId,
    `attempt-${String(generation).padStart(4, '0')}`,
  )
}

export function getSessionWorkspaceDir(
  config: ServerConfig,
  sessionId: string,
): string {
  return join(config.runtimeDir, 'sessions', sessionId, 'workspace')
}

export function getAttachPath(
  config: ServerConfig,
  sessionId: string,
  generation: number,
): string {
  const name = createHash('sha1')
    .update(`${config.runtimeDir}:${sessionId}:${generation}`)
    .digest('hex')
    .slice(0, 16)
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\moss-session-${name}`
  }
  return join(config.runtimeDir, 'sock', `${name}.sock`)
}

export function getRuntimeStatusPath(
  config: ServerConfig,
  sessionId: string,
  generation: number,
): string {
  return join(getAttemptDir(config, sessionId, generation), 'status.json')
}

export function getRuntimeStdoutLogPath(
  config: ServerConfig,
  sessionId: string,
  generation: number,
): string {
  return join(getAttemptDir(config, sessionId, generation), 'stdout.log')
}

export function getRuntimeStderrLogPath(
  config: ServerConfig,
  sessionId: string,
  generation: number,
): string {
  return join(getAttemptDir(config, sessionId, generation), 'stderr.log')
}

export function getSessionConfigDir(
  config: ServerConfig,
  sessionId: string,
  userId: string,
  mode: 'session' | 'user' | undefined,
): string {
  if (mode === 'user') {
    return join(config.runtimeDir, 'users', userId, 'config')
  }
  return join(config.runtimeDir, 'sessions', sessionId, 'config')
}

/**
 * Transcript path is anchored to the session runtime directory so it survives
 * configDir cleanup at session destroy. Layout:
 *   <runtimeDir>/sessions/<sessionId>/transcript/<transcriptSessionId>.jsonl
 *
 * sessionId already provides per-session isolation, so cwd is no longer part
 * of the path.
 */
export function getTranscriptPath(
  runtimeDir: string,
  sessionId: string,
  transcriptSessionId: string,
): string {
  return join(
    runtimeDir,
    'sessions',
    sessionId,
    'transcript',
    `${transcriptSessionId}.jsonl`,
  )
}

export function getSessionTranscriptDir(
  runtimeDir: string,
  sessionId: string,
): string {
  return join(runtimeDir, 'sessions', sessionId, 'transcript')
}

export function getSessionRuntimeMetaDir(
  runtimeDir: string,
  sessionId: string,
): string {
  return join(runtimeDir, 'sessions', sessionId, 'runtime')
}

export function getSessionTmpDir(
  runtimeDir: string,
  sessionId: string,
): string {
  return join(runtimeDir, 'sessions', sessionId, 'tmp')
}

export function getSessionScodeHomeDir(
  runtimeDir: string,
  sessionId: string,
): string {
  return join(runtimeDir, 'sessions', sessionId, 'scode-home', '.nexus', 'sudocode')
}

export function getInContainerPidFile(
  runtimeDir: string,
  sessionId: string,
): string {
  return join(runtimeDir, 'sessions', sessionId, 'runtime', 'scode.pid')
}

/**
 * Decide whether a caller-supplied session cwd may be used as-is.
 *
 * A session's cwd is bind-mounted into the runtime container, so pointing it at
 * moss-server's own working directory hands the agent the whole server tree:
 * `data/runtime/sessions/**` (every session's transcript and manifest, including
 * the JWTs in them), `data/moss.db`, and any scratch files other assistants left
 * in that directory. It also makes the cwd shared across sessions, which defeats
 * per-session workspace isolation — scode keys its own session store on the
 * workspace path, so two assistants sharing a cwd share one scode session bucket
 * and can read each other's history.
 *
 * Reject anything at or above the runtime/storage roots, plus the server's own
 * process cwd. Callers fall back to the per-session workspace dir.
 */
export function isSafeSessionCwd(config: ServerConfig, cwd: string): boolean {
  const normalize = (p: string) => resolve(p).replace(/\/+$/, '') || '/'
  const target = normalize(cwd)
  if (target === '/') return false

  // `target` is unsafe if it IS, or CONTAINS, a protected root. Being *inside*
  // one is fine: the per-session workspace lives under runtimeDir.
  const protectedRoots = [
    config.runtimeDir,
    config.rootDir,
    dirname(config.dbPath),
    process.cwd(),
  ].filter(Boolean)

  for (const root of protectedRoots) {
    const normalizedRoot = normalize(root)
    if (target === normalizedRoot) return false
    if (normalizedRoot.startsWith(`${target}/`)) return false
  }
  return true
}
