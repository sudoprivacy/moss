import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('mossExecution', {
  onAgentEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('execution:event', handler);
    return () => ipcRenderer.off('execution:event', handler);
  },
  onAgentState: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('execution:state', handler);
    return () => ipcRenderer.off('execution:state', handler);
  },
  onInit: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('execution:init', handler);
    return () => ipcRenderer.off('execution:init', handler);
  },
  onPermission: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('execution:permission', handler);
    return () => ipcRenderer.off('execution:permission', handler);
  },
  abort: () => ipcRenderer.invoke('execution:abort'),
  listFiles: () => ipcRenderer.invoke('execution:list-files'),
  sendMessage: (message) => ipcRenderer.invoke('execution:send', { message }),
  minimize: () => ipcRenderer.invoke('execution:minimize'),
  restore: () => ipcRenderer.invoke('execution:restore'),
});
