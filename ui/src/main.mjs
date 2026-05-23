import electron from 'electron';
const { app, BrowserWindow, dialog, ipcMain, screen, shell, Menu } = electron;
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { getInstalledSkills, registerSkillStoreIpcHandlers, SKILL_SEARCH_DIRS } from './skill-store-ipc.mjs';
import { registerAgentIpcHandlers } from './agent-ipc.mjs';
import {
  createMossAppEventHandler,
  deleteStoredApp,
  getStoredApp,
  listAppVersionSnapshots,
  listStoredApps,
  loadStoredAppContent,
  readGeneratedAppPayloadFromWorkspace,
  rollbackAppToVersion,
  saveStoredApp,
} from './app-ipc.mjs';
import {
  findAssistantDirByName,
  readAssistantContext,
  resolveInstalledSkillInfos,
} from './assistant-context-utils.mjs';
import { registerCronIpcHandlers } from './cron-tasks-ipc.mjs';
import { registerLogIpcHandlers, mossLog } from './log-ipc.mjs';
import { initUpdateIpcHandlers, setMainWindowRef } from './update-ipc.mjs';
import { autoUpdaterService } from './auto-updater-service.mjs';
import { registerDocumentIpcHandlers } from './process/bridge/document-bridge.mjs';
import { registerLibreOfficeIpcHandlers } from './process/bridge/libreoffice-bridge.mjs';
import { registerPreviewHistoryIpcHandlers } from './process/bridge/preview-history-bridge.mjs';
import { registerPreviewIpcHandlers } from './process/bridge/preview-bridge.mjs';
import { registerShellIpcHandlers } from './process/bridge/shell-bridge.mjs';
import { registerWorkspaceIpcHandlers } from './process/bridge/workspace-bridge.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(uiRoot, '..');
const cliPath = path.join(repoRoot, 'cli-node.js');
// In packaged app, electron-direct.mjs is copied to ui root (inside asar)
// In dev, it's in repo root. Check ui root first.
let sdkPath = path.join(uiRoot, 'electron-direct.mjs');
try {
  if (!fs.existsSync(sdkPath)) {
    sdkPath = path.join(repoRoot, 'electron-direct.mjs');
  }
} catch {
  sdkPath = path.join(repoRoot, 'electron-direct.mjs');
}
const rendererHtml = path.join(uiRoot, 'dist', 'renderer', 'index.html');
const rendererDevServerUrl = process.env.VITE_DEV_SERVER_URL && String(process.env.VITE_DEV_SERVER_URL).trim();
const shouldOpenDevTools = process.env.MOSS_OPEN_DEVTOOLS === 'true';
const DEFAULT_BYPASS_PERMISSIONS = process.env.CLAUDE_CODE_BYPASS_PERMISSIONS === 'true';
const MAX_FILE_BYTES = 200 * 1024;
const MOSS_HOME = path.join(os.homedir(), '.moss');
const MOSS_PROJECTS_DIR = path.join(MOSS_HOME, 'projects');
const MOSS_WORKSPACES_DIR = path.join(MOSS_HOME, 'workspaces');
const USER_TMP_DIR = path.join(MOSS_HOME, 'workspace');
const MOSS_APPS_DIR = path.join(MOSS_HOME, 'generated-apps');
const MOSS_APP_DATA_DIR = path.join(MOSS_HOME, 'generated-app-data');
const DESKTOP_SETTINGS_PATH = path.join(MOSS_HOME, 'settings.json');
const MOSS_SYSTEM_SKILLS_DIR = path.join(MOSS_HOME, 'skills', 'system');
const MOSS_REPO_SKILLS_DIR = path.join(repoRoot, 'skills');
const ASSISTANT_SYSTEM_DIR = path.join(MOSS_HOME, 'assistants', 'system');
const ASSISTANT_HUB_DIR = path.join(MOSS_HOME, 'assistants', 'hub');
const ASSISTANT_CUSTOM_DIR = path.join(MOSS_HOME, 'assistants', '_my-custom-assistant');
const MOSS_REPO_ASSISTANTS_DIR = path.join(repoRoot, 'assistants');
const AUTH_SETTINGS_PATH = DESKTOP_SETTINGS_PATH;
const SESSION_DB_PATH = path.join(MOSS_HOME, 'moss.db');
const DEFAULT_DESKTOP_SETTINGS = Object.freeze({
  agentMode: 'local',
  localEnabled: true,
  remoteEnabled: false,
  bypassPermissions: DEFAULT_BYPASS_PERMISSIONS,
  model: 'claude-sonnet-4-6',
  maxTurns: 100,
  appendSystemPrompt: '',
  thinkingMode: 'adaptive',
  thinkingBudgetTokens: 16000,
  url: '',
  apiKey: '',
  image: {
    provider: 'minimax',
    url: 'https://api.minimaxi.com/v1/image_generation',
    apiKey: '',
    model: '',
  },
  remoteDirectServerUrl: '',
  remoteDirectCredentialMode: 'password',
  remoteDirectUserEmail: '',
  remoteDirectUserPassword: '',
  remoteDirectApiKey: '',
  remoteDirectWorkspace: '',
  coordinatorMode: false,
  logRotationMaxSize: 10 * 1024 * 1024, // 10MB
  logRotationMaxFiles: 5,
});
const APP_FILES_SUBDIR = 'files';
const APP_VERSIONS_SUBDIR = 'versions';
const APP_STORAGE_FILENAME = 'storage.json';
const MAX_SANITIZED_PATH_LENGTH = 200;

function djb2Hash(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return hash;
}

function sanitizeWorkspacePath(value) {
  const sanitized = String(value || '').replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= MAX_SANITIZED_PATH_LENGTH) {
    return sanitized;
  }
  const hash = Math.abs(djb2Hash(String(value || ''))).toString(36);
  return `${sanitized.slice(0, MAX_SANITIZED_PATH_LENGTH)}-${hash}`;
}

function getTranscriptPathForWorkspace(workspace, sessionId) {
  if (!workspace || !sessionId) return null;
  return path.join(
    MOSS_PROJECTS_DIR,
    sanitizeWorkspacePath(workspace),
    `${sessionId}.jsonl`,
  );
}

// Direct embed should behave like the local-agent launcher, not Claude Desktop.
process.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent';
process.env.CLAUDE_CODE_LOCAL_SETTINGS_AUTH_ONLY = 'true';

let mainWindow = null;
let claudeSessionCtorPromise = null;
let claudeRuntimeModulePromise = null;

