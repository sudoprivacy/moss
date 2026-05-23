/**
 * App IPC handlers and storage utilities
 *
 * This module contains all app-related business logic:
 * - App storage (save, update, delete, list)
 * - Version management (snapshots, rollback)
 * - IPC handlers for app:*
 * - MossTool event handler for agent runtime
 */

import electron from 'electron';
const { ipcMain } = electron;
import fsp from 'node:fs/promises';
import * as path from 'node:path'
import * as fs from 'node:fs'
import os from 'node:os';
import { randomUUID } from 'node:crypto'

// ============================================================================
// Image generation by provider
// ============================================================================

async function generateImageWithProvider({
  provider,
  prompt,
  aspect_ratio,
  subject_reference,
  apiKey,
  url,
  model,
}) {
  const normalizedProvider = typeof provider === 'string' ? provider.trim().toLowerCase() : 'minimax'
  const normalizedApiKey = typeof apiKey === 'string' ? apiKey.trim() : ''
  const normalizedUrl = typeof url === 'string' ? url.trim() : ''
  const normalizedModel = typeof model === 'string' ? model.trim() : ''

  if (normalizedProvider === 'minimax') {
    return generateMinimaxImage({ prompt, aspect_ratio, subject_reference, apiKey: normalizedApiKey, url: normalizedUrl, model: normalizedModel })
  }

  throw new Error(`Unsupported image provider: ${provider}`)
}

async function generateMinimaxImage({ prompt, aspect_ratio, subject_reference, apiKey, url, model }) {
  if (!model) {
    throw new Error('Image model is not configured in desktop settings (image.model)')
  }
  if (!apiKey) {
    throw new Error('Image API key is not configured in desktop settings (image.apiKey)')
  }
  if (!url) {
    throw new Error('Image URL is not configured in desktop settings (image.url)')
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      aspect_ratio: aspect_ratio || '1:1',
      subject_reference,
      response_format: 'base64',
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Image generation failed: ${response.status} ${detail}`)
  }

  const payload = await response.json()
  const images = Array.isArray(payload?.data?.image_base64)
    ? payload.data.image_base64
    : []
  if (images.length === 0) {
    throw new Error('Image generation returned no images')
  }

  return images
}

// ============================================================================
// Generic JSON file CRUD IPC
// ============================================================================

export function registerJsonFileIpc(name, filePath, options = {}) {
  const {
    idField = 'id',
    rootKey = null,
    idPrefix = '',
  } = options;

  const resolvedPath = filePath.startsWith('~/')
    ? path.join(os.homedir(), filePath.slice(2))
    : filePath;

  async function readData() {
    try {
      const raw = await fsp.readFile(resolvedPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (rootKey) {
        return parsed[rootKey] || [];
      }
      return Array.isArray(parsed) ? parsed : (parsed.data || []);
    } catch {
      return [];
    }
  }

  async function writeData(data) {
    if (rootKey) {
      const existing = await readRawFile().catch(() => ({}));
      const obj = { ...existing, [rootKey]: data };
      await fsp.writeFile(resolvedPath, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
    } else {
      await fsp.writeFile(resolvedPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    }
  }

  async function readRawFile() {
    const raw = await fsp.readFile(resolvedPath, 'utf-8');
    return JSON.parse(raw);
  }

  ipcMain.handle(`${name}:list`, async () => {
    return await readData();
  });

  ipcMain.handle(`${name}:get`, async (_event, { id }) => {
    const data = await readData();
    return data.find(item => item[idField] === id) || null;
  });

  ipcMain.handle(`${name}:add`, async (_event, { item }) => {
    const data = await readData();
    const newItem = {
      ...item,
      [idField]: item[idField] || `${idPrefix}${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    };
    data.push(newItem);
    await writeData(data);
    return newItem;
  });

  ipcMain.handle(`${name}:update`, async (_event, { id, updates }) => {
    const data = await readData();
    const index = data.findIndex(item => item[idField] === id);
    if (index === -1) return null;
    data[index] = { ...data[index], ...updates };
    await writeData(data);
    return data[index];
  });

  ipcMain.handle(`${name}:delete`, async (_event, { id }) => {
    const data = await readData();
    const filtered = data.filter(item => item[idField] !== id);
    await writeData(filtered);
    return { ok: true };
  });
}

// ============================================================================
// Constants
// ============================================================================

