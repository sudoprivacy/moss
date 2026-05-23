import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('debugAPI', {
  init: (callback) => {
    ipcRenderer.on('debug:init', (_event, data) => callback(data));
  },
  onAgentEvent: (callback) => {
    ipcRenderer.on('debug:agent-event', (_event, data) => callback(data));
  },
  close: () => ipcRenderer.send('debug:close'),
  sendToAgent: (data) => ipcRenderer.send('debug:send-to-agent', data),
  onResponse: (callback) => {
    ipcRenderer.on('debug:response', (_event, data) => callback(data));
  },
});