const sessions = new Map();
const subAgentSessions = new Map(); // separate storage for sub-agent sessions (not shown in main list)
const appWindows = new Map();
const appWindowStates = new Map();
const debugWindows = new Map();
const executionWindows = new Map(); // name -> BrowserWindow
const executionWindowStates = new Map(); // webContents.id -> state
fs.mkdirSync(MOSS_HOME, { recursive: true });
fs.mkdirSync(MOSS_WORKSPACES_DIR, { recursive: true });
fs.mkdirSync(USER_TMP_DIR, { recursive: true });
fs.mkdirSync(MOSS_APPS_DIR, { recursive: true });
fs.mkdirSync(MOSS_APP_DATA_DIR, { recursive: true });
const sessionDb = new DatabaseSync(SESSION_DB_PATH);
const persistSessionStmt = (() => {
  // Migration: add columns if table exists but columns are missing
  try {
    sessionDb.exec(`ALTER TABLE sessions ADD COLUMN is_sub_agent INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column may already exist or table doesn't exist yet
  }
  try {
    sessionDb.exec(`ALTER TABLE sessions ADD COLUMN worker_summaries_json TEXT`);
  } catch {
    // Column may already exist or table doesn't exist yet
  }
  try {
    sessionDb.exec(`ALTER TABLE sessions ADD COLUMN agent_mode TEXT NOT NULL DEFAULT 'local'`);
  } catch {
    // Column may already exist or table doesn't exist yet
  }
  try {
    sessionDb.exec(`ALTER TABLE sessions ADD COLUMN remote_workspace TEXT`);
  } catch {
    // Column may already exist or table doesn't exist yet
  }
  try {
    sessionDb.exec(`ALTER TABLE sessions ADD COLUMN assistant_name TEXT`);
  } catch {
    // Column may already exist or table doesn't exist yet
  }
  sessionDb.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      preview TEXT NOT NULL,
      agent_mode TEXT NOT NULL DEFAULT 'local',
      remote_workspace TEXT,
      underlying_session_id TEXT,
      history_json TEXT NOT NULL DEFAULT '[]',
      is_sub_agent INTEGER NOT NULL DEFAULT 0,
      worker_summaries_json TEXT,
      assistant_name TEXT
    )
  `);
  return sessionDb.prepare(`
    INSERT INTO sessions (
      id, title, workspace, created_at, updated_at, message_count, preview, agent_mode, remote_workspace, underlying_session_id, history_json, is_sub_agent, worker_summaries_json, assistant_name
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      workspace = excluded.workspace,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      message_count = excluded.message_count,
      preview = excluded.preview,
      agent_mode = excluded.agent_mode,
      remote_workspace = excluded.remote_workspace,
      underlying_session_id = excluded.underlying_session_id,
      history_json = excluded.history_json,
      is_sub_agent = excluded.is_sub_agent,
      worker_summaries_json = excluded.worker_summaries_json,
      assistant_name = excluded.assistant_name
  `);
})();
const deleteSessionStmt = sessionDb.prepare('DELETE FROM sessions WHERE id = ?');
const loadSessionsStmt = sessionDb.prepare(`
  SELECT
    id,
    title,
    workspace,
    created_at,
    updated_at,
    message_count,
    preview,
    agent_mode,
    remote_workspace,
    underlying_session_id,
    is_sub_agent,
    worker_summaries_json,
    assistant_name
  FROM sessions
  WHERE is_sub_agent = 0
  ORDER BY updated_at DESC
`);
const loadSubAgentSessionsStmt = sessionDb.prepare(`
  SELECT
    id,
    title,
    workspace,
    created_at,
    updated_at,
    message_count,
    preview,
    agent_mode,
    remote_workspace,
    underlying_session_id,
    is_sub_agent,
    worker_summaries_json
  FROM sessions
  WHERE is_sub_agent = 1
  ORDER BY created_at ASC
`);

const loadSubAgentSessionsByParentStmt = sessionDb.prepare(`
  SELECT
    id,
    title,
    workspace,
    created_at,
    updated_at,
    message_count,
    preview,
    agent_mode,
    remote_workspace,
    underlying_session_id,
    is_sub_agent,
    worker_summaries_json
  FROM sessions
  WHERE is_sub_agent = 1 AND underlying_session_id = ?
  ORDER BY created_at ASC
`);

function loadLocalSettingsAuthConfig() {
  const result = {
    path: AUTH_SETTINGS_PATH,
    exists: false,
    loaded: false,
    parseError: '',
    injected: [],
  };

  try {
    if (!fs.existsSync(AUTH_SETTINGS_PATH)) {
      return result;
    }

    result.path = AUTH_SETTINGS_PATH;
    result.exists = true;
    const raw = fs.readFileSync(AUTH_SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const env = parsed && typeof parsed === 'object' && parsed.env && typeof parsed.env === 'object'
      ? parsed.env
      : {};

    // 允许注入 env 对象中的所有环境变量，不再限制特定的三个 key
    for (const key of Object.keys(env)) {
      const value = env[key];
      if (typeof value === 'string' && value.trim()) {
        process.env[key] = value.trim();
        result.injected.push(key);
      }
    }

    result.loaded = true;
    return result;
  } catch (error) {
    result.parseError = error instanceof Error ? error.message : String(error);
    return result;
  }
}

const localSettingsAuthConfig = loadLocalSettingsAuthConfig();

function normalizeDesktopSettings(input, existing = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const result = { ...existing };

  if (source.agentMode !== undefined) {
    result.agentMode = source.agentMode === 'remote-direct' ? 'remote-direct' : 'local';
  } else if (result.agentMode === undefined) {
    result.agentMode = DEFAULT_DESKTOP_SETTINGS.agentMode;
  }

  if (source.localEnabled !== undefined) {
    result.localEnabled = Boolean(source.localEnabled);
  } else if (result.localEnabled === undefined) {
    result.localEnabled = DEFAULT_DESKTOP_SETTINGS.localEnabled;
  }

  if (source.remoteEnabled !== undefined) {
    result.remoteEnabled = Boolean(source.remoteEnabled);
  } else if (result.remoteEnabled === undefined) {
    result.remoteEnabled = DEFAULT_DESKTOP_SETTINGS.remoteEnabled;
  }

  if (typeof source.model === 'string' && source.model.trim()) {
    result.model = source.model.trim();
  } else if (result.model === undefined) {
    result.model = DEFAULT_DESKTOP_SETTINGS.model;
  }

  if (source.appendSystemPrompt !== undefined) {
    result.appendSystemPrompt = source.appendSystemPrompt;
  } else if (result.appendSystemPrompt === undefined) {
    result.appendSystemPrompt = DEFAULT_DESKTOP_SETTINGS.appendSystemPrompt;
  }

  if (source.maxTurns !== undefined) {
    let maxTurns = Number.parseInt(String(source.maxTurns), 10);
    if (Number.isFinite(maxTurns) && maxTurns >= 1) {
      result.maxTurns = Math.min(maxTurns, 10_000);
    }
  } else if (result.maxTurns === undefined) {
    result.maxTurns = DEFAULT_DESKTOP_SETTINGS.maxTurns;
  }

  if (source.thinkingMode !== undefined) {
    result.thinkingMode = source.thinkingMode;
  } else if (result.thinkingMode === undefined) {
    result.thinkingMode = DEFAULT_DESKTOP_SETTINGS.thinkingMode;
  }

  if (source.thinkingBudgetTokens !== undefined) {
    let tokens = Number.parseInt(String(source.thinkingBudgetTokens), 10);
    if (Number.isFinite(tokens) && tokens >= 1024) {
      result.thinkingBudgetTokens = Math.min(tokens, 128_000);
    }
  } else if (result.thinkingBudgetTokens === undefined) {
    result.thinkingBudgetTokens = DEFAULT_DESKTOP_SETTINGS.thinkingBudgetTokens;
  }

  if (source.bypassPermissions !== undefined) {
    result.bypassPermissions = Boolean(source.bypassPermissions);
  } else if (result.bypassPermissions === undefined) {
    result.bypassPermissions = DEFAULT_DESKTOP_SETTINGS.bypassPermissions;
  }

  if (typeof source.url === 'string') {
    result.url = source.url.trim();
  } else if (result.url === undefined) {
    result.url = DEFAULT_DESKTOP_SETTINGS.url;
  }

  if (typeof source.apiKey === 'string') {
    result.apiKey = source.apiKey.trim();
  } else if (result.apiKey === undefined) {
    result.apiKey = DEFAULT_DESKTOP_SETTINGS.apiKey;
  }

  const sourceImage = source.image && typeof source.image === 'object' ? source.image : {};
  const existingImage = result.image && typeof result.image === 'object' ? result.image : {};
  result.image = {
    provider:
      typeof sourceImage.provider === 'string'
        ? sourceImage.provider.trim()
        : typeof existingImage.provider === 'string'
          ? existingImage.provider
          : DEFAULT_DESKTOP_SETTINGS.image.provider,
    url:
      typeof sourceImage.url === 'string'
        ? sourceImage.url.trim()
        : typeof existingImage.url === 'string'
          ? existingImage.url
          : DEFAULT_DESKTOP_SETTINGS.image.url,
    apiKey:
      typeof sourceImage.apiKey === 'string'
        ? sourceImage.apiKey.trim()
        : typeof existingImage.apiKey === 'string'
          ? existingImage.apiKey
          : DEFAULT_DESKTOP_SETTINGS.image.apiKey,
    model:
      typeof sourceImage.model === 'string'
        ? sourceImage.model.trim()
        : typeof existingImage.model === 'string'
          ? existingImage.model
          : DEFAULT_DESKTOP_SETTINGS.image.model,
  };

  if (typeof source.remoteDirectServerUrl === 'string') {
    result.remoteDirectServerUrl = source.remoteDirectServerUrl.trim();
  } else if (result.remoteDirectServerUrl === undefined) {
    result.remoteDirectServerUrl = DEFAULT_DESKTOP_SETTINGS.remoteDirectServerUrl;
  }

  if (source.remoteDirectCredentialMode === 'api-key') {
    result.remoteDirectCredentialMode = 'api-key';
  } else if (source.remoteDirectCredentialMode === 'password') {
    result.remoteDirectCredentialMode = 'password';
  } else if (result.remoteDirectCredentialMode === undefined) {
    result.remoteDirectCredentialMode = DEFAULT_DESKTOP_SETTINGS.remoteDirectCredentialMode;
  }

  if (typeof source.remoteDirectUserEmail === 'string') {
    result.remoteDirectUserEmail = source.remoteDirectUserEmail.trim();
  } else if (result.remoteDirectUserEmail === undefined) {
    result.remoteDirectUserEmail = DEFAULT_DESKTOP_SETTINGS.remoteDirectUserEmail;
  }

  if (typeof source.remoteDirectUserPassword === 'string') {
    result.remoteDirectUserPassword = source.remoteDirectUserPassword;
  } else if (result.remoteDirectUserPassword === undefined) {
    result.remoteDirectUserPassword = DEFAULT_DESKTOP_SETTINGS.remoteDirectUserPassword;
  }

  if (typeof source.remoteDirectApiKey === 'string') {
    result.remoteDirectApiKey = source.remoteDirectApiKey.trim();
  } else if (result.remoteDirectApiKey === undefined) {
    result.remoteDirectApiKey = DEFAULT_DESKTOP_SETTINGS.remoteDirectApiKey;
  }

  if (typeof source.remoteDirectWorkspace === 'string') {
    result.remoteDirectWorkspace = source.remoteDirectWorkspace.trim();
  } else if (result.remoteDirectWorkspace === undefined) {
    result.remoteDirectWorkspace = DEFAULT_DESKTOP_SETTINGS.remoteDirectWorkspace;
  }

  if (source.coordinatorMode !== undefined) {
    result.coordinatorMode = Boolean(source.coordinatorMode);
  } else if (result.coordinatorMode === undefined) {
    result.coordinatorMode = DEFAULT_DESKTOP_SETTINGS.coordinatorMode;
  }

  if (source.logRotationMaxSize !== undefined) {
    let size = Number.parseInt(String(source.logRotationMaxSize), 10);
    if (Number.isFinite(size) && size >= 1024 * 1024) {
      result.logRotationMaxSize = Math.min(size, 100 * 1024 * 1024);
    }
  } else if (result.logRotationMaxSize === undefined) {
    result.logRotationMaxSize = DEFAULT_DESKTOP_SETTINGS.logRotationMaxSize;
  }

  if (source.logRotationMaxFiles !== undefined) {
    let files = Number.parseInt(String(source.logRotationMaxFiles), 10);
    if (Number.isFinite(files) && files >= 1 && files <= 20) {
      result.logRotationMaxFiles = files;
    }
  } else if (result.logRotationMaxFiles === undefined) {
    result.logRotationMaxFiles = DEFAULT_DESKTOP_SETTINGS.logRotationMaxFiles;
  }

  return result;
}

function loadDesktopSettings() {
  const result = {
    path: DESKTOP_SETTINGS_PATH,
    exists: false,
    loaded: false,
    parseError: '',
    value: { ...DEFAULT_DESKTOP_SETTINGS },
  };

  try {
    if (!fs.existsSync(DESKTOP_SETTINGS_PATH)) {
      return result;
    }

    result.exists = true;
    const raw = fs.readFileSync(DESKTOP_SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    // 从 env 中提取 url 和 apiKey
    const env = parsed && parsed.env && typeof parsed.env === 'object' ? parsed.env : {};
    const urlFromEnv = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL.trim() : '';
    const apiKeyFromEnv = typeof env.ANTHROPIC_AUTH_TOKEN === 'string' ? env.ANTHROPIC_AUTH_TOKEN.trim() : '';
    // 启动加载时，保留原始 JSON 中的所有 key，只对标准 key 进行合并/格式化
    const normalized = normalizeDesktopSettings(parsed, parsed);
    result.value = {
      ...parsed,
      ...normalized,
      // 从 env 中读取 url 和 apiKey
      url: urlFromEnv || normalized.url || DEFAULT_DESKTOP_SETTINGS.url,
      apiKey: apiKeyFromEnv || normalized.apiKey || DEFAULT_DESKTOP_SETTINGS.apiKey,
      image: normalized.image || { ...DEFAULT_DESKTOP_SETTINGS.image },
    };
    result.loaded = true;
    return result;
  } catch (error) {
    result.parseError = error instanceof Error ? error.message : String(error);
    mossLog('error', 'settings', 'Failed to load settings', { error: result.parseError });
    return result;
  }
}

let desktopSettingsState = loadDesktopSettings();
let desktopSettings = desktopSettingsState.value;
mossLog('info', 'settings', 'Settings loaded', { path: desktopSettingsState.path, exists: desktopSettingsState.exists });

function getDesktopSettingsPayload(extra = {}) {
  return {
    ...desktopSettings,
    settingsPath: desktopSettingsState.path,
    settingsExists: desktopSettingsState.exists,
    settingsLoaded: desktopSettingsState.loaded,
    settingsParseError: desktopSettingsState.parseError,
    ...extra,
  };
}

function saveDesktopSettings(nextSettings) {
  // 读取现有文件，保留 env 等其他配置
  let existingEnv = {};
  try {
    if (fs.existsSync(DESKTOP_SETTINGS_PATH)) {
      const raw = fs.readFileSync(DESKTOP_SETTINGS_PATH, 'utf8');
      const existing = JSON.parse(raw);
      if (existing && existing.env && typeof existing.env === 'object') {
        existingEnv = existing.env;
      }
    }
  } catch { /* ignore */ }

  // 将 url 和 apiKey 存入 env
  const env = { ...existingEnv };
  if (nextSettings.url) {
    env.ANTHROPIC_BASE_URL = nextSettings.url;
  } else {
    delete env.ANTHROPIC_BASE_URL;
  }
  if (nextSettings.apiKey) {
    env.ANTHROPIC_AUTH_TOKEN = nextSettings.apiKey;
  } else {
    delete env.ANTHROPIC_AUTH_TOKEN;
  }

  // 构建完整的保存对象，保留所有现有配置
  const toSave = {
    ...nextSettings,
    env,
    // 从顶级别存，避免重复
    url: undefined,
    apiKey: undefined,
  };
  // 删除 undefined 字段
  Object.keys(toSave).forEach(k => toSave[k] === undefined && delete toSave[k]);
  if (!Object.keys(env).length) {
    delete toSave.env;
  }

  fs.writeFileSync(DESKTOP_SETTINGS_PATH, `${JSON.stringify(toSave, null, 2)}\n`, 'utf8');
  desktopSettingsState = {
    path: DESKTOP_SETTINGS_PATH,
    exists: true,
    loaded: true,
    parseError: '',
    value: nextSettings,
  };
  desktopSettings = nextSettings;
}

function buildThinkingConfig() {
  if (desktopSettings.thinkingMode === 'disabled') {
    return { type: 'disabled' };
  }
  if (desktopSettings.thinkingMode === 'enabled') {
    return {
      type: 'enabled',
      budgetTokens: desktopSettings.thinkingBudgetTokens,
    };
  }
  return { type: 'adaptive' };
}

function buildClaudeSessionConfig(cwd) {
  return {
    cwd,
    model: desktopSettings.model,
    appendSystemPrompt: desktopSettings.appendSystemPrompt || undefined,
    maxTurns: desktopSettings.maxTurns,
    thinkingConfig: buildThinkingConfig(),
    permissionMode: desktopSettings.bypassPermissions ? 'allow-all' : 'default',
    url: desktopSettings.url || undefined,
    apiKey: desktopSettings.apiKey || undefined,
  };
}

function getDesktopAgentMode(settings = desktopSettings) {
  return settings?.agentMode === 'remote-direct' ? 'remote-direct' : 'local';
}

function isRemoteDirectModeEnabled(settings = desktopSettings) {
  return getDesktopAgentMode(settings) === 'remote-direct';
}

function getRemoteDirectWorkspace(settings = desktopSettings) {
  const value = typeof settings?.remoteDirectWorkspace === 'string'
    ? settings.remoteDirectWorkspace.trim()
    : '';
  return value || undefined;
}

function parseRemoteDirectServerInput(raw) {
  if (raw.startsWith('cc+unix://')) {
    throw new Error('Unix domain socket direct-connect is not supported by the desktop client yet.');
  }

  if (raw.startsWith('cc://')) {
    const url = new URL(raw);
    if (!url.hostname || !url.port) {
      throw new Error(`Invalid direct-connect URL: ${raw}`);
    }
    if (url.searchParams.get('token')) {
      throw new Error('The desktop client no longer supports cc://...token=... URLs. Use bearer auth instead.');
    }
    const authMode = url.searchParams.get('auth_mode');
    if (authMode && authMode !== 'auth-center' && authMode !== 'local') {
      throw new Error(`Unsupported direct-connect auth mode in URL: ${authMode}`);
    }
    const serverUrl = `http://${url.hostname}:${url.port}`;
    const authCenterUrl = url.searchParams.get('auth_center') || serverUrl;
    return {
      serverUrl,
      authCenterUrl,
    };
  }

  const serverUrl = raw.replace(/\/+$/, '');
  return {
    serverUrl,
    authCenterUrl: serverUrl,
  };
}

async function requestRemoteDirectAccessToken({
  authCenterUrl,
  credentialMode,
  loginIdentifier,
  password,
  apiKey,
}) {
  const normalizedAuthCenterUrl = typeof authCenterUrl === 'string'
    ? authCenterUrl.trim().replace(/\/+$/, '')
    : '';
  if (!normalizedAuthCenterUrl) {
    throw new Error('Moss server URL is required.');
  }

  let payload;
  if (credentialMode === 'api-key') {
    const normalizedApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!normalizedApiKey) {
      throw new Error('API Key is required for moss server API-key login.');
    }
    payload = {
      grant_type: 'api_key',
      api_key: normalizedApiKey,
    };
  } else {
    const normalizedLoginIdentifier = typeof loginIdentifier === 'string'
      ? loginIdentifier.trim()
      : '';
    if (!normalizedLoginIdentifier) {
      throw new Error('Username or email is required for moss server password login.');
    }
    if (typeof password !== 'string' || !password) {
      throw new Error('User password is required for moss server password login.');
    }
    payload = {
      grant_type: 'password',
      ...(normalizedLoginIdentifier.includes('@')
        ? { email: normalizedLoginIdentifier }
        : { username: normalizedLoginIdentifier }),
      password,
    };
  }

  const response = await fetch(`${normalizedAuthCenterUrl}/api/v1/auth/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const data = await response.json();
      if (data?.error) {
        message = data.error;
      }
    } catch {}
    throw new Error(`Failed to get access token from moss server: ${message}`);
  }

  const data = await response.json();
  if (!data?.access_token) {
    throw new Error('Moss server response missing access_token.');
  }
  return data.access_token;
}

async function resolveRemoteDirectConnection() {
  const raw = typeof desktopSettings.remoteDirectServerUrl === 'string'
    ? desktopSettings.remoteDirectServerUrl.trim()
    : '';

  if (!raw) {
    throw new Error('Remote Direct server URL is required.');
  }

  const parsed = parseRemoteDirectServerInput(raw);
  const authToken = await requestRemoteDirectAccessToken({
    authCenterUrl: parsed.authCenterUrl,
    credentialMode: desktopSettings.remoteDirectCredentialMode,
    // Legacy settings key; accepts either username or email.
    loginIdentifier: desktopSettings.remoteDirectUserEmail,
    password: desktopSettings.remoteDirectUserPassword,
    apiKey: desktopSettings.remoteDirectApiKey,
  });

  return {
    serverUrl: parsed.serverUrl,
    authToken,
  };
}

async function parseRemoteDirectError(prefix, response) {
  let detail = '';
  try {
    const text = await response.text();
    if (text.trim()) {
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed?.error === 'string' && parsed.error.trim()) {
          detail = parsed.error.trim();
        } else {
          detail = text.trim();
        }
      } catch {
        detail = text.trim();
      }
    }
  } catch {}

  return detail
    ? `${prefix}: ${response.status} ${response.statusText}: ${detail}`
    : `${prefix}: ${response.status} ${response.statusText}`;
}

async function fetchRemoteDirectSessionInfo({ serverUrl, authToken, sessionId }) {
  let response;
  try {
    response = await fetch(
      `${serverUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to connect to remote session server: ${message}`);
  }

  if (!response.ok) {
    throw new Error(
      await parseRemoteDirectError(`Failed to query remote session ${sessionId}`, response),
    );
  }

  return response.json();
}

async function fetchRemoteDirectSessionContext({ serverUrl, authToken, sessionId }) {
  let response;
  try {
    response = await fetch(
      `${serverUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/context`,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to connect to remote session server: ${message}`);
  }

  if (!response.ok) {
    throw new Error(
      await parseRemoteDirectError(`Failed to query remote session context ${sessionId}`, response),
    );
  }

  return response.json();
}

async function resumeRemoteDirectSession({ serverUrl, authToken, sessionId }) {
  let response;
  try {
    response = await fetch(
      `${serverUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/resume`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${authToken}`,
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to connect to remote session server: ${message}`);
  }

  if (!response.ok) {
    throw new Error(
      await parseRemoteDirectError(`Failed to resume remote session ${sessionId}`, response),
    );
  }

  const data = await response.json();
  const wsUrl = typeof data?.ws_url === 'string' ? data.ws_url : '';
  const resumedSessionId = typeof data?.session?.sessionId === 'string'
    ? data.session.sessionId
    : sessionId;
  if (!wsUrl) {
    throw new Error(`Remote session ${sessionId} resume response missing ws_url.`);
  }

  return {
    config: {
      serverUrl,
      sessionId: resumedSessionId,
      wsUrl,
      authToken,
    },
    workDir: typeof data?.session?.workDir === 'string' ? data.session.workDir : undefined,
  };
}

function createRemoteDirectRuntime({
  sessionRecord,
  onPermissionRequest,
  onSessionCreated,
  coordinatorMode = false,
}) {
  const shouldPersistSessionRecord = Boolean(
    sessionRecord &&
    typeof sessionRecord.id === 'string' &&
    Array.isArray(sessionRecord.history),
  );
  let disposed = false;
  let activeManager = null;
  let managerConnectPromise = null;
  let currentTurn = null;
  let sessionPromise = null;

  const ensureSessionConfig = async () => {
    if (sessionPromise) {
      return sessionPromise;
    }

    sessionPromise = (async () => {
      const mod = await getClaudeRuntimeModule();
      if (
        typeof mod.createDirectConnectSession !== 'function' ||
        typeof mod.DirectConnectSessionManager !== 'function'
      ) {
        throw new Error(
          'electron-direct.mjs did not export direct-connect runtime helpers.',
        );
      }

      const { serverUrl, authToken } = await resolveRemoteDirectConnection();
      let created;

      if (sessionRecord.underlyingSessionId) {
        const remoteSession = await fetchRemoteDirectSessionInfo({
          serverUrl,
          authToken,
          sessionId: sessionRecord.underlyingSessionId,
        });
        const desiredState = typeof remoteSession?.session?.desiredState === 'string'
          ? remoteSession.session.desiredState
          : 'active';

        created = desiredState === 'active'
          ? await mod.attachDirectConnectSession({
              serverUrl,
              authToken,
              sessionId: sessionRecord.underlyingSessionId,
            })
          : await resumeRemoteDirectSession({
              serverUrl,
              authToken,
              sessionId: sessionRecord.underlyingSessionId,
            });
      } else {
        created = await mod.createDirectConnectSession({
          serverUrl,
          authToken,
          cwd: sessionRecord.remoteWorkspace || getRemoteDirectWorkspace() || undefined,
          dangerouslySkipPermissions: Boolean(desktopSettings.bypassPermissions),
          assistantName: sessionRecord.assistantName,
        });
      }

      sessionRecord.agentMode = 'remote-direct';
      sessionRecord.resumeReadOnlyReason = null;
      if (created?.config?.sessionId) {
        sessionRecord.underlyingSessionId = created.config.sessionId;
      }
      if (created?.workDir) {
        sessionRecord.remoteWorkspace = created.workDir;
      }
      if (shouldPersistSessionRecord) {
        sessionRecord.updatedAt = Date.now();
        schedulePersistSession(sessionRecord, true);
        emitSessionMeta(sessionRecord);
      }
      onSessionCreated?.(created);
      return {
        mod,
        config: created.config,
        workDir: created.workDir,
      };
    })().catch((error) => {
      sessionPromise = null;
      throw error;
    });

    return sessionPromise;
  };

  return {
    kind: 'remote-direct',
    coordinatorMode,
    async *send(prompt) {
      if (disposed) {
        throw new Error('Remote runtime has been disposed.');
      }
      if (currentTurn) {
        throw new Error('Remote runtime is already processing a request.');
      }

      const { mod, config } = await ensureSessionConfig();
      const queue = [];
      let pendingResolve = null;
      let pendingReject = null;
      let settled = false;
      let pendingError = null;

      const flushMessage = (message) => {
        if (pendingResolve) {
          const resolve = pendingResolve;
          pendingResolve = null;
          pendingReject = null;
          resolve(message);
          return;
        }
        queue.push(message);
      };

      const fail = (error) => {
        if (settled) return;
        settled = true;
        pendingError = error instanceof Error ? error : new Error(String(error));
        if (pendingReject) {
          const reject = pendingReject;
          pendingResolve = null;
          pendingReject = null;
          reject(pendingError);
        }
      };

      const nextMessage = () =>
        new Promise((resolve, reject) => {
          if (queue.length > 0) {
            resolve(queue.shift());
            return;
          }
          if (pendingError) {
            reject(pendingError);
            return;
          }
          pendingResolve = resolve;
          pendingReject = reject;
        });

      currentTurn = {
        finished: false,
        flushMessage,
        fail,
      };

      const ensureManager = async () => {
        if (activeManager?.isConnected?.()) {
          return activeManager;
        }

        if (managerConnectPromise) {
          await managerConnectPromise;
          if (!activeManager?.isConnected?.()) {
            throw new Error('Remote session failed to connect.');
          }
          return activeManager;
        }

        managerConnectPromise = new Promise((resolve, reject) => {
          const manager = new mod.DirectConnectSessionManager(config, {
            onConnected: () => {
              managerConnectPromise = null;
              resolve();
            },
            onMessage: (message) => {
              if (!currentTurn) {
                return;
              }
              currentTurn.flushMessage(message);
              if (message?.type === 'result') {
                currentTurn.finished = true;
              }
            },
            onPermissionRequest: async (request, requestId) => {
              try {
                const allowed = await onPermissionRequest?.(request.tool_name, request.input);
                manager.respondToPermissionRequest(requestId, allowed
                  ? { behavior: 'allow' }
                  : { behavior: 'deny', message: 'Denied by user' });
              } catch (error) {
                manager.respondToPermissionRequest(requestId, {
                  behavior: 'deny',
                  message: error instanceof Error ? error.message : String(error),
                });
              }
            },
            onDisconnected: () => {
              const turn = currentTurn;
              activeManager = null;
              managerConnectPromise = null;
              if (turn && !turn.finished) {
                turn.fail(new Error('Remote session disconnected before completion.'));
              }
            },
            onError: (error) => {
              const turn = currentTurn;
              if (managerConnectPromise) {
                managerConnectPromise = null;
                reject(error);
              }
              if (turn) {
                turn.fail(error);
              }
            },
          });

          activeManager = manager;

          try {
            manager.connect();
          } catch (error) {
            activeManager = null;
            managerConnectPromise = null;
            reject(error);
          }
        });

        await managerConnectPromise;
        return activeManager;
      };

      try {
        const manager = await ensureManager();
        const sent = manager.sendMessage(prompt);
        if (!sent) {
          throw new Error('Failed to send prompt to remote session.');
        }

        while (true) {
          const message = await nextMessage();
          yield message;
          if (message?.type === 'result') {
            break;
          }
        }
        if (pendingError) {
          throw pendingError;
        }
      } finally {
        currentTurn = null;
      }
    },
    abort() {
      activeManager?.sendInterrupt?.();
    },
    dispose() {
      disposed = true;
      try {
        activeManager?.disconnect?.();
      } catch {}
      activeManager = null;
      managerConnectPromise = null;
      currentTurn = null;
    },
  };
}

function refreshDesktopSettings(payload = {}) {
  // 这里不再只保留标准 key，而是将 payload 合并到现有的 desktopSettings 中
  // 这样可以保留用户手动在 settings.json 中添加的自定义 key（如 env, apiBaseUrl 等）
  const nextSettings = {
    ...desktopSettings,
    ...normalizeDesktopSettings(payload, desktopSettings)
  };
  saveDesktopSettings(nextSettings);
  mossLog('info', 'settings', 'Settings updated', { keys: Object.keys(payload) });

  let skippedSessionCount = 0;
  for (const sessionRecord of sessions.values()) {
    if (!sessionRecord.busy && sessionRecord.messageCount === 0) {
      sessionRecord.agentMode = getDesktopAgentMode(nextSettings);
      sessionRecord.remoteWorkspace = getRemoteDirectWorkspace(nextSettings) || null;
    }
    if (!sessionRecord.runtime) continue;
    if (sessionRecord.busy || sessionRecord.messageCount > 0) {
      skippedSessionCount += 1;
      continue;
    }
    disposeRuntime(sessionRecord);
  }

  emitToRenderer('agent:settings-changed', getDesktopSettingsPayload({
    skippedSessionCount,
  }));

  return getDesktopSettingsPayload({
    skippedSessionCount,
  });
}

function toPersistedSessionRow(sessionRecord, isSubAgent = false) {
  return [
    sessionRecord.id,
    sessionRecord.title,
    sessionRecord.workspace,
    sessionRecord.createdAt,
    sessionRecord.updatedAt,
    sessionRecord.messageCount,
    sessionRecord.preview || '',
    sessionRecord.agentMode === 'remote-direct' ? 'remote-direct' : 'local',
    sessionRecord.remoteWorkspace || null,
    sessionRecord.underlyingSessionId,
    '[]',
    isSubAgent ? 1 : 0,
    sessionRecord.workerSummariesJson || null,
    sessionRecord.assistantName || null,
  ];
}

function persistSessionRecord(sessionRecord, isSubAgent = false) {
  persistSessionStmt.run(...toPersistedSessionRow(sessionRecord, isSubAgent));
}

function flushPendingSessionPersist(sessionRecord) {
  if (sessionRecord.persistTimer) {
    clearTimeout(sessionRecord.persistTimer);
    sessionRecord.persistTimer = null;
  }
  persistSessionRecord(sessionRecord, sessionRecord.isSubAgent);
}

function schedulePersistSession(sessionRecord, immediate = false) {
  if (immediate) {
    flushPendingSessionPersist(sessionRecord);
    return;
  }
  if (sessionRecord.persistTimer) return;
  sessionRecord.persistTimer = setTimeout(() => {
    sessionRecord.persistTimer = null;
    persistSessionRecord(sessionRecord, sessionRecord.isSubAgent);
  }, 200);
}

function deletePersistedSession(sessionId) {
  deleteSessionStmt.run(sessionId);
}

function inferPersistedSessionAgentMode(row) {
  if (row?.agent_mode === 'remote-direct') {
    return 'remote-direct';
  }
  if (row?.agent_mode === 'local') {
    return 'local';
  }
  if (getDesktopAgentMode() !== 'remote-direct') {
    return 'local';
  }

  const workspace = typeof row?.workspace === 'string' ? row.workspace.trim() : '';
  const sessionId = typeof row?.underlying_session_id === 'string'
    ? row.underlying_session_id.trim()
    : '';
  if (!workspace || !sessionId) {
    return 'local';
  }

  const transcriptPath = getTranscriptPathForWorkspace(workspace, sessionId);
  return transcriptPath && hasFile(transcriptPath) ? 'local' : 'remote-direct';
}

function hydratePersistedSessions() {
  const rows = loadSessionsStmt.all();
  for (const row of rows) {
    const agentMode = inferPersistedSessionAgentMode(row);
    const sessionRecord = {
      id: row.id,
      title: row.title,
      workspace: row.workspace,
      remoteWorkspace: agentMode === 'remote-direct'
        ? (typeof row.remote_workspace === 'string' && row.remote_workspace.trim()
          ? row.remote_workspace.trim()
          : getRemoteDirectWorkspace() || null)
        : null,
      agentMode,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      busy: false,
      messageCount: row.message_count,
      preview: row.preview || '',
      underlyingSessionId: row.underlying_session_id || null,
      pendingPlanApproval: null,
      history: [],
      historyLoadedFromSource: false,
      workerSummariesJson: row.worker_summaries_json || null,
      runtime: null,
      resumeReadOnlyReason: null,
      workspaceWatcher: null,
      workspaceWatcherSyncTimer: null,
      persistTimer: null,
      isSubAgent: false,
      assistantName: row.assistant_name || null,
    };
    sessions.set(sessionRecord.id, sessionRecord);
  }

  // Load sub-agent sessions
  const subAgentRows = loadSubAgentSessionsStmt.all();
  for (const row of subAgentRows) {
    const agentMode = inferPersistedSessionAgentMode(row);
    const sessionRecord = {
      id: row.id,
      title: row.title,
      workspace: row.workspace,
      remoteWorkspace: agentMode === 'remote-direct'
        ? (typeof row.remote_workspace === 'string' && row.remote_workspace.trim()
          ? row.remote_workspace.trim()
          : getRemoteDirectWorkspace() || null)
        : null,
      agentMode,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      busy: false,
      messageCount: row.message_count,
      preview: row.preview || '',
      underlyingSessionId: row.underlying_session_id || null,
      pendingPlanApproval: null,
      history: [],
      historyLoadedFromSource: false,
      workerSummariesJson: row.worker_summaries_json || null,
      runtime: null,
      resumeReadOnlyReason: null,
      workspaceWatcher: null,
      workspaceWatcherSyncTimer: null,
      persistTimer: null,
      isSubAgent: true,
    };
    subAgentSessions.set(sessionRecord.id, sessionRecord);
  }
}

hydratePersistedSessions();

function getPackageMetadata() {
  try {
    const packageJsonPath = path.join(repoRoot, 'package.json');
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return {};
  }
}

function installRuntimeMacros() {
  if (globalThis.MACRO) return globalThis.MACRO;

  const packageMetadata = getPackageMetadata();
  const version = typeof packageMetadata.version === 'string' && packageMetadata.version
    ? packageMetadata.version
    : '0.0.0';

  globalThis.MACRO = Object.freeze({
    VERSION: version,
    BUILD_TIME: '',
    PACKAGE_URL: typeof packageMetadata.name === 'string' && packageMetadata.name
      ? packageMetadata.name
      : '@anthropic-ai/claude-code',
    FEEDBACK_CHANNEL: '',
    ISSUES_EXPLAINER: '',
    VERSION_CHANGELOG: '',
  });

  return globalThis.MACRO;
}

async function getClaudeRuntimeModule() {
  if (claudeRuntimeModulePromise) {
    return claudeRuntimeModulePromise;
  }

  installRuntimeMacros();
  claudeRuntimeModulePromise = import(sdkPath)
    .catch((error) => {
      claudeRuntimeModulePromise = null;
      throw error;
    });

  return claudeRuntimeModulePromise;
}

async function getClaudeSessionCtor() {
  if (claudeSessionCtorPromise) {
    return claudeSessionCtorPromise;
  }

  claudeSessionCtorPromise = getClaudeRuntimeModule()
    .then((mod) => {
      if (typeof mod.ClaudeSession !== 'function') {
        throw new Error('electron-direct.mjs did not export ClaudeSession.');
      }
      return mod.ClaudeSession;
    })
    .catch((error) => {
      claudeSessionCtorPromise = null;
      throw error;
    });

  return claudeSessionCtorPromise;
}

async function getResumeClaudeSessionFn() {
  const mod = await getClaudeRuntimeModule();
  if (typeof mod.resumeClaudeSession !== 'function') {
    throw new Error('electron-direct.mjs did not export resumeClaudeSession.');
  }
  return mod.resumeClaudeSession;
}

async function getLoadClaudeSessionSnapshotFn() {
  const mod = await getClaudeRuntimeModule();
  if (typeof mod.loadClaudeSessionSnapshot !== 'function') {
    throw new Error('electron-direct.mjs did not export loadClaudeSessionSnapshot.');
  }
  return mod.loadClaudeSessionSnapshot;
}

async function getAuthDebugSnapshot() {
  const mod = await getClaudeRuntimeModule();
  if (typeof mod.getAuthDebugSnapshot === 'function') {
    return mod.getAuthDebugSnapshot();
  }
  return null;
}

function formatAuthDebug(authDebug) {
  if (!authDebug) return '';

  const parts = [
    `entrypoint=${authDebug.entrypoint || 'unknown'}`,
    `localSettingsAuthOnly=${authDebug.localSettingsAuthOnly ? 'yes' : 'no'}`,
    `apiKeySource=${authDebug.apiKeySource || 'none'}`,
    `hasApiKey=${authDebug.hasApiKeyCandidate ? 'yes' : 'no'}`,
    `authTokenSource=${authDebug.authTokenSource || 'none'}`,
    `hasAuthToken=${authDebug.hasAuthTokenCandidate ? 'yes' : 'no'}`,
    `apiKeyEnv=${authDebug.hasAnthropicApiKeyEnv ? 'yes' : 'no'}`,
    `authTokenEnv=${authDebug.hasAnthropicAuthTokenEnv ? 'yes' : 'no'}`,
    `apiKeyHelper=${authDebug.hasApiKeyHelper ? 'yes' : 'no'}`,
    `storedOauth=${authDebug.hasStoredOauthAccount ? 'yes' : 'no'}`,
    `primaryApiKey=${authDebug.hasPrimaryApiKey ? 'yes' : 'no'}`,
  ];

  return parts.join(', ');
}

function createDefaultWorkspacePath() {
  const workspaceName = `claude-code-ui-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const candidatePaths = [
    path.join(USER_TMP_DIR, workspaceName),
    path.join(MOSS_WORKSPACES_DIR, workspaceName),
  ];

  for (const candidate of candidatePaths) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      return candidate;
    } catch {}
  }

  return repoRoot;
}

function hasFile(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function getSessionSummary(sessionRecord) {
  const workspace = sessionRecord.agentMode === 'remote-direct'
    ? sessionRecord.remoteWorkspace || sessionRecord.workspace
    : sessionRecord.workspace;
  return {
    id: sessionRecord.id,
    title: sessionRecord.title,
    agentMode: sessionRecord.agentMode === 'remote-direct' ? 'remote-direct' : 'local',
    workspace,
    createdAt: sessionRecord.createdAt,
    updatedAt: sessionRecord.updatedAt,
    busy: sessionRecord.busy,
    messageCount: sessionRecord.messageCount,
    sessionId: sessionRecord.underlyingSessionId,
    preview: sessionRecord.preview,
    pendingPlanApproval: sessionRecord.pendingPlanApproval || null,
    resumeReadOnlyReason: null,
    assistantName: sessionRecord.assistantName || null,
  };
}

function normalizePreviewText(value, maxLength = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function extractTextFromAssistantMessage(message) {
  if (!Array.isArray(message?.message?.content)) return '';
  return message.message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function extractTextFromUserReplayMessage(message) {
  const content = message?.message?.content;
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }
  return '';
}

function extractPreviewFromAssistantMessage(message) {
  const text = extractTextFromAssistantMessage(message);
  if (text) return normalizePreviewText(text);
  return '';
}

function extractPreviewFromStreamEvent(message) {
  const event = message?.event;
  if (!event || typeof event !== 'object') return '';

  if (
    event.type === 'content_block_delta' &&
    event.delta?.type === 'text_delta' &&
    typeof event.delta.text === 'string'
  ) {
    return normalizePreviewText(event.delta.text);
  }

  return '';
}

function deriveSessionPreview(history) {
  if (!Array.isArray(history) || history.length === 0) return '';

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (!entry || typeof entry !== 'object') continue;

    if (entry.type === 'assistant') {
      const preview = extractPreviewFromAssistantMessage(entry);
      if (preview) return preview;
      continue;
    }

    if (entry.type === 'stream_event') {
      const preview = extractPreviewFromStreamEvent(entry);
      if (preview) return preview;
      continue;
    }

    if (entry.type === 'user' && typeof entry.prompt === 'string') {
      const preview = normalizePreviewText(entry.prompt);
      if (preview) return preview;
      continue;
    }

    if (entry.type === 'error' && typeof entry.message === 'string') {
      const preview = normalizePreviewText(entry.message);
      if (preview) return preview;
    }
  }

  return '';
}

function derivePendingPlanApproval(history) {
  if (!Array.isArray(history)) return null;

  let pending = null;
  for (const entry of history) {
    if (!entry || entry.type !== 'app_plan_state' || entry.kind !== 'plan') continue;

    if (entry.state === 'awaiting_approval') {
      pending = {
        kind: 'plan',
        originalPrompt: typeof entry.originalPrompt === 'string' ? entry.originalPrompt : '',
        plan: typeof entry.plan === 'string' ? entry.plan : '',
        requestedAt: typeof entry.timestamp === 'number' ? entry.timestamp : Date.now(),
      };
      continue;
    }

    if (entry.state === 'approved' || entry.state === 'rejected') {
      pending = null;
    }
  }

  return pending;
}

function syncSessionRecordHistory(sessionRecord, history, metadata = {}) {
  const nextHistory = Array.isArray(history) ? history : [];
  sessionRecord.history = nextHistory;
  sessionRecord.historyLoadedFromSource = true;
  sessionRecord.messageCount = nextHistory.length;
  sessionRecord.pendingPlanApproval = derivePendingPlanApproval(nextHistory);

  const derivedPreview = deriveSessionPreview(nextHistory);
  if (derivedPreview) {
    sessionRecord.preview = derivedPreview;
  }

  if (typeof metadata.sessionId === 'string' && metadata.sessionId.trim()) {
    sessionRecord.underlyingSessionId = metadata.sessionId.trim();
  }
  if (typeof metadata.customTitle === 'string' && metadata.customTitle.trim()) {
    sessionRecord.title = metadata.customTitle.trim();
  }
  if (metadata.mode) {
    sessionRecord.isCoordinatorMode = metadata.mode === 'coordinator';
  }
  if (typeof metadata.cwd === 'string' && metadata.cwd.trim()) {
    sessionRecord.workspace = metadata.cwd.trim();
  }
  if (typeof metadata.remoteWorkspace === 'string' && metadata.remoteWorkspace.trim()) {
    sessionRecord.remoteWorkspace = metadata.remoteWorkspace.trim();
  }
}

async function loadSessionHistoryFromSource(sessionRecord) {
  if (!sessionRecord?.underlyingSessionId) {
    return sessionRecord.history;
  }

  if (sessionRecord.runtime) {
    return sessionRecord.history;
  }

  if (sessionRecord.historyLoadedFromSource) {
    return sessionRecord.history;
  }

  if (sessionRecord.busy && Array.isArray(sessionRecord.history) && sessionRecord.history.length > 0) {
    return sessionRecord.history;
  }

  if (sessionRecord.agentMode === 'remote-direct') {
    const { serverUrl, authToken } = await resolveRemoteDirectConnection();
    const context = await fetchRemoteDirectSessionContext({
      serverUrl,
      authToken,
      sessionId: sessionRecord.underlyingSessionId,
    });
    const history = Array.isArray(context?.context?.messages) ? context.context.messages : [];
    syncSessionRecordHistory(sessionRecord, history, {
      sessionId: typeof context?.session?.sessionId === 'string'
        ? context.session.sessionId
        : sessionRecord.underlyingSessionId,
      customTitle: typeof context?.context?.customTitle === 'string'
        ? context.context.customTitle
        : undefined,
      remoteWorkspace: typeof context?.session?.workDir === 'string'
        ? context.session.workDir
        : undefined,
    });
    schedulePersistSession(sessionRecord);
    emitSessionMeta(sessionRecord);
    return sessionRecord.history;
  }

  const loadClaudeSessionSnapshot = await getLoadClaudeSessionSnapshotFn();
  const snapshot = await loadClaudeSessionSnapshot(sessionRecord.underlyingSessionId, {
    cwdHint: sessionRecord.workspace,
  });
  if (!snapshot) {
    throw new Error(`无法从 Claude transcript 恢复会话：${sessionRecord.underlyingSessionId}`);
  }

  syncSessionRecordHistory(sessionRecord, snapshot.messages, {
    sessionId: snapshot.metadata.sourceSessionId || snapshot.metadata.sessionId,
    customTitle: snapshot.metadata.customTitle,
    cwd: snapshot.metadata.cwd,
    mode: snapshot.metadata.mode,
  });
  schedulePersistSession(sessionRecord);
  emitSessionMeta(sessionRecord);
  return sessionRecord.history;
}

function pushSessionHistoryEvent(sessionRecord, event, sender = null) {
  sessionRecord.history.push(event);
  sessionRecord.updatedAt = Date.now();
  sessionRecord.preview = deriveSessionPreview(sessionRecord.history);
  schedulePersistSession(sessionRecord);
  if (sender && !sender.isDestroyed()) {
    sender.send('agent:event', { sessionId: sessionRecord.id, payload: event });
  }
}

function maybeUpdateUnderlyingSessionId(target, nextSessionId) {
  if (typeof nextSessionId !== 'string' || !nextSessionId.trim()) {
    return;
  }

  // Remote-direct sessions must keep the server-side session ID returned by
  // /api/v1/sessions. Streamed SDK messages can carry a different Claude
  // transcript/session ID, and persisting that value breaks later
  // /api/v1/sessions/:id lookups with "Session not found".
  if (target?.agentMode === 'remote-direct') {
    return;
  }

  target.underlyingSessionId = nextSessionId;
}

function setPendingPlanApproval(sessionRecord, pendingPlanApproval) {
  sessionRecord.pendingPlanApproval = pendingPlanApproval;
  sessionRecord.updatedAt = Date.now();
  schedulePersistSession(sessionRecord, true);
  emitSessionMeta(sessionRecord);
}

async function runSessionPrompt({
  sessionRecord,
  sender,
  runtimePrompt,
  visibleUserPrompt,
  attachments = [],
}) {
  const runtime = await ensureRuntime(sessionRecord);

  if (typeof visibleUserPrompt === 'string' && visibleUserPrompt.trim()) {
    const trimmedUserPrompt = visibleUserPrompt.trim();
    const userEvent = {
      type: 'user',
      prompt: trimmedUserPrompt,
      timestamp: Date.now(),
    };
    if (attachments.length > 0) {
      userEvent.files = attachments;
      userEvent.images = attachments.filter((p) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p));
    }

    sessionRecord.history.push(userEvent);
    sessionRecord.messageCount += 1;
    sessionRecord.updatedAt = Date.now();
    sessionRecord.preview = trimmedUserPrompt;
    if (sessionRecord.title === 'New Session') {
      sessionRecord.title = buildSessionTitle(trimmedUserPrompt);
    }
    schedulePersistSession(sessionRecord, true);
    emitSessionMeta(sessionRecord);
    if (!sender.isDestroyed()) {
      sender.send('agent:event', { sessionId: sessionRecord.id, payload: userEvent });
    }
  }

  sessionRecord.busy = true;
  sessionRecord.updatedAt = Date.now();
  schedulePersistSession(sessionRecord, true);
  emitSessionMeta(sessionRecord);
  emitToRenderer('agent:state', { sessionId: sessionRecord.id, busy: true });

  try {
    let latestAssistantText = '';
    let streamedAssistantText = '';
    let skippedInitialReplayUser = false;
    const expectedVisibleUserPrompt =
      typeof visibleUserPrompt === 'string' ? visibleUserPrompt.trim() : '';

    for await (const message of runtime.send(runtimePrompt)) {
      if (
        !skippedInitialReplayUser &&
        expectedVisibleUserPrompt &&
        message?.type === 'user' &&
        message?.parent_tool_use_id == null &&
        !message?.tool_use_result &&
        extractTextFromUserReplayMessage(message) === expectedVisibleUserPrompt
        && (
          message?.isReplay === true ||
          sessionRecord.agentMode === 'remote-direct'
        )
      ) {
        skippedInitialReplayUser = true;
        continue;
      }

      maybeUpdateUnderlyingSessionId(sessionRecord, message.session_id);
      sessionRecord.history.push(message);
      sessionRecord.updatedAt = Date.now();
      sessionRecord.preview = deriveSessionPreview(sessionRecord.history);
      if (message.type === 'assistant') {
        const assistantText = extractTextFromAssistantMessage(message);
        if (assistantText) {
          latestAssistantText = assistantText;
        }
      } else if (
        message.type === 'stream_event' &&
        message.event?.type === 'content_block_delta' &&
        message.event?.delta?.type === 'text_delta' &&
        typeof message.event.delta.text === 'string'
      ) {
        streamedAssistantText += message.event.delta.text;
      }
      schedulePersistSession(sessionRecord);
      if (!sender.isDestroyed()) {
        sender.send('agent:event', { sessionId: sessionRecord.id, payload: message });
      }
    }

    return {
      latestAssistantText,
      streamedAssistantText,
    };
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (/Failed to authenticate|API Error:\s*403|API Error:\s*401|forbidden|unauthorized/i.test(message)) {
      try {
        const authDebug = await getAuthDebugSnapshot();
        const summary = formatAuthDebug(authDebug);
        if (summary) {
          message = `${message}\n[auth debug] ${summary}`;
        }
      } catch {}
    }
    const errorEvent = {
      type: 'error',
      message,
      timestamp: Date.now(),
    };
    sessionRecord.history.push(errorEvent);
    schedulePersistSession(sessionRecord, true);
    if (!sender.isDestroyed()) {
      sender.send('agent:event', { sessionId: sessionRecord.id, payload: errorEvent });
    }
    throw error;
  } finally {
    sessionRecord.busy = false;
    sessionRecord.updatedAt = Date.now();
    schedulePersistSession(sessionRecord, true);
    emitSessionMeta(sessionRecord);
    emitToRenderer('agent:state', {
      sessionId: sessionRecord.id,
      busy: false,
      summary: getSessionSummary(sessionRecord),
    });
  }
}

function getBootStatus() {
  return {
    repoRoot,
    uiRoot,
    cliPath,
    sdkPath,
    cliReady: true, // 核心改动：不再依赖外部 cli-node.js，因为逻辑已经由 electron-direct.mjs 嵌入
    sdkReady: hasFile(sdkPath),
    sessionsCount: sessions.size,
    defaultBypassPermissions: DEFAULT_BYPASS_PERMISSIONS,
    defaultWorkspaceRoot: USER_TMP_DIR,
    appsDir: ensureAppsDir(),
    localSettingsAuthOnly: process.env.CLAUDE_CODE_LOCAL_SETTINGS_AUTH_ONLY === 'true',
    userSettingsPath: localSettingsAuthConfig.path,
    userSettingsExists: localSettingsAuthConfig.exists,
    userSettingsLoaded: localSettingsAuthConfig.loaded,
    userSettingsInjected: localSettingsAuthConfig.injected,
    userSettingsParseError: localSettingsAuthConfig.parseError,
    desktopSettingsPath: DESKTOP_SETTINGS_PATH,
    desktopSettingsExists: desktopSettingsState.exists,
    desktopSettingsLoaded: desktopSettingsState.loaded,
    desktopSettingsParseError: desktopSettingsState.parseError,
  };
}

function emitToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function emitSessionMeta(sessionRecord) {
  emitToRenderer('agent:session-meta', getSessionSummary(sessionRecord));
}

function emitAppsChanged(payload = {}) {
  emitToRenderer('app:changed', {
    timestamp: Date.now(),
    ...payload,
  });
}

function normalizeWorkspace(workspace) {
  const normalized = workspace && String(workspace).trim() ? String(workspace).trim() : createDefaultWorkspacePath();
  return path.resolve(normalized);
}

function buildSessionTitle(prompt) {
  const line = String(prompt || '')
    .split('\n')
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!line) return 'New Session';
  return line.length > 36 ? `${line.slice(0, 36)}...` : line;
}

function ensureAppsDir() {
  fs.mkdirSync(MOSS_APPS_DIR, { recursive: true });
  return MOSS_APPS_DIR;
}

/**
 * Initialize bundled apps from src/apps to generated-apps directory.
 * In packaged mode, reads from process.resourcesPath/apps.
 */
function initializeBundledApps() {
  const bundledAppsDir = app.isPackaged
    ? path.join(process.resourcesPath, 'apps')
    : path.join(uiRoot, 'src', 'apps');
  ensureAppsDir();

  try {
    fs.readdirSync(bundledAppsDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.html'))
      .forEach(entry => {
        const srcPath = path.join(bundledAppsDir, entry.name);
        const dstPath = path.join(MOSS_APPS_DIR, entry.name);
        fs.copyFileSync(srcPath, dstPath, fs.constants.COPYFILE_EXCL);
      });
  } catch (err) {
    console.warn('[app-init] Failed to initialize bundled apps:', err.message);
  }
}

/**
 * Initialize bundled skills from repo skills directory to ~/.moss/skills/system.
 * In packaged mode, reads from process.resourcesPath/skills.
 */
function initializeBundledSkills() {
  fs.mkdirSync(MOSS_SYSTEM_SKILLS_DIR, { recursive: true });

  try {
    const srcDir = app.isPackaged
      ? path.join(process.resourcesPath, 'skills')
      : MOSS_REPO_SKILLS_DIR;
    if (!fs.existsSync(srcDir)) return;

    fs.readdirSync(srcDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .forEach(entry => {
        const srcPath = path.join(srcDir, entry.name);
        const dstPath = path.join(MOSS_SYSTEM_SKILLS_DIR, entry.name);
        try {
          fs.cpSync(srcPath, dstPath, { recursive: true });
        } catch (copyErr) {
          console.warn(`[skill-init] Failed to copy skill ${entry.name}:`, copyErr.message);
        }
      });
  } catch (err) {
    console.warn('[skill-init] Failed to initialize bundled skills:', err.message);
  }
}

/**
 * Initialize bundled assistants from repo assistants directory to ~/.moss/assistants/_system.
 * In packaged mode, reads from process.resourcesPath/assistants.
 */
function initializeBundledAssistants() {
  fs.mkdirSync(ASSISTANT_SYSTEM_DIR, { recursive: true });

  try {
    const srcDir = app.isPackaged
      ? path.join(process.resourcesPath, 'assistants')
      : MOSS_REPO_ASSISTANTS_DIR;
    if (!fs.existsSync(srcDir)) return;

    fs.readdirSync(srcDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .forEach(entry => {
        const srcPath = path.join(srcDir, entry.name);
        const dstPath = path.join(ASSISTANT_SYSTEM_DIR, entry.name);
        try {
          fs.cpSync(srcPath, dstPath, { recursive: true });
        } catch (copyErr) {
          console.warn(`[assistant-init] Failed to copy assistant ${entry.name}:`, copyErr.message);
        }
      });
  } catch (err) {
    console.warn('[assistant-init] Failed to initialize bundled assistants:', err.message);
  }
}

function ensureAppDataRootDir() {
  fs.mkdirSync(MOSS_APP_DATA_DIR, { recursive: true });
  return MOSS_APP_DATA_DIR;
}

function ensureAppDataDir(name) {
  const dataDir = path.join(ensureAppDataRootDir(), name);
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

function ensureAppFilesDir(name) {
  const filesDir = path.join(ensureAppDataDir(name), APP_FILES_SUBDIR);
  fs.mkdirSync(filesDir, { recursive: true });
  return filesDir;
}

function ensureAppVersionsDir(name) {
  const versionsDir = path.join(ensureAppDataDir(name), APP_VERSIONS_SUBDIR);
  fs.mkdirSync(versionsDir, { recursive: true });
  return versionsDir;
}

function getAppStoragePath(name) {
  return path.join(ensureAppDataDir(name), APP_STORAGE_FILENAME);
}

function createAppWindowState(appEntry, appWindow) {
  const state = {
    name: appEntry.name,
    window: appWindow,
    dataDir: ensureAppDataDir(appEntry.name),
    filesDir: ensureAppFilesDir(appEntry.name),
    versionsDir: ensureAppVersionsDir(appEntry.name),
    storagePath: getAppStoragePath(appEntry.name),
    runtime: null,
    underlyingSessionId: null,
    busy: false,
    currentAgentRequestId: null,
    currentAgentContext: '',
    agentMode: getDesktopAgentMode(),
  };
  appWindowStates.set(appWindow.webContents.id, state);
  return state;
}

function getAppWindowStateBySender(sender) {
  const state = appWindowStates.get(sender.id);
  if (!state) {
    throw new Error('App runtime is not available for this window.');
  }
  return state;
}

function disposeAppRuntime(appState) {
  if (!appState?.runtime) return;
  appState.runtime.dispose();
  appState.runtime = null;
  appState.underlyingSessionId = null;
  appState.currentAgentRequestId = null;
  appState.busy = false;
}

function emitToAppWindow(appState, channel, payload) {
  if (!appState?.window || appState.window.isDestroyed()) return;
  appState.window.webContents.send(channel, payload);
}

function emitAppRuntimeEvent(appState, eventType, payload = {}) {
  emitToAppWindow(appState, 'app-runtime:event', {
    type: eventType,
    appName: appState.name,
    timestamp: Date.now(),
    ...payload,
  });
}

function readAppStorageSnapshot(appState) {
  try {
    if (!fs.existsSync(appState.storagePath)) {
      return {};
    }
    const raw = fs.readFileSync(appState.storagePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeAppStorageSnapshot(appState, snapshot) {
  fs.mkdirSync(path.dirname(appState.storagePath), { recursive: true });
  fs.writeFileSync(appState.storagePath, JSON.stringify(snapshot, null, 2), 'utf8');
}

function getAppInfoPayload(appState) {
  const storedApp = loadStoredAppContent(appState.name);
  return {
    name: storedApp.name,
    description: storedApp.description,
    width: storedApp.width,
    height: storedApp.height,
    resizable: storedApp.resizable,
    prd: storedApp.prd,
    filePath: storedApp.filePath,
    dataDir: appState.dataDir,
    filesDir: appState.filesDir,
    versionsDir: appState.versionsDir,
    hostApi: 'window.mossApp',
  };
}

function listAppResourceDescriptors(appState) {
  return [
    { uri: 'app://meta', mimeType: 'application/json', description: 'Current app metadata and host paths.' },
    { uri: 'app://prd', mimeType: 'text/plain', description: 'Current app PRD.' },
    { uri: 'app://html', mimeType: 'text/html', description: 'Current app HTML document.' },
    { uri: 'app://storage', mimeType: 'application/json', description: 'Current key/value storage snapshot.' },
    { uri: 'app://files/<path>', mimeType: 'text/plain', description: 'Text file under the app data files directory.' },
    { uri: 'app://versions', mimeType: 'application/json', description: 'Available app version snapshots.' },
  ];
}

function listAppToolDescriptors() {
  return [
    { name: 'storage.get', description: 'Read one storage value by key.' },
    { name: 'storage.set', description: 'Persist one storage value by key.' },
    { name: 'storage.remove', description: 'Delete one storage value by key.' },
    { name: 'storage.list', description: 'List storage keys.' },
    { name: 'files.list', description: 'List files and directories under the app files root.' },
    { name: 'files.read_text', description: 'Read a UTF-8 text file from the app files root.' },
    { name: 'files.write_text', description: 'Write a UTF-8 text file to the app files root.' },
    { name: 'files.delete', description: 'Delete a file or directory from the app files root.' },
    { name: 'files.mkdir', description: 'Create a directory under the app files root.' },
    { name: 'resources.read', description: 'Read a runtime resource by URI.' },
    { name: 'resources.list', description: 'List runtime resource descriptors.' },
    { name: 'versions.list', description: 'List saved app version snapshots.' },
    { name: 'versions.rollback', description: 'Roll back the current app to a saved version id.' },
    { name: 'agent.send', description: 'Send a prompt to the app-scoped agent. Supports streaming and context.' },
    { name: 'agent.cancel', description: 'Cancel the in-flight app agent request.' },
    { name: 'agent.reset', description: 'Dispose the current app agent runtime.' },
    { name: 'tools.list', description: 'List available runtime tools.' },
  ];
}

async function listAppFiles(appState, dirPath = '.') {
  const root = appState.filesDir;
  const targetPath = ensureInsideRoot(root, path.join(root, dirPath));
  await fsp.mkdir(targetPath, { recursive: true });
  const dirents = await fsp.readdir(targetPath, { withFileTypes: true });

  const items = dirents
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => {
      const fullPath = path.join(targetPath, entry.name);
      return {
        name: entry.name,
        path: path.relative(root, fullPath) || '.',
        absolutePath: fullPath,
        type: entry.isDirectory() ? 'directory' : 'file',
      };
    })
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

  return {
    root,
    path: path.relative(root, targetPath) || '.',
    items,
  };
}

async function readAppTextFile(appState, filePath) {
  const targetPath = ensureInsideRoot(appState.filesDir, path.join(appState.filesDir, filePath));
  const stat = await fsp.stat(targetPath);
  if (!stat.isFile()) {
    throw new Error('Target is not a file.');
  }
  const buffer = await fsp.readFile(targetPath);
  if (buffer.includes(0)) {
    throw new Error('Binary files are not supported by this runtime API.');
  }
  return {
    path: path.relative(appState.filesDir, targetPath),
    content: buffer.toString('utf8'),
    size: stat.size,
  };
}

async function writeAppTextFile(appState, filePath, content) {
  const targetPath = ensureInsideRoot(appState.filesDir, path.join(appState.filesDir, filePath));
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.writeFile(targetPath, String(content ?? ''), 'utf8');
  const stat = await fsp.stat(targetPath);
  return {
    path: path.relative(appState.filesDir, targetPath),
    size: stat.size,
  };
}

async function deleteAppFile(appState, filePath) {
  const targetPath = ensureInsideRoot(appState.filesDir, path.join(appState.filesDir, filePath));
  await fsp.rm(targetPath, { recursive: true, force: true });
  return { ok: true };
}

async function makeAppDirectory(appState, dirPath) {
  const targetPath = ensureInsideRoot(appState.filesDir, path.join(appState.filesDir, dirPath));
  await fsp.mkdir(targetPath, { recursive: true });
  return {
    path: path.relative(appState.filesDir, targetPath) || '.',
  };
}

async function readAppResource(appState, uri) {
  const normalizedUri = String(uri || '').trim();
  if (!normalizedUri) {
    throw new Error('Resource URI is required.');
  }

  if (normalizedUri === 'app://meta') {
    const info = getAppInfoPayload(appState);
    return {
      uri: normalizedUri,
      mimeType: 'application/json',
      text: JSON.stringify(info, null, 2),
      data: info,
    };
  }

  if (normalizedUri === 'app://prd') {
    const info = getAppInfoPayload(appState);
    return {
      uri: normalizedUri,
      mimeType: 'text/plain',
      text: info.prd || '',
    };
  }

  if (normalizedUri === 'app://html') {
    const storedApp = loadStoredAppContent(appState.name);
    return {
      uri: normalizedUri,
      mimeType: 'text/html',
      text: storedApp.html,
    };
  }

  if (normalizedUri === 'app://storage') {
    const storage = readAppStorageSnapshot(appState);
    return {
      uri: normalizedUri,
      mimeType: 'application/json',
      text: JSON.stringify(storage, null, 2),
      data: storage,
    };
  }

  if (normalizedUri === 'app://versions') {
    const versions = listAppVersionSnapshots(appState.name);
    return {
      uri: normalizedUri,
      mimeType: 'application/json',
      text: JSON.stringify(versions, null, 2),
      data: versions,
    };
  }

  if (normalizedUri.startsWith('app://files/')) {
    const relativePath = normalizedUri.slice('app://files/'.length);
    const file = await readAppTextFile(appState, relativePath);
    return {
      uri: normalizedUri,
      mimeType: 'text/plain',
      text: file.content,
      data: file,
    };
  }

  throw new Error(`Unsupported resource URI: ${normalizedUri}`);
}

async function ensureAppAgentRuntime(appState) {
  if (!hasFile(sdkPath)) {
    throw new Error(`Missing electron-direct.mjs at ${sdkPath}.`);
  }

  if (appState.runtime) {
    return appState.runtime;
  }

  const onPermissionRequest = async (toolName, input) => {
    const toolLabel = toolName || 'Tool';
    const detailParts = [];
    if (input) detailParts.push(`输入:\n${JSON.stringify(input, null, 2)}`);

    const dialogTarget = appState.window && !appState.window.isDestroyed()
      ? appState.window
      : mainWindow && !mainWindow.isDestroyed()
        ? mainWindow
        : undefined;

    const response = await dialog.showMessageBox(dialogTarget, {
      type: 'question',
      buttons: ['允许', '拒绝'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: 'App 工具权限确认',
      message: `${appState.name} 请求执行 ${toolLabel}`,
      detail: detailParts.join('\n\n') || '应用中的 agent 请求工具执行权限。',
    });

    return response.response === 0;
  };

  if (appState.agentMode === 'remote-direct') {
    appState.runtime = createRemoteDirectRuntime({
      sessionRecord: appState,
      onPermissionRequest,
      onSessionCreated: (created) => {
        if (created?.workDir) {
          appState.remoteWorkspace = created.workDir;
        }
      },
    });
    return appState.runtime;
  }

  const ClaudeSession = await getClaudeSessionCtor();
  appState.runtime = new ClaudeSession({
    ...buildClaudeSessionConfig(appState.dataDir),
    onPermissionRequest,
    onAppEvent: (appEvent) => mossAppEventHandler(appEvent, appState),
  });
  return appState.runtime;
}

function buildAppAgentPrompt(appState, prompt, systemPrompt = '') {
  const info = getAppInfoPayload(appState);
  const parts = [];
  if (systemPrompt && String(systemPrompt).trim()) {
    parts.push(`SYSTEM INSTRUCTIONS:\n${String(systemPrompt).trim()}`);
  }
  if (appState.currentAgentContext) {
    parts.push(`APP CONTEXT:\n${appState.currentAgentContext}`);
  }
  parts.push(
    'You are assisting an Electron mini app through its host runtime.',
    `App name: ${info.name}`,
    `App description: ${info.description || 'n/a'}`,
    `App data directory: ${info.dataDir}`,
    '',
    'App PRD:',
    info.prd || '(empty)',
    '',
    'User request:',
    String(prompt || '').trim()
  );
  return parts.join('\n');
}

function buildAgentContextBlock(context) {
  if (context == null) return '';
  if (typeof context === 'string') {
    return context.trim();
  }
  try {
    return JSON.stringify(context, null, 2);
  } catch {
    return String(context);
  }
}

function normalizeAppAgentResult(appState, requestId, result) {
  return {
    ok: true,
    requestId,
    sessionId: appState.underlyingSessionId,
    text: result.text || '',
    content: [{ type: 'text', text: result.text || '' }],
    completedAt: Date.now(),
  };
}

async function sendPromptToAppAgent(appState, payload = {}) {
  if (appState.busy) {
    return {
      ok: false,
      error: {
        code: 'busy',
        message: 'This app agent is already processing a request.',
      },
    };
  }

  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  if (!prompt) {
    return {
      ok: false,
      error: {
        code: 'invalid_prompt',
        message: 'Prompt is required.',
      },
    };
  }

  const runtime = await ensureAppAgentRuntime(appState);
  const requestId = typeof payload.requestId === 'string' && payload.requestId.trim()
    ? payload.requestId.trim()
    : randomUUID();
  const stream = payload.stream === true;
  const contextBlock = buildAgentContextBlock(payload.context);
  appState.currentAgentContext = contextBlock;
  const runtimePrompt = buildAppAgentPrompt(appState, prompt, payload.systemPrompt);

  const runRequest = async () => {
    appState.busy = true;
    appState.currentAgentRequestId = requestId;
    emitAppRuntimeEvent(appState, 'agent:start', {
      requestId,
      prompt,
      stream,
    });

    try {
      let latestAssistantText = '';
      let streamedAssistantText = '';

      for await (const message of runtime.send(runtimePrompt)) {
        maybeUpdateUnderlyingSessionId(appState, message.session_id);
        if (message.type === 'assistant') {
          const assistantText = extractTextFromAssistantMessage(message);
          if (assistantText) {
            latestAssistantText = assistantText;
          }
        } else if (
          message.type === 'stream_event' &&
          message.event?.type === 'content_block_delta' &&
          message.event?.delta?.type === 'text_delta' &&
          typeof message.event.delta.text === 'string'
        ) {
          streamedAssistantText += message.event.delta.text;
          emitAppRuntimeEvent(appState, 'agent:delta', {
            requestId,
            delta: message.event.delta.text,
            text: streamedAssistantText,
          });
        }
      }

      const finalResult = normalizeAppAgentResult(appState, requestId, {
        text: latestAssistantText || streamedAssistantText,
      });
      emitAppRuntimeEvent(appState, 'agent:complete', finalResult);
      return finalResult;
    } catch (error) {
      const normalizedError = {
        ok: false,
        requestId,
        error: {
          code: 'agent_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      };
      emitAppRuntimeEvent(appState, 'agent:error', normalizedError);
      return normalizedError;
    } finally {
      appState.busy = false;
      appState.currentAgentRequestId = null;
    }
  };

  if (stream) {
    void runRequest();
    return {
      ok: true,
      requestId,
      streaming: true,
      sessionId: appState.underlyingSessionId,
    };
  }

  return runRequest();
}

function cancelAppAgentRequest(appState, requestId = '') {
  if (!appState.busy || !appState.runtime) {
    return {
      ok: false,
      error: {
        code: 'not_running',
        message: 'No in-flight app agent request.',
      },
    };
  }
  if (requestId && appState.currentAgentRequestId && requestId !== appState.currentAgentRequestId) {
    return {
      ok: false,
      error: {
        code: 'request_mismatch',
        message: 'Request id does not match the active app agent request.',
      },
    };
  }

  appState.runtime.abort();
  emitAppRuntimeEvent(appState, 'agent:cancelled', {
    requestId: appState.currentAgentRequestId,
  });
  return {
    ok: true,
    requestId: appState.currentAgentRequestId,
  };
}

async function callAppTool(appState, name, args = {}) {
  switch (name) {
    case 'storage.get': {
      const key = String(args.key || '').trim();
      if (!key) throw new Error('storage.get requires key.');
      const storage = readAppStorageSnapshot(appState);
      return storage[key];
    }
    case 'storage.set': {
      const key = String(args.key || '').trim();
      if (!key) throw new Error('storage.set requires key.');
      const storage = readAppStorageSnapshot(appState);
      storage[key] = args.value;
      writeAppStorageSnapshot(appState, storage);
      emitAppRuntimeEvent(appState, 'storage:changed', {
        key,
        value: args.value,
        action: 'set',
      });
      return { ok: true, key, value: args.value };
    }
    case 'storage.remove': {
      const key = String(args.key || '').trim();
      if (!key) throw new Error('storage.remove requires key.');
      const storage = readAppStorageSnapshot(appState);
      delete storage[key];
      writeAppStorageSnapshot(appState, storage);
      emitAppRuntimeEvent(appState, 'storage:changed', {
        key,
        action: 'remove',
      });
      return { ok: true, key };
    }
    case 'storage.list':
      return Object.keys(readAppStorageSnapshot(appState));
    case 'files.list':
      return listAppFiles(appState, args.path || '.');
    case 'files.read_text':
      return readAppTextFile(appState, args.path);
    case 'files.write_text':
      return writeAppTextFile(appState, args.path, args.content).then((result) => {
        emitAppRuntimeEvent(appState, 'files:changed', {
          action: 'write',
          path: result.path,
        });
        return result;
      });
    case 'files.delete':
      return deleteAppFile(appState, args.path).then((result) => {
        emitAppRuntimeEvent(appState, 'files:changed', {
          action: 'delete',
          path: args.path,
        });
        return result;
      });
    case 'files.mkdir':
      return makeAppDirectory(appState, args.path || '.').then((result) => {
        emitAppRuntimeEvent(appState, 'files:changed', {
          action: 'mkdir',
          path: result.path,
        });
        return result;
      });
    case 'resources.read':
      return readAppResource(appState, args.uri);
    case 'resources.list':
      return listAppResourceDescriptors(appState);
    case 'versions.list':
      return listAppVersionSnapshots(appState.name);
    case 'versions.rollback': {
      const versionId = String(args.versionId || '').trim();
      if (!versionId) throw new Error('versions.rollback requires versionId.');
      const rolledBack = rollbackAppToVersion(appState.name, versionId);
      emitAppsChanged({ action: 'rolled-back', name: appState.name });
      emitAppRuntimeEvent(appState, 'app:rolled-back', {
        versionId,
        app: rolledBack,
      });
      refreshOpenAppWindow(appState.name);
      launchAppWindowByEntry(rolledBack);
      return {
        ok: true,
        versionId,
        app: rolledBack,
      };
    }
    case 'agent.send':
      return sendPromptToAppAgent(appState, args);
    case 'agent.cancel':
      return cancelAppAgentRequest(appState, String(args.requestId || ''));
    case 'agent.reset':
      disposeAppRuntime(appState);
      emitAppRuntimeEvent(appState, 'agent:reset', {});
      return { ok: true };
    case 'tools.list':
      return listAppToolDescriptors();
    default:
      throw new Error(`Unknown app tool: ${name}`);
  }
}

function refreshOpenAppWindow(name) {
  const existingWindow = appWindows.get(name);
  if (!existingWindow || existingWindow.isDestroyed()) return;
  const appState = appWindowStates.get(existingWindow.webContents.id);
  if (appState) {
    disposeAppRuntime(appState);
  }
  const appEntry = getStoredApp(name);
  void existingWindow.loadFile(appEntry.filePath);
}

function launchAppWindowByEntry(appEntry) {
  const existingWindow = appWindows.get(appEntry.name);
  if (existingWindow && !existingWindow.isDestroyed()) {
    if (existingWindow.isMinimized()) {
      existingWindow.restore();
    }
    existingWindow.show();
    existingWindow.focus();
    return existingWindow;
  }

  const appWindow = new BrowserWindow({
    title: appEntry.name,
    width: appEntry.width || 900,
    height: appEntry.height || 700,
    resizable: appEntry.resizable !== false,
    backgroundColor: '#0b1120',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'app-preload.mjs'),
      sandbox: false, // 核心修复：必须关闭 sandbox 模式，Host API 才能在 ContextBridge 中正确挂载
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  appWindows.set(appEntry.name, appWindow);
  const appState = createAppWindowState(appEntry, appWindow);
  appWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  appWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== appWindow.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
        void shell.openExternal(url);
      }
    }
  });
  appWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  appWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  appWindow.on('closed', () => {
    const state = appWindowStates.get(appWindow.webContents.id);
    if (state) {
      disposeAppRuntime(state);
      appWindowStates.delete(appWindow.webContents.id);
    }
    appWindows.delete(appEntry.name);
  });
  emitAppRuntimeEvent(appState, 'app:window-opened', {
    name: appEntry.name,
  });
  void appWindow.loadFile(appEntry.filePath);
  return appWindow;
}

const executionHtmlDev = rendererDevServerUrl ? `${rendererDevServerUrl}/src/execution.html` : null;
const executionHtmlProd = path.join(uiRoot, 'dist', 'renderer', 'src', 'execution.html');

function emitToExecutionWindow(webContents, channel, payload) {
  if (!webContents || webContents.isDestroyed()) return;
  webContents.send(channel, payload);
}

async function launchPlanExecutionWindow({ originalPrompt, plan, mainWindow, originalSessionId }) {
  const execWindow = new BrowserWindow({
    title: 'Plan Execution',
    width: 800,
    height: 700,
    resizable: true,
    backgroundColor: '#09111c',
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'execution-preload.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const execSessionId = randomUUID();
  const execWorkspace = path.join(MOSS_WORKSPACES_DIR, execSessionId);
  fs.mkdirSync(execWorkspace, { recursive: true });

  const execSessionRecord = createSessionRecord({ workspace: execWorkspace, isSubAgent: true });
  // Update the id to execSessionId and store in subAgentSessions
  execSessionRecord.id = execSessionId;
  execSessionRecord.underlyingSessionId = originalSessionId;
  subAgentSessions.set(execSessionId, execSessionRecord);
  // Re-persist with the correct underlyingSessionId
  persistSessionRecord(execSessionRecord, true);

  const execState = {
    id: execSessionId,
    window: execWindow,
    originalPrompt,
    plan,
    busy: false,
    sessionRecord: execSessionRecord,
    workspace: execWorkspace,
    mainWindow, // the main window that initiated this execution
    originalSessionId, // the main window's session ID
  };
  executionWindows.set(execSessionId, execWindow);
  executionWindowStates.set(execWindow.webContents.id, execState);

  execWindow.on('close', (event) => {
    // Prevent actual close, just hide the window so we can restore it later
    event.preventDefault();
    execWindow.hide();
  });

  // Load the execution HTML
  if (rendererDevServerUrl) {
    void execWindow.loadURL(executionHtmlDev);
  } else {
    if (!hasFile(executionHtmlProd)) {
      throw new Error(`Missing execution.html at ${executionHtmlProd}. Run "vite build" in ui first.`);
    }
    void execWindow.loadFile(executionHtmlProd);
  }

  // Send initial state to the execution window
  execWindow.webContents.once('did-finish-load', () => {
    execState.busy = true;
    emitToExecutionWindow(execWindow.webContents, 'execution:init', {
      originalPrompt,
      plan,
      busy: true,
      workspace: execWorkspace,
    });
    // Run the plan execution in the background
    void runPlanExecution(execSessionRecord, execWindow, execState, originalPrompt, plan);
  });

  return execSessionId;
}

async function runPlanExecution(execSessionRecord, execWindow, execState, originalPrompt, plan) {
  const { mainWindow } = execState;

  const sendEvent = (channel, data) => {
    if (execWindow.webContents.isDestroyed()) return;
    execWindow.webContents.send(channel, data);
    // Also send to bubble window if it exists
    if (execState.bubbleWindow && !execState.bubbleWindow.isDestroyed()) {
      execState.bubbleWindow.webContents.send(channel, data);
    }
  };

  // Notify main window of execution state changes
  const notifyMainWindow = (type, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.send(type, data);
    }
  };

  const runtimePrompt = `You are executing an approved implementation plan.

Original user request: ${originalPrompt}

Approved plan:
${plan}

Follow the plan step by step. Use tools to complete each step. Report progress as you complete each step. When you encounter an error, describe it clearly.

Important:
- Execute ALL steps in the plan
- Use file operation tools to create/modify files as needed
- Report each completed step
- Do not stop until all steps are complete`;

  const runtime = await ensureRuntime(execSessionRecord);

  // Add user message to history
  const userEvent = {
    type: 'user',
    prompt: originalPrompt,
    timestamp: Date.now(),
  };
  execSessionRecord.history.push(userEvent);
  execSessionRecord.messageCount += 1;
  execSessionRecord.busy = true;
  execSessionRecord.updatedAt = Date.now();
  schedulePersistSession(execSessionRecord);

  sendEvent('execution:state', { busy: true });

  try {
    for await (const message of runtime.send(runtimePrompt)) {
      maybeUpdateUnderlyingSessionId(execSessionRecord, message.session_id);
      execSessionRecord.history.push(message);
      execSessionRecord.updatedAt = Date.now();
      execSessionRecord.preview = deriveSessionPreview(execSessionRecord.history);
      schedulePersistSession(execSessionRecord);
      sendEvent('execution:event', { sessionId: execSessionRecord.id, payload: message });
    }
    execSessionRecord.busy = false;
    execState.busy = false; // Update execState so execution:list returns correct state
    schedulePersistSession(execSessionRecord, true); // Persist final state
    sendEvent('execution:event', { type: 'message_stop' });
    sendEvent('execution:state', { busy: false });

    // Build summary of completed work
    const summaryMessage = `Sub-agent task completed:\n\nOriginal request: ${execState.originalPrompt}\n\nPlan executed:\n${execState.plan}`;

    // Push completion message to main session history so main agent can see it
    const mainSessionRecord = getSessionRecord(execState.originalSessionId);
    if (mainSessionRecord) {
      pushSessionHistoryEvent(mainSessionRecord, {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: `[Sub-agent completed] ${summaryMessage}` }],
        },
        timestamp: Date.now(),
      }, mainWindow.webContents);
      schedulePersistSession(mainSessionRecord);
      // Notify main window to refresh
      notifyMainWindow('agent:event', {
        sessionId: execState.originalSessionId,
        payload: { type: 'message', message: { role: 'user', content: [{ type: 'text', text: `[Sub-agent completed] ${summaryMessage}` }] } },
      });
    }
  } catch (error) {
    execSessionRecord.busy = false;
    execState.busy = false; // Update execState so execution:list returns correct state
    schedulePersistSession(execSessionRecord, true); // Persist final state
    const message = error instanceof Error ? error.message : String(error);
    sendEvent('execution:event', { type: 'error', message });
    sendEvent('execution:state', { busy: false });
    notifyMainWindow('agent:event', {
      sessionId: execState.originalSessionId,
      payload: { type: 'plan_execution_error', message },
    });
  }
}

function disposeSessionRuntime(sessionRecord) {
  if (sessionRecord?.runtime) {
    try {
      sessionRecord.runtime.abort();
    } catch {}
    sessionRecord.runtime = null;
  }
}

function ensureInsideRoot(rootPath, targetPath) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path is outside the active workspace.');
  }
  return resolvedTarget;
}

function createSessionRecord({ workspace, isSubAgent = false, title, assistantName } = {}) {
  const now = Date.now();
  const normalizedWorkspace = normalizeWorkspace(workspace);
  fs.mkdirSync(normalizedWorkspace, { recursive: true });

  // 核心改动：在工作区初始化 git
  try {
    if (!fs.existsSync(path.join(normalizedWorkspace, '.git'))) {
      execSync('git init', { cwd: normalizedWorkspace, stdio: 'ignore' });
    }
  } catch (error) {
    console.warn(`Failed to initialize git in ${normalizedWorkspace}:`, error);
  }

  const sessionRecord = {
    id: randomUUID(),
    title: title || 'New Session',
    workspace: normalizedWorkspace,
    remoteWorkspace: getRemoteDirectWorkspace() || null,
    agentMode: getDesktopAgentMode(),
    createdAt: now,
    updatedAt: now,
    busy: false,
    messageCount: 0,
    preview: '',
    underlyingSessionId: null,
    pendingPlanApproval: null,
    history: [],
    historyLoadedFromSource: false,
    runtime: null,
    resumeReadOnlyReason: null,
    workspaceWatcher: null,
    workspaceWatcherSyncTimer: null,
    persistTimer: null,
    isSubAgent,
    assistantName: assistantName || null,
  };
  if (!isSubAgent) {
    sessions.set(sessionRecord.id, sessionRecord);
  }
  persistSessionRecord(sessionRecord, isSubAgent);
  if (!isSubAgent) {
    void startWorkspaceWatcher(sessionRecord);
    emitSessionMeta(sessionRecord);
    mossLog('info', 'session', 'Session created', { sessionId: sessionRecord.id, workspace: normalizedWorkspace, isSubAgent });
  }
  return sessionRecord;
}

function getSessionRecord(sessionId) {
  const sessionRecord = sessions.get(sessionId);
  if (!sessionRecord) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  return sessionRecord;
}

// SDK writes task-notification queue-operation events directly to its .jsonl transcript file,
// bypassing the runtime.send() stream. This helper reads those events so the UI can display
// async worker results even when the coordinator never ran a second turn.
// Find the subagents directory for a session.
// The SDK stores sub-agent files under:
//   MOSS_PROJECTS_DIR/{sanitized_cwd}/{sessionId}/subagents/
// The CWD used by the SDK runtime may differ from sessionRecord.workspace
// (e.g. in coordinator mode the runtime runs inside an execution window workspace),
// so we search all workspace subdirectories for the matching sessionId directory.
async function findSessionSubagentDir(underlyingSessionId) {
  if (!underlyingSessionId) return null;
  try {
    const workspaceDirs = await fsp.readdir(MOSS_PROJECTS_DIR);
    for (const dir of workspaceDirs) {
      const candidate = path.join(MOSS_PROJECTS_DIR, dir, underlyingSessionId, 'subagents');
      try {
        await fsp.access(candidate);
        return candidate;
      } catch {}
    }
  } catch {}
  return null;
}

function disposeRuntime(sessionRecord) {
  if (!sessionRecord.runtime) return;
  sessionRecord.runtime.dispose();
  sessionRecord.runtime = null;
  schedulePersistSession(sessionRecord, true);
}

function closeWorkspaceWatcher(sessionRecord) {
  if (!sessionRecord.workspaceWatcher) return;
  sessionRecord.workspaceWatcher.closed = true;
  for (const watcher of sessionRecord.workspaceWatcher.watchers.values()) {
    try {
      watcher.close();
    } catch {}
  }
  sessionRecord.workspaceWatcher.watchers.clear();
  sessionRecord.workspaceWatcher = null;
  if (sessionRecord.workspaceWatcherSyncTimer) {
    clearTimeout(sessionRecord.workspaceWatcherSyncTimer);
    sessionRecord.workspaceWatcherSyncTimer = null;
  }
  if (sessionRecord.persistTimer) {
    clearTimeout(sessionRecord.persistTimer);
    sessionRecord.persistTimer = null;
  }
}

async function collectDirectories(rootPath) {
  const directories = [];
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop();
    directories.push(current);
    let dirents = [];
    try {
      dirents = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of dirents) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.' || entry.name === '..') continue;
      pending.push(path.join(current, entry.name));
    }
  }
  return directories;
}

function emitWorkspaceChanged(sessionRecord, eventType, changedPath) {
  emitToRenderer('workspace:changed', {
    sessionId: sessionRecord.id,
    workspace: sessionRecord.workspace,
    eventType,
    path: changedPath,
    timestamp: Date.now(),
  });
}

async function syncWorkspaceWatcher(sessionRecord) {
  const watcherState = sessionRecord.workspaceWatcher;
  if (!watcherState || watcherState.closed) return;

  const directories = await collectDirectories(sessionRecord.workspace);
  if (watcherState.closed) return;
  const nextPaths = new Set(directories);

  for (const watchedPath of watcherState.watchers.keys()) {
    if (nextPaths.has(watchedPath)) continue;
    try {
      watcherState.watchers.get(watchedPath)?.close();
    } catch {}
    watcherState.watchers.delete(watchedPath);
  }

  for (const dirPath of directories) {
    if (watcherState.watchers.has(dirPath)) continue;
    try {
      const watcher = fs.watch(dirPath, (eventType, filename) => {
        const changedPath = filename ? path.join(dirPath, filename.toString()) : dirPath;
        emitWorkspaceChanged(sessionRecord, eventType, changedPath);
        if (sessionRecord.workspaceWatcherSyncTimer) {
          clearTimeout(sessionRecord.workspaceWatcherSyncTimer);
        }
        sessionRecord.workspaceWatcherSyncTimer = setTimeout(() => {
          sessionRecord.workspaceWatcherSyncTimer = null;
          void syncWorkspaceWatcher(sessionRecord);
        }, 150);
      });
      watcherState.watchers.set(dirPath, watcher);
    } catch {}
  }
}

/**
 * Handler for MossTool app events from agent runtime.
 * This maps event types to internal app functions and returns results.
 */
const mossAppEventHandler = createMossAppEventHandler(
  {
    launchAppWindow: launchAppWindowByEntry,
    previewAppFile: (filePath) => {
      const previewWindow = new BrowserWindow({
        title: `Preview - ${path.basename(filePath)}`,
        width: 900,
        height: 700,
        resizable: true,
        backgroundColor: '#0b1120',
        autoHideMenuBar: true,
        webPreferences: {
          sandbox: false,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      void previewWindow.loadFile(filePath)
    },
    refreshOpenAppWindow: (name) => {
      const win = appWindows.get(name)
      if (win && !win.isDestroyed()) {
        win.reload()
      }
    },
    getOpenAppWindow: (name) => appWindows.get(name),
    closeAppWindow: (name) => {
      const win = appWindows.get(name)
      if (win && !win.isDestroyed()) {
        win.close()
      }
    },
  },
  {
    emitAppsChanged,
  },
  {
    getSettings: () => desktopSettings,
  },
)

async function startWorkspaceWatcher(sessionRecord) {
  closeWorkspaceWatcher(sessionRecord);
  sessionRecord.workspaceWatcher = {
    closed: false,
    watchers: new Map(),
  };
  await syncWorkspaceWatcher(sessionRecord);
}

async function ensureRuntime(sessionRecord) {
  if (!hasFile(sdkPath)) {
    throw new Error(`Missing electron-direct.mjs at ${sdkPath}.`);
  }

  if (sessionRecord.runtime) {
    // If coordinatorMode changed, need to recreate runtime
    const currentCoordinatorMode = sessionRecord.isCoordinatorMode ?? false
    const existingCoordinatorMode = sessionRecord.runtime.coordinatorMode ?? false
    if (currentCoordinatorMode !== existingCoordinatorMode) {
      sessionRecord.runtime.dispose()
      sessionRecord.runtime = null
    } else {
      return sessionRecord.runtime
    }
  }

  const onPermissionRequest = async (toolName, input) => {
    const toolLabel = toolName || 'Tool';
    const detailParts = [];
    if (input) detailParts.push(`输入:\n${JSON.stringify(input, null, 2)}`);

    emitToRenderer('agent:permission', {
      sessionId: sessionRecord.id,
      request: {
        tool_name: toolName,
        input,
      },
    });

    const dialogTarget = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const response = await dialog.showMessageBox(dialogTarget, {
      type: 'question',
      buttons: ['允许', '拒绝'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: '工具权限确认',
      message: `${toolLabel} 请求执行`,
      detail: detailParts.join('\n\n') || 'Agent 请求工具执行权限。',
    });

    return response.response === 0;
  };

  if (sessionRecord.agentMode === 'remote-direct') {
    sessionRecord.runtime = createRemoteDirectRuntime({
      sessionRecord,
      coordinatorMode: sessionRecord.isCoordinatorMode ?? false,
      onPermissionRequest,
      onSessionCreated: (created) => {
        if (created?.workDir) {
          sessionRecord.remoteWorkspace = created.workDir;
        }
      },
    });
    return sessionRecord.runtime;
  }

  const ClaudeSession = await getClaudeSessionCtor();

  sessionRecord.runtime = new ClaudeSession({
    ...buildClaudeSessionConfig(sessionRecord.workspace),
    coordinatorMode: sessionRecord.isCoordinatorMode ?? false,
    onPermissionRequest,
    onAppEvent: (appEvent) => mossAppEventHandler(appEvent, sessionRecord),
  });

  // Coordinator mode: teammate windows disabled - all events flow through main coordinator's runtime.send() stream
  // All teammate events are already routed through the main coordinator session via the SDK

  return sessionRecord.runtime;
}

async function resumeSessionRecord(sessionRecord) {
  if (sessionRecord.agentMode === 'remote-direct' || sessionRecord.isSubAgent) {
    return null;
  }
  if (sessionRecord.runtime) {
    return {
      history: sessionRecord.history,
      metadata: {
        sessionId: sessionRecord.underlyingSessionId,
        sourceSessionId: sessionRecord.underlyingSessionId,
        projectDir: null,
        cwd: sessionRecord.workspace,
      },
    };
  }

  if (!sessionRecord.underlyingSessionId) {
    sessionRecord.resumeReadOnlyReason = null;
    return null;
  }

  const targetSessionId = sessionRecord.underlyingSessionId;
  const resumeClaudeSession = await getResumeClaudeSessionFn();

  try {
    const resumed = await resumeClaudeSession(targetSessionId, {
      ...buildClaudeSessionConfig(sessionRecord.workspace),
      onPermissionRequest: async (toolName, input) => {
        const toolLabel = toolName || 'Tool';
        const detailParts = [];
        if (input) detailParts.push(`输入:\n${JSON.stringify(input, null, 2)}`);

        emitToRenderer('agent:permission', {
          sessionId: sessionRecord.id,
          request: {
            tool_name: toolName,
            input,
          },
        });

        const dialogTarget = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
        const response = await dialog.showMessageBox(dialogTarget, {
          type: 'question',
          buttons: ['允许', '拒绝'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
          title: '工具权限确认',
          message: `${toolLabel} 请求执行`,
          detail: detailParts.join('\n\n') || 'Agent 请求工具执行权限。',
        });

        return response.response === 0;
      },
      onAppEvent: (appEvent) => mossAppEventHandler(appEvent, sessionRecord),
    });

    if (!resumed) {
      sessionRecord.resumeReadOnlyReason = `找不到 Claude transcript：${targetSessionId}`;
      sessionRecord.runtime = null;
      return null;
    }

    sessionRecord.runtime = resumed.session;
    sessionRecord.resumeReadOnlyReason = null;
    sessionRecord.historyLoadedFromSource = true;
    sessionRecord.underlyingSessionId = resumed.metadata.sourceSessionId || resumed.metadata.sessionId;
    sessionRecord.history = Array.isArray(resumed.messages) ? resumed.messages : [];
    sessionRecord.messageCount = sessionRecord.history.length;
    sessionRecord.pendingPlanApproval = derivePendingPlanApproval(sessionRecord.history);
    sessionRecord.updatedAt = Date.now();
    sessionRecord.preview = deriveSessionPreview(sessionRecord.history);
    if (resumed.metadata.customTitle) {
      sessionRecord.title = resumed.metadata.customTitle;
    }
    if (resumed.metadata.mode) {
      sessionRecord.isCoordinatorMode = resumed.metadata.mode === 'coordinator';
    }
    if (typeof resumed.metadata.cwd === 'string' && resumed.metadata.cwd.trim()) {
      sessionRecord.workspace = resumed.metadata.cwd;
    }
    if (sessionRecord.workspaceWatcher) {
      await syncWorkspaceWatcher(sessionRecord);
    } else {
      await startWorkspaceWatcher(sessionRecord);
    }
    schedulePersistSession(sessionRecord, true);
    emitSessionMeta(sessionRecord);
    return { history: sessionRecord.history, metadata: resumed.metadata };
  } catch (error) {
    sessionRecord.runtime = null;
    sessionRecord.resumeReadOnlyReason = error instanceof Error ? error.message : String(error);
    schedulePersistSession(sessionRecord, true);
    emitSessionMeta(sessionRecord);
    return null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1220,
    minHeight: 780,
    title: 'Moss',
    backgroundColor: '#09111c',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'darwin'
      ? false
      : {
          color: '#09111c',
          symbolColor: '#dbe4ea',
          height: 36,
        },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      webviewTag: true,
      allowRunningInsecureContent: false,
      webSecurity: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (rendererDevServerUrl) {
    void mainWindow.loadURL(rendererDevServerUrl);
    if (shouldOpenDevTools) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    if (!hasFile(rendererHtml)) {
      throw new Error(`Missing renderer build at ${rendererHtml}. Run "vite build" in ui first.`);
    }
    void mainWindow.loadFile(rendererHtml);
  }
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mossLog('info', 'app', 'Main window created');
}

// Set main window reference for update IPC after window creation
function initializeAutoUpdater() {
  setMainWindowRef(mainWindow);

  // Initialize auto-updater service
  autoUpdaterService.initialize((status) => {
    mainWindow?.webContents.send('auto-update:status', status);
  });

  // Auto-check for updates after startup (skip in dev/CI)
  const skipAutoUpdate = process.env.MOSS_DISABLE_AUTO_UPDATE === 'true' || process.env.CI === 'true';
  if (!skipAutoUpdate) {
    setTimeout(() => {
      mossLog('info', 'Update', 'Starting auto-update check...');
      autoUpdaterService.checkForUpdatesAndNotify();
    }, 3000);
  }

  // Set up application menu with "Check for Updates..."
  const isMac = process.platform === 'darwin';
  const template = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac
        ? [
            { role: 'pasteAndMatchStyle' },
            { role: 'delete' },
            { role: 'selectAll' },
          ]
        : [
            { role: 'delete' },
            { type: 'separator' },
            { role: 'selectAll' },
          ]),
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });

  template.push({
    label: 'Help',
    submenu: [
      {
        label: 'Check for Updates...',
        click: () => {
          mainWindow?.webContents.send('update:open-modal');
        },
      },
    ],
  });

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

async function listDirectoryEntries(sessionRecord, dirPath) {
  if (sessionRecord.agentMode === 'remote-direct') {
    const root = sessionRecord.remoteWorkspace || getRemoteDirectWorkspace() || '(remote workspace)';
    return {
      root,
      path: root,
      relativePath: '.',
      items: [],
      remote: true,
      message: 'Remote Direct mode does not support browsing the remote workspace from this UI yet.',
    };
  }

  const root = sessionRecord.workspace;
  const targetPath = ensureInsideRoot(root, dirPath || root);
  const dirents = await fsp.readdir(targetPath, { withFileTypes: true });

  const items = dirents
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => {
      const fullPath = path.join(targetPath, entry.name);
      return {
        name: entry.name,
        path: fullPath,
        relativePath: path.relative(root, fullPath) || entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
      };
    })
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

  return {
    root,
    path: targetPath,
    relativePath: path.relative(root, targetPath) || '.',
    items,
  };
}

function getWorkspaceFilePreviewInfo(targetPath) {
  const ext = path.extname(targetPath).toLowerCase().replace(/^\./, '');

  const imageMimeByExt = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    avif: 'image/avif',
    tif: 'image/tiff',
    tiff: 'image/tiff',
  };

  if (imageMimeByExt[ext]) {
    return {
      contentType: 'image',
      language: 'image',
      mimeType: imageMimeByExt[ext],
    };
  }

  if (ext === 'pdf') {
    return {
      contentType: 'pdf',
      language: 'pdf',
      mimeType: 'application/pdf',
    };
  }

  if (ext === 'md' || ext === 'markdown') {
    return {
      contentType: 'markdown',
      language: 'markdown',
      mimeType: 'text/markdown',
    };
  }

  if (ext === 'html' || ext === 'htm') {
    return {
      contentType: 'html',
      language: 'html',
      mimeType: 'text/html',
    };
  }

  if (ext === 'diff' || ext === 'patch') {
    return {
      contentType: 'diff',
      language: 'diff',
      mimeType: 'text/plain',
    };
  }

  if (['doc', 'docx', 'odt'].includes(ext)) {
    return {
      contentType: 'word',
      language: ext || 'word',
      mimeType: 'application/octet-stream',
    };
  }

  if (['xls', 'xlsx', 'ods', 'csv'].includes(ext)) {
    return {
      contentType: 'excel',
      language: ext || 'excel',
      mimeType: 'application/octet-stream',
    };
  }

  if (['ppt', 'pptx', 'odp'].includes(ext)) {
    return {
      contentType: 'ppt',
      language: ext || 'ppt',
      mimeType: 'application/octet-stream',
    };
  }

  if (['txt', 'log', 'text'].includes(ext)) {
    return {
      contentType: 'text',
      language: 'text',
      mimeType: 'text/plain',
    };
  }

  return {
    contentType: 'code',
    language: ext || 'text',
    mimeType: 'text/plain',
  };
}

async function readWorkspaceFile(sessionRecord, filePath) {
  if (sessionRecord.agentMode === 'remote-direct') {
    throw new Error('Remote Direct mode does not support reading remote workspace files from this UI yet.');
  }

  const targetPath = ensureInsideRoot(sessionRecord.workspace, filePath);
  const stat = await fsp.stat(targetPath);
  if (!stat.isFile()) {
    throw new Error('Target is not a file.');
  }
  const previewInfo = getWorkspaceFilePreviewInfo(targetPath);
  const baseResult = {
    path: targetPath,
    relativePath: path.relative(sessionRecord.workspace, targetPath),
    size: stat.size,
    truncated: false,
    contentType: previewInfo.contentType,
    language: previewInfo.language,
    mimeType: previewInfo.mimeType,
    metadata: {},
  };

  if (
    previewInfo.contentType === 'image' ||
    previewInfo.contentType === 'pdf' ||
    previewInfo.contentType === 'word' ||
    previewInfo.contentType === 'excel' ||
    previewInfo.contentType === 'ppt'
  ) {
    return {
      ...baseResult,
      content: '',
    };
  }

  if (stat.size > MAX_FILE_BYTES) {
    return {
      ...baseResult,
      truncated: true,
      metadata: {
        ...baseResult.metadata,
        previewEditable: false,
        previewSaveable: false,
        previewReason: 'truncated',
      },
      content: `File too large to preview (${stat.size} bytes).`,
    };
  }

  const buffer = await fsp.readFile(targetPath);
  if (buffer.includes(0)) {
    return {
      ...baseResult,
      contentType: 'unsupported',
      language: 'binary',
      metadata: {
        ...baseResult.metadata,
        previewEditable: false,
        previewSaveable: false,
        previewReason: 'binary',
      },
      content: 'Binary file preview is not supported in this app.',
    };
  }

  return {
    ...baseResult,
    content: buffer.toString('utf8'),
  };
}

app.whenReady().then(() => {
  // Initialize bundled apps from src/apps to generated-apps
  initializeBundledApps();

  // Initialize bundled skills from repo skills to ~/.moss/skills/system
  initializeBundledSkills();

  // Initialize bundled assistants from repo assistants to ~/.moss/assistants/_system
  initializeBundledAssistants();

  // Register app IPC handlers
  registerLogIpcHandlers({ getDesktopSettings: () => desktopSettings });
  registerSkillStoreIpcHandlers();
  registerAgentIpcHandlers();
  registerCronIpcHandlers();
  initUpdateIpcHandlers();
  registerDocumentIpcHandlers();
  registerLibreOfficeIpcHandlers();
  registerPreviewHistoryIpcHandlers();
  registerPreviewIpcHandlers(() => mainWindow);
  registerShellIpcHandlers();
  registerWorkspaceIpcHandlers({
    getSessionRecord,
    ensureInsideRoot,
    readWorkspaceFile,
    fsp,
  });

  mossLog('info', 'app', 'Application starting', { version: app.getVersion() });

  createWindow();
  initializeAutoUpdater();
  for (const sessionRecord of sessions.values()) {
    void startWorkspaceWatcher(sessionRecord);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      mossLog('info', 'app', 'Main window recreated on activate');
    }
  });
  mossLog('info', 'app', 'Application ready');
});

app.on('window-all-closed', () => {
  for (const sessionRecord of sessions.values()) {
    closeWorkspaceWatcher(sessionRecord);
    disposeRuntime(sessionRecord);
  }
  for (const appState of appWindowStates.values()) {
    disposeAppRuntime(appState);
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('agent:get-status', () => getBootStatus());
ipcMain.handle('agent:get-auth-debug', async () => getAuthDebugSnapshot());
ipcMain.handle('agent:get-settings', () => getDesktopSettingsPayload());
ipcMain.handle('agent:update-settings', (_event, payload = {}) => refreshDesktopSettings(payload));

ipcMain.handle('agent:getRemoteInstalledAssistants', async () => {
  try {
    const { serverUrl, authToken } = await resolveRemoteDirectConnection();
    const response = await fetch(`${serverUrl}/api/v1/agents/installed`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${authToken}`,
      },
    });
    if (!response.ok) {
      const detail = await parseRemoteDirectError('Failed to fetch remote assistants', response);
      return { success: false, error: detail };
    }
    const assistants = await response.json();
    return { success: true, data: assistants };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
});
ipcMain.handle('agent:get-adapter-config', () => {
  const adapterConfigPath = path.join(MOSS_HOME, 'adapters.json');
  try {
    if (!fs.existsSync(adapterConfigPath)) return {};
    const raw = fs.readFileSync(adapterConfigPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
});
ipcMain.handle('agent:update-adapter-config', (_event, payload = {}) => {
  const adapterConfigPath = path.join(MOSS_HOME, 'adapters.json');
  let current = {};
  try {
    if (fs.existsSync(adapterConfigPath)) {
      const raw = fs.readFileSync(adapterConfigPath, 'utf8');
      current = JSON.parse(raw);
    }
  } catch { /* ignore */ }
  const merged = { ...current, ...payload };
  if (payload.telegram) merged.telegram = { ...current.telegram, ...payload.telegram };
  if (payload.feishu) merged.feishu = { ...current.feishu, ...payload.feishu };
  if (payload.pairing !== undefined) merged.pairing = { ...current.pairing, ...payload.pairing };
  fs.mkdirSync(MOSS_HOME, { recursive: true });
  fs.writeFileSync(adapterConfigPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  // Re-read to return (masking secrets like the server does)
  try {
    const fresh = JSON.parse(fs.readFileSync(adapterConfigPath, 'utf8'));
    if (fresh.telegram?.botToken) fresh.telegram.botToken = '****' + fresh.telegram.botToken.slice(-4);
    if (fresh.feishu?.appSecret) fresh.feishu.appSecret = '****' + fresh.feishu.appSecret.slice(-4);
    if (fresh.feishu?.encryptKey) fresh.feishu.encryptKey = '****' + fresh.feishu.encryptKey.slice(-4);
    if (fresh.feishu?.verificationToken) fresh.feishu.verificationToken = '****' + fresh.feishu.verificationToken.slice(-4);
    if (fresh.pairing?.code) fresh.pairing.code = '******';
    return fresh;
  } catch {
    return merged;
  }
});

ipcMain.handle('agent:list-sessions', () => {
  const currentMode = getDesktopAgentMode();
  const localEnabled = desktopSettings.localEnabled ?? true;
  const remoteEnabled = desktopSettings.remoteEnabled ?? false;
  // 当两种模式都开启时，返回所有会话；否则只返回当前模式的会话
  const showAll = localEnabled && remoteEnabled;
  return Array.from(sessions.values())
    .filter(s => showAll || (s.agentMode === 'remote-direct' ? 'remote-direct' : 'local') === currentMode)
    .map(getSessionSummary)
    .sort((a, b) => b.updatedAt - a.updatedAt);
});

ipcMain.handle('agent:create-session', (_event, payload = {}) => {
  const sessionRecord = createSessionRecord({
    workspace: payload.workspace,
    title: payload.title,
    assistantName: payload.assistant_name,
  });
  return {
    summary: getSessionSummary(sessionRecord),
    detail: {
      ...getSessionSummary(sessionRecord),
      history: sessionRecord.history,
    },
  };
});

ipcMain.handle('agent:get-session', async (_event, { sessionId }) => {
  const sessionRecord = getSessionRecord(sessionId);
  const history = await loadSessionHistoryFromSource(sessionRecord);
  return {
    ...getSessionSummary(sessionRecord),
    history,
    workerSummariesJson: sessionRecord.workerSummariesJson || null,
  };
});

ipcMain.handle('agent:set-worker-summaries', (_event, { sessionId, workerSummariesJson }) => {
  const sessionRecord = getSessionRecord(sessionId);
  sessionRecord.workerSummariesJson = workerSummariesJson || null;
  schedulePersistSession(sessionRecord);
  return { ok: true };
});

// Read worker (sub-agent) results directly from the SDK's subagents directory.
// Each async worker has its own .jsonl file under:
//   MOSS_PROJECTS_DIR/{encoded_workspace}/{sessionId}/subagents/agent-{agentId}.jsonl
// This is the authoritative source for worker output, not the coordinator's event stream.
ipcMain.handle('agent:get-worker-results', async (_event, { sessionId }) => {
  const sessionRecord = getSessionRecord(sessionId);
  const subagentDir = await findSessionSubagentDir(sessionRecord.underlyingSessionId);
  if (!subagentDir) return { results: {} };

  const results = {};
  try {
    const files = await fsp.readdir(subagentDir);
    for (const file of files) {
      if (!file.startsWith('agent-') || !file.endsWith('.jsonl')) continue;
      const agentId = file.slice('agent-'.length, -'.jsonl'.length);
      const jsonlPath = path.join(subagentDir, file);
      try {
        const content = await fsp.readFile(jsonlPath, 'utf-8');
        const events = [];
        let resultText = null;
        let status = 'running';
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            events.push(event);
            if (event?.type === 'result') {
              resultText = typeof event.result === 'string' ? event.result.trim() : null;
              status = event.subtype === 'success' ? 'completed' : 'failed';
            }
          } catch {}
        }
        results[agentId] = { resultText, status, events };
      } catch {}
    }
  } catch {}

  return { results };
});

ipcMain.handle('agent:update-session', (_event, { sessionId, title }) => {
  const sessionRecord = getSessionRecord(sessionId);
  const normalizedTitle = typeof title === 'string' ? title.trim() : '';
  if (!normalizedTitle) {
    throw new Error('Title is required.');
  }

  sessionRecord.title = normalizedTitle;
  sessionRecord.updatedAt = Date.now();
  schedulePersistSession(sessionRecord, true);
  emitSessionMeta(sessionRecord);

  return {
    ...getSessionSummary(sessionRecord),
    history: sessionRecord.history,
  };
});

ipcMain.handle('agent:delete-session', (_event, { sessionId }) => {
  const sessionRecord = getSessionRecord(sessionId);
  mossLog('info', 'session', 'Session deleted', { sessionId, workspace: sessionRecord.workspace });
  closeWorkspaceWatcher(sessionRecord);
  disposeRuntime(sessionRecord);
  sessions.delete(sessionId);
  deletePersistedSession(sessionId);
  emitToRenderer('agent:session-removed', { sessionId });
  return { ok: true };
});

ipcMain.handle('agent:pick-directory', async () => {
  const response = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (response.canceled || response.filePaths.length === 0) {
    return null;
  }
  return response.filePaths[0];
});

ipcMain.handle('agent:pick-files', async () => {
  const response = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
  });
  if (response.canceled || response.filePaths.length === 0) {
    return [];
  }
  return response.filePaths.map((filePath) => ({
    name: path.basename(filePath),
    path: filePath,
  }));
});

