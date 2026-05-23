import { renderMessages } from './messages.js';
import {
  renderPreviewContent,
  renderPreviewTabs,
  renderWorkspaceHeader,
  renderWorkspaceTree,
  resetWorkspaceView,
  setWorkspaceTab,
} from './workspace.js';

const els = {
  appShell: document.getElementById('appShell'),
  leftSidebar: document.getElementById('leftSidebar'),
  rightSidebar: document.getElementById('rightSidebar'),
  leftResizeHandle: document.getElementById('leftResizeHandle'),
  rightResizeHandle: document.getElementById('rightResizeHandle'),
  toggleLeftSidebarBtn: document.getElementById('toggleLeftSidebarBtn'),
  toggleRightSidebarBtn: document.getElementById('toggleRightSidebarBtn'),
  cliStatusPill: document.getElementById('cliStatusPill'),
  sdkStatusPill: document.getElementById('sdkStatusPill'),
  newSessionBtn: document.getElementById('newSessionBtn'),
  deleteSessionBtn: document.getElementById('deleteSessionBtn'),
  stopBtn: document.getElementById('stopBtn'),
  sendBtn: document.getElementById('sendBtn'),
  pickDirBtn: document.getElementById('pickDirBtn'),
  refreshTreeBtn: document.getElementById('refreshTreeBtn'),
  sessionList: document.getElementById('sessionList'),
  chatTitle: document.getElementById('chatTitle'),
  chatMeta: document.getElementById('chatMeta'),
  messageList: document.getElementById('messageList'),
  promptInput: document.getElementById('promptInput'),
  errorText: document.getElementById('errorText'),
  workspaceTitle: document.getElementById('workspaceTitle'),
  workspaceMeta: document.getElementById('workspaceMeta'),
  workspacePath: document.getElementById('workspacePath'),
  filesTabBtn: document.getElementById('filesTabBtn'),
  previewTabBtn: document.getElementById('previewTabBtn'),
  workspaceSearchInput: document.getElementById('workspaceSearchInput'),
  treePanel: document.getElementById('treePanel'),
  previewPanel: document.getElementById('previewPanel'),
  treeRoot: document.getElementById('treeRoot'),
  previewTabs: document.getElementById('previewTabs'),
  filePreviewTitle: document.getElementById('filePreviewTitle'),
  filePreviewContent: document.getElementById('filePreviewContent'),
};

const LAYOUT_STORAGE_KEY = 'moss:desktop-layout:v1';
const DEFAULT_LAYOUT = {
  leftWidth: 276,
  rightWidth: 336,
  leftCollapsed: false,
  rightCollapsed: false,
};
const LEFT_WIDTH_RANGE = { min: 220, max: 520 };
const RIGHT_WIDTH_RANGE = { min: 260, max: 640 };

