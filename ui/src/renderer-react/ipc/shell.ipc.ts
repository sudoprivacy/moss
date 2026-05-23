export const shellIpc = {
  openFile: (filePath: string) => window.agentDesktop.shell.openFile(filePath),
  openExternal: (url: string) => window.agentDesktop.shell.openExternal(url),
  showItemInFolder: (filePath: string) => window.agentDesktop.shell.showItemInFolder(filePath),
};