ipcMain.handle('workspace:open', async (_event, { sessionId }) => {
  const sessionRecord = getSessionRecord(sessionId);
  const result = await shell.openPath(sessionRecord.workspace);
  if (result) {
    throw new Error(result);
  }
  return { ok: true };
});

ipcMain.handle('agent:set-session-workspace', async (_event, { sessionId, workspace }) => {
  const sessionRecord = getSessionRecord(sessionId);
  if (sessionRecord.messageCount > 0) {
    throw new Error('Workspace can only be changed before the first message.');
  }
  if (sessionRecord.agentMode === 'remote-direct') {
    sessionRecord.remoteWorkspace = String(workspace || '').trim() || null;
    sessionRecord.updatedAt = Date.now();
    schedulePersistSession(sessionRecord, true);
    emitSessionMeta(sessionRecord);
    return {
      ...getSessionSummary(sessionRecord),
      history: sessionRecord.history,
    };
  }
  sessionRecord.workspace = normalizeWorkspace(workspace);
  await fsp.mkdir(sessionRecord.workspace, { recursive: true });
  await startWorkspaceWatcher(sessionRecord);
  sessionRecord.updatedAt = Date.now();
  schedulePersistSession(sessionRecord, true);
  emitSessionMeta(sessionRecord);
  return {
    ...getSessionSummary(sessionRecord),
    history: sessionRecord.history,
  };
});