const MOSS_HOME = path.join(os.homedir(), '.moss')
const MOSS_APPS_DIR = path.join(MOSS_HOME, 'generated-apps')
const MOSS_APP_DATA_DIR = path.join(MOSS_HOME, 'generated-app-data')
const APP_FILES_SUBDIR = 'files'
const APP_VERSIONS_SUBDIR = 'versions'
const APP_STORAGE_FILENAME = 'storage.json'
const APP_CURRENT_VERSION_FILENAME = 'current-version.json'
const SESSION_APP_BUILD_SUBDIR = '.moss-app-build'
const APP_METADATA_SCRIPT_TYPE = 'application/ld+json'
const APP_PRD_SCRIPT_TYPE = 'application/x-goose-prd'
const APP_SCHEMA_CONTEXT = 'urn:goose.ai:schema'
const APP_SCHEMA_TYPE = 'GooseApp'
const APP_CSP_CONTENT = "default-src 'self' 'unsafe-inline' data: blob: file: https:; img-src 'self' data: blob: file: https:; media-src 'self' data: blob: file: https:; font-src 'self' data: blob: file: https:; connect-src 'self' data: blob: file: https:; style-src 'self' 'unsafe-inline' https:; script-src 'self' 'unsafe-inline'; frame-src 'self' https:"

// ============================================================================
// Types
// ============================================================================

/**
 * @typedef {Object} StoredApp
 * @property {string} name
 * @property {string} title
 * @property {string} description
 * @property {string} icon
 * @property {number} width
 * @property {number} height
 * @property {boolean} resizable
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} [versionCount]
 * @property {string|null} [latestVersionId]
 * @property {string|null} [latestVersion]
 * @property {string|null} [currentVersionId]
 * @property {string|null} [currentVersion]
 */

/**
 * @typedef {Object} AppVersion
 * @property {string} id
 * @property {string} version
 * @property {number} createdAt
 * @property {string} reason
 * @property {string} note
 * @property {string} description
 * @property {number} width
 * @property {number} height
 * @property {boolean} resizable
 * @property {boolean} [isCurrent]
 * @property {boolean} [isLatest]
 */

// ============================================================================
// Directory Helpers
// ============================================================================

function ensureAppsDir() {
  fs.mkdirSync(MOSS_APPS_DIR, { recursive: true })
  return MOSS_APPS_DIR
}

function ensureAppDataRootDir() {
  fs.mkdirSync(MOSS_APP_DATA_DIR, { recursive: true })
  return MOSS_APP_DATA_DIR
}

function ensureAppDataDir(name) {
  const dataDir = path.join(ensureAppDataRootDir(), name)
  fs.mkdirSync(dataDir, { recursive: true })
  return dataDir
}

function ensureAppFilesDir(name) {
  const filesDir = path.join(ensureAppDataDir(name), APP_FILES_SUBDIR)
  fs.mkdirSync(filesDir, { recursive: true })
  return filesDir
}

function ensureAppVersionsDir(name) {
  const versionsDir = path.join(ensureAppDataDir(name), APP_VERSIONS_SUBDIR)
  fs.mkdirSync(versionsDir, { recursive: true })
  return versionsDir
}

function getAppStoragePath(name) {
  return path.join(ensureAppDataDir(name), APP_STORAGE_FILENAME)
}

function getAppCurrentVersionPath(name) {
  return path.join(ensureAppDataDir(name), APP_CURRENT_VERSION_FILENAME)
}

function getAppFilePath(name) {
  return path.join(ensureAppsDir(), `${name}.html`)
}

// ============================================================================
// Version Management
// ============================================================================

function parseAppVersionIndex(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : null
  }
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const semverMatch = raw.match(/^0\.0\.(\d+)$/)
  if (!semverMatch) return null
  const parsed = Number.parseInt(semverMatch[1], 10)
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : null
}

function formatAppVersionNumber(value) {
  const parsed = parseAppVersionIndex(value)
  if (!parsed) return null
  return `0.0.${parsed}`
}

function readAppCurrentVersion(name) {
  const currentVersionPath = getAppCurrentVersionPath(name)
  if (!fs.existsSync(currentVersionPath)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(currentVersionPath, 'utf8'))
    const id = String(parsed.id ?? '').trim()
    const version = formatAppVersionNumber(parsed.version)
    if (!id && !version) return null
    return { id: id || null, version: version || null }
  } catch {
    return null
  }
}

