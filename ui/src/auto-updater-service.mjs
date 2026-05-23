/**
 * Auto-updater service for Moss
 * Uses electron-updater with GitHub releases
 */

import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import log from 'electron-log';
import { EventEmitter } from 'events';

/**
 * Returns an explicit update channel override when configured.
 * Architecture-specific channels are opt-in to avoid breaking the default latest.yml flow.
 */
export function getUpdateChannel(env = process.env) {
  const configuredChannel = String(env.MOSS_UPDATE_CHANNEL || '').trim();
  return configuredChannel || undefined;
}

// AutoUpdateStatus and StatusBroadcastCallback types removed - using JSDoc or inline types below

class AutoUpdaterService extends EventEmitter {
  constructor() {
    super();
    this._isInitialized = false;
    this._eventHandlersSetup = false;
    this._allowPrerelease = false;
    this._statusBroadcastCallback = null;
    this._autoUpdaterHandlers = new Map();
    autoUpdater.logger = log;
    autoUpdater.logger.transports.file.level = 'info';

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    const channel = getUpdateChannel();
    if (channel !== undefined) {
      autoUpdater.channel = channel;
      log.info(`Update channel set to: ${channel}`);
    }
  }

  initialize(statusBroadcastCallback) {
    this._statusBroadcastCallback = statusBroadcastCallback ?? null;
    this._isInitialized = true;

    if (!this._eventHandlersSetup) {
      this.setupEventHandlers();
      this._eventHandlersSetup = true;
    }
  }

  setStatusBroadcastCallback(callback) {
    this._statusBroadcastCallback = callback;
  }

  get isInitialized() {
    return this._isInitialized;
  }

  reset() {
    this._isInitialized = false;
    this._allowPrerelease = false;
    this._statusBroadcastCallback = null;
  }

  setAllowPrerelease(allow) {
    this._allowPrerelease = allow;
    autoUpdater.allowPrerelease = allow;
    autoUpdater.allowDowngrade = allow;
    log.info(`Prerelease updates ${allow ? 'enabled' : 'disabled'}`);
  }

  get allowPrerelease() {
    return this._allowPrerelease;
  }

  setupEventHandlers() {
    const register = (event, handler) => {
      autoUpdater.on(event, handler);
      this._autoUpdaterHandlers.set(event, handler);
    };

    register('checking-for-update', () => {
      log.info('Checking for updates...');
      this.broadcastStatus({ status: 'checking' });
    });

    register('update-available', (info) => {
      log.info(`Update available: ${info.version}`);
      this.broadcastStatus({
        status: 'available',
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      });
    });

    register('update-not-available', () => {
      log.info('Application is up to date');
      this.broadcastStatus({ status: 'not-available' });
    });

    register('download-progress', (progress) => {
      log.info(`Download progress: ${progress.percent.toFixed(2)}%`);
      this.broadcastStatus({
        status: 'downloading',
        progress: {
          bytesPerSecond: progress.bytesPerSecond,
          percent: progress.percent,
          transferred: progress.transferred,
          total: progress.total,
        },
      });
    });

    register('update-downloaded', (info) => {
      log.info('Update downloaded');
      this.broadcastStatus({
        status: 'downloaded',
        version: info.version,
        downloadedFilePath: info.downloadedFile,
      });
    });

    register('error', (error) => {
      log.error('Auto-updater error:', error);
      this.broadcastStatus({
        status: 'error',
        error: error.message,
      });
    });
  }

  broadcastStatus(status) {
    this.emit('update-status', status);
    if (this._statusBroadcastCallback) {
      this._statusBroadcastCallback(status);
    }
  }

  async checkForUpdates() {
    try {
      if (!this._isInitialized) {
        throw new Error('AutoUpdaterService not initialized');
      }

      const result = await autoUpdater.checkForUpdates();
      if (!result) {
        return { success: false, error: 'checkForUpdates returned null (not packaged or dev mode)' };
      }
      return {
        success: true,
        updateInfo: result.updateInfo,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Check for updates failed:', message);
      return {
        success: false,
        error: message,
      };
    }
  }

  async downloadUpdate() {
    try {
      if (!this._isInitialized) {
        throw new Error('AutoUpdaterService not initialized');
      }

      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Download update failed:', message);
      return {
        success: false,
        error: message,
      };
    }
  }

  quitAndInstall() {
    log.info('Quitting and installing update...');
    autoUpdater.quitAndInstall(false, true);
  }

  getDownloadedFilePath() {
    const helper = autoUpdater['downloadedUpdateHelper'];
    return helper?.file ?? null;
  }

  async checkForUpdatesAndNotify() {
    try {
      autoUpdater.allowDowngrade = false;
      await autoUpdater.checkForUpdatesAndNotify();
    } catch (error) {
      log.error('Auto-update check failed:', error);
    }
  }
}

export const autoUpdaterService = new AutoUpdaterService();