ipcMain.handle('agent:abort', async (_event, { sessionId }) => {
  const sessionRecord = getSessionRecord(sessionId);
  sessionRecord.runtime?.abort();
  schedulePersistSession(sessionRecord, true);
  return { ok: true };
});

ipcMain.handle('workspace:list-dir', async (_event, { sessionId, dirPath }) => {
  const sessionRecord = getSessionRecord(sessionId);
  return listDirectoryEntries(sessionRecord, dirPath);
});

ipcMain.handle('workspace:read-file', async (_event, { sessionId, filePath }) => {
  const sessionRecord = getSessionRecord(sessionId);
  return readWorkspaceFile(sessionRecord, filePath);
});

ipcMain.handle('app:list', async () => {
  return listStoredApps().map(({ filePath, ...appEntry }) => appEntry);
});

ipcMain.handle('app:list-versions', async (_event, { name }) => {
  return listAppVersionSnapshots(name);
});

ipcMain.handle('app:launch', async (_event, { name }) => {
  launchAppWindowByEntry(getStoredApp(name));
  return { ok: true };
});

ipcMain.handle('app:rollback', async (_event, { name, versionId }) => {
  const rolledBack = rollbackAppToVersion(name, versionId);
  refreshOpenAppWindow(name);
  launchAppWindowByEntry(rolledBack);
  emitAppsChanged({
    action: 'rolled-back',
    app: rolledBack,
    versionId,
  });
  return {
    ok: true,
    app: rolledBack,
  };
});