function writeAppCurrentVersion(name, versionSelection) {
  const payload = {
    id: String(versionSelection?.id ?? '').trim(),
    version: formatAppVersionNumber(versionSelection?.version),
  }
  fs.writeFileSync(getAppCurrentVersionPath(name), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

/** @type {Map<string, import('./types').AppVersionSnapshot[]>} */
const _versionSnapshotCache = new Map()

function loadAppVersionSnapshots(name) {
  if (_versionSnapshotCache.has(name)) {
    return _versionSnapshotCache.get(name)
  }
  const versionsDir = ensureAppVersionsDir(name)
  const entries = fs.readdirSync(versionsDir, { withFileTypes: true })
  const snapshots = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const filePath = path.join(versionsDir, entry.name)
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      snapshots.push({
        id: String(parsed.id || path.basename(entry.name, '.json')),
        version: formatAppVersionNumber(parsed.version),
        createdAt: Number(parsed.createdAt) || Date.now(),
        reason: String(parsed.reason || 'updated'),
        note: String(parsed.note || ''),
        description: String(parsed.description || ''),
        width: Number(parsed.width) || 900,
        height: Number(parsed.height) || 700,
        resizable: parsed.resizable !== false,
        prd: String(parsed.prd || ''),
        html: String(parsed.html || ''),
        appName: name,
      })
    } catch {
      // Skip invalid snapshots
    }
  }

  snapshots.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))

  // Assign version numbers to snapshots that don't have one
  let assignedVersion = 0
  for (const snapshot of snapshots) {
    if (snapshot.version) {
      assignedVersion = Math.max(assignedVersion, parseAppVersionIndex(snapshot.version) || 0)
      continue
    }
    assignedVersion += 1
    snapshot.version = formatAppVersionNumber(assignedVersion)
  }

  _versionSnapshotCache.set(name, snapshots)
  return snapshots
}

function clearVersionSnapshotCache(name) {
  _versionSnapshotCache.delete(name)
}

function getLatestAppVersionSnapshot(name, snapshots = loadAppVersionSnapshots(name)) {
  return snapshots[snapshots.length - 1] || null
}

function getCurrentAppVersionSnapshot(name, snapshots = loadAppVersionSnapshots(name)) {
  const currentSelection = readAppCurrentVersion(name)
  let currentSnapshot = null

  if (currentSelection?.id) {
    currentSnapshot = snapshots.find(s => s.id === currentSelection.id) || null
  }
  if (!currentSnapshot && currentSelection?.version) {
    currentSnapshot = snapshots.find(s => s.version === currentSelection.version) || null
  }
  if (!currentSnapshot) {
    currentSnapshot = getLatestAppVersionSnapshot(name, snapshots)
  }

  if (currentSnapshot && (currentSelection?.id !== currentSnapshot.id || currentSelection?.version !== currentSnapshot.version)) {
    writeAppCurrentVersion(name, currentSnapshot)
  }

  return currentSnapshot
}

// ============================================================================
// HTML Building/Parsing
// ============================================================================

function buildStoredAppHtml(appRecord) {
  const metadata = {
    '@context': APP_SCHEMA_CONTEXT,
    '@type': APP_SCHEMA_TYPE,
    name: appRecord.name,
    title: appRecord.title || appRecord.name,
    icon: appRecord.icon || '',
    description: appRecord.description,
    width: appRecord.width,
    height: appRecord.height,
    resizable: appRecord.resizable,
    mcpServers: ['apps'],
    runtime: {
      hostApi: 'window.mossApp',
      capabilities: ['storage', 'files', 'agent', 'resources'],
    },
  }
  const cspMeta = `  <meta http-equiv="Content-Security-Policy" content="${APP_CSP_CONTENT}">`
  const metadataScript = `  <script type="${APP_METADATA_SCRIPT_TYPE}">\n${JSON.stringify(metadata, null, 2)}\n  </script>`
  const prdScript = appRecord.prd
    ? `  <script type="${APP_PRD_SCRIPT_TYPE}">\n${appRecord.prd}\n  </script>`
    : ''
  const scripts = prdScript ? `${cspMeta}\n${metadataScript}\n${prdScript}\n` : `${cspMeta}\n${metadataScript}\n`
  const html = String(appRecord.html || '').trim()

  if (html.includes('</head>')) {
    return html.replace('</head>', `${scripts}</head>`)
  }

  if (html.includes('<html')) {
    const htmlTagEnd = html.indexOf('>')
    if (htmlTagEnd !== -1) {
      return `${html.slice(0, htmlTagEnd + 1)}\n<head>\n${scripts}</head>\n${html.slice(htmlTagEnd + 1)}`
    }
  }

  return `<html>\n<head>\n${scripts}</head>\n<body>\n${html}\n</body>\n</html>`
}

