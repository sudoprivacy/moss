import electron from 'electron';

const { ipcMain } = electron;

export function registerPreviewIpcHandlers(getMainWindow) {
  ipcMain.handle('preview.open', async (_event, data) => {
    const mainWindow = getMainWindow?.();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('preview.open', data);
    }
    return { ok: true };
  });

  ipcMain.handle('preview.close', async () => ({ ok: true }));
}