ipcMain.handle('app:delete', async (_event, { name }) => {
  const existingWindow = appWindows.get(name);
  if (existingWindow && !existingWindow.isDestroyed()) {
    existingWindow.close();
  }
  await deleteStoredApp(name);
  emitAppsChanged({ action: 'deleted', name });
  return { ok: true };
});

ipcMain.handle('app:save', async (_event, { sessionId, launch = true }) => {
  try {
    const sessionRecord = getSessionRecord(sessionId);
    const payload = readGeneratedAppPayloadFromWorkspace(sessionRecord);
    const createdApp = saveStoredApp(payload);
    if (launch) {
      launchAppWindowByEntry(createdApp);
    }
    emitAppsChanged({
      action: 'created',
      app: {
        name: createdApp.name,
        description: createdApp.description,
        width: createdApp.width,
        height: createdApp.height,
        resizable: createdApp.resizable,
        createdAt: createdApp.createdAt,
        updatedAt: createdApp.updatedAt,
      },
    });
    return { ok: true, app: createdApp };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('app:open-debug', async (event, { name }) => {
  const parentWindow = BrowserWindow.fromWebContents(event.sender);
  if (!parentWindow) return { error: 'No parent window' };

  const existingDebug = debugWindows.get(name);
  if (existingDebug && !existingDebug.isDestroyed()) {
    existingDebug.focus();
    return { ok: true };
  }

  const debugWindow = new BrowserWindow({
    title: `Moss Debug - ${name}`,
    width: 500,
    height: 600,
    minWidth: 400,
    minHeight: 400,
    resizable: true,
    backgroundColor: '#0b1120',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'debug-preload.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  debugWindows.set(name, debugWindow);
  debugWindow.setParentWindow(parentWindow);

  debugWindow.on('closed', () => {
    debugWindows.delete(name);
  });

  debugWindow.webContents.on('did-finish-load', () => {
    debugWindow.webContents.send('debug:init', { name });
  });

  const debugHtmlPath = path.join(__dirname, 'debug.html');
  void debugWindow.loadFile(debugHtmlPath);

  return { ok: true };
});

ipcMain.on('debug:close', (event) => {
  const debugWindow = BrowserWindow.fromWebContents(event.sender);
  if (debugWindow) {
    debugWindow.close();
  }
});

ipcMain.on('debug:send-to-agent', (event, { prompt, appName }) => {
  const debugWindow = BrowserWindow.fromWebContents(event.sender);
  const parentWindow = debugWindow?.getParentWindow();
  if (!parentWindow) return;

  const appState = appWindowStates.get(parentWindow.webContents.id);
  if (!appState || !appState.runtime) return;

  // Forward events to debug window
  const originalEmit = appState.runtime.emit;
  if (originalEmit) {
    appState.runtime.emit = function(...args) {
      if (debugWindow && !debugWindow.isDestroyed()) {
        debugWindow.webContents.send('debug:agent-event', args[0]);
      }
      return originalEmit.apply(this, args);
    };
  }

  appState.runtime.agent.send(prompt, (err, response) => {
    if (debugWindow && !debugWindow.isDestroyed()) {
      debugWindow.webContents.send('debug:response', response);
    }
  });
});

ipcMain.handle('app-runtime:get-info', async (event) => {
  const appState = getAppWindowStateBySender(event.sender);
  return getAppInfoPayload(appState);
});

ipcMain.handle('app-runtime:list-tools', async () => {
  return listAppToolDescriptors();
});

ipcMain.handle('app-runtime:list-resources', async (event) => {
  const appState = getAppWindowStateBySender(event.sender);
  return listAppResourceDescriptors(appState);
});

ipcMain.handle('app-runtime:read-resource', async (event, { uri }) => {
  const appState = getAppWindowStateBySender(event.sender);
  return readAppResource(appState, uri);
});

ipcMain.handle('app-runtime:call-tool', async (event, { name, args }) => {
  const appState = getAppWindowStateBySender(event.sender);
  return callAppTool(appState, name, args);
});

ipcMain.handle('app-runtime:storage:get', async (event, { key }) => {
  const appState = getAppWindowStateBySender(event.sender);
  return callAppTool(appState, 'storage.get', { key });
});

ipcMain.handle('app-runtime:storage:set', async (event, { key, value }) => {
  const appState = getAppWindowStateBySender(event.sender);
  return callAppTool(appState, 'storage.set', { key, value });
});

ipcMain.handle('app-runtime:storage:remove', async (event, { key }) => {
  const appState = getAppWindowStateBySender(event.sender);
  return callAppTool(appState, 'storage.remove', { key });
});

ipcMain.handle('app-runtime:storage:list', async (event) => {
  const appState = getAppWindowStateBySender(event.sender);
  return callAppTool(appState, 'storage.list');
});

ipcMain.handle('app-runtime:files:list', async (event, payload = {}) => {
  const appState = getAppWindowStateBySender(event.sender);
  return callAppTool(appState, 'files.list', payload);
});

ipcMain.handle('app-runtime:files:read-text', async (event, payload = {}) => {
  const appState = getAppWindowStateBySender(event.sender);
  return callAppTool(appState, 'files.read_text', payload);
});

ipcMain.handle('app-runtime:files:write-text', async (event, payload = {}) => {
  const appState = getAppWindowStateBySender(event.sender);
  return callAppTool(appState, 'files.write_text', payload);
});

ipcMain.handle('app-runtime:files:delete', async (event, payload = {}) => {
  const appState = getAppWindowStateBySender(event.sender);
  return callAppTool(appState, 'files.delete', payload);
});

ipcMain.handle('app-runtime:files:mkdir', async (event, payload = {}) => {
  const appState = getAppWindowStateBySender(event.sender);
  return callAppTool(appState, 'files.mkdir', payload);
});

ipcMain.handle('app-runtime:agent:send', async (event, payload = {}) => {
  const appState = getAppWindowStateBySender(event.sender);
  return callAppTool(appState, 'agent.send', payload);
});

ipcMain.handle('app-runtime:agent:cancel', async (event, payload = {}) => {
  const appState = getAppWindowStateBySender(event.sender);
  return callAppTool(appState, 'agent.cancel', payload);
});

ipcMain.handle('app-runtime:agent:reset', async (event) => {
  const appState = getAppWindowStateBySender(event.sender);
  return callAppTool(appState, 'agent.reset');
});

ipcMain.handle('fs:getImageBase64', async (event, { path: filePath }) => {
  try {
    const ext = path.extname(filePath || '').toLowerCase().replace(/^\./, '');
    const mimeMap = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
      svg: 'image/svg+xml', ico: 'image/x-icon',
    };
    const mime = mimeMap[ext] || 'application/octet-stream';
    const base64 = await fsp.readFile(filePath, { encoding: 'base64' });
    return `data:${mime};base64,${base64}`;
  } catch {
    return null;
  }
});

ipcMain.handle('fs:getFileMetadata', async (event, { path: filePath }) => {
  try {
    const stats = await fsp.stat(filePath);
    return { size: stats.size };
  } catch {
    return null;
  }
});

ipcMain.handle('fs:getHomeDir', async () => {
  return os.homedir();
});

ipcMain.handle('fs:getAppIcon', async () => {
  try {
    // Try production path first, then dev path
    const prodIcon = path.join(uiRoot, 'dist', 'build', 'icon.png');
    const devIcon = path.join(uiRoot, 'public', 'build', 'icon.png');
    const iconPath = fs.existsSync(prodIcon) ? prodIcon : (fs.existsSync(devIcon) ? devIcon : null);
    if (!iconPath) {
      return null;
    }
    const base64 = await fsp.readFile(iconPath, { encoding: 'base64' });
    return `data:image/png;base64,${base64}`;
  } catch {
    return null;
  }
});

ipcMain.handle('fs:readText', async (event, { path: filePath }) => {
  try {
    const content = await fsp.readFile(filePath, 'utf-8');
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:delete', async (event, { path: filePath }) => {
  try {
    await fsp.rm(filePath, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:list', async (event, { path: dirPath }) => {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    return entries.map(entry => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }));
  } catch (err) {
    return [];
  }
});

ipcMain.handle('fs:createTempFile', async (event, { fileName }) => {
  try {
    const safeFileName = String(fileName || '').replace(/[<>:"/\\|?*]/g, '_');
    const tempPath = path.join(os.tmpdir(), `moss_${Date.now()}_${safeFileName}`);
    return tempPath;
  } catch {
    return null;
  }
});

ipcMain.handle('fs:writeFile', async (event, { path: filePath, data }) => {
  try {
    await fsp.writeFile(filePath, Buffer.from(data));
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('workspace:saveImage', async (event, { sessionId, fileName, data }) => {
  try {
    const sessionRecord = getSessionRecord(sessionId);
    if (sessionRecord.agentMode === 'remote-direct') {
      throw new Error('Remote Direct mode does not support uploading local images to the remote workspace yet.');
    }
    const safeName = String(fileName || 'image').replace(/[<>:"/\\|?*]/g, '_');
    const filePath = path.join(sessionRecord.workspace, safeName);
    await fsp.writeFile(filePath, Buffer.from(data));
    return { path: filePath };
  } catch (err) {
    return { error: String(err) };
  }
});

ipcMain.handle('workspace:copyFileToWorkspace', async (event, { sessionId, sourcePath, fileName }) => {
  try {
    const sessionRecord = getSessionRecord(sessionId);
    if (sessionRecord.agentMode === 'remote-direct') {
      throw new Error('Remote Direct mode does not support uploading local files to the remote workspace yet.');
    }
    const safeName = String(fileName || path.basename(sourcePath)).replace(/[<>:"/\\|?*]/g, '_');
    const destPath = path.join(sessionRecord.workspace, safeName);
    const data = await fsp.readFile(sourcePath);
    await fsp.writeFile(destPath, data);
    return { path: destPath };
  } catch (err) {
    return { error: String(err) };
  }
});

ipcMain.handle('agent:send', async (event, { sessionId, prompt, mode, appName, files, coordinatorMode, assistantName }) => {
  const sessionRecord = getSessionRecord(sessionId);
  if (sessionRecord.busy) {
    throw new Error('This session is already processing a request.');
  }
  if (!sessionRecord.runtime && sessionRecord.underlyingSessionId) {
    await resumeSessionRecord(sessionRecord);
  }

  // Store coordinator mode flag on sessionRecord so runtime can read it
  sessionRecord.isCoordinatorMode = mode === 'coordinator' || coordinatorMode;

  const trimmedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
  const filePaths = Array.isArray(files) ? files.filter(f => typeof f === 'string' && f.trim()) : [];

  if (sessionRecord.agentMode === 'remote-direct' && filePaths.length > 0) {
    throw new Error('Remote Direct mode does not support local file attachments yet.');
  }

  if (!trimmedPrompt && filePaths.length === 0) {
    throw new Error('Prompt is required.');
  }
  const isPlanOnly = mode === 'plan';
  const isCoordinatorMode = mode === 'coordinator' || coordinatorMode;

  if (isPlanOnly && sessionRecord.pendingPlanApproval) {
    throw new Error('There is already a pending plan awaiting approval.');
  }

  // Build assistant context prefix (rules + skills list)
  let assistantContextPrefix = '';
  let assistantEnabledSkills = [];
  if (assistantName) {
    try {
      const assistantDir = await findAssistantDirByName(assistantName, [
        ASSISTANT_CUSTOM_DIR,
        ASSISTANT_HUB_DIR,
        ASSISTANT_SYSTEM_DIR,
      ]);
      const assistantContext = assistantDir
        ? await readAssistantContext(assistantDir, assistantName)
        : null;
      const assistantRules = assistantContext?.rules || '';
      assistantEnabledSkills = assistantContext?.enabledSkillIdentifiers || [];

      // Get skill info for enabled skills
      let skillsInfo = '';
      const skillDirsInfo = `\n\n## Skill Search Directories\nWhen looking for skills, search in:\n- ${SKILL_SEARCH_DIRS.join('\n- ')}`;

      if (assistantEnabledSkills && assistantEnabledSkills.length > 0) {
        const installedSkills = await getInstalledSkills();
        const skillInfos = resolveInstalledSkillInfos(assistantEnabledSkills, installedSkills);

        if (skillInfos.length > 0) {
          skillsInfo = '\n\n## Skills Available\n' +
            skillInfos.map(s => `- ${s.name}: ${s.path}`).join('\n');
        }
      }

      if (assistantRules || skillsInfo || skillDirsInfo) {
        assistantContextPrefix = `

${assistantRules}${skillsInfo}${skillDirsInfo}

---

`;
      }
    } catch (err) {
      console.error('[agent:send] Failed to load assistant context:', err);
    }
  }

  const appContextPrefix = appName && typeof appName === 'string'
    ? `Current bound app context:\n- appName: ${appName}\n- This session is attached to an existing app. If you need editable source, first use moss(action: "app_extract_to_workspace", name: appName).\n\n`
    : ''

  // For remote-direct mode, assistant rules are injected via MOSS_ASSISTANT_NAME env var
  // in CLI process, so don't concatenate them to the user prompt here
  const runtimePrompt = isPlanOnly
    ? `You are in PLAN-ONLY mode. Your ONLY task is to create a step-by-step plan. CRITICAL RULES:\n1. Do NOT use ANY tools. If you need to think, use internal reasoning only.\n2. Do NOT create, read, write, or modify any files.\n3. Do NOT execute any commands.\n4. Do NOT output any code blocks, code, or file content.\n5. ONLY output a clear, structured plan in plain text/markdown.\n\nUser request:\n${trimmedPrompt}\n\nCreate a HIGH-LEVEL plan with:\n- Goal (one sentence)\n- Main steps only - keep total steps to 10 or fewer. For simple requests, use only 2-3 steps.\n- Each step should be a meaningful milestone, not a tiny sub-step.\n- Do not break steps into sub-steps.\n\nDo not execute anything. Just plan.`
    : (sessionRecord.agentMode === 'remote-direct' ? '' : assistantContextPrefix) + appContextPrefix + trimmedPrompt;

  const visibleUserPrompt = trimmedPrompt;

  // Set coordinator mode env var before creating runtime
  const previousCoordinatorMode = process.env.CLAUDE_CODE_COORDINATOR_MODE;
  if (isCoordinatorMode) {
    process.env.CLAUDE_CODE_COORDINATOR_MODE = '1';
  } else {
    delete process.env.CLAUDE_CODE_COORDINATOR_MODE;
  }

  const {
    latestAssistantText,
    streamedAssistantText,
  } = await runSessionPrompt({
    sessionRecord,
    sender: event.sender,
    runtimePrompt,
    visibleUserPrompt,
    attachments: filePaths,
  }).finally(() => {
    // Restore previous coordinator mode setting
    if (previousCoordinatorMode !== undefined) {
      process.env.CLAUDE_CODE_COORDINATOR_MODE = previousCoordinatorMode;
    } else {
      delete process.env.CLAUDE_CODE_COORDINATOR_MODE;
    }
  });

  if (isPlanOnly) {
    // Check if agent used any tools - if so, it didn't follow the plan-only instruction
    const usedTools = sessionRecord.history.some((msg) => {
      if (msg.type === 'user') {
        const content = msg.message && msg.message.content;
        return Array.isArray(content) && content.some((block) => block && block.type === 'tool_result');
      }
      if (msg.type === 'assistant') {
        const content = msg.message && msg.message.content;
        return Array.isArray(content) && content.some((block) => block && block.type === 'tool_use');
      }
      return false;
    });
    if (usedTools) {
      sessionRecord.busy = false;
      sessionRecord.preview = '';
      pushSessionHistoryEvent(sessionRecord, {
        type: 'app_plan_state',
        kind: 'plan',
        state: 'rejected',
        originalPrompt: trimmedPrompt,
        plan: '',
        timestamp: Date.now(),
      }, event.sender);
      setPendingPlanApproval(sessionRecord, null);
      return {
        ok: false,
        error: 'Agent attempted to execute tools instead of just creating a plan. Please try again.',
        sessionId,
      };
    }

    const planText = String(latestAssistantText || streamedAssistantText || '').trim();
    if (!planText) {
      throw new Error('Planner did not return a usable plan.');
    }
    // Plan mode: store plan in history but don't show approval card - treat like normal conversation
    pushSessionHistoryEvent(sessionRecord, {
      type: 'app_plan_state',
      kind: 'plan',
      state: 'awaiting_approval',
      originalPrompt: trimmedPrompt,
      plan: planText,
      timestamp: Date.now(),
    }, event.sender);
  }

  return {
    ok: true,
    sessionId,
    summary: getSessionSummary(sessionRecord),
    pendingPlanApproval: sessionRecord.pendingPlanApproval || null,
  };
});

ipcMain.handle('agent:approve-plan', async (event, { sessionId }) => {
  const sessionRecord = getSessionRecord(sessionId);
  if (sessionRecord.busy) {
    throw new Error('This session is already processing a request.');
  }
  const pendingPlanApproval = sessionRecord.pendingPlanApproval;
  if (!pendingPlanApproval || pendingPlanApproval.kind !== 'plan') {
    throw new Error('There is no plan waiting for approval.');
  }

  pushSessionHistoryEvent(sessionRecord, {
    type: 'app_plan_state',
    kind: pendingPlanApproval.kind,
    state: 'approved',
    originalPrompt: pendingPlanApproval.originalPrompt,
    plan: pendingPlanApproval.plan,
    timestamp: Date.now(),
  }, event.sender);
  setPendingPlanApproval(sessionRecord, null);

  return {
    ok: true,
    sessionId,
    summary: getSessionSummary(sessionRecord),
  };
});

ipcMain.handle('agent:reject-plan', async (event, { sessionId }) => {
  const sessionRecord = getSessionRecord(sessionId);
  if (sessionRecord.busy) {
    throw new Error('This session is already processing a request.');
  }
  const pendingPlanApproval = sessionRecord.pendingPlanApproval;
  if (!pendingPlanApproval || pendingPlanApproval.kind !== 'plan') {
    throw new Error('There is no plan waiting for approval.');
  }

  pushSessionHistoryEvent(sessionRecord, {
    type: 'app_plan_state',
    kind: pendingPlanApproval.kind,
    state: 'rejected',
    originalPrompt: pendingPlanApproval.originalPrompt,
    plan: pendingPlanApproval.plan,
    timestamp: Date.now(),
  }, event.sender);
  setPendingPlanApproval(sessionRecord, null);

  return {
    ok: true,
    sessionId,
    summary: getSessionSummary(sessionRecord),
  };
});

ipcMain.handle('execution:abort', async (event) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow) return { error: 'No sender window' };
  const execState = [...executionWindowStates.values()].find(
    (s) => s.window === senderWindow || s.bubbleWindow === senderWindow,
  );
  if (!execState) return { error: 'Not an execution window' };
  if (execState.sessionRecord && execState.sessionRecord.runtime) {
    try {
      execState.sessionRecord.runtime.abort();
    } catch {}
  }
  execState.busy = false;
  // Notify both windows
  if (!execState.window.isDestroyed()) {
    execState.window.webContents.send('execution:state', { busy: false });
  }
  if (execState.bubbleWindow && !execState.bubbleWindow.isDestroyed()) {
    execState.bubbleWindow.webContents.send('execution:state', { busy: false });
  }
  return { ok: true };
});

ipcMain.handle('execution:get-initial-state', async (event) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow) return { error: 'No sender window' };
  const execState = [...executionWindowStates.values()].find(
    (s) => s.window === senderWindow || s.bubbleWindow === senderWindow,
  );
  if (!execState) return { error: 'Not an execution window' };
  return {
    originalPrompt: execState.originalPrompt,
    plan: execState.plan,
    busy: execState.busy,
    workspace: execState.workspace,
    steps: [],
    logLines: [],
  };
});

ipcMain.handle('execution:list', async (_event, { sessionId } = {}) => {
  // Return list of all execution windows for the given session
  const list = [];

  // Filter executionWindowStates by sessionId (both active windows and their originalSessionId)
  for (const state of executionWindowStates.values()) {
    // If no sessionId provided, show all. Otherwise only show matching ones.
    if (sessionId && state.originalSessionId !== sessionId) continue;
    list.push({
      id: state.id,
      originalPrompt: state.originalPrompt,
      busy: state.busy,
      workspace: state.workspace,
      hasBubble: Boolean(state.bubbleWindow && !state.bubbleWindow.isDestroyed()),
      createdAt: state.sessionRecord?.createdAt || Date.now(),
    });
  }

  // If sessionId provided, also include persisted sub-agent sessions from database
  if (sessionId) {
    const dbSubAgents = loadSubAgentSessionsByParentStmt.all(sessionId);
    for (const row of dbSubAgents) {
      // Skip if already in executionWindowStates (active window exists)
      // Need to check by session id, not webContents id
      let alreadyExists = false;
      for (const state of executionWindowStates.values()) {
        if (state.sessionRecord?.id === row.id) {
          alreadyExists = true;
          break;
        }
      }
      if (alreadyExists) continue;
      // Determine busy state from subAgentSessions if loaded
      const subAgentSession = subAgentSessions.get(row.id);
      list.push({
        id: row.id,
        originalPrompt: row.preview || row.title || '子 Agent',
        busy: subAgentSession?.busy || false,
        workspace: row.workspace,
        hasBubble: false,
        createdAt: row.created_at,
      });
    }
  }

  // Sort by creation time, oldest first
  list.sort((a, b) => a.createdAt - b.createdAt);
  return { executions: list };
});

ipcMain.handle('coordinator:list-tasks', async (_event, { sessionId }) => {
  // List in-process teammate tasks from the coordinator session's runtime
  const sessionRecord = sessionId ? getSessionRecord(sessionId) : null;
  if (!sessionRecord?.runtime) {
    return { tasks: [] };
  }

  try {
    // Use the public getAppState() method added to ClaudeSession
    const state = sessionRecord.runtime.getAppState?.();
    if (!state?.tasks) {
      return { tasks: [] };
    }
    const tasks = Object.values(state.tasks)
      .filter(t => t.type === 'in_process_teammate' || t.type === 'local_agent')
      .map(t => ({
        id: t.id,
        agentId: t.identity?.agentId || null,
        name: t.identity?.agentName || t.id,
        status: t.status,
        isIdle: t.isIdle || false,
        description: t.description || '',
        color: t.identity?.color || '#8b5cf6',
      }));
    return { tasks };
  } catch {
    return { tasks: [] };
  }
});

ipcMain.handle('execution:create-for-teammate', async (event, { sessionId, taskId, description, prompt }) => {
  // Check if already created for this taskId
  for (const state of executionWindowStates.values()) {
    if (state.teammateTaskId === taskId && state.originalSessionId === sessionId) {
      return { ok: true, executionSessionId: state.id, alreadyExists: true };
    }
  }

  // Create an execution window for a coordinator teammate task
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  const mainWin = senderWindow && !senderWindow.isDestroyed() ? senderWindow : mainWindow;
  if (!mainWin) {
    return { error: 'No main window' };
  }

  const sessionRecord = sessionId ? getSessionRecord(sessionId) : null;
  if (!sessionRecord) return { error: 'Session not found' };

  const execSessionId = randomUUID();
  const execWorkspace = path.join(MOSS_WORKSPACES_DIR, execSessionId);
  fs.mkdirSync(execWorkspace, { recursive: true });

  const execSessionRecord = createSessionRecord({ workspace: execWorkspace, isSubAgent: true });
  execSessionRecord.id = execSessionId;
  execSessionRecord.underlyingSessionId = sessionId;
  subAgentSessions.set(execSessionId, execSessionRecord);
  persistSessionRecord(execSessionRecord, true);

  const execWindow = new BrowserWindow({
    title: `Worker: ${description || taskId}`,
    width: 800,
    height: 700,
    resizable: true,
    backgroundColor: '#09111c',
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    show: false,  // Don't show window automatically - just show in panel
    webPreferences: {
      preload: path.join(__dirname, 'execution-preload.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const execState = {
    id: execSessionId,
    window: execWindow,
    originalPrompt: prompt || description || 'Worker task',
    plan: prompt || description || 'Worker task',
    busy: true,
    sessionRecord: execSessionRecord,
    workspace: execWorkspace,
    mainWindow: mainWin,
    originalSessionId: sessionId,
    teammateTaskId: taskId,
  };
  executionWindows.set(execSessionId, execWindow);
  executionWindowStates.set(execWindow.webContents.id, execState);

  execWindow.on('close', (event) => {
    event.preventDefault();
    execWindow.hide();
  });

  if (rendererDevServerUrl) {
    void execWindow.loadURL(executionHtmlDev);
  } else {
    if (!hasFile(executionHtmlProd)) {
      return { error: `Missing execution.html at ${executionHtmlProd}` };
    }
    void execWindow.loadFile(executionHtmlProd);
  }

  // Ensure window stays hidden
  execWindow.hide();

  execWindow.webContents.once('did-finish-load', () => {
    emitToExecutionWindow(execWindow.webContents, 'execution:init', {
      originalPrompt: prompt || description || 'Worker task',
      plan: prompt || description || 'Worker task',
      busy: false,  // Teammate runs in coordinator runtime, can't track progress here
      workspace: execWorkspace,
    });
    // Don't show window - just add to ExecutionPetPanel as a hidden/minimized icon
  });

  return { ok: true, executionSessionId: execSessionId };
});

ipcMain.handle('execution:update-teammate-state', async (event, { taskId, sessionId, completed }) => {
  // Find execution window by teammateTaskId and update its state
  for (const state of executionWindowStates.values()) {
    if (state.teammateTaskId === taskId && state.originalSessionId === sessionId) {
      if (completed) {
        state.busy = false;  // Update the busy state so execution:list returns correct value
        if (!state.window.isDestroyed()) {
          state.window.webContents.send('execution:event', { type: 'message_stop' });
          state.window.webContents.send('execution:state', { busy: false });
        }
      }
      return { ok: true };
    }
  }
  return { ok: false, error: 'Not found' };
});

ipcMain.handle('execution:focus', async (_event, { executionId }) => {
  const execState = [...executionWindowStates.values()].find((s) => s.id === executionId);
  if (!execState) return { error: 'Execution not found' };

  if (execState.window.isDestroyed()) {
    return { error: 'Execution window was closed. Please restart.' };
  }

  if (execState.bubbleWindow && !execState.bubbleWindow.isDestroyed()) {
    execState.bubbleWindow.close();
  }
  execState.window.webContents.send('execution:state', { busy: execState.busy });
  execState.window.show();
  execState.window.focus();
  return { ok: true };
});

ipcMain.handle('execution:list-files', async (event) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow) return { error: 'No sender window' };
  const execState = [...executionWindowStates.values()].find(
    (s) => s.window === senderWindow || s.bubbleWindow === senderWindow,
  );
  if (!execState) return { error: 'Not an execution window' };

  try {
    const entries = fs.readdirSync(execState.workspace, { withFileTypes: true });
    const files = entries
      .filter(e => e.isFile())
      .map(e => ({ name: e.name, path: path.join(execState.workspace, e.name) }));
    return { files, workspace: execState.workspace };
  } catch (err) {
    return { files: [], workspace: execState.workspace, error: String(err) };
  }
});

ipcMain.handle('execution:send', async (event, { message }) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow) return { error: 'No sender window' };
  // Look up by main window ID (bubble's webContents.id won't be in the map)
  const execState = [...executionWindowStates.values()].find(
    (s) => s.window === senderWindow || s.bubbleWindow === senderWindow,
  );
  if (!execState) return { error: 'Not an execution window' };

  const { sessionRecord } = execState;
  const sendEvent = (channel, data) => {
    // Send to main window
    if (!execState.window.isDestroyed()) {
      execState.window.webContents.send(channel, data);
    }
    // Send to bubble if it exists
    if (execState.bubbleWindow && !execState.bubbleWindow.isDestroyed()) {
      execState.bubbleWindow.webContents.send(channel, data);
    }
  };

  // Add user message to history
  const userEvent = {
    type: 'user',
    prompt: message,
    timestamp: Date.now(),
  };
  sessionRecord.history.push(userEvent);
  sessionRecord.messageCount += 1;
  sessionRecord.updatedAt = Date.now();
  sessionRecord.busy = true;
  sessionRecord.preview = message;

  sendEvent('execution:event', { sessionId: sessionRecord.id, payload: userEvent });
  sendEvent('execution:state', { busy: true });

  try {
    const runtime = await ensureRuntime(sessionRecord);
    for await (const msg of runtime.send(message)) {
      maybeUpdateUnderlyingSessionId(sessionRecord, msg.session_id);
      sessionRecord.history.push(msg);
      sessionRecord.updatedAt = Date.now();
      sessionRecord.preview = deriveSessionPreview(sessionRecord.history);
      sendEvent('execution:event', { sessionId: sessionRecord.id, payload: msg });
    }
    sessionRecord.busy = false;
    sendEvent('execution:event', { sessionId: sessionRecord.id, payload: { type: 'message_stop' } });
    sendEvent('execution:state', { busy: false });
    return { ok: true };
  } catch (error) {
    sessionRecord.busy = false;
    const errMsg = error instanceof Error ? error.message : String(error);
    sendEvent('execution:event', { sessionId: sessionRecord.id, payload: { type: 'error', message: errMsg } });
    sendEvent('execution:state', { busy: false });
    return { error: errMsg };
  }
});

ipcMain.handle('execution:minimize', async (event) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow) return { error: 'No sender window' };
  const execState = [...executionWindowStates.values()].find(
    (s) => s.window === senderWindow || s.bubbleWindow === senderWindow,
  );
  if (!execState) return { error: 'Not an execution window' };

  // Just hide the window - the pet panel in main window shows status
  senderWindow.hide();
  return { ok: true };
});

ipcMain.handle('execution:restore', async (event) => {
  const bubbleWindow = BrowserWindow.fromWebContents(event.sender);
  if (!bubbleWindow) return { error: 'No sender window' };

  // Find the execState that owns this bubble
  let execState = null;
  for (const [, state] of executionWindowStates) {
    if (state.bubbleWindow === bubbleWindow) {
      execState = state;
      break;
    }
  }

  // Close bubble
  if (!bubbleWindow.isDestroyed()) {
    bubbleWindow.close();
  }

  // Restore and show main window
  const mainWindow = execState?.window;
  if (mainWindow && !mainWindow.isDestroyed()) {
    // Send current state to main window before showing it, since hidden windows
    // may not process IPC events in real-time and can have stale state
    if (execState) {
      if (!mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('execution:state', { busy: execState.busy });
        if (!execState.busy) {
          mainWindow.webContents.send('execution:event', { type: 'message_stop' });
        }
      }
    }
    mainWindow.show();
    mainWindow.focus();
  }
  return { ok: true };
});
