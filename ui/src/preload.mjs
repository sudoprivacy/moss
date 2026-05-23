import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('agentDesktop', {
  getStatus: () => ipcRenderer.invoke('agent:get-status'),
  getAuthDebug: () => ipcRenderer.invoke('agent:get-auth-debug'),
  getSettings: () => ipcRenderer.invoke('agent:get-settings'),
  updateSettings: (payload) => ipcRenderer.invoke('agent:update-settings', payload),
  getAdapterConfig: () => ipcRenderer.invoke('agent:get-adapter-config'),
  updateAdapterConfig: (payload) => ipcRenderer.invoke('agent:update-adapter-config', payload),
  listSessions: () => ipcRenderer.invoke('agent:list-sessions'),
  createSession: (payload) => ipcRenderer.invoke('agent:create-session', payload),
  getSession: (payload) => ipcRenderer.invoke('agent:get-session', payload),
  updateSession: (payload) => ipcRenderer.invoke('agent:update-session', payload),
  deleteSession: (payload) => ipcRenderer.invoke('agent:delete-session', payload),
  pickDirectory: () => ipcRenderer.invoke('agent:pick-directory'),
  pickFiles: () => ipcRenderer.invoke('agent:pick-files'),
  setSessionWorkspace: (payload) => ipcRenderer.invoke('agent:set-session-workspace', payload),
  openWorkspace: (payload) => ipcRenderer.invoke('workspace:open', payload),
  copyFileToWorkspace: (payload) => ipcRenderer.invoke('workspace:copyFileToWorkspace', payload),
  send: (payload) => ipcRenderer.invoke('agent:send', payload),
  approvePlan: (payload) => ipcRenderer.invoke('agent:approve-plan', payload),
  rejectPlan: (payload) => ipcRenderer.invoke('agent:reject-plan', payload),
  abort: (payload) => ipcRenderer.invoke('agent:abort', payload),
  listApps: () => ipcRenderer.invoke('app:list'),
  listAppVersions: (payload) => ipcRenderer.invoke('app:list-versions', payload),
  launchApp: (payload) => ipcRenderer.invoke('app:launch', payload),
  rollbackApp: (payload) => ipcRenderer.invoke('app:rollback', payload),
  deleteApp: (payload) => ipcRenderer.invoke('app:delete', payload),
  listWorkspaceDir: (payload) => ipcRenderer.invoke('workspace:list-dir', payload),
  readWorkspaceFile: (payload) => ipcRenderer.invoke('workspace:read-file', payload),
  document: {
    convert: (payload) => ipcRenderer.invoke('document.convert', payload),
    libreOffice: {
      isAvailable: () => ipcRenderer.invoke('document.libreoffice.is-available'),
    },
  },
  libreOffice: {
    checkInstalled: () => ipcRenderer.invoke('libreoffice.check-installed'),
    install: () => ipcRenderer.invoke('libreoffice.install'),
    installFromLocalFile: (payload) => ipcRenderer.invoke('libreoffice.install-from-local-file', payload),
    uninstall: () => ipcRenderer.invoke('libreoffice.uninstall'),
    getInstallState: () => ipcRenderer.invoke('libreoffice.get-install-state'),
    onInstallProgress: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('libreoffice.install-progress', handler);
      return () => ipcRenderer.off('libreoffice.install-progress', handler);
    },
    onInstallResult: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('libreoffice.install-result', handler);
      return () => ipcRenderer.off('libreoffice.install-result', handler);
    },
  },
  previewHistory: {
    list: (payload) => ipcRenderer.invoke('previewHistory.list', payload),
    save: (payload) => ipcRenderer.invoke('previewHistory.save', payload),
    getContent: (payload) => ipcRenderer.invoke('previewHistory.getContent', payload),
  },
  preview: {
    open: (payload) => ipcRenderer.invoke('preview.open', payload),
    close: () => ipcRenderer.invoke('preview.close'),
    onOpen: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('preview.open', handler);
      return () => ipcRenderer.off('preview.open', handler);
    },
  },
  workspace: {
    writeFile: (payload) => ipcRenderer.invoke('workspace.write-file', payload),
  },
  shell: {
    openFile: (filePath) => ipcRenderer.invoke('shell.open-file', filePath),
    openExternal: (url) => ipcRenderer.invoke('shell.open-external', url),
    showItemInFolder: (filePath) => ipcRenderer.invoke('shell.show-item-in-folder', filePath),
  },
  fs: {
    getImageBase64: (path) => ipcRenderer.invoke('fs:getImageBase64', { path }),
    getFileMetadata: (path) => ipcRenderer.invoke('fs:getFileMetadata', { path }),
    createTempFile: (fileName) => ipcRenderer.invoke('fs:createTempFile', { fileName }),
    writeFile: (path, data) => ipcRenderer.invoke('fs:writeFile', { path, data }),
    getAppIcon: () => ipcRenderer.invoke('fs:getAppIcon'),
    saveImageToWorkspace: (sessionId, fileName, data) => ipcRenderer.invoke('workspace:saveImage', { sessionId, fileName, data }),
  },
  onEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('agent:event', handler);
    return () => ipcRenderer.off('agent:event', handler);
  },
  onState: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('agent:state', handler);
    return () => ipcRenderer.off('agent:state', handler);
  },
  onPermission: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('agent:permission', handler);
    return () => ipcRenderer.off('agent:permission', handler);
  },
  onSessionMeta: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('agent:session-meta', handler);
    return () => ipcRenderer.off('agent:session-meta', handler);
  },
  onSessionRemoved: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('agent:session-removed', handler);
    return () => ipcRenderer.off('agent:session-removed', handler);
  },
  onWorkspaceChanged: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('workspace:changed', handler);
    return () => ipcRenderer.off('workspace:changed', handler);
  },
  onAppsChanged: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('app:changed', handler);
    return () => ipcRenderer.off('app:changed', handler);
  },
  onSettingsChanged: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('agent:settings-changed', handler);
    return () => ipcRenderer.off('agent:settings-changed', handler);
  },
  // Sub-agent execution window management
  listExecutions: (sessionId) => ipcRenderer.invoke('execution:list', { sessionId }),
  focusExecution: (executionId) => ipcRenderer.invoke('execution:focus', { executionId }),
  createExecutionForTeammate: (payload) => ipcRenderer.invoke('execution:create-for-teammate', payload),
  updateTeammateState: (payload) => ipcRenderer.invoke('execution:update-teammate-state', payload),
  listCoordinatorTasks: (sessionId) => ipcRenderer.invoke('coordinator:list-tasks', { sessionId }),
  onTeammateSpawned: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('coordinator:teammate-spawned', handler);
    return () => ipcRenderer.off('coordinator:teammate-spawned', handler);
  },
  onTeammateCompleted: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('coordinator:teammate-completed', handler);
    return () => ipcRenderer.off('coordinator:teammate-completed', handler);
  },
  // Worker (sub-agent) results from SDK subagents directory
  getWorkerResults: (payload) => ipcRenderer.invoke('agent:get-worker-results', payload),
  setWorkerSummaries: (payload) => ipcRenderer.invoke('agent:set-worker-summaries', payload),
  // Cron task management
  cronList: () => ipcRenderer.invoke('cron:list'),
  cronDelete: (taskId) => ipcRenderer.invoke('cron:delete', { taskId }),
  // Assistant management
  getInstalledAssistants: () => ipcRenderer.invoke('agent:getInstalledAssistants'),
  getRemoteInstalledAssistants: () => ipcRenderer.invoke('agent:getRemoteInstalledAssistants'),
  getAssistantContext: (assistantName) => ipcRenderer.invoke('agent:getAssistantContext', { assistantName }),
  getSkillInfosByIds: (skillIds) => ipcRenderer.invoke('agent:getSkillInfosByIds', { skillIds }),
  // Log management
  logGetPath: () => ipcRenderer.invoke('log:get-path'),
  logDownload: () => ipcRenderer.invoke('log:download'),
  logWrite: (payload) => ipcRenderer.invoke('log:write', payload),

  // Update / Auto-update
  update: {
    check: (params) => ipcRenderer.invoke('update:check', params),
    download: (params) => ipcRenderer.invoke('update:download', params),
    onOpenModal: (callback) => {
      const handler = () => callback();
      ipcRenderer.on('update:open-modal', handler);
      return () => ipcRenderer.off('update:open-modal', handler);
    },
    onDownloadProgress: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('update:download-progress', handler);
      return () => ipcRenderer.off('update:download-progress', handler);
    },
  },
  autoUpdate: {
    check: (params) => ipcRenderer.invoke('auto-update:check', params),
    download: () => ipcRenderer.invoke('auto-update:download'),
    quitAndInstall: () => ipcRenderer.invoke('auto-update:quit-and-install'),
    getDownloadedFilePath: () => ipcRenderer.invoke('auto-update:get-downloaded-file-path'),
    getMirrorStatus: () => ipcRenderer.invoke('auto-update:get-mirror-status'),
    onStatus: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('auto-update:status', handler);
      return () => ipcRenderer.off('auto-update:status', handler);
    },
  },
});
