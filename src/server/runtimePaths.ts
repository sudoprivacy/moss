import { createHash } from 'crypto'
import { join } from 'path'
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
