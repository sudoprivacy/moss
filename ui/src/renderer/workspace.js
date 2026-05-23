function basename(filePath) {
  if (!filePath) return '';
  const normalized = filePath.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || normalized;
}

function matchesQuery(item, query) {
  if (!query) return true;
  const lower = query.toLowerCase();
  return (
    item.name.toLowerCase().includes(lower) ||
    String(item.relativePath || '').toLowerCase().includes(lower)
  );
}

function isVisibleDirectory(item, state) {
  if (!state.workspaceQuery) return true;
  if (matchesQuery(item, state.workspaceQuery)) return true;
  const cached = state.directoryCache.get(item.path);
  if (!cached?.items) return false;
  return cached.items.some((child) =>
    child.type === 'directory'
      ? isVisibleDirectory(child, state)
      : matchesQuery(child, state.workspaceQuery)
  );
}

export function renderWorkspaceHeader(els, sessionDetail) {
  if (!sessionDetail) {
    els.workspaceTitle.textContent = '工作区';
    els.workspaceMeta.textContent = '选择会话后可浏览目录';
    els.workspacePath.textContent = '-';
    return;
  }

  els.workspaceTitle.textContent = basename(sessionDetail.workspace) || sessionDetail.workspace;
  els.workspaceMeta.textContent =
    sessionDetail.messageCount > 0
      ? '已锁定到当前会话工作区'
      : '首条消息前可以切换工作区';
  els.workspacePath.textContent = sessionDetail.workspace;
}

export async function renderWorkspaceTree({ els, state, loadDirectory, readWorkspaceFile }) {
  els.treeRoot.innerHTML = '';
  if (!state.sessionDetail) return;

  const rootData = await loadDirectory(state.sessionDetail.workspace);
  if (!rootData) return;

  const container = await createTreeNode({
    dirPath: rootData.path,
    items: rootData.items,
    depth: 0,
    els,
    state,
    loadDirectory,
    readWorkspaceFile,
  });

  if (!container.childNodes.length) {
    const empty = document.createElement('div');
    empty.className = 'workspace-empty';
    empty.textContent = state.workspaceQuery
      ? '没有匹配的文件。'
      : '这个工作区没有可显示的文件。';
    els.treeRoot.appendChild(empty);
    return;
  }

  els.treeRoot.appendChild(container);
}

async function createTreeNode({ dirPath, items, depth, els, state, loadDirectory, readWorkspaceFile }) {
  const fragment = document.createElement('div');
  for (const item of items) {
    if (item.type === 'directory' && !isVisibleDirectory(item, state)) {
      continue;
    }
    if (item.type === 'file' && !matchesQuery(item, state.workspaceQuery)) {
      continue;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'tree-item';

    const row = document.createElement('div');
    row.className = `tree-item-row ${state.selectedFilePath === item.path ? 'active' : ''}`;
    row.style.paddingLeft = `${10 + depth * 12}px`;

    const caret = document.createElement('span');
    caret.className = 'tree-caret';
    const isOpen = state.openDirectories.has(item.path);
    caret.textContent = item.type === 'directory' ? (isOpen ? '▾' : '▸') : '•';

    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = item.name;

    row.append(caret, name);
    row.addEventListener('click', async () => {
      if (item.type === 'directory') {
        if (state.openDirectories.has(item.path)) {
          state.openDirectories.delete(item.path);
        } else {
          state.openDirectories.add(item.path);
          await loadDirectory(item.path);
        }
        await renderWorkspaceTree({ els, state, loadDirectory, readWorkspaceFile });
        return;
      }

      state.selectedFilePath = item.path;
      state.activeWorkspaceTab = 'preview';
      const fileData = await readWorkspaceFile(item.path);
      upsertPreviewTab(state, fileData);
      renderPreviewTabs(els, state);
      renderPreviewContent(els, state);
      await renderWorkspaceTree({ els, state, loadDirectory, readWorkspaceFile });
    });

    wrapper.appendChild(row);

    if (item.type === 'directory' && state.openDirectories.has(item.path)) {
      const childData = state.directoryCache.get(item.path) || (await loadDirectory(item.path));
      if (childData?.items?.length) {
        const children = document.createElement('div');
        children.className = 'tree-children';
        children.appendChild(await createTreeNode({
          dirPath: item.path,
          items: childData.items,
          depth: depth + 1,
          els,
          state,
          loadDirectory,
          readWorkspaceFile,
        }));
        wrapper.appendChild(children);
      }
    }

    fragment.appendChild(wrapper);
  }
  return fragment;
}

function upsertPreviewTab(state, fileData) {
  const existingIndex = state.previewTabs.findIndex((entry) => entry.path === fileData.path);
  if (existingIndex !== -1) {
    state.previewTabs[existingIndex] = fileData;
  } else {
    state.previewTabs.push(fileData);
  }
  state.activePreviewPath = fileData.path;
}

export function resetWorkspaceView(els, state) {
  state.selectedFilePath = null;
  state.openDirectories = new Set();
  state.directoryCache = new Map();
  state.previewTabs = [];
  state.activePreviewPath = null;
  state.workspaceQuery = '';
  state.activeWorkspaceTab = 'files';
  els.workspaceSearchInput.value = '';
  renderPreviewTabs(els, state);
  renderPreviewContent(els, state);
}

export function renderPreviewTabs(els, state) {
  els.previewTabs.innerHTML = '';
  if (state.previewTabs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'preview-tab-empty';
    empty.textContent = '未打开文件';
    els.previewTabs.appendChild(empty);
    return;
  }

  for (const file of state.previewTabs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `preview-tab ${file.path === state.activePreviewPath ? 'active' : ''}`;
    button.textContent = basename(file.path);
    button.addEventListener('click', () => {
      state.activePreviewPath = file.path;
      state.activeWorkspaceTab = 'preview';
      renderPreviewTabs(els, state);
      renderPreviewContent(els, state);
    });
    els.previewTabs.appendChild(button);
  }
}

export function renderPreviewContent(els, state) {
  const active = state.previewTabs.find((entry) => entry.path === state.activePreviewPath) || null;
  if (!active) {
    els.filePreviewTitle.textContent = '未选择文件';
    els.filePreviewContent.textContent = '在右侧文件树里点一个文件。';
    return;
  }
  els.filePreviewTitle.textContent = active.relativePath;
  els.filePreviewContent.textContent = active.content;
}

export function setWorkspaceTab(els, state, tab) {
  state.activeWorkspaceTab = tab;
  els.filesTabBtn.classList.toggle('active', tab === 'files');
  els.previewTabBtn.classList.toggle('active', tab === 'preview');
  els.treePanel.hidden = tab !== 'files';
  els.previewPanel.hidden = tab !== 'preview';
}
