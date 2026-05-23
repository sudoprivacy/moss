/**
 * Update IPC handlers for Moss
 * Handles manual update flow via GitHub Releases
 */

import electron from 'electron';
const { ipcMain, app } = electron;
import * as fs from 'node:fs';
import * as path from 'node:path';
import semver from 'semver';
import { autoUpdaterService } from './auto-updater-service.mjs';
import { MAX_DOWNLOAD_REDIRECTS } from './download-utils.mjs';
import { mossLog } from './log-ipc.mjs';

const DEFAULT_REPO = 'moss-ai/moss';
const DEFAULT_USER_AGENT = 'Moss';
const ALLOWED_ASSET_EXTS = ['.exe', '.msi', '.dmg', '.zip', '.AppImage', '.deb', '.rpm'];
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
const MAX_REDIRECTS = MAX_DOWNLOAD_REDIRECTS;

const isAllowedAssetName = (name) => {
  const ext = path.extname(name);
  return ALLOWED_ASSET_EXTS.includes(ext);
};

const normalizeTagToSemver = (tag) => {
  const trimmed = tag.trim();
  const withoutV = trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
  if (!/^\d+\.\d+\.\d+/.test(withoutV)) return null;
  return semver.valid(withoutV);
};

const assertAllowedUrl = (rawUrl) => {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid download URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Only https download URLs are allowed');
  }
  if (!ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname)) {
    throw new Error(`Download host not allowed: ${parsed.hostname}`);
  }
};