function parseStoredAppHtml(fileContent, filePath = '') {
  const metadataScriptType = APP_METADATA_SCRIPT_TYPE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const prdScriptType = APP_PRD_SCRIPT_TYPE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const metadataMatch = fileContent.match(
    new RegExp(`<script type="${metadataScriptType}"[^>]*>\\s*([\\s\\S]*?)\\s*<\\/script>`, 'i'),
  )
  if (!metadataMatch) {
    throw new Error(`Missing app metadata in ${filePath || 'HTML content'}`)
  }

  const metadata = JSON.parse(metadataMatch[1])

  // Extract title from metadata or HTML
  let title = metadata.title || metadata.name || ''
  const titleMatch = fileContent.match(/<title[^>]*>([^<]*)<\/title>/i)
  if (!title && titleMatch) {
    title = titleMatch[1].trim()
  }

  const prdMatch = fileContent.match(
    new RegExp(`<script type="${prdScriptType}"[^>]*>\\s*([\\s\\S]*?)\\s*<\\/script>`, 'i'),
  )
  const prd = prdMatch?.[1]?.trim() || ''

  // Clean HTML: remove metadata scripts and CSP
  const cleanHtml = fileContent
    .replace(new RegExp(`<script type="${metadataScriptType}"[^>]*>[\\s\\S]*?<\\/script>`, 'gi'), '')
    .replace(new RegExp(`<script type="${prdScriptType}"[^>]*>[\\s\\S]*?<\\/script>`, 'gi'), '')
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/gi, '')
    .trim()

  return {
    name: String(metadata.name || ''),
    title: String(title),
    description: String(metadata.description || ''),
    icon: String(metadata.icon || ''),
    width: Number(metadata.width) || 900,
    height: Number(metadata.height) || 700,
    resizable: metadata.resizable !== false,
    html: cleanHtml,
    prd,
    filePath,
  }
}

// ============================================================================
// App Storage Operations
// ============================================================================

