import electron from 'electron';
import { libreOfficeService } from '../services/libreoffice-service.mjs';

const { ipcMain, BrowserWindow } = electron;

let installState = { installing: false };

function emitToAll(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

export function registerLibreOfficeIpcHandlers() {
  ipcMain.handle('libreoffice.check-installed', async () => {
    try {
      const status = await libreOfficeService.checkInstalled();
      return { success: true, data: { ...status, source: 'system' } };
    } catch (error) {
      return { success: false, msg: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('libreoffice.get-install-state', async () => {
    return { success: true, data: installState };
  });

  ipcMain.handle('libreoffice.install', async () => {
    installState = { installing: true };
    try {
      await libreOfficeService.install((phase, percent) => {
        installState = { installing: true, phase, percent };
        emitToAll('libreoffice.install-progress', { phase, percent });
      });
      emitToAll('libreoffice.install-result', { success: true });
      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      emitToAll('libreoffice.install-result', { success: false, msg });
      return { success: false, msg };
    } finally {
      setTimeout(() => {
        installState = { installing: false };
      }, 0);
    }
  });

  ipcMain.handle('libreoffice.install-from-local-file', async (_event, { filePath }) => {
    installState = { installing: true };
    try {
      await libreOfficeService.installFromLocalFile(filePath, (phase, percent) => {
        installState = { installing: true, phase, percent };
        emitToAll('libreoffice.install-progress', { phase, percent });
      });
      emitToAll('libreoffice.install-result', { success: true });
      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      emitToAll('libreoffice.install-result', { success: false, msg });
      return { success: false, msg };
    } finally {
      setTimeout(() => {
        installState = { installing: false };
      }, 0);
    }
  });

  ipcMain.handle('libreoffice.uninstall', async () => {
    try {
      await libreOfficeService.uninstall();
      return { success: true };
    } catch (error) {
      return { success: false, msg: error instanceof Error ? error.message : String(error) };
    }
  });
}
