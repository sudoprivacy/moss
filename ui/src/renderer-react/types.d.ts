export type PendingPlanApproval = {
  kind: 'plan';
  originalPrompt: string;
  plan: string;
  requestedAt: number;
};

export type SessionSummary = {
  id: string;
  title: string;
  agentMode?: 'local' | 'remote-direct';
  workspace: string;
  createdAt: number;
  updatedAt: number;
  busy: boolean;
  messageCount: number;
  sessionId: string | null;
  preview: string;
  pendingPlanApproval?: PendingPlanApproval | null;
  resumeReadOnlyReason?: string | null;
  assistantName?: string | null;
};

export type SessionDetail = SessionSummary & {
  history: AgentEvent[];
  workerSummariesJson: string | null;
};

export type AgentEvent = Record<string, any>;

export type PairedUser = {
  userId: string | number
  displayName: string
  pairedAt: number
}

export type PairingState = {
  code?: string | null
  expiresAt?: number | null
  createdAt?: number | null
}

export type AdapterFileConfig = {
  serverUrl?: string
  defaultProjectDir?: string
  pairing?: PairingState
  telegram?: {
    botToken?: string
    allowedUsers?: number[]
    pairedUsers?: PairedUser[]
    defaultWorkDir?: string
  }
  feishu?: {
    appId?: string
    appSecret?: string
    encryptKey?: string
    verificationToken?: string
    allowedUsers?: string[]
    pairedUsers?: PairedUser[]
    defaultWorkDir?: string
    streamingCard?: boolean
  }
}

export type DesktopSettings = {
  agentMode: 'local' | 'remote-direct';
  localEnabled: boolean;
  remoteEnabled: boolean;
  bypassPermissions: boolean;
  model: string;
  maxTurns: number;
  appendSystemPrompt: string;
  thinkingMode: 'adaptive' | 'enabled' | 'disabled';
  thinkingBudgetTokens: number;
  url: string;
  apiKey: string;
  image: {
    provider: string;
    url: string;
    apiKey: string;
    model: string;
  };
  remoteDirectServerUrl: string;
  remoteDirectCredentialMode: 'password' | 'api-key';
  // Legacy key name; stores either username or email for password login.
  remoteDirectUserEmail: string;
  remoteDirectUserPassword: string;
  remoteDirectApiKey: string;
  remoteDirectWorkspace: string;
  settingsPath: string;
  settingsExists: boolean;
  settingsLoaded: boolean;
  settingsParseError: string;
  skippedSessionCount?: number;
  coordinatorMode?: boolean;
};

export type StoredApp = {
  name: string;
  title: string;
  description: string;
  icon: string;
  width: number;
  height: number;
  resizable: boolean;
  createdAt: number;
  updatedAt: number;
  versionCount?: number;
  latestVersionId?: string | null;
  latestVersion?: string | null;
  currentVersionId?: string | null;
  currentVersion?: string | null;
  publishedVersion?: string | null;
};

export type AppVersion = {
  id: string;
  version: string;
  createdAt: number;
  reason: string;
  note: string;
  description: string;
  width: number;
  height: number;
  resizable: boolean;
  isCurrent?: boolean;
  isLatest?: boolean;
};

export type FileTreeNode = {
  id: string;
  name: string;
  type: 'folder' | 'file';
  path: string;
  children?: FileTreeNode[];
};

export type WorkspacePreviewContentType =
  | 'markdown'
  | 'html'
  | 'image'
  | 'pdf'
  | 'diff'
  | 'word'
  | 'excel'
  | 'ppt'
  | 'url'
  | 'text'
  | 'code'
  | 'unsupported';

export type WorkspacePreviewData = {
  path: string;
  relativePath: string;
  content: string;
  size?: number;
  truncated?: boolean;
  contentType: WorkspacePreviewContentType;
  language?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
};

export type PreviewHistoryTarget = {
  contentType: WorkspacePreviewContentType;
  filePath?: string;
  workspace?: string;
  fileName?: string;
  title?: string;
  language?: string;
  conversationId?: string;
};

export type PreviewSnapshotInfo = {
  id: string;
  label: string;
  createdAt: number;
  size: number;
  contentType: WorkspacePreviewContentType;
  fileName?: string;
  filePath?: string;
};

declare namespace JSX {
  interface IntrinsicElements {
    webview: any;
  }
}

