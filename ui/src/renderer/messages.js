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

function extractAssistantText(entry) {
  if (!Array.isArray(entry?.message?.content)) return '';
  return entry.message.content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
    .trim();
}

function buildResultText(entry) {
  const lines = [];
  if (entry.subtype) lines.push(`subtype: ${entry.subtype}`);
  if (typeof entry.duration_ms === 'number') lines.push(`duration_ms: ${entry.duration_ms}`);
  if (typeof entry.total_cost_usd === 'number') lines.push(`total_cost_usd: ${entry.total_cost_usd}`);
  if (entry.session_id) lines.push(`session_id: ${entry.session_id}`);
  return lines.join('\n');
}

function createMeta(type, timestamp) {
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.innerHTML = `<span>${escapeHtml(type)}</span><span>${formatShortTime(timestamp || Date.now())}</span>`;
  return meta;
}

function createBody(text, code = false) {
  const body = document.createElement('div');
  body.className = `message-body ${code ? 'code' : ''}`;
  body.textContent = text;
  return body;
}

function buildToolBlocks(entry) {
  const fragment = document.createDocumentFragment();
  const title = document.createElement('div');
  title.className = 'tool-call-title';
  title.textContent = entry.subtype ? `${entry.subtype}` : 'tool';
  fragment.appendChild(title);

  if (entry.subtype === 'exec_command') {
    const command = entry.command ?? entry.cmd ?? '';
    if (command) {
      fragment.appendChild(createBody(command, true));
    }
  } else if (entry.subtype === 'apply_patch') {
    const patch = entry.patch ?? entry.input ?? '';
    if (patch) {
      fragment.appendChild(createBody(patch, true));
    }
  } else if (entry.subtype === 'web_search') {
    const query = entry.query ?? entry.search_query ?? '';
    if (query) {
      fragment.appendChild(createBody(query, true));
    }
  }

  const raw = document.createElement('details');
  raw.className = 'tool-call-raw';
  raw.innerHTML = '<summary>Raw payload</summary>';
  raw.appendChild(createBody(JSON.stringify(entry, null, 2), true));
  fragment.appendChild(raw);

  return fragment;
}

function renderGeneric(entry, type) {
  const row = document.createElement('div');
  row.className = `message-row ${type}`;

  const card = document.createElement('article');
  card.className = 'message-card';
  card.appendChild(createMeta(type, entry.timestamp));
  card.appendChild(createBody(JSON.stringify(entry, null, 2), true));

  row.appendChild(card);
  return row;
}

function renderToolCall(entry, type) {
  const row = document.createElement('div');
  row.className = 'message-row tool';

  const card = document.createElement('article');
  card.className = 'message-card tool-card';
  card.appendChild(createMeta(type, entry.timestamp));
  card.appendChild(buildToolBlocks(entry));

  row.appendChild(card);
  return row;
}

export function renderMessages(container, sessionDetail) {
  container.innerHTML = '';

  if (!sessionDetail) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '左侧选一个会话，或者新建一个。这里会显示与本地 agent 的完整流式对话。';
    container.appendChild(empty);
    return;
  }

  const history = sessionDetail.history || [];
  if (history.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '这个会话还没有消息。先在下面输入 prompt。';
    container.appendChild(empty);
    return;
  }

  for (const entry of history) {
    const type = typeof entry.type === 'string' ? entry.type : 'event';

    if (type === 'user') {
      const row = document.createElement('div');
      row.className = 'message-row user';
      const card = document.createElement('article');
      card.className = 'message-card';
      card.appendChild(createMeta(type, entry.timestamp));
      card.appendChild(createBody(entry.prompt || ''));
      row.appendChild(card);
      container.appendChild(row);
      continue;
    }

    if (type === 'assistant') {
      const row = document.createElement('div');
      row.className = 'message-row assistant';
      const card = document.createElement('article');
      card.className = 'message-card';
      const text = extractAssistantText(entry) || JSON.stringify(entry, null, 2);
      card.appendChild(createMeta(type, entry.timestamp));
      card.appendChild(createBody(text));
      row.appendChild(card);
      container.appendChild(row);
      continue;
    }

    if (type === 'result') {
      const row = document.createElement('div');
      row.className = 'message-row result';
      const card = document.createElement('article');
      card.className = 'message-card';
      card.appendChild(createMeta(type, entry.timestamp));
      card.appendChild(createBody(buildResultText(entry) || JSON.stringify(entry, null, 2), true));
      row.appendChild(card);
      container.appendChild(row);
      continue;
    }

    if (type === 'error') {
      const row = document.createElement('div');
      row.className = 'message-row error';
      const card = document.createElement('article');
      card.className = 'message-card';
      card.appendChild(createMeta(type, entry.timestamp));
      card.appendChild(createBody(entry.message || 'Unknown error', true));
      row.appendChild(card);
      container.appendChild(row);
      continue;
    }

    if (type === 'system') {
      const row = document.createElement('div');
      row.className = 'message-row system';
      const card = document.createElement('article');
      card.className = 'message-card';
      card.appendChild(createMeta(type, entry.timestamp));
      card.appendChild(createBody(entry.detail || JSON.stringify(entry, null, 2), true));
      row.appendChild(card);
      container.appendChild(row);
      continue;
    }

    if (type.includes('tool')) {
      container.appendChild(renderToolCall(entry, type));
      continue;
    }

    container.appendChild(renderGeneric(entry, type));
  }

  container.scrollTop = container.scrollHeight;
}
