import * as React from 'react';
import { AppSidebar } from '@/components/app-sidebar';
import { AppsPanel } from '@/components/apps-panel';
import { ChatArea } from '@/components/chat-area';
import { PreviewDrawer } from '@/components/preview-drawer';
import { previewIpc } from '@/ipc/preview.ipc';
import { UpdateModal } from '@/components/update-modal';
import { TaskPanel, type PreviewTabData } from '@/components/task-panel';
import { ExecutionPetPanel } from '@/components/execution-pet-panel';
import { BuddyCompanion, isBuddyEnabled, setBuddyEnabled } from '@/components/buddy';
import { SettingsView } from '@/components/settings-view';
import {
  buildMainChatRenderMessagesFromHistory,
  buildWorkerRenderMessagesFromSubagentEvents,
  type TranscriptRenderMessage,
  type WorkerThread,
  type WorkerThreadStatus,
} from '@/lib/agent-transcript';
import { PRESET_THEMES } from '@/theme/presets';
import { applyCssTheme, getStoredThemeId, setStoredThemeId } from '@/theme/cssTheme';
import type {
  AgentEvent,
  AppVersion,
  CoordinatorTask,
  DesktopSettings,
  ExecutionSummary,
  FileTreeNode,
  InstalledAssistant,
  SessionDetail,
  SessionSummary,
  StoredApp,
  WorkspacePreviewData,
  WorkerSubagentResult,
} from './types';

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)}分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)}小时前`;
  return `${Math.floor(diff / day)}天前`;
}

function formatSidebarPreview(preview: string): string {
  const raw = String(preview || '').trim();
  if (!raw) return '';

  const withoutFence = raw.includes('```') ? raw.split('```')[0] : raw;
  const singleLine = withoutFence.replace(/\s+/g, ' ').trim();
  if (!singleLine) return '';

  return singleLine.length > 48 ? `${singleLine.slice(0, 48)}...` : singleLine;
}

function basename(filePath: string): string {
  if (!filePath) return '';
  const normalized = filePath.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || normalized;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function loadPanelLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw);
    return {
      leftWidth: clamp(Number(parsed.leftWidth) || DEFAULT_LAYOUT.leftWidth, LEFT_WIDTH_RANGE.min, LEFT_WIDTH_RANGE.max),
      previewWidth: clamp(Number(parsed.previewWidth) || DEFAULT_LAYOUT.previewWidth, PREVIEW_WIDTH_RANGE.min, PREVIEW_WIDTH_RANGE.max),
      rightWidth: clamp(Number(parsed.rightWidth) || DEFAULT_LAYOUT.rightWidth, RIGHT_WIDTH_RANGE.min, RIGHT_WIDTH_RANGE.max),
      leftCollapsed: Boolean(parsed.leftCollapsed),
      rightCollapsed: Boolean(parsed.rightCollapsed),
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}


function toSidebarSessions(
  summaries: SessionSummary[],
  pinnedIds: Set<string>
) {
  return summaries.map((session) => ({
    ...session,
    preview: formatSidebarPreview(session.preview),
    time: formatRelativeTime(session.updatedAt),
    workspaceLabel: basename(session.workspace),
    isPinned: pinnedIds.has(session.id),
    // 使用后端返回的 agentMode，如果没有则默认为 local
    agentMode: session.agentMode || 'local',
  }));
}

type ThemeMode = 'dark' | 'light' | 'system';
type ComposerIntent = 'chat' | 'plan' | 'coordinator';
type LayoutState = {
  leftWidth: number;
  previewWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
};

type PreviewTabMetadata = Record<string, unknown> & {
  sessionId?: string;
  workspace?: string;
  originalContent?: string;
  dirty?: boolean;
  lastSavedAt?: number;
  previewEditable?: boolean;
  previewSaveable?: boolean;
  previewReason?: string;
};

const LAYOUT_STORAGE_KEY = 'ui.panelLayout.v1';
const DEFAULT_LAYOUT: LayoutState = {
  leftWidth: 248,
  previewWidth: 420,
  rightWidth: 280,
  leftCollapsed: false,
  rightCollapsed: false,
};
const LEFT_WIDTH_RANGE = { min: 210, max: 420 };
const PREVIEW_WIDTH_RANGE = { min: 320, max: 760 };
const RIGHT_WIDTH_RANGE = { min: 280, max: 560 };

function canEditPreviewType(contentType: WorkspacePreviewData['contentType']): boolean {
  return ['markdown', 'html', 'text', 'code', 'diff', 'url', 'unsupported'].includes(contentType);
}

function getPreviewTabMetadata(file: WorkspacePreviewData | null | undefined): PreviewTabMetadata {
  return ((file?.metadata as PreviewTabMetadata | undefined) || {}) as PreviewTabMetadata;
}

function isDirtyPreviewTab(file: WorkspacePreviewData | null | undefined): boolean {
  return Boolean(getPreviewTabMetadata(file).dirty);
}

function enrichWorkspacePreviewFile(
  file: WorkspacePreviewData,
  sessionId: string | null,
  workspace: string | null | undefined,
  existing?: WorkspacePreviewData | null
): PreviewTabData {
  if (file.path.startsWith('preview:')) {
    return file;
  }

  const existingMetadata = getPreviewTabMetadata(existing);
  const existingDirty = Boolean(existingMetadata.dirty);
  const content = existingDirty ? existing?.content || file.content : file.content;

  return {
    ...file,
    content,
    metadata: {
      ...(file.metadata || {}),
      ...(existingDirty ? existingMetadata : {}),
      sessionId: sessionId || existingMetadata.sessionId,
      workspace: workspace || existingMetadata.workspace,
      originalContent: canEditPreviewType(file.contentType)
        ? file.content
        : existingMetadata.originalContent,
      dirty: existingDirty ? true : false,
    },
  };
}

function upsertSummary(list: SessionSummary[], summary: SessionSummary) {
  const next = list.some((entry) => entry.id === summary.id)
    ? list.map((entry) => (entry.id === summary.id ? summary : entry))
    : [summary, ...list];
  return next.sort((a, b) => b.updatedAt - a.updatedAt);
}

function filterVisibleNodes(items: any[], query: string, cache: Map<string, any>, expandedDirs: Set<string>): FileTreeNode[] {
  const lower = query.trim().toLowerCase();
  return items
    .map((item) => {
      const cached = cache.get(item.path);
      const children = item.type === 'directory' && expandedDirs.has(item.path) && cached?.items
        ? filterVisibleNodes(cached.items, query, cache, expandedDirs)
        : undefined;

      const selfMatch =
        !lower ||
        item.name.toLowerCase().includes(lower) ||
        String(item.relativePath || '').toLowerCase().includes(lower);

      if (!selfMatch && item.type === 'directory' && (!children || children.length === 0)) {
        return null;
      }
      if (!selfMatch && item.type === 'file') {
        return null;
      }

      return {
        id: item.path,
        name: item.name,
        type: item.type === 'directory' ? 'folder' : 'file',
        path: item.path,
        children,
      } satisfies FileTreeNode;
    })
    .filter(Boolean) as FileTreeNode[];
}

function mapCoordinatorTaskStatus(status: string | undefined): 'running' | 'completed' | 'failed' | undefined {
  const normalized = String(status || '').toLowerCase();
  if (!normalized) return undefined;
  if (/(fail|error|killed|stopped|cancel)/.test(normalized)) return 'failed';
  if (/(complete|completed|done|success|finished)/.test(normalized)) return 'completed';
  if (/(run|running|pending|queued|waiting|spawned|created|active)/.test(normalized)) return 'running';
  return undefined;
}

export default function App() {
  const isMacOS =
    typeof navigator !== 'undefined' &&
    /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform} ${navigator.userAgent}`);
  const [bootError, setBootError] = React.useState('');
  const [permissionNotice, setPermissionNotice] = React.useState('');
  const [activeView, setActiveView] = React.useState<'chat' | 'apps' | 'settings'>('chat');
  const getSystemTheme = (): 'dark' | 'light' => {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  };

  const resolveTheme = (pref: ThemeMode): 'dark' | 'light' => {
    return pref === 'system' ? getSystemTheme() : pref;
  };

  const [themeMode, setThemeMode] = React.useState<ThemeMode>(() => {
    try {
      const stored = localStorage.getItem('ui.themeMode');
      if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
    } catch {}
    return 'light';
  });
  const [cssThemeId, setCssThemeId] = React.useState<string>(() => {
    return getStoredThemeId() || 'grid-theme';
  });
  const [sessionSearchQuery, setSessionSearchQuery] = React.useState('');
  const [layout, setLayout] = React.useState<LayoutState>(() => loadPanelLayout());
  const [summaries, setSummaries] = React.useState<SessionSummary[]>([]);
  const [apps, setApps] = React.useState<StoredApp[]>([]);
  const [versionsByApp, setVersionsByApp] = React.useState<Record<string, AppVersion[]>>({});
  const [selectedAppName, setSelectedAppName] = React.useState('');
  const [composerIntent, setComposerIntent] = React.useState<ComposerIntent>('chat');
  const [installedAssistants, setInstalledAssistants] = React.useState<InstalledAssistant[]>([]);
  const [selectedAssistant, setSelectedAssistant] = React.useState<InstalledAssistant | null>(null);
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null);
  const [activeDetail, setActiveDetail] = React.useState<SessionDetail | null>(null);
  const [input, setInput] = React.useState('');
  const [pinnedIds, setPinnedIds] = React.useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('ui.pinnedSessions');
      return new Set(raw ? JSON.parse(raw) : []);
    } catch {
      return new Set();
    }
  });

  // Map sessionId -> agentMode ('local' | 'remote-direct')
  const [sessionAgentModes, setSessionAgentModes] = React.useState<Map<string, 'local' | 'remote-direct'>>(() => {
    try {
      const raw = localStorage.getItem('ui.sessionAgentModes');
      if (!raw) return new Map();
      const obj = JSON.parse(raw);
      return new Map(Object.entries(obj));
    } catch {
      return new Map();
    }
  });

  const persistSessionAgentModes = React.useCallback((map: Map<string, 'local' | 'remote-direct'>) => {
    setSessionAgentModes(map);
    const obj = Object.fromEntries(map.entries());
    localStorage.setItem('ui.sessionAgentModes', JSON.stringify(obj));
  }, []);
  const [workspaceQuery, setWorkspaceQuery] = React.useState('');
  const [expandedDirs, setExpandedDirs] = React.useState<Set<string>>(new Set());
  const [directoryCache, setDirectoryCache] = React.useState<Map<string, any>>(new Map());
  const [selectedFilePath, setSelectedFilePath] = React.useState<string | null>(null);
  const [previewTabs, setPreviewTabs] = React.useState<PreviewTabData[]>([]);
  const [activePreviewPath, setActivePreviewPath] = React.useState<string | null>(null);
  const [desktopSettings, setDesktopSettings] = React.useState<DesktopSettings | null>(null);
  const [settingsDraft, setSettingsDraft] = React.useState<DesktopSettings | null>(null);
  const [settingsNotice, setSettingsNotice] = React.useState('');
  const [planDecisionBusy, setPlanDecisionBusy] = React.useState(false);
  const [executions, setExecutions] = React.useState<ExecutionSummary[]>([]);
  const [coordinatorTasks, setCoordinatorTasks] = React.useState<CoordinatorTask[]>([]);
  const [activeWorkerThreadId, setActiveWorkerThreadId] = React.useState<string | null>(null);
  const [stickyWorkerTaskStatuses, setStickyWorkerTaskStatuses] = React.useState<Record<string, 'completed' | 'failed'>>({});
  const [workerSubagentResults, setWorkerSubagentResults] = React.useState<Record<string, WorkerSubagentResult>>({});
  // Workers from previous coordinator runs in the same session, grouped by round.
  const [archivedWorkerRounds, setArchivedWorkerRounds] = React.useState<WorkerThread[][]>([]);
  const archivedWorkerRoundsRef = React.useRef<WorkerThread[][]>([]);
  const previewAutoCollapsedRightRef = React.useRef(false);
  const previewAutoCollapsedBySessionRef = React.useRef<string | null>(null);
  const [forceBuddyUpdate, setForceBuddyUpdate] = React.useState(0);
  const workspaceRefreshTimerRef = React.useRef<number | null>(null);
  const refreshedTerminalWorkerIdsRef = React.useRef<Set<string>>(new Set());
  // Tracks which task IDs were present in the previous coordinatorTasks poll,
  // so we can detect disappearances (tasks that completed without a terminal status).
  const prevCoordinatorTaskIdsRef = React.useRef<Set<string>>(new Set());
  // Keeps the last non-empty thread list so the worker panel and summary stay
  // visible after the backend clears coordinatorTasks on completion.
  const frozenWorkerThreadsRef = React.useRef<WorkerThread[]>([]);
  // When the memo detects a new run (new task IDs while frozen is non-empty), it
  // stores the old frozen workers here so the effect can archive them to state.
  const pendingArchiveRef = React.useRef<WorkerThread[] | null>(null);
  const prevBusyRef = React.useRef<boolean | undefined>(undefined);
  const layoutRef = React.useRef(layout);
  const activeSessionIdRef = React.useRef<string | null>(null);
  const activeDetailRef = React.useRef<SessionDetail | null>(null);
  const expandedDirsRef = React.useRef<Set<string>>(new Set());
  const previewTabsRef = React.useRef<WorkspacePreviewData[]>([]);
  const openSessionRequestIdRef = React.useRef(0);
  const getDirtyPreviewTabs = React.useCallback(
    () => previewTabsRef.current.filter((tab) => isDirtyPreviewTab(tab)),
    []
  );
  const confirmDiscardDirtyPreviewTabs = React.useCallback((message?: string) => {
    const dirtyTabs = getDirtyPreviewTabs();
    if (dirtyTabs.length === 0) return true;
    return window.confirm(message || `有 ${dirtyTabs.length} 个预览存在未保存修改，确认放弃？`);
  }, [getDirtyPreviewTabs]);

  const clearSessionWorkspaceState = React.useCallback(() => {
    setDirectoryCache(new Map());
    setExpandedDirs(new Set());
    setSelectedFilePath(null);
    setPreviewTabs([]);
    setActivePreviewPath(null);
    setWorkspaceQuery('');
    previewAutoCollapsedRightRef.current = false;
    previewAutoCollapsedBySessionRef.current = null;
  }, []);

  const persistPinned = React.useCallback((next: Set<string>) => {
    setPinnedIds(next);
    localStorage.setItem('ui.pinnedSessions', JSON.stringify(Array.from(next)));
  }, []);

  const refreshSummaries = React.useCallback(async () => {
    const list = await window.agentDesktop.listSessions();
    setSummaries(list);
    return list;
  }, []);

  const refreshApps = React.useCallback(async () => {
    const nextApps = await window.agentDesktop.listApps();
    setApps(nextApps);
    return nextApps;
  }, []);

  const refreshAssistants = React.useCallback(async (mode?: 'local' | 'remote-direct') => {
    const agentMode = mode ?? desktopSettings?.agentMode ?? 'local';
    const result = agentMode === 'remote-direct'
      ? await window.agentDesktop.getRemoteInstalledAssistants()
      : await window.agentDesktop.getInstalledAssistants();
    const assistants = result?.data ?? result ?? [];
    setInstalledAssistants(Array.isArray(assistants) ? assistants : []);
    return assistants;
  }, [desktopSettings?.agentMode]);

  const loadAppVersions = React.useCallback(async (name: string) => {
    const versions = await window.agentDesktop.listAppVersions({ name });
    setVersionsByApp((prev) => ({ ...prev, [name]: versions }));
    return versions;
  }, []);

  const applyDesktopSettings = React.useCallback((next: DesktopSettings) => {
    setDesktopSettings((prev) => (prev ? { ...prev, ...next } : next));
    setSettingsDraft((prev) => (prev ? { ...prev, ...next } : next));
  }, []);

  const navigateToHome = React.useCallback((options?: { resetInput?: boolean; resetApp?: boolean; preserveIntent?: boolean; forceDiscardDirty?: boolean }) => {
    if (!options?.forceDiscardDirty && !confirmDiscardDirtyPreviewTabs('当前存在未保存的预览修改，确认离开当前会话？')) {
      return false;
    }
    setActiveView('chat');
    setActiveSessionId(null);
    setActiveDetail(null);
    clearSessionWorkspaceState();
    if (!options?.preserveIntent) {
      setComposerIntent('chat');
    }
    if (options?.resetInput) {
      setInput('');
    }
    if (options?.resetApp) {
      setSelectedAppName('');
    }
    return true;
  }, [clearSessionWorkspaceState, confirmDiscardDirtyPreviewTabs]);

  const openSession = React.useCallback(async (sessionId: string) => {
    if (activeSessionIdRef.current !== sessionId) {
      if (!confirmDiscardDirtyPreviewTabs('当前存在未保存的预览修改，确认切换到其他会话？')) {
        return false;
      }
    }
    const requestId = ++openSessionRequestIdRef.current;
    const detail = await window.agentDesktop.getSession({ sessionId });
    if (requestId !== openSessionRequestIdRef.current) {
      return false;
    }
    setActiveView('chat');
    setActiveSessionId(sessionId);
    setActiveDetail(detail);
    clearSessionWorkspaceState();
    return true;
  }, [clearSessionWorkspaceState, confirmDiscardDirtyPreviewTabs]);

  const createAndOpenSession = React.useCallback(async (title?: string, workspace?: string, assistantName?: string) => {
    const payload: { title?: string; workspace?: string; assistant_name?: string } = {};
    if (workspace) payload.workspace = workspace;
    if (title) payload.title = title;
    if (assistantName) payload.assistant_name = assistantName;
    const created = await window.agentDesktop.createSession(payload);
    setSummaries((prev) => upsertSummary(prev, created.summary));
    // Record session agentMode based on current settings
    const mode = desktopSettings?.agentMode ?? 'local';
    persistSessionAgentModes(new Map(sessionAgentModes).set(created.summary.id, mode));
    await openSession(created.summary.id);
    return created.summary.id;
  }, [openSession, desktopSettings?.agentMode, sessionAgentModes, persistSessionAgentModes]);

  const ensureRootDirectory = React.useCallback(async (sessionId: string, workspace: string) => {
    const data = await window.agentDesktop.listWorkspaceDir({ sessionId, dirPath: workspace });
    setDirectoryCache(new Map([[workspace, data]]));
  }, []);

  React.useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  React.useEffect(() => {
    layoutRef.current = layout;
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  }, [layout]);

  React.useEffect(() => {
    activeDetailRef.current = activeDetail;
  }, [activeDetail]);

  React.useEffect(() => {
    expandedDirsRef.current = expandedDirs;
  }, [expandedDirs]);

  React.useEffect(() => {
    previewTabsRef.current = previewTabs;
  }, [previewTabs]);

  React.useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (getDirtyPreviewTabs().length === 0) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [getDirtyPreviewTabs]);

  React.useEffect(() => {
    const root = document.documentElement;
    const resolved = resolveTheme(themeMode);
    root.setAttribute('data-theme', resolved);
    root.style.colorScheme = resolved;
    localStorage.setItem('ui.themeMode', themeMode);
  }, [themeMode]);

  // Listen for system theme changes when in system mode
  React.useEffect(() => {
    if (themeMode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      const root = document.documentElement;
      const resolved = resolveTheme('system');
      root.setAttribute('data-theme', resolved);
      root.style.colorScheme = resolved;
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [themeMode]);

  // Apply CSS theme when cssThemeId changes
  React.useEffect(() => {
    const theme = PRESET_THEMES.find((t) => t.id === cssThemeId);
    applyCssTheme(theme?.css || null);
    setStoredThemeId(cssThemeId);
  }, [cssThemeId]);

  React.useEffect(() => {
    return () => {
      document.body.classList.remove('layout-resizing');
    };
  }, []);

  React.useEffect(() => {
    if (selectedAppName && !apps.some((entry) => entry.name === selectedAppName)) {
      setSelectedAppName('');
    }
  }, [apps, selectedAppName]);

  // Poll for active sub-agent executions (pets)
  React.useEffect(() => {
    if (!activeSessionId) {
      setExecutions([]);
      return;
    }
    let mounted = true;
    const loadExecutions = async () => {
      try {
        const result = await window.agentDesktop.listExecutions(activeSessionId);
        if (mounted && result?.executions) {
          setExecutions(result.executions);
        }
      } catch {
        // ignore
      }
    };
    loadExecutions();
    const timer = window.setInterval(loadExecutions, 3000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [activeSessionId]);

  // Poll for coordinator mode in-process teammate tasks
  React.useEffect(() => {
    if (!activeSessionId) {
      setCoordinatorTasks([]);
      return;
    }
    let mounted = true;
    const loadCoordinatorTasks = async () => {
      try {
        const result = await window.agentDesktop.listCoordinatorTasks(activeSessionId);
        if (mounted && result?.tasks) {
          setCoordinatorTasks(result.tasks);
        }
      } catch {
        // ignore
      }
    };
    loadCoordinatorTasks();
    const timer = window.setInterval(loadCoordinatorTasks, 2000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [activeSessionId]);

  React.useEffect(() => {
    setStickyWorkerTaskStatuses({});
    setWorkerSubagentResults({});
    setArchivedWorkerRounds([]);
    archivedWorkerRoundsRef.current = [];
    refreshedTerminalWorkerIdsRef.current = new Set();
    prevCoordinatorTaskIdsRef.current = new Set();
    frozenWorkerThreadsRef.current = [];
    pendingArchiveRef.current = null;
    prevBusyRef.current = undefined;
  }, [activeSessionId]);

  // Track busy transitions:
  // false → true: new coordinator request started — reset auxiliary tracking state.
  //               frozenWorkerThreadsRef is intentionally NOT cleared here so
  //               multi-turn coordinator follow-ups keep workers visible.
  //               The resolvedWorkerThreads memo archives old workers when new task IDs appear.
  // true  → false: coordinator just finished — persist worker states to SQLite so
  //               the worker panel survives session switches and app restarts.
  React.useEffect(() => {
    const busy = Boolean(activeDetail?.busy);
    if (prevBusyRef.current === false && busy === true) {
      setStickyWorkerTaskStatuses({});
      setWorkerSubagentResults({});
      refreshedTerminalWorkerIdsRef.current = new Set();
      prevCoordinatorTaskIdsRef.current = new Set();
    } else if (prevBusyRef.current === true && busy === false) {
      const threads = frozenWorkerThreadsRef.current;
      const archived = archivedWorkerRoundsRef.current;
      const sid = activeSessionIdRef.current;
      if ((threads.length > 0 || archived.length > 0) && sid) {
        // Persist worker metadata (messages excluded — they live in .jsonl files).
        const data = {
          current: threads.map((t) => ({ ...t, messages: [] as TranscriptRenderMessage[] })),
          archived: archived.map((round) =>
            round.map((t) => ({ ...t, messages: [] as TranscriptRenderMessage[] })),
          ),
        };
        void window.agentDesktop.setWorkerSummaries({
          sessionId: sid,
          workerSummariesJson: JSON.stringify(data),
        });
      }
    }
    prevBusyRef.current = busy;
  }, [activeDetail?.busy]);

  // After each render, flush any pending archive produced by the resolvedWorkerThreads memo.
  // The memo can't call setState, so it signals via pendingArchiveRef.
  React.useEffect(() => {
    if (!pendingArchiveRef.current) return;
    const toArchive = pendingArchiveRef.current;
    pendingArchiveRef.current = null;
    setArchivedWorkerRounds((prev) => {
      const next = [...prev, toArchive];
      archivedWorkerRoundsRef.current = next;
      return next;
    });
  });

  // Restore worker panel from SQLite when opening a session that had previous coordinator runs.
  // The saved JSON is the lightweight worker summary; full event streams are re-fetched
  // from .jsonl files via getWorkerResults.
  React.useEffect(() => {
    const json = activeDetail?.workerSummariesJson;
    if (!activeSessionId || !json) return;
    if (frozenWorkerThreadsRef.current.length > 0) return; // live data already present
    try {
      const saved = JSON.parse(json);
      // Support both the old format (WorkerThread[]) and the new format ({current, archived}).
      let current: WorkerThread[] = [];
      let archived: WorkerThread[][] = [];
      if (Array.isArray(saved)) {
        current = saved;
      } else if (saved && typeof saved === 'object') {
        if (Array.isArray(saved.current)) current = saved.current;
        if (Array.isArray(saved.archived)) {
          archived = saved.archived.every((entry) => Array.isArray(entry))
            ? (saved.archived as WorkerThread[][]).filter((round) => round.length > 0)
            : (saved.archived.length > 0 ? [saved.archived as WorkerThread[]] : []);
        }
      }
      if (current.length === 0 && archived.length === 0) return;
      frozenWorkerThreadsRef.current = current;
      setArchivedWorkerRounds(archived);
      archivedWorkerRoundsRef.current = archived;
      // Re-fetch event streams to populate message history — also triggers a re-render
      // so resolvedWorkerThreads picks up the restored frozenWorkerThreadsRef.
      void window.agentDesktop.getWorkerResults({ sessionId: activeSessionId })
        .then((res) => {
          if (activeSessionIdRef.current !== activeSessionId) return;
          setWorkerSubagentResults(res?.results ?? {});
        });
    } catch {}
  }, [activeSessionId, activeDetail?.workerSummariesJson]);

  React.useEffect(() => {
    if (!activeDetail?.workspace || !activeSessionId) {
      setDirectoryCache(new Map());
      return;
    }
    void ensureRootDirectory(activeSessionId, activeDetail.workspace);
  }, [activeDetail?.workspace, activeSessionId, ensureRootDirectory]);

  const refreshWorkspaceSnapshot = React.useCallback(async () => {
    const sessionId = activeSessionIdRef.current;
    const detail = activeDetailRef.current;
    if (!sessionId || !detail?.workspace) return;

    const validExpandedDirs = Array.from(expandedDirsRef.current).filter((p) =>
      p.startsWith(detail.workspace)
    );
    const pathsToRefresh = [detail.workspace, ...validExpandedDirs];
    const refreshedEntries = await Promise.all(
      pathsToRefresh.map(async (dirPath) => {
        try {
          const data = await window.agentDesktop.listWorkspaceDir({
            sessionId,
            dirPath,
          });
          return [dirPath, data] as const;
        } catch {
          return [dirPath, null] as const;
        }
      })
    );

    setDirectoryCache(() => {
      const next = new Map<string, any>();
      for (const [dirPath, data] of refreshedEntries) {
        if (data) next.set(dirPath, data);
      }
      return next;
    });

    if (previewTabsRef.current.length === 0) return;

    const refreshedTabs = await Promise.all(
      previewTabsRef.current.map(async (tab) => {
        const metadata = getPreviewTabMetadata(tab);
        if (metadata.dirty) {
          return tab;
        }
        try {
          const refreshed = await window.agentDesktop.readWorkspaceFile({
            sessionId,
            filePath: tab.path,
          });
          return enrichWorkspacePreviewFile(refreshed, sessionId, detail.workspace, tab);
        } catch {
          return null;
        }
      })
    );

    const nextTabs = refreshedTabs.filter(Boolean) as PreviewTabData[];
    setPreviewTabs(nextTabs);
    setSelectedFilePath((prev) => (prev && nextTabs.some((tab) => tab.path === prev) ? prev : null));
    setActivePreviewPath((prev) => {
      if (prev && nextTabs.some((tab) => tab.path === prev)) return prev;
      return nextTabs[0]?.path || null;
    });
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const status = await window.agentDesktop.getStatus();
        const nextSettings = await window.agentDesktop.getSettings();
        if (!status.cliReady) {
          setBootError('缺少 cli-node.js。先在仓库根目录执行 bun run build:node。');
        }
        applyDesktopSettings(nextSettings);
        await refreshApps();
        await refreshSummaries();
        await refreshAssistants(nextSettings.agentMode ?? 'local');
        if (cancelled) return;
        setActiveSessionId(null);
        setActiveDetail(null);
      } catch (error: any) {
        if (!cancelled) {
          setBootError(error?.message || String(error));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applyDesktopSettings, openSession, refreshApps, refreshSummaries, refreshAssistants]);

  React.useEffect(() => {

    const offEvent = window.agentDesktop.onEvent((payload) => {
      if (payload.sessionId !== activeSessionIdRef.current) return;
      setActiveDetail((prev) => {
        if (!prev) return prev;
        return { ...prev, history: [...prev.history, payload.payload] };
      });
    });

    const offState = window.agentDesktop.onState((payload) => {
      if (payload?.summary) {
        setSummaries((prev) => upsertSummary(prev, payload.summary));
        if (payload.summary.id === activeSessionIdRef.current) {
          setActiveDetail((prev) => (prev ? { ...prev, ...payload.summary } : prev));
        }
      }
    });

    const offPermission = window.agentDesktop.onPermission((payload) => {
      if (payload?.sessionId !== activeSessionIdRef.current) return;
      const toolName = payload?.request?.tool_name || 'Tool';
      setPermissionNotice(`${toolName} 正在请求权限确认`);
      window.setTimeout(() => {
        setPermissionNotice((current) =>
          current === `${toolName} 正在请求权限确认` ? '' : current
        );
      }, 4000);
    });

    const offMeta = window.agentDesktop.onSessionMeta((summary) => {
      setSummaries((prev) => upsertSummary(prev, summary));
      if (summary.id === activeSessionIdRef.current) {
        setActiveDetail((prev) => (prev ? { ...prev, ...summary } : prev));
      }
    });

    const offRemoved = window.agentDesktop.onSessionRemoved(({ sessionId }) => {
      setSummaries((prev) => prev.filter((entry) => entry.id !== sessionId));
      if (sessionId === activeSessionIdRef.current) {
        navigateToHome();
      }
    });

    const offAppsChanged = window.agentDesktop.onAppsChanged((payload) => {
      const changedName = payload?.app?.name;
      if (changedName && selectedAssistant?.name === 'app-builder-assistant') {
        setSelectedAppName(changedName);
        void loadAppVersions(changedName);
      }
      void refreshApps();
    });

    const offWorkspaceChanged = window.agentDesktop.onWorkspaceChanged((payload) => {
      if (payload?.sessionId !== activeSessionIdRef.current) return;
      if (workspaceRefreshTimerRef.current) {
        window.clearTimeout(workspaceRefreshTimerRef.current);
      }
      workspaceRefreshTimerRef.current = window.setTimeout(() => {
        workspaceRefreshTimerRef.current = null;
        void refreshWorkspaceSnapshot();
      }, 120);
    });

    const offSettingsChanged = window.agentDesktop.onSettingsChanged((payload) => {
      applyDesktopSettings(payload);
    });

    // Listen for teammate spawn events to auto-create execution windows
    const offTeammateSpawned = window.agentDesktop.onTeammateSpawned(async (payload) => {
      const { sessionId, taskId, description, prompt } = payload;
      if (sessionId !== activeSessionIdRef.current) return;
      // Create execution window for this teammate
      try {
        await window.agentDesktop.createExecutionForTeammate({
          sessionId,
          taskId,
          description,
          prompt,
        });
        // Refresh executions list
        const executions = await window.agentDesktop.listExecutions(sessionId);
        if (executions?.executions) {
          setExecutions(executions.executions);
        }
      } catch (err) {
        void window.agentDesktop.logWrite({
          level: 'error',
          category: 'renderer',
          message: 'Failed to create execution window for teammate',
          data: {
            sessionId,
            taskId,
            description,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    });

    // Listen for teammate completion events
    const offTeammateCompleted = window.agentDesktop.onTeammateCompleted(async (payload) => {
      const { sessionId, taskId, description, status } = payload;
      if (sessionId !== activeSessionIdRef.current) return;

      // Update the execution window state via IPC
      try {
        await window.agentDesktop.updateTeammateState({ taskId, sessionId, completed: true });
      } catch (err) {
        void window.agentDesktop.logWrite({
          level: 'error',
          category: 'renderer',
          message: 'Failed to update teammate state',
          data: {
            sessionId,
            taskId,
            description,
            status,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }

      // Refresh executions list
      const executions = await window.agentDesktop.listExecutions(sessionId);
      if (executions?.executions) {
        setExecutions(executions.executions);
      }
    });

    return () => {
      if (workspaceRefreshTimerRef.current) {
        window.clearTimeout(workspaceRefreshTimerRef.current);
        workspaceRefreshTimerRef.current = null;
      }
      offEvent();
      offState();
      offPermission();
      offMeta();
      offRemoved();
      offAppsChanged();
      offWorkspaceChanged();
      offSettingsChanged();
      offTeammateSpawned();
      offTeammateCompleted();
    };
  }, [applyDesktopSettings, loadAppVersions, navigateToHome, refreshApps, refreshWorkspaceSnapshot, selectedAssistant]);

  const sidebarSessions = React.useMemo(
    () => toSidebarSessions(summaries, pinnedIds),
    [summaries, pinnedIds, sessionAgentModes]
  );

  // Worker threads are built directly from coordinatorTasks (authoritative for
  // list + agentId + status) and workerSubagentResults (authoritative for content).
  // The frozen list accumulates all workers ever seen so completed ones remain
  // visible even after the backend removes them from coordinatorTasks.
  const resolvedWorkerThreads = React.useMemo(() => {
    const live = coordinatorTasks.map((task, index) => {
      const stickyStatus = stickyWorkerTaskStatuses[task.id];
      const taskStatus = mapCoordinatorTaskStatus(task.status);
      // isIdle is the SDK-native signal: true means the worker has finished.
      const status: WorkerThreadStatus = stickyStatus
        || (task.isIdle ? (taskStatus === 'failed' ? 'failed' : 'completed') : taskStatus)
        || 'queued';
      // agentId (e.g. "alice@team1") is the key used in .jsonl filenames;
      // task.id is the internal taskId which differs from the file-based agentId.
      const resultKey = task.agentId || task.id;
      const subagentResult = workerSubagentResults[resultKey];
      const resultText = subagentResult?.resultText || undefined;
      const summary = resultText || undefined;
      const messages = subagentResult?.events?.length
        ? buildWorkerRenderMessagesFromSubagentEvents(subagentResult.events)
        : [];
      return {
        id: task.id,
        title: task.description || task.name || `Worker ${index + 1}`,
        prompt: '',
        status,
        agentId: task.agentId || task.id,
        description: task.description,
        summary,
        resultText,
        messages,
      };
    });

    const frozen = frozenWorkerThreadsRef.current;
    if (live.length === 0 && frozen.length === 0) return [];

    // Detect a genuinely new coordinator run vs incremental task spawning within
    // the same run.
    //
    // Workers are spawned one by one: the first poll may show [A], the next [A,B],
    // then [A,B,C]. Each arrival has hasNewTasks=true, but the OLD task IDs are
    // still present in live — so this is the same run, not a new one.
    //
    // A truly new run is: new task IDs appeared AND ALL previous frozen IDs have
    // disappeared from live (the SDK cleared the old run's task list).
    const frozenIds = new Set(frozen.map((t) => t.id));
    const liveIds  = new Set(live.map((t) => t.id));
    const hasNewTasks = live.some((t) => !frozenIds.has(t.id));
    const allOldGone  = frozen.every((t) => !liveIds.has(t.id));
    if (hasNewTasks && frozen.length > 0 && allOldGone) {
      // New run started — archive the previous run's workers, then reset frozen.
      // Can't call setState here (inside memo), so signal via ref; the effect below
      // will pick this up and update archivedWorkerRounds state.
      pendingArchiveRef.current = frozen;
      frozenWorkerThreadsRef.current = live;
      return live;
    }

    // Merge: preserve original ordering from frozen, update with live data where
    // available, and append any brand-new workers not yet in frozen.
    const liveById = new Map(live.map((t) => [t.id, t]));
    const merged = [
      ...frozen.map((t) => {
        const liveVersion = liveById.get(t.id);
        if (liveVersion) return liveVersion;
        // Task no longer in live (completed and removed by backend). Re-apply the
        // latest sticky status and worker results so the panel shows correct state.
        const stickyStatus = stickyWorkerTaskStatuses[t.id];
        const resultKey = t.agentId || t.id;
        const subagentResult = workerSubagentResults[resultKey];
        const resultText = subagentResult?.resultText || t.resultText;
        const messages = subagentResult?.events?.length
          ? buildWorkerRenderMessagesFromSubagentEvents(subagentResult.events)
          : t.messages;
        return {
          ...t,
          status: (stickyStatus || t.status) as WorkerThreadStatus,
          resultText,
          summary: resultText || t.summary,
          messages,
        };
      }),
      ...live.filter((t) => !frozenIds.has(t.id)),
    ];

    frozenWorkerThreadsRef.current = merged;
    return merged;
  }, [coordinatorTasks, stickyWorkerTaskStatuses, workerSubagentResults]);

  React.useEffect(() => {
    if (!activeSessionId) return;

    const currentTaskIds = new Set(coordinatorTasks.map((t) => t.id));

    // Two complementary signals for task completion:
    // 1. task.isIdle === true  — SDK-native: task finished but still in the list
    // 2. task disappeared from list — SDK sometimes removes tasks without status update
    const prevIds = prevCoordinatorTaskIdsRef.current;
    const disappearedIds = [...prevIds].filter(
      (id) => !currentTaskIds.has(id) && !refreshedTerminalWorkerIdsRef.current.has(id),
    );
    prevCoordinatorTaskIdsRef.current = currentTaskIds;

    const nextSticky: Record<string, 'completed' | 'failed'> = {};
    for (const task of coordinatorTasks) {
      const taskStatus = mapCoordinatorTaskStatus(task.status);
      // isIdle is the SDK-native signal that a worker finished (primary source)
      if (task.isIdle || taskStatus === 'completed' || taskStatus === 'failed') {
        nextSticky[task.id] = taskStatus === 'failed' ? 'failed' : 'completed';
      }
    }
    // Disappeared tasks: treat as completed (SDK sometimes removes without status)
    for (const id of disappearedIds) {
      nextSticky[id] = 'completed';
    }

    const newTerminalTaskIds = Object.keys(nextSticky).filter(
      (taskId) => !refreshedTerminalWorkerIdsRef.current.has(taskId),
    );

    if (Object.keys(nextSticky).length > 0) {
      setStickyWorkerTaskStatuses((prev) => {
        let changed = false;
        const merged = { ...prev };
        for (const [taskId, status] of Object.entries(nextSticky)) {
          if (merged[taskId] !== status) {
            merged[taskId] = status;
            changed = true;
          }
        }
        return changed ? merged : prev;
      });
    }

    if (newTerminalTaskIds.length === 0) return;

    newTerminalTaskIds.forEach((taskId) => {
      refreshedTerminalWorkerIdsRef.current.add(taskId);
    });

    void (async () => {
      try {
        const workerResultsRes = await window.agentDesktop.getWorkerResults({ sessionId: activeSessionId });
        if (activeSessionIdRef.current !== activeSessionId) return;
        if (workerResultsRes?.results) {
          setWorkerSubagentResults((prev) => ({ ...prev, ...workerResultsRes.results }));
        }
      } catch {
        // ignore refresh failures; polling will retry on the next change
      }
    })();
  }, [activeSessionId, coordinatorTasks]);

  // chatMessages is built exclusively from session history.
  // The coordinator agent produces its own formatted summary in the history;
  // the UI must not generate its own summary on top of it.
  // Worker status is shown in WorkerThreadPanel, not injected into chatMessages.
  const chatMessages = React.useMemo(
    () => buildMainChatRenderMessagesFromHistory(activeDetail?.history || []),
    [activeDetail?.history],
  );

  React.useEffect(() => {
    if (resolvedWorkerThreads.length === 0) {
      setActiveWorkerThreadId(null);
      return;
    }
    setActiveWorkerThreadId((current) => (
      current && resolvedWorkerThreads.some((thread) => thread.id === current)
        ? current
        : null
    ));
  }, [resolvedWorkerThreads]);

  const workspaceTree = React.useMemo(() => {
    if (!activeDetail?.workspace) return [];
    const root = directoryCache.get(activeDetail.workspace);
    if (!root?.items) return [];
    return filterVisibleNodes(root.items, workspaceQuery, directoryCache, expandedDirs);
  }, [activeDetail?.workspace, directoryCache, expandedDirs, workspaceQuery]);

  const activePreview = React.useMemo(
    () => previewTabs.find((entry) => entry.path === activePreviewPath) || null,
    [previewTabs, activePreviewPath]
  );
  const previewDrawerVisible = Boolean(
    activeView === 'chat' && activeSessionId && previewTabs.length > 0 && activePreview !== null
  );

  const restoreWorkspacePanelAfterPreview = React.useCallback(() => {
    if (!activeSessionId) return;
    if (!previewAutoCollapsedRightRef.current) return;
    if (previewAutoCollapsedBySessionRef.current !== activeSessionId) return;
    previewAutoCollapsedRightRef.current = false;
    previewAutoCollapsedBySessionRef.current = null;
    setLayout((prev) => (prev.rightCollapsed ? { ...prev, rightCollapsed: false } : prev));
  }, [activeSessionId]);

  const openPreviewDrawer = React.useCallback((file: WorkspacePreviewData) => {
    setSelectedFilePath(file.path);
    setPreviewTabs((prev) => {
      const existing = prev.find((entry) => entry.path === file.path);
      const nextFile = enrichWorkspacePreviewFile(file, activeSessionId, activeDetail?.workspace, existing);
      if (existing) {
        return prev.map((entry) => (entry.path === file.path ? nextFile : entry));
      }
      return [...prev, nextFile];
    });
    setActivePreviewPath(file.path);
    setActiveView('chat');
    setLayout((prev) => {
      if (prev.rightCollapsed) return prev;
      previewAutoCollapsedRightRef.current = true;
      previewAutoCollapsedBySessionRef.current = activeSessionId;
      return { ...prev, rightCollapsed: true };
    });
  }, [activeDetail?.workspace, activeSessionId]);

  const handleClosePreviewTab = React.useCallback((path: string) => {
    setPreviewTabs((prev) => {
      const next = prev.filter((entry) => entry.path !== path);
      const nextActivePath = next[0]?.path || null;
      setActivePreviewPath((current) => {
        if (current !== path) return current;
        return nextActivePath;
      });
      setSelectedFilePath((current) => (current === path ? nextActivePath : current));
      if (next.length === 0) {
        restoreWorkspacePanelAfterPreview();
      }
      return next;
    });
  }, [restoreWorkspacePanelAfterPreview]);

  const handleClosePreviewDrawer = React.useCallback(() => {
    setPreviewTabs([]);
    setActivePreviewPath(null);
    setSelectedFilePath(null);
    restoreWorkspacePanelAfterPreview();
  }, [restoreWorkspacePanelAfterPreview]);

  const handleUpdatePreviewTab = React.useCallback((path: string, patch: Partial<WorkspacePreviewData>) => {
    setPreviewTabs((prev) => prev.map((entry) => (entry.path === path ? { ...entry, ...patch } : entry)));
  }, []);

  const handleCloseOtherPreviewTabs = React.useCallback((path: string) => {
    setPreviewTabs((prev) => {
      const active = prev.find((entry) => entry.path === path) || null;
      const next = active ? [active] : [];
      setActivePreviewPath(active?.path || null);
      setSelectedFilePath(active?.path || null);
      if (next.length === 0) restoreWorkspacePanelAfterPreview();
      return next;
    });
  }, [restoreWorkspacePanelAfterPreview]);

  const handleCloseAllPreviewTabs = React.useCallback(() => {
    handleClosePreviewDrawer();
  }, [handleClosePreviewDrawer]);

  React.useEffect(() => {
    if (previewTabs.length === 0) {
      setActivePreviewPath(null);
      restoreWorkspacePanelAfterPreview();
    }
  }, [previewTabs.length, restoreWorkspacePanelAfterPreview]);

  React.useEffect(() => {
    const unsubscribe = previewIpc.onOpen((payload) => {
      const path = `preview:${payload.contentType}:${payload.metadata?.title || payload.content.slice(0, 48)}`;
      openPreviewDrawer({
        path,
        relativePath: String(payload.metadata?.title || payload.metadata?.fileName || path),
        content: payload.content,
        contentType: payload.contentType,
        language: String(payload.metadata?.language || ''),
        mimeType: undefined,
        metadata: payload.metadata,
        size: typeof payload.content === 'string' ? payload.content.length : 0,
        truncated: false,
      });
    });
    return unsubscribe;
  }, [openPreviewDrawer]);

  const toggleSidebar = React.useCallback((side: 'left' | 'right') => {
    setLayout((prev) => (
      side === 'left'
        ? { ...prev, leftCollapsed: !prev.leftCollapsed }
        : { ...prev, rightCollapsed: !prev.rightCollapsed }
    ));
  }, []);

  const startResize = React.useCallback((side: 'left' | 'preview' | 'right', clientX: number) => {
    const start = layoutRef.current;
    if (side === 'left' && start.leftCollapsed) return;
    if (side === 'right' && start.rightCollapsed) return;

    document.body.classList.add('layout-resizing');

    const onMouseMove = (event: MouseEvent) => {
      const delta = event.clientX - clientX;
      setLayout((prev) => (
        side === 'left'
          ? {
              ...prev,
              leftWidth: clamp(start.leftWidth + delta, LEFT_WIDTH_RANGE.min, LEFT_WIDTH_RANGE.max),
            }
          : side === 'right'
            ? {
              ...prev,
              rightWidth: clamp(start.rightWidth - delta, RIGHT_WIDTH_RANGE.min, RIGHT_WIDTH_RANGE.max),
            }
            : {
              ...prev,
              previewWidth: clamp(start.previewWidth - delta, PREVIEW_WIDTH_RANGE.min, PREVIEW_WIDTH_RANGE.max),
            }
      ));
    };

    const onMouseUp = () => {
      document.body.classList.remove('layout-resizing');
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, []);

  const handleNewSession = React.useCallback(async () => {
    navigateToHome({ resetInput: true, resetApp: true });
  }, [navigateToHome]);

  const handleSelectSession = React.useCallback(async (sessionId: string) => {
    const opened = await openSession(sessionId);
    if (!opened) return;
    setActiveView('chat');
  }, [openSession]);

  const handleDeleteSession = React.useCallback(async (sessionId: string) => {
    await window.agentDesktop.deleteSession({ sessionId });
    if (activeSessionId === sessionId) {
      navigateToHome({ forceDiscardDirty: true });
    }
    // Remove from sessionAgentModes map
    const nextModes = new Map(sessionAgentModes);
    nextModes.delete(sessionId);
    persistSessionAgentModes(nextModes);
    await refreshSummaries();
  }, [activeSessionId, navigateToHome, refreshSummaries, sessionAgentModes, persistSessionAgentModes]);

  const handleRenameSession = React.useCallback(async (sessionId: string, newTitle: string) => {
    if (!newTitle.trim()) return;
    try {
      await window.agentDesktop.updateSession({ sessionId, title: newTitle });
    } catch (e) {
      void window.agentDesktop.logWrite({
        level: 'error',
        category: 'renderer',
        message: 'Rename session failed',
        data: {
          sessionId,
          title: newTitle,
          error: e instanceof Error ? e.message : String(e),
        },
      });
    }
    setSummaries((prev) => prev.map((entry) =>
      entry.id === sessionId ? { ...entry, title: newTitle } : entry
    ));
    if (activeSessionId === sessionId) {
      setActiveDetail((prev) => (prev ? { ...prev, title: newTitle } : prev));
    }
  }, [activeSessionId]);

  const handleTogglePin = React.useCallback((sessionId: string) => {
    const next = new Set(pinnedIds);
    if (next.has(sessionId)) next.delete(sessionId);
    else next.add(sessionId);
    persistPinned(next);
  }, [persistPinned, pinnedIds]);

  const submitPrompt = React.useCallback(async (intent: ComposerIntent, files?: Array<{ name: string; path: string }>, workspace?: string) => {
    const hasText = input.trim().length > 0;
    const hasFiles = files && files.length > 0;
    if (!hasText && !hasFiles) return;
    if (activeDetail?.busy || planDecisionBusy) return;

    const prompt = input.trim();
    setInput('');

    let sessionId = activeSessionId;
    let sessionJustCreated = false;
    if (!sessionId) {
      sessionId = await createAndOpenSession(undefined, workspace, selectedAssistant?.name);
      sessionJustCreated = true;
    }
    if (!sessionId) return;

    // If we just created a new session and have files, copy them to the new workspace
    let filesToSend = files;
    if (sessionJustCreated && hasFiles) {
      const newFiles: Array<{ name: string; path: string }> = [];
      for (const file of files!) {
        const result = await window.agentDesktop.copyFileToWorkspace({
          sessionId,
          sourcePath: file.path,
          fileName: file.name,
        }) as { path: string } | { error: string };
        if ('path' in result) {
          newFiles.push({ name: file.name, path: result.path });
        }
      }
      filesToSend = newFiles;
    }

    // Reset auxiliary tracking state before sending. frozenWorkerThreadsRef is
    // intentionally NOT cleared here so multi-turn coordinators keep their
    // worker panel visible during follow-up turns. The resolvedWorkerThreads
    // memo resets frozen automatically when genuinely new task IDs appear.
    refreshedTerminalWorkerIdsRef.current = new Set();
    prevCoordinatorTaskIdsRef.current = new Set();
    setStickyWorkerTaskStatuses({});
    setWorkerSubagentResults({});

    await window.agentDesktop.send({
      sessionId,
      prompt,
      mode: intent === 'chat' ? undefined : intent,
      appName: selectedAssistant?.name === 'app-builder-assistant' ? selectedAppName : undefined,
      files: filesToSend?.map(f => f.path),
      coordinatorMode: intent === 'coordinator' ? true : undefined,
      assistantName: selectedAssistant?.name,
    });
  }, [activeDetail?.busy, activeSessionId, createAndOpenSession, input, planDecisionBusy, selectedAppName, selectedAssistant]);

  const handleSend = React.useCallback(async (files?: Array<{ name: string; path: string }>, workspace?: string) => {
    await submitPrompt(composerIntent, files, workspace);
  }, [composerIntent, submitPrompt]);

  const handleApprovePlan = React.useCallback(async () => {
    if (!activeSessionId) return;
    setPlanDecisionBusy(true);
    try {
      await window.agentDesktop.approvePlan({ sessionId: activeSessionId });
      const detail = await window.agentDesktop.getSession({ sessionId: activeSessionId });
      setActiveDetail(detail);
      setSummaries((prev) => upsertSummary(prev, detail));
    } finally {
      setPlanDecisionBusy(false);
    }
  }, [activeSessionId]);

  const handleRejectPlan = React.useCallback(async () => {
    if (!activeSessionId) return;
    setPlanDecisionBusy(true);
    try {
      const detail = await window.agentDesktop.rejectPlan({ sessionId: activeSessionId });
      const nextDetail = await window.agentDesktop.getSession({ sessionId: activeSessionId });
      setActiveDetail(nextDetail);
      setSummaries((prev) => upsertSummary(prev, detail?.summary || nextDetail));
    } finally {
      setPlanDecisionBusy(false);
    }
  }, [activeSessionId]);

  const handleStop = React.useCallback(async () => {
    if (!activeSessionId) return;
    await window.agentDesktop.abort({ sessionId: activeSessionId });
  }, [activeSessionId]);

  const handlePickWorkspace = React.useCallback(async () => {
    if (!activeSessionId) return;
    if (!confirmDiscardDirtyPreviewTabs('当前存在未保存的预览修改，确认切换工作区？')) {
      return;
    }
    const dir = await window.agentDesktop.pickDirectory();
    if (!dir) return;
    const detail = await window.agentDesktop.setSessionWorkspace({ sessionId: activeSessionId, workspace: dir });
    setActiveDetail(detail);
    setSummaries((prev) => prev.map((entry) => (entry.id === detail.id ? detail : entry)));
    setDirectoryCache(new Map());
    setExpandedDirs(new Set());
    setSelectedFilePath(null);
    setPreviewTabs([]);
    setActivePreviewPath(null);
  }, [activeSessionId, confirmDiscardDirtyPreviewTabs]);

  const handleRefreshWorkspace = React.useCallback(async () => {
    await refreshWorkspaceSnapshot();
  }, [refreshWorkspaceSnapshot]);

  const handleOpenWorkspace = React.useCallback(async () => {
    if (!activeSessionId) return;
    await window.agentDesktop.openWorkspace({ sessionId: activeSessionId });
  }, [activeSessionId]);

  const handleToggleFolder = React.useCallback(async (path: string) => {
    const next = new Set(expandedDirs);
    if (next.has(path)) {
      next.delete(path);
      setExpandedDirs(next);
      return;
    }
    next.add(path);
    setExpandedDirs(next);
    const data = await window.agentDesktop.listWorkspaceDir({
      sessionId: activeSessionId,
      dirPath: path,
    });
    setDirectoryCache((prev) => new Map(prev).set(path, data));
  }, [activeSessionId, expandedDirs]);

  const handleSelectFile = React.useCallback(async (path: string) => {
    if (!activeSessionId) return;
    const existing = previewTabsRef.current.find((entry) => entry.path === path);
    if (existing) {
      openPreviewDrawer(existing);
      return;
    }
    const data = await window.agentDesktop.readWorkspaceFile({
      sessionId: activeSessionId,
      filePath: path,
    });
    openPreviewDrawer(data);
  }, [activeSessionId, openPreviewDrawer]);

  const handleLaunchApp = React.useCallback(async (name: string) => {
    await window.agentDesktop.launchApp({ name });
  }, []);

  const handleSelectAssistant = React.useCallback((assistant: InstalledAssistant) => {
    setSelectedAssistant(assistant);
  }, []);

  const handleClearAssistant = React.useCallback(() => {
    setSelectedAssistant(null);
  }, []);

  const handleIterateExistingApp = React.useCallback(async (name: string) => {
    const appBuilderAssistant = installedAssistants.find(a => a.name === 'app-builder-assistant');
    if (appBuilderAssistant) {
      setSelectedAssistant(appBuilderAssistant);
    }

    const ok = navigateToHome({ preserveIntent: true });
    if (!ok) return;
    await createAndOpenSession(`迭代 ${name}`, undefined, appBuilderAssistant?.name);

    setSelectedAppName(name);
    setComposerIntent('chat');
    setActiveView('chat');
  }, [navigateToHome, createAndOpenSession, installedAssistants]);

  const handleDeleteApp = React.useCallback(async (name: string) => {
    await window.agentDesktop.deleteApp({ name });
    setVersionsByApp((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    await refreshApps();
  }, [refreshApps]);

  const handleRollbackApp = React.useCallback(async (name: string, versionId: string) => {
    const result = await window.agentDesktop.rollbackApp({ name, versionId });
    if (result?.app?.name) {
      setSelectedAppName(result.app.name);
    }
    await refreshApps();
    await loadAppVersions(name);
  }, [loadAppVersions, refreshApps]);

  const autoSaveSettings = React.useCallback(async (key: keyof DesktopSettings, value: any) => {
    try {
      const payload = { [key]: value };
      const saved = await window.agentDesktop.updateSettings(payload);
      applyDesktopSettings(saved);
    } catch (error: any) {
      setSettingsNotice(error?.message || String(error));
    }
  }, [applyDesktopSettings]);

  const autoSaveImageSettings = React.useCallback(async (image: DesktopSettings['image']) => {
    try {
      const saved = await window.agentDesktop.updateSettings({ image });
      applyDesktopSettings(saved);
    } catch (error: any) {
      setSettingsNotice(error?.message || String(error));
    }
  }, [applyDesktopSettings]);

  const handleNewSessionModeChange = React.useCallback(async (mode: 'local' | 'remote-direct') => {
    await autoSaveSettings('agentMode', mode);
    // Refresh assistants list based on new mode
    await refreshAssistants(mode);
  }, [autoSaveSettings, refreshAssistants]);

  const renderSettingsView = () => (
    <SettingsView
      settingsDraft={settingsDraft}
      setSettingsDraft={setSettingsDraft}
      settingsNotice={settingsNotice}
      autoSaveSettings={autoSaveSettings}
      autoSaveImageSettings={autoSaveImageSettings}
      themeMode={themeMode}
      setThemeMode={setThemeMode}
      cssThemeId={cssThemeId}
      setCssThemeId={setCssThemeId}
      buddyEnabled={isBuddyEnabled()}
      onBuddyEnabledChange={(enabled) => {
        setBuddyEnabled(enabled);
        setForceBuddyUpdate((n) => n + 1);
      }}
    />
  );

  return (
    <div className={`${themeMode === 'dark' ? 'dark' : ''} flex h-screen w-full flex-col overflow-hidden app-shell`}>
      <div className="moss-window-chrome shrink-0">
        <div
          className="moss-window-drag h-9"
          style={{ paddingLeft: isMacOS ? 84 : 0 }}
        />
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className="min-h-0 shrink-0 overflow-hidden"
          style={{ width: layout.leftCollapsed ? 68 : layout.leftWidth }}
        >
          <AppSidebar
            sessions={sidebarSessions}
            activeSessionId={activeSessionId}
            activeView={activeView}
            appsCount={apps.length}
            themeMode={themeMode}
            collapsed={layout.leftCollapsed}
            searchQuery={sessionSearchQuery}
            localEnabled={desktopSettings?.localEnabled ?? true}
            remoteEnabled={desktopSettings?.remoteEnabled ?? false}
            newSessionMode={desktopSettings?.agentMode === 'remote-direct' ? 'remote-direct' : 'local'}
            onChangeView={setActiveView}
            onChangeTheme={setThemeMode}
            onSelectSession={handleSelectSession}
            onNewSession={handleNewSession}
            onNewSessionModeChange={handleNewSessionModeChange}
            onDeleteSession={handleDeleteSession}
            onRenameSession={handleRenameSession}
            onTogglePin={handleTogglePin}
            onToggleCollapse={() => toggleSidebar('left')}
            onSearchChange={setSessionSearchQuery}
          />
        </div>

        <div
          className={`
            relative hidden w-3 shrink-0 cursor-col-resize bg-transparent transition-colors
            before:absolute before:inset-y-4 before:left-1/2 before:w-px before:-translate-x-1/2 before:rounded-full before:bg-border/80
            hover:before:bg-primary/60 lg:block
          `}
          onMouseDown={(event) => {
            event.preventDefault();
            startResize('left', event.clientX);
          }}
        />

        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          {(bootError || permissionNotice) && (
            <div className="pointer-events-none absolute right-4 top-4 z-20 max-w-md rounded-2xl border border-border/80 bg-card/92 px-3 py-2 text-xs text-muted-foreground shadow-[0_18px_48px_-36px_rgba(0,0,0,0.6)] backdrop-blur">
              {bootError || permissionNotice}
            </div>
          )}
          {activeView === 'chat' ? (
            activeSessionId ? (
              <ChatArea
                messages={chatMessages}
                value={input}
                selectedAppName={selectedAppName}
                loading={Boolean(activeDetail?.busy)}
                readOnlyReason={activeDetail?.resumeReadOnlyReason || null}
                hasActiveSession={Boolean(activeSessionId)}
                sessionTitle={activeDetail?.title || 'New Session'}
                sessionMessageCount={activeDetail?.messageCount || 0}
                sessionId={activeSessionId || undefined}
                sessionWorkspace={activeDetail?.workspace || undefined}
                pendingPlanApproval={activeDetail?.pendingPlanApproval || null}
                planDecisionBusy={planDecisionBusy}
                leftCollapsed={layout.leftCollapsed}
                rightCollapsed={layout.rightCollapsed}
                composerIntent={composerIntent}
                workerThreads={resolvedWorkerThreads}
                archivedWorkerRounds={archivedWorkerRounds}
                activeWorkerThreadId={activeWorkerThreadId}
                onChange={setInput}
                onComposerIntentChange={setComposerIntent}
                onToggleLeftSidebar={() => toggleSidebar('left')}
                onToggleRightSidebar={() => toggleSidebar('right')}
                onApprovePlan={handleApprovePlan}
                onRejectPlan={handleRejectPlan}
                onSend={handleSend}
                onStop={handleStop}
                onToggleWorkerThread={setActiveWorkerThreadId}
                installedAssistants={installedAssistants}
                selectedAssistant={selectedAssistant}
                onSelectAssistant={handleSelectAssistant}
                onClearAssistant={handleClearAssistant}
                remoteEnabled={desktopSettings?.remoteEnabled ?? false}
                newSessionMode={desktopSettings?.agentMode === 'remote-direct' ? 'remote-direct' : 'local'}
                onNewSessionModeChange={handleNewSessionModeChange}
              />
            ) : (
              <ChatArea
                messages={[]}
                value={input}
                selectedAppName={selectedAppName}
                loading={false}
                hasActiveSession={false}
                sessionTitle=""
                sessionMessageCount={0}
                sessionWorkspace={undefined}
                pendingPlanApproval={null}
                planDecisionBusy={false}
                leftCollapsed={layout.leftCollapsed}
                rightCollapsed={layout.rightCollapsed}
                composerIntent={composerIntent}
                workerThreads={[]}
                archivedWorkerRounds={[]}
                activeWorkerThreadId={null}
                onChange={setInput}
                onComposerIntentChange={setComposerIntent}
                onToggleLeftSidebar={() => toggleSidebar('left')}
                onToggleRightSidebar={() => toggleSidebar('right')}
                onApprovePlan={handleApprovePlan}
                onRejectPlan={handleRejectPlan}
                onSend={handleSend}
                onStop={handleStop}
                onToggleWorkerThread={setActiveWorkerThreadId}
                installedAssistants={installedAssistants}
                selectedAssistant={selectedAssistant}
                onSelectAssistant={handleSelectAssistant}
                onClearAssistant={handleClearAssistant}
                remoteEnabled={desktopSettings?.remoteEnabled ?? false}
                newSessionMode={desktopSettings?.agentMode === 'remote-direct' ? 'remote-direct' : 'local'}
                onNewSessionModeChange={handleNewSessionModeChange}
              />
            )
          ) : activeView === 'apps' ? (
            <AppsPanel
              apps={apps}
              versionsByApp={versionsByApp}
              onLaunch={handleLaunchApp}
              onDelete={handleDeleteApp}
              onIterate={handleIterateExistingApp}
              onLoadVersions={loadAppVersions}
              onRollback={handleRollbackApp}
            />
          ) : (
            renderSettingsView()
          )}
        </div>

        {previewDrawerVisible && (
          <>
            <div
              className={`
                relative hidden w-3 shrink-0 cursor-col-resize bg-transparent transition-colors
                before:absolute before:inset-y-4 before:left-1/2 before:w-px before:-translate-x-1/2 before:rounded-full before:bg-border/80
                hover:before:bg-primary/60 lg:block
              `}
              onMouseDown={(event) => {
                event.preventDefault();
                startResize('preview', event.clientX);
              }}
            />

            <div
              className="min-h-0 shrink-0 overflow-hidden border-l border-border/70"
              style={{ width: layout.previewWidth }}
            >
              <PreviewDrawer
                visible={previewDrawerVisible}
                tabs={previewTabs}
                activePath={activePreviewPath}
                onActivate={setActivePreviewPath}
                onUpdateTab={handleUpdatePreviewTab}
                onCloseTab={handleClosePreviewTab}
                onCloseOthers={handleCloseOtherPreviewTabs}
                onCloseAll={handleCloseAllPreviewTabs}
                onCloseDrawer={handleClosePreviewDrawer}
              />
            </div>
          </>
        )}

        {activeView === 'chat' && activeSessionId && (
          <>
            <div
              className={`
                relative hidden w-3 shrink-0 cursor-col-resize bg-transparent transition-colors
                before:absolute before:inset-y-4 before:left-1/2 before:w-px before:-translate-x-1/2 before:rounded-full before:bg-border/80
                hover:before:bg-primary/60 lg:block
              `}
              onMouseDown={(event) => {
                event.preventDefault();
                startResize('right', event.clientX);
              }}
            />

            <div
              className="min-h-0 shrink-0 overflow-hidden border-l border-border/70"
              style={{ width: layout.rightCollapsed ? 0 : layout.rightWidth }}
            >
              <TaskPanel
                collapsed={layout.rightCollapsed}
                onToggleCollapse={() => toggleSidebar('right')}
                searchQuery={workspaceQuery}
                onSearchChange={setWorkspaceQuery}
                onRefresh={handleRefreshWorkspace}
                onOpenWorkspace={handleOpenWorkspace}
                treeItems={workspaceTree}
                expandedPaths={expandedDirs}
                selectedFilePath={selectedFilePath}
                onToggleFolder={handleToggleFolder}
                onSelectFile={handleSelectFile}
                previewTabs={previewTabs}
                activePreviewPath={activePreviewPath}
                onActivatePreview={setActivePreviewPath}
                previewTitle={activePreview?.relativePath || '未选择文件'}
              />
            </div>
          </>
        )}

        <ExecutionPetPanel
          executions={executions}
          onFocus={(executionId) => {
            void window.agentDesktop.focusExecution(executionId);
          }}
        />
        {isBuddyEnabled() && (
          <BuddyCompanion key={forceBuddyUpdate} />
        )}
        <UpdateModal />
      </div>
    </div>
  );
}