const fetchGitHubReleases = async (repo) => {
  const url = `https://api.github.com/repos/${repo}/releases`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': DEFAULT_USER_AGENT,
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub releases request failed (${res.status}): ${body || res.statusText}`);
    }

    const json = await res.json();
    if (!Array.isArray(json)) {
      throw new Error('GitHub releases response is not an array');
    }
    return json;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('GitHub API request timed out (30s)');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
};

const scoreAsset = (asset) => {
  const { platform, arch } = process;
  const nameLower = asset.name.toLowerCase();
  const ext = path.extname(asset.name);

  let score = 0;

  const platformHints = platform === 'win32' ? ['win', 'win32', 'windows'] : platform === 'darwin' ? ['mac', 'darwin', 'osx'] : ['linux'];
  const archHints = arch === 'arm64' ? ['arm64', 'aarch64'] : ['x64', 'x86_64', 'amd64'];

  if (platformHints.some((hint) => nameLower.includes(hint))) score += 20;
  if (archHints.some((hint) => nameLower.includes(hint))) score += 10;

  if (platform === 'win32') {
    if (ext === '.exe') score += 100;
    if (ext === '.msi') score += 90;
    if (ext === '.zip') score += 50;
  } else if (platform === 'darwin') {
    if (ext === '.dmg') score += 100;
    if (ext === '.zip') score += 70;
  } else {
    if (ext === '.AppImage') score += 100;
    if (ext === '.deb') score += 90;
    if (ext === '.rpm') score += 80;
    if (ext === '.zip') score += 40;
  }

  return score;
};

const pickRecommendedAsset = (assets) => {
  if (!assets.length) return undefined;
  const scored = assets
    .map((asset) => ({ asset, score: scoreAsset(asset) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.asset;
};

const mapRelease = (rel) => {
  const version = normalizeTagToSemver(rel.tag_name);
  if (!version) return null;

  const assets = (rel.assets || [])
    .filter((asset) => asset && asset.name && asset.browser_download_url)
    .filter((asset) => isAllowedAssetName(asset.name))
    .map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
      contentType: asset.content_type,
    }));

  return {
    tagName: rel.tag_name,
    version,
    name: rel.name,
    body: rel.body,
    htmlUrl: rel.html_url,
    publishedAt: rel.published_at,
    prerelease: Boolean(rel.prerelease),
    draft: Boolean(rel.draft),
    assets,
    recommendedAsset: pickRecommendedAsset(assets),
  };
};

const sanitizeFileName = (name) => {
  const base = path.basename(name).trim();
  return base || `Moss-update-${Date.now()}`;
};

const ensureUniquePath = (target) => {
  if (!fs.existsSync(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let i = 1; i < 1000; i++) {
    const next = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(next)) return next;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
};

// Download state
const downloads = new Map();

const emitProgress = (evt) => {
  mainWindow?.webContents.send('update:download-progress', evt);
};

const startDownloadInBackground = async (downloadId, url, filePath, abortController) => {
  let receivedBytes = 0;
  let totalBytes;

  const startedAt = Date.now();
  let lastEmitAt = 0;

  const emitThrottled = (status) => {
    const now = Date.now();
    const shouldEmit = now - lastEmitAt >= 250 || status !== 'downloading';
    if (!shouldEmit) return;

    const elapsedSec = Math.max(0.001, (now - startedAt) / 1000);
    const bytesPerSecond = receivedBytes / elapsedSec;
    const percent = totalBytes ? Math.min(100, (receivedBytes / totalBytes) * 100) : undefined;

    lastEmitAt = now;
    emitProgress({
      downloadId,
      status,
      receivedBytes,
      totalBytes,
      percent,
      bytesPerSecond,
      filePath: status === 'completed' ? filePath : undefined,
    });
  };

  emitThrottled('starting');

  let stream = null;
  try {
    let current = url;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      assertAllowedUrl(current);

      const res = await fetch(current, {
        signal: abortController.signal,
        redirect: 'manual',
        headers: { 'User-Agent': DEFAULT_USER_AGENT },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new Error(`Redirect (${res.status}) missing location header`);
        current = new URL(location, current).toString();
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Download failed (${res.status}): ${body || res.statusText}`);
      }

      const contentLengthHeader = res.headers.get('content-length');
      if (contentLengthHeader) {
        const parsed = parseInt(contentLengthHeader, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          totalBytes = parsed;
        }
      }

      if (!res.body) throw new Error('Download response has no body');

      stream = fs.createWriteStream(filePath);
      const reader = res.body.getReader();

      let doneReading = false;
      while (!doneReading) {
        const { done, value } = await reader.read();
        doneReading = done;
        if (doneReading) break;
        if (!value) continue;

        receivedBytes += value.byteLength;

        const buf = Buffer.from(value);
        if (!stream.write(buf)) {
          await new Promise((resolve) => stream?.once('drain', () => resolve()));
        }

        emitThrottled('downloading');
      }

      await new Promise((resolve, reject) => {
        if (!stream) { resolve(); return; }
        stream.end(() => resolve());
        stream.on('error', reject);
      });

      emitThrottled('completed');
      return;
    }

    throw new Error('Too many redirects while downloading');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isAbort = abortController.signal.aborted || message.toLowerCase().includes('aborted');

    try { stream?.close(); } catch { /* ignore */ }
    try { if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true }); } catch { /* ignore */ }

    emitProgress({
      downloadId,
      status: isAbort ? 'cancelled' : 'error',
      receivedBytes,
      totalBytes,
      error: message,
    });
  } finally {
    downloads.delete(downloadId);
  }
};

// Track mainWindow reference for emitting events
let mainWindow = null;
export function setMainWindowRef(win) {
  mainWindow = win;
}

