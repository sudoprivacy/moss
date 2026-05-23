export const libreOfficeIpc = {
  checkInstalled: () => window.agentDesktop.libreOffice.checkInstalled(),
  install: () => window.agentDesktop.libreOffice.install(),
  installFromLocalFile: (payload: { filePath: string }) => window.agentDesktop.libreOffice.installFromLocalFile(payload),
  uninstall: () => window.agentDesktop.libreOffice.uninstall(),
  getInstallState: () => window.agentDesktop.libreOffice.getInstallState(),
  onInstallProgress: (callback: (payload: { phase: string; percent?: number }) => void) =>
    window.agentDesktop.libreOffice.onInstallProgress(callback),
  onInstallResult: (callback: (payload: { success: boolean; msg?: string }) => void) =>
    window.agentDesktop.libreOffice.onInstallResult(callback),
};
