import { contextBridge, ipcRenderer } from 'electron';

const mossApp = {
  storage: {
    getItem: (key) => ipcRenderer.invoke('app-runtime:storage:get', { key }),
    setItem: (key, value) => ipcRenderer.invoke('app-runtime:storage:set', { key, value }),
    removeItem: (key) => ipcRenderer.invoke('app-runtime:storage:remove', { key }),
    list: () => ipcRenderer.invoke('app-runtime:storage:list'),
  },
  fs: {
    list: (dirPath) => ipcRenderer.invoke('app-runtime:files:list', { path: dirPath }),
    readText: (filePath) => ipcRenderer.invoke('app-runtime:files:read-text', { path: filePath }),
    writeText: (filePath, content) => ipcRenderer.invoke('app-runtime:files:write-text', { path: filePath, content }),
    mkdir: (dirPath) => ipcRenderer.invoke('app-runtime:files:mkdir', { path: dirPath }),
    delete: (filePath) => ipcRenderer.invoke('app-runtime:files:delete', { path: filePath }),
    readGlobalText: (filePath) => ipcRenderer.invoke('fs:readText', { path: filePath }),
    deleteGlobal: (filePath) => ipcRenderer.invoke('fs:delete', { path: filePath }),
    listGlobal: (dirPath) => ipcRenderer.invoke('fs:list', { path: dirPath }),
    getHomeDir: () => ipcRenderer.invoke('fs:getHomeDir'),
  },
  agent: {
    send: (payload) => ipcRenderer.invoke('app-runtime:agent:send', payload),
    cancel: (requestId) => ipcRenderer.invoke('app-runtime:agent:cancel', { requestId }),
    reset: () => ipcRenderer.invoke('app-runtime:agent:reset'),
  },
  cron: {
    list: () => ipcRenderer.invoke('cron:list'),
    delete: (id) => ipcRenderer.invoke('cron:delete', { id }),
  },
  skillStore: {
    fetchSkills: (params) => ipcRenderer.invoke('skill-store:fetchSkills', params),
    fetchCategories: () => ipcRenderer.invoke('skill-store:fetchCategories'),
    fetchSkillDetail: (skillId) => ipcRenderer.invoke('skill-store:fetchSkillDetail', { skillId }),
    getInstalledSkills: () => ipcRenderer.invoke('skill-store:getInstalledSkills'),
    downloadAndInstall: (params) => ipcRenderer.invoke('skill-store:downloadAndInstall', params),
    uninstall: (skillName, sourcePath) => ipcRenderer.invoke('skill-store:uninstall', { skillName, sourcePath }),
    importLocal: (sourcePath) => ipcRenderer.invoke('skill-store:importLocal', { sourcePath }),
    openImportDialog: () => ipcRenderer.invoke('skill-store:openImportDialog'),
  },
  agentStore: {
    fetchAssistants: (params) => ipcRenderer.invoke('agent:fetchAssistants', params),
    fetchCategories: () => ipcRenderer.invoke('agent:fetchCategories'),
    fetchAssistantDetail: (assistantId) => ipcRenderer.invoke('agent:fetchAssistantDetail', { assistantId }),
    getInstalledAssistants: () => ipcRenderer.invoke('agent:getInstalledAssistants'),
    downloadAndInstall: (params) => ipcRenderer.invoke('agent:downloadAndInstall', params),
    uninstall: (assistantName, sourcePath) => ipcRenderer.invoke('agent:uninstall', { assistantName, sourcePath }),
    updateAssistantMeta: (assistantName, updates) => ipcRenderer.invoke('agent:updateAssistantMeta', { assistantName, updates }),
    getAssistantContext: (assistantName) => ipcRenderer.invoke('agent:getAssistantContext', { assistantName }),
    fetchSkillDetailsByIds: (skillIds) => ipcRenderer.invoke('agent:fetchSkillDetailsByIds', { skillIds }),
  },
  openDebug: () => ipcRenderer.invoke('app:open-debug', { name: document.title }),
  onAgentEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('agent:event', handler);
    return () => ipcRenderer.off('agent:event', handler);
  },
  onAgentState: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('agent:state', handler);
    return () => ipcRenderer.off('agent:state', handler);
  },
  onPermission: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('agent:permission', handler);
    return () => ipcRenderer.off('agent:permission', handler);
  },
  listResources: () => ipcRenderer.invoke('app-runtime:list-resources'),
  listTools: () => ipcRenderer.invoke('app-runtime:list-tools'),
  getAppInfo: () => ipcRenderer.invoke('app-runtime:get-info'),
  getMeta: () => ipcRenderer.invoke('app-runtime:get-meta'),
  getVersions: () => ipcRenderer.invoke('app-runtime:get-versions'),
  rollback: (versionId) => ipcRenderer.invoke('app-runtime:rollback', { versionId }),
};

contextBridge.exposeInMainWorld('mossApp', mossApp);

contextBridge.exposeInMainWorld('appVersionInfo', {
  version: '1.0.0',
  name: 'Moss App Runtime',
});

contextBridge.exposeInMainWorld('mossDebug', {
  open: () => ipcRenderer.invoke('app:open-debug', { name: document.title }),
});

// Inject floating debug button
function injectDebugButton() {
  const btn = document.createElement('button');
  btn.textContent = 'Moss';
  btn.style.cssText = `
    position: fixed;
    bottom: 16px;
    right: 16px;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: linear-gradient(135deg, #3b82f6, #8b5cf6);
    color: white;
    border: none;
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);
    z-index: 99999;
    display: flex;
    align-items: center;
    justify-content: center;
  `;
  btn.title = 'Open Moss Debug Window';
  btn.onclick = () => {
    ipcRenderer.invoke('app:open-debug', { name: document.title });
  };
  document.body.appendChild(btn);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectDebugButton);
} else {
  injectDebugButton();
}