declare global {
  interface Window {
    agentDesktop: {
      getStatus: () => Promise<any>;
      getAuthDebug: () => Promise<any>;
      getSettings: () => Promise<DesktopSettings>;
      updateSettings: (payload: Partial<DesktopSettings>) => Promise<DesktopSettings>;
      getAdapterConfig: () => Promise<AdapterFileConfig>;
      updateAdapterConfig: (patch: Partial<AdapterFileConfig>) => Promise<AdapterFileConfig>;
      listSessions: () => Promise<SessionSummary[]>;
      createSession: (payload?: { workspace?: string; title?: string; assistant_name?: string }) => Promise<{ summary: SessionSummary; detail: SessionDetail }>;
      getSession: (payload: { sessionId: string }) => Promise<SessionDetail>;
      updateSession: (payload: { sessionId: string; title: string }) => Promise<SessionDetail>;
      deleteSession: (payload: { sessionId: string }) => Promise<{ ok: boolean }>;
      pickDirectory: () => Promise<string | null>;
      pickFiles: () => Promise<Array<{ name: string; path: string }>>;
      setSessionWorkspace: (payload: { sessionId: string; workspace: string }) => Promise<SessionDetail>;
      openWorkspace: (payload: { sessionId: string }) => Promise<{ ok: boolean }>;
      copyFileToWorkspace: (payload: { sessionId: string; sourcePath: string; fileName: string }) => Promise<{ path: string } | { error: string }>;
      send: (payload: {
        sessionId: string;
        prompt: string;
        mode?: 'chat' | 'plan' | 'coordinator';
        appName?: string;
        files?: string[];
        coordinatorMode?: boolean;
        assistantName?: string;
      }) => Promise<any>;
      approvePlan: (payload: { sessionId: string }) => Promise<any>;
      rejectPlan: (payload: { sessionId: string }) => Promise<any>;
      abort: (payload: { sessionId: string }) => Promise<{ ok: boolean }>;
      listApps: () => Promise<StoredApp[]>;
      listAppVersions: (payload: { name: string }) => Promise<AppVersion[]>;
      launchApp: (payload: { name: string }) => Promise<{ ok: boolean }>;
      rollbackApp: (payload: { name: string; versionId: string }) => Promise<{ ok: boolean; app: StoredApp }>;
      deleteApp: (payload: { name: string }) => Promise<{ ok: boolean }>;
      saveApp: (payload: { sessionId: string; launch?: boolean }) => Promise<{ ok: boolean; app?: StoredApp; error?: string }>;
      listWorkspaceDir: (payload: { sessionId: string; dirPath?: string }) => Promise<any>;
      readWorkspaceFile: (payload: { sessionId: string; filePath: string }) => Promise<WorkspacePreviewData>;
      document: {
        convert: (payload: { filePath: string; to: 'libreoffice-pdf' | 'markdown' | 'word-html' | 'excel-json' | 'ppt-json' | 'pptx-arraybuffer' }) => Promise<any>;
        libreOffice: {
          isAvailable: () => Promise<boolean>;
        };
      };
      libreOffice: {
        checkInstalled: () => Promise<any>;
        install: () => Promise<any>;
        installFromLocalFile: (payload: { filePath: string }) => Promise<any>;
        uninstall: () => Promise<any>;
        getInstallState: () => Promise<any>;
        onInstallProgress: (callback: (payload: { phase: string; percent?: number }) => void) => () => void;
        onInstallResult: (callback: (payload: { success: boolean; msg?: string }) => void) => () => void;
      };
      previewHistory: {
        list: (payload: { target: PreviewHistoryTarget }) => Promise<PreviewSnapshotInfo[]>;
        save: (payload: { target: PreviewHistoryTarget; content: string }) => Promise<PreviewSnapshotInfo>;
        getContent: (payload: { target: PreviewHistoryTarget; snapshotId: string }) => Promise<{ snapshot: PreviewSnapshotInfo; content: string } | null>;
      };
      preview: {
        open: (payload: { content: string; contentType: WorkspacePreviewContentType; metadata?: Record<string, unknown> }) => Promise<{ ok: boolean }>;
        close: () => Promise<{ ok: boolean }>;
        onOpen: (callback: (payload: { content: string; contentType: WorkspacePreviewContentType; metadata?: Record<string, unknown> }) => void) => () => void;
      };
      workspace: {
        writeFile: (payload: { sessionId: string; filePath: string; content: string }) => Promise<WorkspacePreviewData>;
      };
      shell: {
        openFile: (filePath: string) => Promise<string>;
        openExternal: (url: string) => Promise<{ ok: boolean }>;
        showItemInFolder: (filePath: string) => Promise<{ ok: boolean }>;
      };
      fs: {
        getImageBase64: (path: string) => Promise<string | null>;
        getFileMetadata: (path: string) => Promise<{ size: number } | null>;
        createTempFile: (fileName: string) => Promise<string | null>;
        writeFile: (path: string, data: number[]) => Promise<boolean>;
        saveImageToWorkspace: (sessionId: string, fileName: string, data: number[]) => Promise<{ path: string } | { error: string }>;
        getAppIcon: () => Promise<string | null>;
      };
      onEvent: (callback: (payload: any) => void) => () => void;
      onState: (callback: (payload: any) => void) => () => void;
      onPermission: (callback: (payload: any) => void) => () => void;
      onSessionMeta: (callback: (payload: SessionSummary) => void) => () => void;
      onSessionRemoved: (callback: (payload: { sessionId: string }) => void) => () => void;
      onWorkspaceChanged: (callback: (payload: any) => void) => () => void;
      onAppsChanged: (callback: (payload: any) => void) => () => void;
      onSettingsChanged: (callback: (payload: DesktopSettings) => void) => () => void;
      listExecutions: (sessionId?: string) => Promise<{ executions: ExecutionSummary[] }>;
      focusExecution: (executionId: string) => Promise<{ ok?: boolean; error?: string }>;
      createExecutionForTeammate: (payload: { sessionId: string; taskId: string; description: string; prompt: string }) => Promise<{ ok?: boolean; executionSessionId?: string; error?: string }>;
      listCoordinatorTasks: (sessionId?: string) => Promise<{ tasks: CoordinatorTask[] }>;
      onTeammateSpawned: (callback: (payload: { sessionId: string; taskId: string; description: string; prompt: string; color?: string }) => void) => () => void;
      onTeammateCompleted: (callback: (payload: { sessionId: string; taskId: string; description: string; status: string }) => void) => () => void;
      updateTeammateState: (payload: { sessionId: string; taskId: string; completed?: boolean }) => Promise<{ ok?: boolean; error?: string }>;
      getWorkerResults: (payload: { sessionId: string }) => Promise<{ results: Record<string, WorkerSubagentResult> }>;
      setWorkerSummaries: (payload: { sessionId: string; workerSummariesJson: string | null }) => Promise<{ ok: boolean }>;
      cronList: () => Promise<CronTask[]>;
      cronDelete: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
      getInstalledAssistants: () => Promise<{ success: boolean; data?: InstalledAssistant[]; error?: string }>;
      getRemoteInstalledAssistants: () => Promise<{ success: boolean; data?: InstalledAssistant[]; error?: string }>;
      getAssistantContext: (assistantName: string) => Promise<{ success: boolean; data?: string; error?: string }>;
      getSkillInfosByIds: (skillIds: string[]) => Promise<{ success: boolean; data?: Array<{ name: string; path: string }>; error?: string }>;
      logWrite: (payload: { level?: string; category?: string; message: string; data?: unknown }) => Promise<void>;
      update: {
        check: (params?: { includePrerelease?: boolean }) => Promise<{ success: boolean; data?: UpdateCheckResult; msg?: string }>;
        download: (params: { url: string; fileName?: string }) => Promise<{ success: boolean; data?: { downloadId: string; filePath: string }; msg?: string }>;
        onOpenModal: (callback: () => void) => () => void;
        onDownloadProgress: (callback: (evt: UpdateDownloadProgressEvent) => void) => () => void;
      };
      autoUpdate: {
        check: (params?: { includePrerelease?: boolean }) => Promise<{ success: boolean; data?: { updateInfo?: { version: string; releaseDate?: string; releaseNotes?: string } }; msg?: string }>;
        download: () => Promise<{ success: boolean; msg?: string }>;
        quitAndInstall: () => Promise<void>;
        getDownloadedFilePath: () => Promise<{ success: boolean; data?: { path: string | null } }>;
        getMirrorStatus: () => Promise<{ success: boolean; data?: { useMirror: boolean; reason: string } }>;
        onStatus: (callback: (evt: AutoUpdateStatus) => void) => () => void;
      };
    };
  }
}