export function initUpdateIpcHandlers() {
  // Auto-update status broadcast via webContents
  autoUpdaterService.setStatusBroadcastCallback((status) => {
    mainWindow?.webContents.send('auto-update:status', status);
  });

  // update.check - check for updates via GitHub Releases (stable only)
  ipcMain.handle('update:check', async (_event, params) => {
    try {
      const currentVersion = app.getVersion();
      const currentSemver = semver.valid(currentVersion) || semver.coerce(currentVersion)?.version;

      if (!currentSemver) {
        return { success: true, data: { currentVersion, updateAvailable: false } };
      }

      const releases = await fetchGitHubReleases(DEFAULT_REPO);

      // Only stable releases (no prerelease)
      const candidates = releases
        .filter((r) => !r.draft && !r.prerelease)
        .map(mapRelease)
        .filter((r) => r !== null)
        .sort((a, b) => (semver.gt(b.version, a.version) ? 1 : -1));

      if (candidates.length === 0) {
        return { success: true, data: { currentVersion, updateAvailable: false } };
      }

      const latest = candidates[0];
      const updateAvailable = semver.gt(latest.version, currentSemver);
      mossLog('Update', `GitHub latest: ${latest.version}, current: ${currentSemver}, update available: ${updateAvailable}`);

      return {
        success: true,
        data: {
          currentVersion,
          updateAvailable,
          latest,
        },
      };
    } catch (err) {
      return { success: false, msg: err instanceof Error ? err.message : String(err) };
    }
  });

  // update.download - download a release asset
  ipcMain.handle('update:download', (_event, params) => {
    try {
      if (!params?.url) {
        return { success: false, msg: 'missing url' };
      }

      assertAllowedUrl(params.url);

      const downloadsDir = app.getPath('downloads');
      const urlObj = new URL(params.url);
      const urlName = path.basename(urlObj.pathname);
      const baseName = sanitizeFileName(params.fileName || urlName);
      const targetPath = path.join(downloadsDir, baseName);

      if (fs.existsSync(targetPath)) {
        const stats = fs.statSync(targetPath);
        if (stats.size > 0) {
          mossLog('Update', `File already exists: ${targetPath}`);
          return { success: true, data: { downloadId: 'cached', filePath: targetPath } };
        }
      }

      const downloadId = `dl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const abortController = new AbortController();
      const uniquePath = ensureUniquePath(targetPath);
      downloads.set(downloadId, { abortController, filePath: uniquePath });

      void startDownloadInBackground(downloadId, params.url, uniquePath, abortController);

      return { success: true, data: { downloadId, filePath: uniquePath } };
    } catch (err) {
      return { success: false, msg: err instanceof Error ? err.message : String(err) };
    }
  });

  // update.open - open the update modal
  ipcMain.on('update:open', () => {
    mainWindow?.webContents.send('update:open-modal');
  });

  // autoUpdate.check - check using electron-updater
  ipcMain.handle('auto-update:check', async (_event, params) => {
    try {
      autoUpdaterService.setAllowPrerelease(false); // stable only

      const result = await autoUpdaterService.checkForUpdates();
      if (result.success && result.updateInfo) {
        const currentVersion = app.getVersion();
        if (!semver.gt(result.updateInfo.version, currentVersion)) {
          return { success: true, data: {} };
        }
        return {
          success: true,
          data: {
            updateInfo: {
              version: result.updateInfo.version,
              releaseDate: result.updateInfo.releaseDate,
              releaseNotes: typeof result.updateInfo.releaseNotes === 'string' ? result.updateInfo.releaseNotes : undefined,
            },
          },
        };
      }
      return { success: result.success, msg: result.error };
    } catch (err) {
      return { success: false, msg: err instanceof Error ? err.message : String(err) };
    }
  });

  // autoUpdate.download - download using electron-updater
  ipcMain.handle('auto-update:download', async () => {
    try {
      const result = await autoUpdaterService.downloadUpdate();
      return { success: result.success, msg: result.error };
    } catch (err) {
      return { success: false, msg: err instanceof Error ? err.message : String(err) };
    }
  });

  // autoUpdate.quitAndInstall
  ipcMain.handle('auto-update:quit-and-install', async () => {
    try {
      autoUpdaterService.quitAndInstall();
    } catch (err) {
      mossLog('error', 'Update', 'quitAndInstall failed:', err);
    }
  });

  // autoUpdate.getDownloadedFilePath
  ipcMain.handle('auto-update:get-downloaded-file-path', async () => {
    try {
      const filePath = autoUpdaterService.getDownloadedFilePath();
      return { success: true, data: { path: filePath } };
    } catch {
      return { success: true, data: { path: null } };
    }
  });

  mossLog('info', 'Update', 'Update IPC handlers registered');
}
