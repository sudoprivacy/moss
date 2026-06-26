import { existsSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { serverFileConfigSchema, type ServerConfig, type ServerFileConfig } from './types.js'
import { normalizeHubApiBaseUrl } from './hubConfig.js'
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
      engine: 'scode',
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
    hub: {},
    wikiIndex: {
      enabled: true,
      modelId: 'Xenova/multilingual-e5-small',
      maxPassagesPerWiki: 20_000,
      topKVector: 50,
    },
    cabin: {
      enabled: false,
      tokenSecret: 'dev-cabin-token-secret',
      tokenTtlSeconds: 2 * 60 * 60,
      passengerInfoPrivacyLevel: 2,
      asrUrl: 'http://127.0.0.1:8002/v1/audio/transcriptions',
      asrModel: 'Qwen/Qwen3-ASR-1.7B',
      ttsUrl: 'http://127.0.0.1:8004/v1/audio/speech',
      ttsModel: 'qwen3-tts',
      ttsVoice: 'vivian',
      ttsLanguage: 'chinese',
      llmBaseUrl: 'http://127.0.0.1:8000/v1',
      llmModel: 'Qwen3.6-35B-A3B-NVFP4',
      controlTimeoutMs: 10_000,
      assistantName: 'cabin-ai-flight-attendant',
      assistantDisplayName: '客舱 AI 乘务员',
      createMossSession: false,
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
    engine: raw.runtimeDefaults.engine,
    scodePath: raw.runtimeDefaults.scodePath
      ? normalizePath(raw.runtimeDefaults.scodePath)
      : undefined,
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
    docker: {
      containerMode: raw.docker.containerMode,
      maxSessionsPerUser: raw.docker.maxSessionsPerUser,
      userContainerIdleTimeoutMs: raw.docker.userContainerIdleTimeoutMs,
      execKillGraceMs: raw.docker.execKillGraceMs,
      user: raw.docker.user,
    },
    session: {
      maxDetachedBusyMs: 2 * 60 * 60 * 1000,
    },
    startupPolicy: raw.recovery.startupPolicy,
    heartbeatTimeoutMs: raw.recovery.heartbeatTimeoutMs,
    reattachProbeTimeoutMs: raw.recovery.reattachProbeTimeoutMs,
    resumeOnMissingRuntime: raw.recovery.resumeOnMissingRuntime,
    logLevel: raw.logging.level,
    auditFile: raw.logging.auditFile
      ? normalizePath(raw.logging.auditFile)
      : undefined,
    hubApiBaseUrl: raw.hub?.apiBaseUrl
      ? normalizeHubApiBaseUrl(raw.hub.apiBaseUrl)
      : undefined,
    hubAuthorization: raw.hub?.authorization?.trim() || undefined,
    cosBaseUrl: raw.hub?.cosBaseUrl?.trim() || undefined,
    wikiIndex: {
      enabled: raw.wikiIndex.enabled && process.env.MOSS_WIKI_INDEX_DISABLED !== '1',
      modelId: raw.wikiIndex.modelId,
      modelMirror: process.env.MOSS_MODEL_MIRROR || raw.wikiIndex.modelMirror,
      maxPassagesPerWiki: raw.wikiIndex.maxPassagesPerWiki,
      topKVector: raw.wikiIndex.topKVector,
    },
    cabin: {
      enabled: process.env.CABIN_ENABLED
        ? process.env.CABIN_ENABLED === '1' || process.env.CABIN_ENABLED === 'true'
        : raw.cabin.enabled,
      tokenSecret: process.env.CABIN_TOKEN_SECRET || raw.cabin.tokenSecret,
      tokenTtlSeconds: process.env.CABIN_TOKEN_TTL_SECONDS
        ? Number.parseInt(process.env.CABIN_TOKEN_TTL_SECONDS, 10)
        : raw.cabin.tokenTtlSeconds,
      passengerInfoUrl: process.env.CABIN_PASSENGER_INFO_URL || raw.cabin.passengerInfoUrl,
      passengerInfoAuth: process.env.CABIN_PASSENGER_INFO_AUTH || raw.cabin.passengerInfoAuth,
      passengerInfoPrivacyLevel: process.env.CABIN_PASSENGER_INFO_PRIVACY_LEVEL
        ? Number.parseInt(process.env.CABIN_PASSENGER_INFO_PRIVACY_LEVEL, 10)
        : raw.cabin.passengerInfoPrivacyLevel,
      asrUrl: process.env.CABIN_ASR_URL || raw.cabin.asrUrl,
      asrModel: process.env.CABIN_ASR_MODEL || raw.cabin.asrModel,
      asrApiKey: process.env.CABIN_ASR_API_KEY || raw.cabin.asrApiKey,
      ttsUrl: process.env.CABIN_TTS_URL || raw.cabin.ttsUrl,
      ttsModel: process.env.CABIN_TTS_MODEL || raw.cabin.ttsModel,
      ttsVoice: process.env.CABIN_TTS_VOICE || raw.cabin.ttsVoice,
      ttsLanguage: process.env.CABIN_TTS_LANGUAGE || raw.cabin.ttsLanguage,
      ttsApiKey: process.env.CABIN_TTS_API_KEY || raw.cabin.ttsApiKey,
      llmBaseUrl: process.env.CABIN_LLM_BASE_URL || raw.cabin.llmBaseUrl,
      llmModel: process.env.CABIN_LLM_MODEL || raw.cabin.llmModel,
      llmApiKey: process.env.CABIN_LLM_API_KEY || raw.cabin.llmApiKey,
      controlBaseUrl: process.env.CABIN_CONTROL_BASE_URL || raw.cabin.controlBaseUrl,
      controlAuth: process.env.CABIN_CONTROL_AUTH || raw.cabin.controlAuth,
      controlTimeoutMs: process.env.CABIN_CONTROL_TIMEOUT_MS
        ? Number.parseInt(process.env.CABIN_CONTROL_TIMEOUT_MS, 10)
        : raw.cabin.controlTimeoutMs,
      assistantName: process.env.CABIN_ASSISTANT_NAME || raw.cabin.assistantName,
      assistantDisplayName:
        process.env.CABIN_ASSISTANT_DISPLAY_NAME || raw.cabin.assistantDisplayName,
      createMossSession: process.env.CABIN_CREATE_MOSS_SESSION
        ? process.env.CABIN_CREATE_MOSS_SESSION === '1' || process.env.CABIN_CREATE_MOSS_SESSION === 'true'
        : raw.cabin.createMossSession,
    },
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
