import electron from 'electron';

const { ipcMain } = electron;

export function registerWorkspaceIpcHandlers({
  getSessionRecord,
  ensureInsideRoot,
  readWorkspaceFile,
  fsp,
}) {
  ipcMain.handle('workspace.write-file', async (_event, { sessionId, filePath, content }) => {
    const sessionRecord = getSessionRecord(sessionId);
    const targetPath = ensureInsideRoot(sessionRecord.workspace, filePath);

    await fsp.writeFile(targetPath, String(content ?? ''), 'utf8');
    return await readWorkspaceFile(sessionRecord, targetPath);
  });
}