export type ExecutionSummary = {
  id: string;
  originalPrompt: string;
  busy: boolean;
  workspace: string;
  hasBubble: boolean;
  createdAt: number;
};

export type CoordinatorTask = {
  id: string;
  agentId: string | null;
  name: string;
  status: string;
  isIdle: boolean;
  description: string;
  color: string;
};

export type CronTask = {
  id: string;
  cron: string;
  prompt: string;
  createdAt: number;
  lastFiredAt?: number;
  recurring?: boolean;
  permanent?: boolean;
};

export type WorkerSubagentResult = {
  resultText: string | null;
  status: string;
  events: any[];
};

export type InstalledAssistant = {
  name: string;
  displayName: string;
  description: string;
  avatar: string;
  emoji: string;
  category: string;
  categories: string[];
  version: string;
  source: string;
  isBuiltin: boolean;
  isHubInstalled: boolean;
  tag: string;
  enabled: boolean;
  skills: string[];
  enabledSkills: string[];
};

// Update types
export type UpdateReleaseInfo = {
  tagName: string;
  version: string;
  name?: string;
  body?: string;
  htmlUrl: string;
  publishedAt?: string;
  prerelease: boolean;
  draft: boolean;
  assets: GitHubReleaseAsset[];
  recommendedAsset?: GitHubReleaseAsset;
};

export type GitHubReleaseAsset = {
  name: string;
  url: string;
  size: number;
  contentType?: string;
};

export type UpdateCheckResult = {
  currentVersion: string;
  updateAvailable: boolean;
  latest?: UpdateReleaseInfo;
};

export type UpdateDownloadProgressEvent = {
  downloadId: string;
  status: 'starting' | 'downloading' | 'completed' | 'error' | 'cancelled';
  receivedBytes: number;
  totalBytes?: number;
  percent?: number;
  bytesPerSecond?: number;
  filePath?: string;
  error?: string;
};

export type AutoUpdateStatus = {
  status: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'cancelled';
  version?: string;
  releaseDate?: string;
  releaseNotes?: string;
  progress?: {
    bytesPerSecond: number;
    percent: number;
    transferred: number;
    total: number;
  };
  error?: string;
  downloadedFilePath?: string;
};

export {};
