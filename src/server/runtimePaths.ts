import { createHash } from 'crypto'
import { join } from 'path'
import { sanitizePath } from '../utils/sessionStoragePortable.js'
import type { ServerConfig } from './types.js'

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

export function getAttachPath(
  config: ServerConfig,
  sessionId: string,
  generation: number,
): string {
  const name = createHash('sha1')
    .update(`${sessionId}:${generation}`)
    .digest('hex')
    .slice(0, 16)
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

export function getTranscriptPath(
  configDir: string,
  cwd: string,
  sessionId: string,
): string {
  return join(configDir, 'projects', sanitizePath(cwd), `${sessionId}.jsonl`)
}
