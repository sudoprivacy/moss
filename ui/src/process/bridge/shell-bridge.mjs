import electron from 'electron';

const { ipcMain, shell } = electron;

export function registerShellIpcHandlers() {
  ipcMain.handle('shell.open-file', async (_event, filePath) => {
    return await shell.openPath(filePath);
  });

  ipcMain.handle('shell.open-external', async (_event, url) => {
    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('shell.show-item-in-folder', async (_event, filePath) => {
    shell.showItemInFolder(filePath);
    return { ok: true };
  });
}