function slugifyAppName(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function toAppVersionSnapshotRecord(appRecord, extra = {}) {
  const existingSnapshots = Array.isArray(extra.existingSnapshots) ? extra.existingSnapshots : []
  const nextVersionNumber = existingSnapshots.reduce((max, snapshot) => {
    const versionNumber = parseAppVersionIndex(snapshot.version)
    return versionNumber ? Math.max(max, versionNumber) : max
  }, 0) + 1

  return {
    id: String(extra.id || `${Date.now()}-${randomUUID().slice(0, 8)}`),
    version: formatAppVersionNumber(extra.version) || formatAppVersionNumber(nextVersionNumber),
    appName: appRecord.name,
    createdAt: Number(extra.createdAt) || Date.now(),
    reason: String(extra.reason || 'updated'),
    note: String(extra.note || ''),
    description: appRecord.description || '',
    width: appRecord.width || 900,
    height: appRecord.height || 700,
    resizable: appRecord.resizable !== false,
    prd: appRecord.prd || '',
    html: appRecord.html || '',
  }
}

function saveAppVersionSnapshot(appRecord, extra = {}) {
  clearVersionSnapshotCache(appRecord.name)
  const existingSnapshots = loadAppVersionSnapshots(appRecord.name)
  const snapshot = toAppVersionSnapshotRecord(appRecord, { ...extra, existingSnapshots })
  const filePath = path.join(ensureAppVersionsDir(appRecord.name), `${snapshot.id}.json`)
  fs.writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  // Invalidate again so the next read includes the snapshot we just wrote.
  clearVersionSnapshotCache(appRecord.name)
  writeAppCurrentVersion(appRecord.name, snapshot)
  return snapshot
}

export function listAppVersionSnapshots(name) {
  const snapshots = loadAppVersionSnapshots(name)
  const currentSnapshot = getCurrentAppVersionSnapshot(name, snapshots)
  const latestSnapshot = getLatestAppVersionSnapshot(name, snapshots)
  return [...snapshots]
    .sort((a, b) => {
      const versionDiff = (parseAppVersionIndex(b.version) || 0) - (parseAppVersionIndex(a.version) || 0)
      return versionDiff || b.createdAt - a.createdAt
    })
    .map(({ id, version, createdAt, reason, note, description, width, height, resizable }) => ({
      id,
      version,
      createdAt,
      reason,
      note,
      description,
      width,
      height,
      resizable,
      isCurrent: id === currentSnapshot?.id,
      isLatest: id === latestSnapshot?.id,
    }))
}

export function rollbackAppToVersion(name, versionId) {
  const normalizedVersion = formatAppVersionNumber(versionId)
  const snapshots = loadAppVersionSnapshots(name)
  const snapshot = snapshots.find(
    entry => entry.id === versionId || (normalizedVersion && entry.version === normalizedVersion),
  )
  if (!snapshot) {
    throw new Error(`Unknown app version: ${versionId}`)
  }

  const rolledBackApp = updateStoredApp(name, {
    description: snapshot.description,
    width: snapshot.width,
    height: snapshot.height,
    resizable: snapshot.resizable,
    prd: snapshot.prd,
    html: snapshot.html,
  }, {
    saveVersion: false,
    currentVersionId: snapshot.id,
    currentVersion: snapshot.version,
  })

  return rolledBackApp
}

export function listStoredApps() {
  const entries = fs.readdirSync(ensureAppsDir(), { withFileTypes: true })
  const apps = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.html')) continue
    const filePath = path.join(ensureAppsDir(), entry.name)
    try {
      const fileContent = fs.readFileSync(filePath, 'utf8')
      const parsed = parseStoredAppHtml(fileContent, filePath)
      const stat = fs.statSync(filePath)
      const versions = loadAppVersionSnapshots(parsed.name)
      const latestVersion = getLatestAppVersionSnapshot(parsed.name, versions)
      const currentVersion = getCurrentAppVersionSnapshot(parsed.name, versions)
      apps.push({
        name: parsed.name,
        title: parsed.title,
        description: parsed.description,
        icon: parsed.icon,
        width: parsed.width,
        height: parsed.height,
        resizable: parsed.resizable,
        filePath,
        createdAt: stat.birthtimeMs || stat.ctimeMs || Date.now(),
        updatedAt: stat.mtimeMs || Date.now(),
        versionCount: versions.length,
        latestVersionId: latestVersion?.id || null,
        latestVersion: latestVersion?.version || null,
        currentVersionId: currentVersion?.id || latestVersion?.id || null,
        currentVersion: currentVersion?.version || latestVersion?.version || null,
      })
    } catch {
      // Skip invalid apps
    }
  }

  return apps.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function saveStoredApp(appRecord) {
  ensureAppsDir()
  const existingNames = new Set(listStoredApps().map(entry => entry.name))
  const baseName = slugifyAppName(appRecord.name) || `generated-app-${Date.now()}`
  let name = baseName
  let counter = 1

  while (existingNames.has(name)) {
    name = `${baseName}-${counter}`
    counter++
  }

  const nextRecord = { ...appRecord, name }
  const filePath = getAppFilePath(name)
  fs.writeFileSync(filePath, buildStoredAppHtml(nextRecord), 'utf8')
  const snapshot = saveAppVersionSnapshot(nextRecord, { reason: 'created' })
  const stat = fs.statSync(filePath)

  return {
    name,
    description: nextRecord.description,
    width: nextRecord.width,
    height: nextRecord.height,
    resizable: nextRecord.resizable,
    filePath,
    createdAt: stat.birthtimeMs || stat.ctimeMs || Date.now(),
    updatedAt: stat.mtimeMs || Date.now(),
    versionCount: 1,
    latestVersionId: snapshot.id,
    latestVersion: snapshot.version,
    currentVersionId: snapshot.id,
    currentVersion: snapshot.version,
  }
}

export function updateStoredApp(name, appRecord, options = {}) {
  const existing = getStoredApp(name)
  const nextRecord = {
    ...existing,
    ...appRecord,
    name,
  }
  fs.writeFileSync(existing.filePath, buildStoredAppHtml(nextRecord), 'utf8')
  const snapshot = options.saveVersion === false
    ? null
    : saveAppVersionSnapshot(nextRecord, { reason: options.reason || 'updated' })
  if (options.saveVersion === false && (options.currentVersionId || options.currentVersion)) {
    writeAppCurrentVersion(name, {
      id: options.currentVersionId,
      version: options.currentVersion,
    })
  }
  const stat = fs.statSync(existing.filePath)
  const versions = loadAppVersionSnapshots(name)
  const latestVersion = getLatestAppVersionSnapshot(name, versions)
  const currentVersion = getCurrentAppVersionSnapshot(name, versions)

  return {
    name,
    description: nextRecord.description,
    width: nextRecord.width,
    height: nextRecord.height,
    resizable: nextRecord.resizable,
    filePath: existing.filePath,
    createdAt: stat.birthtimeMs || stat.ctimeMs || Date.now(),
    updatedAt: stat.mtimeMs || Date.now(),
    versionCount: versions.length,
    latestVersionId: latestVersion?.id || snapshot?.id || null,
    latestVersion: latestVersion?.version || snapshot?.version || null,
    currentVersionId: currentVersion?.id || snapshot?.id || null,
    currentVersion: currentVersion?.version || snapshot?.version || null,
    publishedVersion: snapshot?.version || null,
  }
}

export function getStoredApp(name) {
  const appEntry = listStoredApps().find(entry => entry.name === name)
  if (!appEntry) {
    throw new Error(`Unknown app: ${name}`)
  }
  return appEntry
}

export async function deleteStoredApp(name) {
  const appEntry = listStoredApps().find(entry => entry.name === name)
  if (!appEntry) {
    throw new Error(`Unknown app: ${name}`)
  }
  await Promise.all([
    fsp.rm(appEntry.filePath, { force: true }),
    fsp.rm(path.join(ensureAppDataRootDir(), name), { recursive: true, force: true }),
  ])
  clearVersionSnapshotCache(name)
}

export function loadStoredAppContent(name) {
  const appEntry = getStoredApp(name)
  const fileContent = fs.readFileSync(appEntry.filePath, 'utf8')
  return {
    ...appEntry,
    ...parseStoredAppHtml(fileContent, appEntry.filePath),
  }
}

export function getSessionAppBuildPaths(sessionRecord) {
  const buildDir = path.join(sessionRecord.workspace, SESSION_APP_BUILD_SUBDIR)
  return {
    buildDir,
    metadataPath: path.join(buildDir, 'app-meta.json'),
    htmlPath: path.join(buildDir, 'index.html'),
  }
}

export function readGeneratedAppPayloadFromWorkspace(sessionRecord) {
  const { metadataPath, htmlPath } = getSessionAppBuildPaths(sessionRecord)

  if (!fs.existsSync(metadataPath)) {
    throw new Error(`App metadata file was not created: ${metadataPath}`)
  }
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`App html file was not created: ${htmlPath}`)
  }

  let metadata
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `Failed to parse generated app metadata JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const html = fs.readFileSync(htmlPath, 'utf8').trim()
  if (!html.toLowerCase().includes('<html')) {
    throw new Error(`Generated HTML file did not contain a full HTML document: ${htmlPath}`)
  }

  return {
    name: slugifyAppName(metadata?.name) || `generated-app-${Date.now()}`,
    title: String(metadata?.title || metadata?.name || '').trim(),
    description: String(metadata?.description || '').trim(),
    icon: String(metadata?.icon || '').trim(),
    width: Number(metadata.width) || 900,
    height: Number(metadata.height) || 700,
    resizable: metadata?.resizable !== false,
    html,
  }
}

export function extractAppToWorkspace(name, sessionRecord, versionId) {
  if (!sessionRecord?.workspace) {
    throw new Error('Session workspace is required for app extraction')
  }

  const baseApp = loadStoredAppContent(name)
  const source = versionId
    ? {
        ...baseApp,
        ...getAppVersionSnapshot(name, versionId),
      }
    : baseApp
  const buildPaths = getSessionAppBuildPaths(sessionRecord)

  fs.mkdirSync(buildPaths.buildDir, { recursive: true })

  const metadata = {
    name,
    title: String(source.title || name || ''),
    icon: String(source.icon || ''),
    description: String(source.description || ''),
    width: Number(source.width) || 900,
    height: Number(source.height) || 700,
    resizable: source.resizable !== false,
  }

  fs.writeFileSync(buildPaths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
  fs.writeFileSync(buildPaths.htmlPath, String(source.html || ''), 'utf8')

  const appEntry = getStoredApp(name)
  const extractedVersion = versionId
    ? getAppVersionSnapshot(name, versionId).version || null
    : appEntry.currentVersion || null

  return {
    app: {
      name,
      title: metadata.title,
      icon: metadata.icon,
      description: metadata.description,
      width: metadata.width,
      height: metadata.height,
      resizable: metadata.resizable,
      currentVersionId: appEntry.currentVersionId || null,
      currentVersion: appEntry.currentVersion || null,
      latestVersionId: appEntry.latestVersionId || null,
      latestVersion: appEntry.latestVersion || null,
      extractedVersionId: versionId || appEntry.currentVersionId || null,
      extractedVersion,
    },
    metadataPath: buildPaths.metadataPath,
    htmlPath: buildPaths.htmlPath,
  }
}

/**
 * Build app metadata and HTML into a merged file.
 * Returns the path to the built file for later publishing.
 */
export function buildAppFile(appRecord) {
  const buildDir = path.join(MOSS_HOME, 'app-build')
  fs.mkdirSync(buildDir, { recursive: true })
  const filePath = path.join(buildDir, `${slugifyAppName(appRecord.name) || 'app'}.html`)
  fs.writeFileSync(filePath, buildStoredAppHtml(appRecord), 'utf8')
  return filePath
}

/**
 * Publish a built app file to the app store with version.
 */
export function publishAppFromFile(filePath, options = {}) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`App file not found: ${filePath}`)
  }
  const fileContent = fs.readFileSync(filePath, 'utf8')
  const parsed = parseStoredAppHtml(fileContent, filePath)

  ensureAppsDir()
  const existingNames = new Set(listStoredApps().map(entry => entry.name))
  const requestedName = slugifyAppName(options.name)
  const parsedName = slugifyAppName(parsed.name)
  const baseName = requestedName || parsedName || `generated-app-${Date.now()}`
  let name = baseName
  let counter = 1

  while (existingNames.has(name)) {
    name = `${baseName}-${counter}`
    counter++
  }

  const nextRecord = {
    ...parsed,
    name,
    description: String(options.description || parsed.description || ''),
  }
  const destPath = getAppFilePath(name)
  fs.writeFileSync(destPath, buildStoredAppHtml(nextRecord), 'utf8')

  const snapshot = saveAppVersionSnapshot(nextRecord, {
    reason: options.reason || 'published',
    version: options.version,
  })
  const stat = fs.statSync(destPath)

  return {
    name,
    description: nextRecord.description,
    width: nextRecord.width,
    height: nextRecord.height,
    resizable: nextRecord.resizable,
    filePath: destPath,
    createdAt: stat.birthtimeMs || stat.ctimeMs || Date.now(),
    updatedAt: stat.mtimeMs || Date.now(),
    versionCount: 1,
    latestVersionId: snapshot.id,
    latestVersion: snapshot.version,
    currentVersionId: snapshot.id,
    currentVersion: snapshot.version,
    publishedVersion: snapshot.version,
  }
}

// ============================================================================
// Window Operations (callbacks from main process)
// ============================================================================

/**
 * @typedef {Object} AppWindowCallbacks
 * @property {(appEntry: StoredApp) => void} launchAppWindow
 * @property {(filePath: string) => void} previewAppFile
 * @property {(name: string) => void} refreshOpenAppWindow
 * @property {(name: string) => BrowserWindow|undefined} getOpenAppWindow
 * @property {(name: string) => void} closeAppWindow
 */

/**
 * @typedef {Object} AppEventCallbacks
 * @property {(payload: Object) => void} emitAppsChanged
 */

// ============================================================================
// IPC Handlers
// ============================================================================

export function registerAppIpcHandlers(ipcMain, windows, events) {
  ipcMain.handle('app:list', async () => {
    return listStoredApps().map(({ filePath, ...app }) => app)
  })

  ipcMain.handle('app:list-versions', async (_event, { name }) => {
    return listAppVersionSnapshots(name)
  })

  ipcMain.handle('app:launch', async (_event, { name }) => {
    const app = getStoredApp(name)
    windows.launchAppWindow(app)
    return { ok: true }
  })

  ipcMain.handle('app:rollback', async (_event, { name, versionId }) => {
    const rolledBack = rollbackAppToVersion(name, versionId)
    windows.refreshOpenAppWindow(name)
    windows.launchAppWindow(rolledBack)
    events.emitAppsChanged({ action: 'rolled-back', app: rolledBack, versionId })
    return { ok: true, app: rolledBack }
  })

  ipcMain.handle('app:delete', async (_event, { name }) => {
    const existingWindow = windows.getOpenAppWindow(name)
    if (existingWindow && !existingWindow.isDestroyed()) {
      existingWindow.close()
    }
    windows.closeAppWindow(name)
    await deleteStoredApp(name)
    events.emitAppsChanged({ action: 'deleted', name })
    return { ok: true }
  })

  ipcMain.handle('app:save', async (_event, { sessionId, launch = true }, getSessionRecord) => {
    try {
      const sessionRecord = getSessionRecord()
      if (!sessionRecord) {
        return { ok: false, error: 'Session not found' }
      }
      const payload = readGeneratedAppPayloadFromWorkspace(sessionRecord)
      const createdApp = saveStoredApp(payload)
      if (launch) {
        windows.launchAppWindow(createdApp)
      }
      events.emitAppsChanged({
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
      })
      return { ok: true, app: createdApp }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle('app:open-debug', async (_event, { name }) => {
    // Debug handler - main process will handle this separately
    return { ok: false, error: 'Debug must be handled by main process' }
  })
}

// ============================================================================
// MossTool Event Handler (for agent runtime)
// ============================================================================

/**
 * @typedef {Object} MossAppEvent
 * @property {'app_build'} type
 * @property {Object} input
 */
/** @type {MossAppEvent[]} */
const MossAppEventTypes = [
  'app_build',
  'app_preview',
  'app_publish',
  'app_launch',
  'app_update',
  'app_extract_to_workspace',
  'app_get_versions',
  'image_generate',
]

/**
 * @typedef {Object} MossAppEventResult
 * @property {boolean} ok
 * @property {StoredApp} [app]
 * @property {string} [filePath]
 * @property {string[]} [filePaths]
 * @property {AppVersion[]} [versions]
 * @property {string} [error]
 */

export function createMossAppEventHandler(windows, events, options = {}) {
  const getSettings = typeof options.getSettings === 'function'
    ? options.getSettings
    : () => ({})

  return async (event, sessionRecord = null) => {
    try {
      switch (event.type) {
        case 'app_build': {
          // Build app metadata and HTML into a merged file in workspace
          // Returns the file path for later publishing
          const filePath = buildAppFile(event.input)
          return { ok: true, filePath }
        }

        case 'app_preview': {
          // Preview an HTML file at the given path
          windows.previewAppFile(event.input.filePath)
          return { ok: true }
        }

        case 'app_publish': {
          // Publish a built app file to the app store with version
          const publishedApp = publishAppFromFile(event.input.filePath, {
            name: event.input.name,
            description: event.input.description,
            version: event.input.version,
            reason: event.input.reason,
          })
          const app = {
            ...publishedApp,
            publishedVersion: publishedApp.publishedVersion || null,
          }
          events.emitAppsChanged({ action: 'created', app })
          return { ok: true, app }
        }

        case 'app_launch': {
          const app = getStoredApp(event.input.name)
          windows.launchAppWindow(app)
          return { ok: true, app }
        }

        case 'app_update': {
          const { name, filePath, reason, ...updates } = event.input
          const definedUpdates = Object.fromEntries(
            Object.entries(updates).filter(([, value]) => value !== undefined),
          )
          let normalizedUpdates = definedUpdates

          if (filePath) {
            if (!fs.existsSync(filePath)) {
              throw new Error(`App file not found: ${filePath}`)
            }
            const fileContent = fs.readFileSync(filePath, 'utf8')
            normalizedUpdates = {
              ...parseStoredAppHtml(fileContent, filePath),
              ...definedUpdates,
            }
          }

          const updatedApp = updateStoredApp(name, normalizedUpdates, {
            reason: reason || 'updated',
          })
          const app = {
            ...updatedApp,
            publishedVersion: updatedApp.publishedVersion || null,
          }
          events.emitAppsChanged({ action: 'updated', app })
          return { ok: true, app }
        }

        case 'app_extract_to_workspace': {
          if (!sessionRecord) {
            throw new Error('Session context is required for app_extract_to_workspace')
          }
          const extracted = extractAppToWorkspace(event.input.name, sessionRecord, event.input.versionId)
          return {
            ok: true,
            app: extracted.app,
            metadataPath: extracted.metadataPath,
            htmlPath: extracted.htmlPath,
          }
        }

        case 'app_get_versions': {
          const versions = listAppVersionSnapshots(event.input.name)
          return { ok: true, versions }
        }

        case 'image_generate': {
          const { prompt, aspect_ratio, subject_reference, out_path } =
            event.input || {}

          if (!prompt || typeof prompt !== 'string') {
            throw new Error('image_generate requires a prompt string')
          }
          if (!sessionRecord?.workspace) {
            throw new Error('Session context is required for image_generate')
          }
          if (sessionRecord.agentMode === 'remote-direct') {
            throw new Error('Remote Direct mode does not support writing generated images to the remote workspace yet.')
          }
          if (!out_path || typeof out_path !== 'string') {
            throw new Error('image_generate requires out_path')
          }

          const resolvedOutputPath = path.resolve(sessionRecord.workspace, out_path)
          const relativeOutputPath = path.relative(
            sessionRecord.workspace,
            resolvedOutputPath,
          )
          if (
            relativeOutputPath.startsWith('..') ||
            path.isAbsolute(relativeOutputPath)
          ) {
            throw new Error(
              'image_generate out_path must stay inside the current session workspace',
            )
          }

          const settings = getSettings() || {}
          const imageSettings =
            settings.image && typeof settings.image === 'object'
              ? settings.image
              : {}

          const imageProvider =
            typeof imageSettings.provider === 'string'
              ? imageSettings.provider.trim()
              : 'minimax'

          const images = await generateImageWithProvider({
            provider: imageProvider,
            prompt,
            aspect_ratio,
            subject_reference,
            apiKey: imageSettings.apiKey,
            url: imageSettings.url,
            model: imageSettings.model,
          })

          await fsp.mkdir(path.dirname(resolvedOutputPath), { recursive: true })

          const parsedPath = path.parse(resolvedOutputPath)
          const ext = parsedPath.ext || '.jpeg'
          const basePath = path.join(parsedPath.dir, parsedPath.name)
          const filePaths = []

          const mimeMap = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.bmp': 'image/bmp',
            '.svg': 'image/svg+xml',
            '.avif': 'image/avif',
            '.tif': 'image/tiff',
            '.tiff': 'image/tiff',
          }

          for (let i = 0; i < images.length; i += 1) {
            const filePath =
              images.length === 1
                ? resolvedOutputPath
                : `${basePath}-${i}${ext}`
            await fsp.writeFile(filePath, Buffer.from(images[i], 'base64'))
            filePaths.push(filePath)
          }

          const firstPath = filePaths[0]
          const previewUrl = `moss-image://${encodeURI(firstPath)}`
          const previewMarkdown = `![generated image](${previewUrl})`
          const mediaType =
            mimeMap[path.extname(firstPath).toLowerCase()] || 'image/jpeg'

          return {
            ok: true,
            fileKind: 'image',
            filePath: firstPath,
            filePaths,
            previewUrl,
            previewMarkdown,
            mediaType,
          }
        }

        default:
          return { ok: false, error: `Unknown event type: ${event.type}` }
      }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  }
}

// Export for type checking
export const emitAppsChanged = () => {}

// Placeholder for backward compatibility - actual emitAppsChanged is in main.mjs
export function noop() {}