const state = {
  sessions: [],
  activeSessionId: null,
  sessionDetail: null,
  selectedFilePath: null,
  openDirectories: new Set(),
  directoryCache: new Map(),
  previewTabs: [],
  activePreviewPath: null,
  activeWorkspaceTab: 'files',
  workspaceQuery: '',
  layout: loadLayoutState(),
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function loadLayoutState() {
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    const parsed = JSON.parse(raw);
    return {
      leftWidth: clamp(Number(parsed.leftWidth) || DEFAULT_LAYOUT.leftWidth, LEFT_WIDTH_RANGE.min, LEFT_WIDTH_RANGE.max),
      rightWidth: clamp(Number(parsed.rightWidth) || DEFAULT_LAYOUT.rightWidth, RIGHT_WIDTH_RANGE.min, RIGHT_WIDTH_RANGE.max),
      leftCollapsed: Boolean(parsed.leftCollapsed),
      rightCollapsed: Boolean(parsed.rightCollapsed),
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

function persistLayoutState() {
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(state.layout));
  } catch {
    // Ignore storage failures and keep the in-memory layout state.
  }
}

function applyLayoutState() {
  els.appShell.style.setProperty('--left-panel-width', `${state.layout.leftWidth}px`);
  els.appShell.style.setProperty('--right-panel-width', `${state.layout.rightWidth}px`);
  els.appShell.classList.toggle('left-collapsed', state.layout.leftCollapsed);
  els.appShell.classList.toggle('right-collapsed', state.layout.rightCollapsed);
  els.leftSidebar.classList.toggle('collapsed', state.layout.leftCollapsed);
  els.rightSidebar.classList.toggle('collapsed', state.layout.rightCollapsed);
  els.leftResizeHandle.classList.toggle('disabled', state.layout.leftCollapsed);
  els.rightResizeHandle.classList.toggle('disabled', state.layout.rightCollapsed);
  els.toggleLeftSidebarBtn.textContent = state.layout.leftCollapsed ? '▸' : '◂';
  els.toggleLeftSidebarBtn.setAttribute('aria-label', state.layout.leftCollapsed ? '展开左侧栏' : '收起左侧栏');
  els.toggleRightSidebarBtn.textContent = state.layout.rightCollapsed ? '◂' : '▸';
  els.toggleRightSidebarBtn.setAttribute('aria-label', state.layout.rightCollapsed ? '展开右侧栏' : '收起右侧栏');
}

function updateLayout(patch, { persist = true } = {}) {
  state.layout = { ...state.layout, ...patch };
  applyLayoutState();
  if (persist) {
    persistLayoutState();
  }
}

function toggleSidebar(side) {
  if (side === 'left') {
    updateLayout({ leftCollapsed: !state.layout.leftCollapsed });
    return;
  }
  updateLayout({ rightCollapsed: !state.layout.rightCollapsed });
}

function startResize(side, event) {
  if (window.matchMedia('(max-width: 1120px)').matches) return;
  if (side === 'left' && state.layout.leftCollapsed) return;
  if (side === 'right' && state.layout.rightCollapsed) return;
  event.preventDefault();

  const startX = event.clientX;
  const startWidth = side === 'left' ? state.layout.leftWidth : state.layout.rightWidth;
  const handle = side === 'left' ? els.leftResizeHandle : els.rightResizeHandle;

  handle.classList.add('active');
  document.body.classList.add('is-resizing');

  const onMouseMove = (moveEvent) => {
    const delta = moveEvent.clientX - startX;
    if (side === 'left') {
      updateLayout({
        leftWidth: clamp(startWidth + delta, LEFT_WIDTH_RANGE.min, LEFT_WIDTH_RANGE.max),
      }, { persist: false });
      return;
    }
    updateLayout({
      rightWidth: clamp(startWidth - delta, RIGHT_WIDTH_RANGE.min, RIGHT_WIDTH_RANGE.max),
    }, { persist: false });
  };

  const onMouseUp = () => {
    handle.classList.remove('active');
    document.body.classList.remove('is-resizing');
    persistLayoutState();
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

function formatTime(timestamp) {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString();
}

function basename(filePath) {
  if (!filePath) return '';
  const normalized = filePath.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || normalized;
}

function setStatusPill(element, ready) {
  element.className = `pill ${ready ? 'ready' : 'missing'}`;
}

function setError(message = '') {
  els.errorText.textContent = message;
}

function upsertSessionSummary(summary) {
  const existingIndex = state.sessions.findIndex((entry) => entry.id === summary.id);
  if (existingIndex === -1) {
    state.sessions.unshift(summary);
  } else {
    state.sessions[existingIndex] = { ...state.sessions[existingIndex], ...summary };
  }
  state.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

function getActiveSummary() {
  return state.sessions.find((entry) => entry.id === state.activeSessionId) || null;
}

function renderSessionList() {
  els.sessionList.innerHTML = '';

  if (state.sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '还没有会话。点击“新建会话”开始。';
    els.sessionList.appendChild(empty);
    return;
  }

  for (const session of state.sessions) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `session-item ${session.id === state.activeSessionId ? 'active' : ''}`;
    item.addEventListener('click', () => {
      void openSession(session.id);
    });

    item.innerHTML = `
      <div class="session-item-top">
        <div class="session-item-title">${escapeHtml(session.title)}</div>
        <div class="session-item-time">${session.busy ? '运行中' : formatShortTime(session.updatedAt)}</div>
      </div>
      <div class="session-item-bottom">
        <div class="session-item-workspace">${escapeHtml(basename(session.workspace) || session.workspace || '-')}</div>
        <div class="session-item-time">${session.messageCount || 0} 条</div>
      </div>
    `;
    els.sessionList.appendChild(item);
  }
}

function escapeHtml(input) {
  return String(input)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatShortTime(timestamp) {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function summarizeActiveSession() {
  const active = state.sessionDetail;
  if (!active) {
    els.chatTitle.textContent = '选择一个会话';
    els.chatMeta.textContent = '新建会话后开始发送消息';
    return;
  }
  els.chatTitle.textContent = active.title;
  const metaParts = [
    `工作区: ${active.workspace}`,
    `创建于: ${formatTime(active.createdAt)}`,
  ];
  if (active.sessionId) {
    metaParts.push(`Agent Session: ${active.sessionId}`);
  }
  els.chatMeta.textContent = metaParts.join('  ·  ');
}

function messageText(entry) {
  if (entry.type === 'user') {
    return entry.prompt || '';
  }
  if (entry.type === 'assistant') {
    if (Array.isArray(entry?.message?.content)) {
      const text = entry.message.content
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('\n\n')
        .trim();
      if (text) return text;
    }
  }
  if (entry.type === 'result') {
    const lines = [];
    if (entry.subtype) lines.push(`subtype: ${entry.subtype}`);
    if (typeof entry.duration_ms === 'number') lines.push(`duration_ms: ${entry.duration_ms}`);
    if (typeof entry.total_cost_usd === 'number') lines.push(`total_cost_usd: ${entry.total_cost_usd}`);
    if (lines.length > 0) return lines.join('\n');
  }
  if (entry.type === 'error') {
    return entry.message || 'Unknown error';
  }
  return JSON.stringify(entry, null, 2);
}

function setBusyForActiveSession() {
  const active = getActiveSummary();
  const hasActive = Boolean(state.activeSessionId);
  els.sendBtn.disabled = !hasActive || Boolean(active?.busy);
  els.stopBtn.disabled = !hasActive || !active?.busy;
  els.deleteSessionBtn.disabled = !hasActive || Boolean(active?.busy);
  els.pickDirBtn.disabled = !hasActive || (state.sessionDetail?.messageCount || 0) > 0;
  els.refreshTreeBtn.disabled = !hasActive;
}

async function refreshSessions() {
  state.sessions = await window.agentDesktop.listSessions();
  renderSessionList();
  setBusyForActiveSession();
}

async function openSession(sessionId) {
  state.activeSessionId = sessionId;
  state.sessionDetail = await window.agentDesktop.getSession({ sessionId });
  upsertSessionSummary(state.sessionDetail);
  renderSessionList();
  summarizeActiveSession();
  renderMessages(els.messageList, state.sessionDetail);
  renderWorkspaceHeader(els, state.sessionDetail);
  setBusyForActiveSession();
  resetWorkspaceView(els, state);
  setWorkspaceTab(els, state, state.activeWorkspaceTab);
  await renderWorkspaceTree({
    els,
    state,
    loadDirectory,
    readWorkspaceFile,
  });
}

async function createSession() {
  const result = await window.agentDesktop.createSession({});
  upsertSessionSummary(result.summary);
  renderSessionList();
  await openSession(result.summary.id);
}

async function deleteActiveSession() {
  if (!state.activeSessionId) return;
  const sessionId = state.activeSessionId;
  await window.agentDesktop.deleteSession({ sessionId });
  state.sessions = state.sessions.filter((entry) => entry.id !== sessionId);
  state.activeSessionId = state.sessions[0]?.id || null;
  if (state.activeSessionId) {
    await openSession(state.activeSessionId);
  } else {
    state.sessionDetail = null;
    renderSessionList();
    summarizeActiveSession();
    renderMessages(els.messageList, state.sessionDetail);
    renderWorkspaceHeader(els, state.sessionDetail);
    resetWorkspaceView(els, state);
    setWorkspaceTab(els, state, state.activeWorkspaceTab);
    renderWorkspaceTree({
      els,
      state,
      loadDirectory,
      readWorkspaceFile,
    });
    setBusyForActiveSession();
  }
}

async function loadDirectory(dirPath) {
  if (!state.activeSessionId) return null;
  const key = dirPath || state.sessionDetail.workspace;
  if (state.directoryCache.has(key)) {
    return state.directoryCache.get(key);
  }
  const data = await window.agentDesktop.listWorkspaceDir({
    sessionId: state.activeSessionId,
    dirPath,
  });
  state.directoryCache.set(key, data);
  return data;
}

async function readWorkspaceFile(filePath) {
  return window.agentDesktop.readWorkspaceFile({
    sessionId: state.activeSessionId,
    filePath,
  });
}

async function pickWorkspace() {
  if (!state.activeSessionId) return;
  const nextWorkspace = await window.agentDesktop.pickDirectory();
  if (!nextWorkspace) return;

  try {
    const detail = await window.agentDesktop.setSessionWorkspace({
      sessionId: state.activeSessionId,
      workspace: nextWorkspace,
    });
    state.sessionDetail = detail;
    upsertSessionSummary(detail);
    renderSessionList();
    summarizeActiveSession();
    renderWorkspaceHeader(els, state.sessionDetail);
    resetWorkspaceView(els, state);
    setWorkspaceTab(els, state, state.activeWorkspaceTab);
    await renderWorkspaceTree({
      els,
      state,
      loadDirectory,
      readWorkspaceFile,
    });
    setBusyForActiveSession();
  } catch (error) {
    setError(error?.message || String(error));
  }
}

async function sendPrompt() {
  if (!state.activeSessionId) return;
  const prompt = els.promptInput.value.trim();
  if (!prompt) {
    setError('先输入 prompt。');
    return;
  }
  setError('');

  try {
    els.promptInput.value = '';
    await window.agentDesktop.send({
      sessionId: state.activeSessionId,
      prompt,
    });
    await openSession(state.activeSessionId);
  } catch (error) {
    setError(error?.message || String(error));
  }
}

function wireEvents() {
  window.agentDesktop.onEvent((event) => {
    if (event.sessionId !== state.activeSessionId) return;
    if (!state.sessionDetail) return;
    state.sessionDetail.history.push(event.payload);
    renderMessages(els.messageList, state.sessionDetail);
  });

  window.agentDesktop.onState((payload) => {
    if (!payload?.sessionId) return;
    const target = state.sessions.find((entry) => entry.id === payload.sessionId);
    if (target) {
      target.busy = Boolean(payload.busy);
      if (payload.summary) {
        Object.assign(target, payload.summary);
      }
    }
    if (state.sessionDetail?.id === payload.sessionId && payload.summary) {
      state.sessionDetail = { ...state.sessionDetail, ...payload.summary };
      summarizeActiveSession();
      renderWorkspaceHeader(els, state.sessionDetail);
    }
    renderSessionList();
    setBusyForActiveSession();
  });

  window.agentDesktop.onSessionMeta((summary) => {
    upsertSessionSummary(summary);
    if (state.sessionDetail?.id === summary.id) {
      state.sessionDetail = { ...state.sessionDetail, ...summary };
      summarizeActiveSession();
      renderWorkspaceHeader(els, state.sessionDetail);
    }
    renderSessionList();
    setBusyForActiveSession();
  });

  window.agentDesktop.onSessionRemoved(({ sessionId }) => {
    state.sessions = state.sessions.filter((entry) => entry.id !== sessionId);
    if (state.activeSessionId === sessionId) {
      state.activeSessionId = null;
      state.sessionDetail = null;
    }
    renderSessionList();
    summarizeActiveSession();
    renderMessages(els.messageList, state.sessionDetail);
    renderWorkspaceHeader(els, state.sessionDetail);
    setBusyForActiveSession();
  });

  els.leftResizeHandle.addEventListener('mousedown', (event) => {
    startResize('left', event);
  });

  els.rightResizeHandle.addEventListener('mousedown', (event) => {
    startResize('right', event);
  });

  els.toggleLeftSidebarBtn.addEventListener('click', () => {
    toggleSidebar('left');
  });

  els.toggleRightSidebarBtn.addEventListener('click', () => {
    toggleSidebar('right');
  });

  window.addEventListener('resize', () => {
    applyLayoutState();
  });
}

async function bootstrap() {
  applyLayoutState();
  const status = await window.agentDesktop.getStatus();
  setStatusPill(els.cliStatusPill, status.cliReady);
  setStatusPill(els.sdkStatusPill, status.sdkReady);
  els.cliStatusPill.textContent = status.cliReady ? 'CLI ready' : 'CLI missing';
  els.sdkStatusPill.textContent = status.sdkReady ? 'SDK ready' : 'SDK missing';

  if (!status.cliReady) {
    setError('缺少 cli-node.js。先在仓库根目录执行 bun run build:node。');
  }

  await refreshSessions();
  if (state.sessions.length === 0) {
    await createSession();
  } else {
    await openSession(state.sessions[0].id);
  }
}

els.newSessionBtn.addEventListener('click', () => {
  void createSession();
});

els.deleteSessionBtn.addEventListener('click', () => {
  void deleteActiveSession();
});

els.pickDirBtn.addEventListener('click', () => {
  void pickWorkspace();
});

els.refreshTreeBtn.addEventListener('click', () => {
  state.directoryCache = new Map();
  void renderWorkspaceTree({
    els,
    state,
    loadDirectory,
    readWorkspaceFile,
  });
});

els.sendBtn.addEventListener('click', () => {
  void sendPrompt();
});

els.stopBtn.addEventListener('click', () => {
  if (!state.activeSessionId) return;
  void window.agentDesktop.abort({ sessionId: state.activeSessionId });
});

els.promptInput.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    void sendPrompt();
  }
});

els.filesTabBtn.addEventListener('click', () => {
  setWorkspaceTab(els, state, 'files');
});

els.previewTabBtn.addEventListener('click', () => {
  setWorkspaceTab(els, state, 'preview');
  renderPreviewTabs(els, state);
  renderPreviewContent(els, state);
});

els.workspaceSearchInput.addEventListener('input', () => {
  state.workspaceQuery = els.workspaceSearchInput.value.trim();
  void renderWorkspaceTree({
    els,
    state,
    loadDirectory,
    readWorkspaceFile,
  });
});

wireEvents();
void bootstrap();
