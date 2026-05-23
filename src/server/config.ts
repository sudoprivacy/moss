import { existsSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { serverFileConfigSchema, type ServerConfig, type ServerFileConfig } from './types.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { expandPath } from '../utils/path.js'

export function getDefaultServerConfigPath(): string {
  return join(getClaudeConfigHomeDir(), 'server', 'server.json')
}

function getDefaultStoragePaths(): {
  rootDir: string
  dbPath: string
  transcriptDir: string
  runtimeDir: string
} {
  const baseDir = join(getClaudeConfigHomeDir(), 'server')
  return {
    rootDir: baseDir,
    dbPath: join(baseDir, 'moss.db'),
    transcriptDir: join(baseDir, 'transcripts'),
    runtimeDir: join(baseDir, 'runtime'),
  }
}

export function getDefaultServerConfig(): ServerFileConfig {
  const storage = getDefaultStoragePaths()
  return {
    server: {
      host: '0.0.0.0',
      port: 43127,
    },
    auth: {
      mode: 'local',
      tokenTtlSec: 60 * 60,
    },
    bootstrapAdmin: {
      username: 'admin',
    },
    storage: {
      rootDir: storage.rootDir,
      dbPath: storage.dbPath,
      transcriptDir: storage.transcriptDir,
      runtimeDir: storage.runtimeDir,
    },
    runtimeDefaults: {
      type: 'host',
      dockerMode: 'session',
      idleTimeoutMs: 10 * 60 * 1000,
      maxSessions: 32,
    },
    docker: {
      stopTimeoutSec: 10,
      labels: {},
    },
    recovery: {
      startupPolicy: 'reattach-or-resume',
      heartbeatTimeoutMs: 30_000,
      reattachProbeTimeoutMs: 3_000,
      resumeOnMissingRuntime: true,
    },
    logging: {
      level: 'info',
    },
  }
}

function normalizePath(input: string): string {
  return expandPath(input)
}

function resolveServerConfig(raw: ServerFileConfig): ServerConfig {
  const defaultStorage = getDefaultStoragePaths()
  return {
    host: raw.server.host,
    port: raw.server.port,
    advertisedHost: raw.server.advertisedHost,
    authMode: 'local',
    tokenTtlSec: raw.auth.tokenTtlSec,
    bootstrapAdmin: {
      username: raw.bootstrapAdmin.username,
      password: raw.bootstrapAdmin.password,
      email: raw.bootstrapAdmin.email,
    },
    workspace: raw.runtimeDefaults.workspace
      ? normalizePath(raw.runtimeDefaults.workspace)
      : undefined,
    defaultRuntime: raw.runtimeDefaults.type,
    dockerImage: raw.runtimeDefaults.dockerImage,
    dockerMode: raw.runtimeDefaults.dockerMode,
    idleTimeoutMs: raw.runtimeDefaults.idleTimeoutMs,
    maxSessions: raw.runtimeDefaults.maxSessions,
    rootDir: raw.storage.rootDir
      ? normalizePath(raw.storage.rootDir)
      : defaultStorage.rootDir,
    dbPath: raw.storage.dbPath
      ? normalizePath(raw.storage.dbPath)
      : defaultStorage.dbPath,
    transcriptDir: raw.storage.transcriptDir
      ? normalizePath(raw.storage.transcriptDir)
      : defaultStorage.transcriptDir,
    runtimeDir: raw.storage.runtimeDir
      ? normalizePath(raw.storage.runtimeDir)
      : defaultStorage.runtimeDir,
    dockerNetwork: raw.docker.network,
    dockerStopTimeoutSec: raw.docker.stopTimeoutSec,
    dockerLabels: raw.docker.labels,
    startupPolicy: raw.recovery.startupPolicy,
    heartbeatTimeoutMs: raw.recovery.heartbeatTimeoutMs,
    reattachProbeTimeoutMs: raw.recovery.reattachProbeTimeoutMs,
    resumeOnMissingRuntime: raw.recovery.resumeOnMissingRuntime,
    logLevel: raw.logging.level,
    auditFile: raw.logging.auditFile
      ? normalizePath(raw.logging.auditFile)
      : undefined,
  }
}

export async function readServerConfig(
  configPath = process.env.MOSS_SERVER_CONFIG || getDefaultServerConfigPath(),
): Promise<{
  configPath: string
  config: ServerConfig
}> {
  const resolvedConfigPath = normalizePath(configPath)

  // Check if config file exists
  if (!existsSync(resolvedConfigPath)) {
    // Create default config file and parent directory
    const defaultConfig = getDefaultServerConfig()
    await mkdir(dirname(resolvedConfigPath), { recursive: true })
    await writeFile(resolvedConfigPath, JSON.stringify(defaultConfig, null, 2), 'utf8')

    process.stderr.write(`\nCreated default config at: ${resolvedConfigPath}\n`)
    process.stderr.write(`Please edit the config file to customize settings.\n`)
    process.stderr.write(`Note: bootstrapAdmin.password should be set before first login.\n\n`)

    return {
      configPath: resolvedConfigPath,
      config: resolveServerConfig(defaultConfig),
    }
  }

  const rawText = await readFile(resolvedConfigPath, 'utf8')
  const parsed = rawText.trim()
    ? (JSON.parse(rawText) as Record<string, unknown>)
    : {}
  const result = serverFileConfigSchema().safeParse(parsed)
  if (!result.success) {
    throw new Error(`Invalid server config at ${resolvedConfigPath}: ${result.error.message}`)
  }
  return {
    configPath: resolvedConfigPath,
    config: resolveServerConfig(result.data),
  }
}

export async function ensureServerDirectories(config: ServerConfig): Promise<void> {
  await Promise.all([
    mkdir(config.rootDir, { recursive: true }),
    mkdir(dirname(config.dbPath), { recursive: true }),
    mkdir(config.transcriptDir, { recursive: true }),
    mkdir(config.runtimeDir, { recursive: true }),
    config.auditFile ? mkdir(dirname(config.auditFile), { recursive: true }) : Promise.resolve(),
  ])
}