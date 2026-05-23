export type ToolStatus = 'pending' | 'running' | 'success' | 'error';

export type ToolStep = {
  id: string;
  name: string;
  toolName: string;
  type: 'exec' | 'search' | 'code' | 'api' | 'db' | 'other';
  status: ToolStatus;
  duration?: number;
  result?: string;
  inputSummary?: string;
  statusText?: string;
  input?: unknown;
  output?: unknown;
  outputText?: string;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  timestamp: Date;
  toolSteps?: ToolStep[];
  toolsComplete?: boolean;
  meta?: string[];
  streaming?: boolean;
  images?: string[];
  files?: string[];
};

export type TranscriptAttachment = {
  kind: 'image' | 'file';
  path: string;
};

type TranscriptRenderMessageBase = {
  id: string;
  timestamp: Date;
  meta?: string[];
};

export type UserTextRenderMessage = TranscriptRenderMessageBase & {
  type: 'user_text';
  role: 'user';
  content: string;
  attachments?: TranscriptAttachment[];
};

export type AssistantTextRenderMessage = TranscriptRenderMessageBase & {
  type: 'assistant_text';
  role: 'assistant';
  content: string;
  streaming?: boolean;
  attachments?: TranscriptAttachment[];
};

export type ThinkingRenderMessage = TranscriptRenderMessageBase & {
  type: 'thinking';
  role: 'assistant';
  content: string;
  streaming?: boolean;
};

export type ToolUseRenderMessage = TranscriptRenderMessageBase & {
  type: 'tool_use';
  role: 'assistant';
  toolUseId: string;
  parentToolUseId?: string;
  toolName: string;
  displayName: string;
  input?: unknown;
  inputText?: string;
  status: ToolStatus;
  statusText?: string;
  duration?: number;
};

export type ToolResultRenderMessage = TranscriptRenderMessageBase & {
  type: 'tool_result';
  role: 'assistant';
  toolUseId: string;
  parentToolUseId?: string;
  toolName: string;
  content: string;
  rawContent?: unknown;
  isError?: boolean;
  attachments?: TranscriptAttachment[];
};

export type SystemRenderMessage = TranscriptRenderMessageBase & {
  type: 'system';
  role: 'system';
  content: string;
};

export type TranscriptRenderMessage =
  | UserTextRenderMessage
  | AssistantTextRenderMessage
  | ThinkingRenderMessage
  | ToolUseRenderMessage
  | ToolResultRenderMessage
  | SystemRenderMessage;

export type WorkerThreadStatus = 'queued' | 'running' | 'completed' | 'failed';

export type WorkerThread = {
  id: string;
  title: string;
  prompt: string;
  status: WorkerThreadStatus;
  agentId?: string;
  description?: string;
  summary?: string;
  resultText?: string;
  messages: TranscriptRenderMessage[];
};

export type AgentTranscriptDebugInfo = {
  historyLength: number;
  mainHistoryLength: number;
  derivedWorkers: Array<{
    id: string;
    title: string;
    status: WorkerThreadStatus;
    promptPreview: string;
    resultPreview: string;
    messageCount: number;
  }>;
  mainMessages: Array<{
    role: 'user' | 'assistant';
    contentPreview: string;
    meta?: string[];
  }>;
};

type AgentEvent = Record<string, any>;

type MutableChatMessage = ChatMessage & {
  _finalized?: boolean;
};

type AssistantTurnState = {
  startedAt: Date;
  items: TranscriptRenderMessage[];
  meta: string[];
};

type RenderBuilderState = {
  items: TranscriptRenderMessage[];
  currentAssistantTurn: AssistantTurnState | null;
  nextId: number;
  toolUsesById: Map<string, ToolUseRenderMessage>;
};

function safeDate(input: unknown): Date {
  if (typeof input === 'number') return new Date(input);
  if (typeof input === 'string') {
    const timestamp = Date.parse(input);
    if (!Number.isNaN(timestamp)) return new Date(timestamp);
  }
  return new Date();
}

function formatJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeText(entry)).filter(Boolean).join('\n\n').trim();
  }
  if (value && typeof value === 'object') {
    if (typeof (value as any).text === 'string') return (value as any).text.trim();
    if (typeof (value as any).content === 'string') return (value as any).content.trim();
  }
  return '';
}

function appendText(message: MutableChatMessage, text: string) {
  const normalized = String(text || '').trim();
  if (!normalized) return;
  message.content = message.content ? `${message.content}\n\n${normalized}` : normalized;
}

function appendThinking(message: MutableChatMessage, text: string) {
  const normalized = String(text || '');
  if (!normalized.trim()) return;
  message.thinking = `${message.thinking || ''}${normalized}`;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function normalizeToolResultPayload(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    const parsed = safeJsonParse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return null;
}

function collectImagePathsFromToolResult(content: unknown): string[] {
  const payload = normalizeToolResultPayload(content);
  if (!payload || payload.fileKind !== 'image') {
    return [];
  }

  const candidates: string[] = [];
  if (typeof payload.filePath === 'string' && payload.filePath.trim()) {
    candidates.push(payload.filePath);
  }
  if (Array.isArray(payload.filePaths)) {
    for (const filePath of payload.filePaths) {
      if (typeof filePath === 'string' && filePath.trim()) {
        candidates.push(filePath);
      }
    }
  }

  return Array.from(new Set(candidates));
}

function collectAttachmentsFromToolResult(content: unknown): TranscriptAttachment[] {
  const payload = normalizeToolResultPayload(content);
  if (!payload) return [];

  const attachments: TranscriptAttachment[] = [];
  const fileKind = typeof payload.fileKind === 'string' ? payload.fileKind : undefined;
  const pushPath = (path: unknown) => {
    if (typeof path !== 'string' || !path.trim()) return;
    attachments.push({
      kind: fileKind === 'image' || isImagePath(path) ? 'image' : 'file',
      path,
    });
  };

  pushPath(payload.filePath);
  if (Array.isArray(payload.filePaths)) {
    for (const filePath of payload.filePaths) {
      pushPath(filePath);
    }
  }

  return attachments;
}

function summarizeThinkingBlock(block: any): string {
  if (block?.type === 'thinking' && typeof block.thinking === 'string') {
    return block.thinking;
  }
  if (block?.type === 'redacted_thinking') {
    return '模型返回了受保护的思考内容，当前只提供占位信息。';
  }
  return '';
}

function summarizeToolResultBlock(block: any): string {
  const parts: string[] = [];
  const text = normalizeText(block?.content);
  if (text) parts.push(text);
  else if (block?.content !== undefined) parts.push(formatJson(block.content));
  if (block?.is_error) parts.unshift('执行失败');
  return parts.join('\n\n').trim();
}

function extractInputSummary(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const i = input as Record<string, unknown>;
  if (typeof i.file_path === 'string') return i.file_path;
  if (typeof i.path === 'string') return i.path;
  if (typeof i.pattern === 'string') return i.pattern;
  if (typeof i.command === 'string') return String(i.command).slice(0, 100);
  if (typeof i.url === 'string') return i.url;
  if (typeof i.query === 'string') return String(i.query).slice(0, 100);
  if (typeof i.prompt === 'string') return String(i.prompt).slice(0, 100);
  const firstStr = Object.values(i).find((v) => typeof v === 'string');
  return firstStr ? String(firstStr).slice(0, 100) : undefined;
}

function mapToolType(name: string): ToolStep['type'] {
  const lower = String(name || '').toLowerCase();
  if (lower.includes('bash') || lower.includes('exec') || lower.includes('command')) return 'exec';
  if (lower.includes('read') || lower.includes('glob') || lower.includes('grep') || lower.includes('search')) return 'search';
  if (lower.includes('write') || lower.includes('edit') || lower.includes('patch') || lower.includes('multi_edit')) return 'code';
  if (lower.includes('web') || lower.includes('fetch') || lower.includes('api')) return 'api';
  if (lower.includes('sql') || lower.includes('db')) return 'db';
  return 'other';
}

function humanizeToolName(name: string): string {
  return String(name || 'Tool')
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
}

function buildToolDetail(input: unknown, output?: unknown): string {
  const parts: string[] = [];
  if (input !== undefined && input !== null && !(typeof input === 'object' && Object.keys(input).length === 0)) {
    parts.push(`Input\n${formatJson(input)}`);
  }
  if (output !== undefined && output !== null) {
    parts.push(`Output\n${typeof output === 'string' ? output : formatJson(output)}`);
  }
  return parts.join('\n\n').trim();
}

function syncToolStep(step: ToolStep, block: any) {
  const rawToolName = String(block?.tool_name || block?.name || step.toolName || block?.display_name || 'Tool').trim() || 'Tool';
  const displayName = String(block?.display_name || rawToolName || step.name || 'Tool').trim() || 'Tool';
  step.toolName = rawToolName;
  step.name = humanizeToolName(displayName);
  step.type = mapToolType(rawToolName);
  if (Object.prototype.hasOwnProperty.call(block ?? {}, 'input')) {
    step.input = block?.input;
    step.inputSummary = extractInputSummary(block?.input);
  }
  const detailOutput = step.output !== undefined ? step.output : step.outputText;
  step.result = buildToolDetail(step.input, detailOutput);
}

function normalizeTextFromContentBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      if ((block as any).type === 'text' && typeof (block as any).text === 'string') {
        return (block as any).text;
      }
      if ((block as any).type === 'thinking' && typeof (block as any).thinking === 'string') {
        return (block as any).thinking;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function previewText(value: unknown, max = 120): string {
  const text = normalizeText(value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path);
}

function mergeMeta(
  existing: string[] | undefined,
  incoming: string[] | undefined,
): string[] | undefined {
  if (!existing?.length && !incoming?.length) return undefined;
  const merged = [...(existing || [])];
  for (const entry of incoming || []) {
    if (!merged.includes(entry)) merged.push(entry);
  }
  return merged.length > 0 ? merged : undefined;
}

function mergeAttachments(
  existing: TranscriptAttachment[] | undefined,
  incoming: TranscriptAttachment[] | undefined,
): TranscriptAttachment[] | undefined {
  if (!existing?.length && !incoming?.length) return undefined;
  const merged = [...(existing || [])];
  for (const attachment of incoming || []) {
    if (!merged.some((entry) => entry.kind === attachment.kind && entry.path === attachment.path)) {
      merged.push(attachment);
    }
  }
  return merged.length > 0 ? merged : undefined;
}

function attachmentsFromPaths(
  images?: string[] | null,
  files?: string[] | null,
): TranscriptAttachment[] | undefined {
  const attachments: TranscriptAttachment[] = [];

  for (const image of images || []) {
    if (typeof image === 'string' && image.trim()) {
      attachments.push({ kind: 'image', path: image });
    }
  }

  for (const file of files || []) {
    if (typeof file !== 'string' || !file.trim()) continue;
    attachments.push({
      kind: isImagePath(file) ? 'image' : 'file',
      path: file,
    });
  }

  return attachments.length > 0 ? mergeAttachments(undefined, attachments) : undefined;
}

function nextRenderId(state: RenderBuilderState, prefix: string): string {
  state.nextId += 1;
  return `${prefix}-${state.nextId}`;
}

function createAssistantTurn(timestamp: Date): AssistantTurnState {
  return {
    startedAt: timestamp,
    items: [],
    meta: [],
  };
}

function ensureAssistantTurn(
  state: RenderBuilderState,
  timestamp: Date,
): AssistantTurnState {
  if (!state.currentAssistantTurn) {
    state.currentAssistantTurn = createAssistantTurn(timestamp);
  } else if (timestamp.getTime() > state.currentAssistantTurn.startedAt.getTime()) {
    state.currentAssistantTurn.startedAt = timestamp;
  }
  return state.currentAssistantTurn;
}

function pushTurnItem(
  turn: AssistantTurnState,
  item: TranscriptRenderMessage,
) {
  turn.items.push(item);
}

function resetAssistantTurn(
  state: RenderBuilderState,
  timestamp: Date,
): AssistantTurnState {
  const turn = ensureAssistantTurn(state, timestamp);
  for (const item of turn.items) {
    if (item.type === 'tool_use') {
      state.toolUsesById.delete(item.toolUseId);
    }
  }
  turn.startedAt = timestamp;
  turn.items = [];
  turn.meta = [];
  return turn;
}

function appendTurnMeta(turn: AssistantTurnState, value: string) {
  if (!value || turn.meta.includes(value)) return;
  turn.meta.push(value);
}

function lastTurnItem(
  turn: AssistantTurnState,
): TranscriptRenderMessage | undefined {
  return turn.items[turn.items.length - 1];
}

function ensureAssistantTextItem(
  state: RenderBuilderState,
  turn: AssistantTurnState,
  timestamp: Date,
): AssistantTextRenderMessage {
  const last = lastTurnItem(turn);
  if (last?.type === 'assistant_text') {
    if (timestamp.getTime() > last.timestamp.getTime()) last.timestamp = timestamp;
    return last;
  }

  const item: AssistantTextRenderMessage = {
    id: nextRenderId(state, 'assistant-text'),
    type: 'assistant_text',
    role: 'assistant',
    content: '',
    timestamp,
  };
  pushTurnItem(turn, item);
  return item;
}

function appendAssistantTextItem(
  state: RenderBuilderState,
  turn: AssistantTurnState,
  timestamp: Date,
  text: string,
  options?: { streaming?: boolean; preserveWhitespace?: boolean },
) {
  const rawText = String(text || '');
  const normalized = options?.preserveWhitespace ? rawText : rawText.trim();
  if (!normalized) return;

  const item = ensureAssistantTextItem(state, turn, timestamp);
  if (options?.preserveWhitespace) {
    item.content += normalized;
  } else {
    item.content = item.content ? `${item.content}\n\n${normalized}` : normalized;
  }
  if (options?.streaming) item.streaming = true;
}

function ensureThinkingItem(
  state: RenderBuilderState,
  turn: AssistantTurnState,
  timestamp: Date,
): ThinkingRenderMessage {
  const last = lastTurnItem(turn);
  if (last?.type === 'thinking') {
    if (timestamp.getTime() > last.timestamp.getTime()) last.timestamp = timestamp;
    return last;
  }

  const item: ThinkingRenderMessage = {
    id: nextRenderId(state, 'thinking'),
    type: 'thinking',
    role: 'assistant',
    content: '',
    timestamp,
  };
  pushTurnItem(turn, item);
  return item;
}

function appendThinkingItem(
  state: RenderBuilderState,
  turn: AssistantTurnState,
  timestamp: Date,
  text: string,
  options?: { streaming?: boolean },
) {
  const normalized = String(text || '');
  if (!normalized.trim()) return;
  const item = ensureThinkingItem(state, turn, timestamp);
  item.content += normalized;
  if (options?.streaming) item.streaming = true;
}

function appendAssistantAttachments(
  state: RenderBuilderState,
  turn: AssistantTurnState,
  timestamp: Date,
  attachments: TranscriptAttachment[] | undefined,
) {
  if (!attachments?.length) return;
  const item = ensureAssistantTextItem(state, turn, timestamp);
  item.attachments = mergeAttachments(item.attachments, attachments);
}

function buildToolInputText(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === 'string') return input;
  if (typeof input === 'object' && Object.keys(input).length === 0) return undefined;
  return formatJson(input);
}

function ensureToolUseMessage(
  state: RenderBuilderState,
  turn: AssistantTurnState,
  timestamp: Date,
  block: any,
): ToolUseRenderMessage {
  const toolUseId = String(block?.id || block?.tool_use_id || block?.toolCallId || '').trim()
    || nextRenderId(state, 'tool-use-generated');
  const existing = state.toolUsesById.get(toolUseId);
  if (existing && turn.items.includes(existing)) {
    existing.timestamp = timestamp;
    if (typeof block?.tool_name === 'string' && block.tool_name.trim()) {
      existing.toolName = block.tool_name.trim();
    }
    if (typeof block?.display_name === 'string' && block.display_name.trim()) {
      existing.displayName = humanizeToolName(block.display_name);
    } else if (existing.displayName.trim().length === 0) {
      existing.displayName = humanizeToolName(existing.toolName);
    }
    if (Object.prototype.hasOwnProperty.call(block ?? {}, 'input')) {
      existing.input = block.input;
      existing.inputText = buildToolInputText(block.input) ?? existing.inputText;
    }
    if (typeof block?.parent_tool_use_id === 'string' && block.parent_tool_use_id.trim()) {
      existing.parentToolUseId = block.parent_tool_use_id.trim();
    }
    return existing;
  }

  const toolName = String(block?.tool_name || block?.name || 'Tool').trim() || 'Tool';
  const item: ToolUseRenderMessage = {
    id: nextRenderId(state, 'tool-use'),
    type: 'tool_use',
    role: 'assistant',
    timestamp,
    toolUseId,
    parentToolUseId:
      typeof block?.parent_tool_use_id === 'string' && block.parent_tool_use_id.trim()
        ? block.parent_tool_use_id.trim()
        : undefined,
    toolName,
    displayName: humanizeToolName(String(block?.display_name || toolName).trim() || toolName),
    input: block?.input,
    inputText: buildToolInputText(block?.input),
    status: 'running',
    statusText: '进行中',
  };
  pushTurnItem(turn, item);
  state.toolUsesById.set(toolUseId, item);
  return item;
}

function updateToolUseStatus(
  state: RenderBuilderState,
  toolUseId: string | undefined,
  patch: Partial<Pick<ToolUseRenderMessage, 'status' | 'statusText' | 'duration' | 'timestamp'>>,
) {
  if (!toolUseId) return;
  const toolUse = state.toolUsesById.get(toolUseId);
  if (!toolUse) return;
  if (patch.status) toolUse.status = patch.status;
  if (typeof patch.statusText === 'string') toolUse.statusText = patch.statusText;
  if (typeof patch.duration === 'number') toolUse.duration = patch.duration;
  if (patch.timestamp) toolUse.timestamp = patch.timestamp;
}

function finalizeAssistantTurn(
  state: RenderBuilderState,
  options?: { complete?: boolean },
) {
  const turn = state.currentAssistantTurn;
  if (!turn) return;

  if (turn.meta.length > 0) {
    const target = [...turn.items]
      .reverse()
      .find((item) => item.type !== 'system');
    if (target) {
      target.meta = mergeMeta(target.meta, turn.meta);
    } else {
      state.items.push({
        id: nextRenderId(state, 'system'),
        type: 'system',
        role: 'system',
        content: turn.meta.join(' · '),
        timestamp: turn.startedAt,
        meta: mergeMeta(undefined, turn.meta),
      });
    }
  }

  if (options?.complete) {
    for (const item of turn.items) {
      if (item.type === 'assistant_text' || item.type === 'thinking') {
        item.streaming = false;
      }
      if (
        item.type === 'tool_use' &&
        (item.status === 'running' || item.status === 'pending')
      ) {
        item.status = 'success';
        item.statusText = item.statusText && item.statusText !== '进行中'
          ? item.statusText
          : '执行完成';
      }
    }
  }

  state.items.push(...turn.items.filter((item) => {
    if (item.type === 'assistant_text') {
      return item.content.trim().length > 0 || (item.attachments?.length ?? 0) > 0;
    }
    if (item.type === 'thinking') {
      return item.content.trim().length > 0;
    }
    return true;
  }));
  state.currentAssistantTurn = null;
}

function addUserRenderMessage(
  state: RenderBuilderState,
  timestamp: Date,
  content: string,
  attachments?: TranscriptAttachment[],
) {
  state.items.push({
    id: nextRenderId(state, 'user'),
    type: 'user_text',
    role: 'user',
    content: String(content || ''),
    timestamp,
    attachments,
  });
}

function addSystemRenderMessage(
  state: RenderBuilderState,
  timestamp: Date,
  content: string,
  meta?: string[],
) {
  const normalized = String(content || '').trim();
  if (!normalized) return;
  state.items.push({
    id: nextRenderId(state, 'system'),
    type: 'system',
    role: 'system',
    content: normalized,
    timestamp,
    meta,
  });
}

function addToolResultMessage(
  state: RenderBuilderState,
  turn: AssistantTurnState,
  timestamp: Date,
  block: any,
  rawContent?: unknown,
) {
  const toolUseId = String(block?.tool_use_id || '').trim();
  const toolUse = toolUseId ? state.toolUsesById.get(toolUseId) : undefined;
  const toolName = String(block?.tool_name || toolUse?.toolName || 'Tool').trim() || 'Tool';
  const attachments = mergeAttachments(
    attachmentsFromPaths(collectImagePathsFromToolResult(block?.content), undefined),
    collectAttachmentsFromToolResult(rawContent ?? block?.content),
  );
  const content =
    summarizeToolResultBlock(block)
    || normalizeText(rawContent)
    || formatJson(rawContent ?? block?.content ?? '');

  if (toolUseId) {
    updateToolUseStatus(state, toolUseId, {
      status: block?.is_error ? 'error' : 'success',
      statusText: block?.is_error ? '执行失败' : '执行完成',
      timestamp,
    });
  }

  pushTurnItem(turn, {
    id: nextRenderId(state, 'tool-result'),
    type: 'tool_result',
    role: 'assistant',
    timestamp,
    toolUseId,
    parentToolUseId: toolUse?.parentToolUseId,
    toolName,
    content,
    rawContent: rawContent ?? block?.content,
    isError: Boolean(block?.is_error),
    attachments,
  });
}

function extractRawUserText(event: AgentEvent): string {
  if (typeof event?.prompt === 'string') {
    return event.prompt;
  }

  const content = event?.message?.content;
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
      .map((block: any) => block.text)
      .join('\n')
      .trim();
  }

  return '';
}

function getEventOriginKind(event: AgentEvent): string | undefined {
  const kind = event?.origin?.kind;
  return typeof kind === 'string' && kind.trim() ? kind : undefined;
}

// ---------------------------------------------------------------------------
// Event classifiers used for main-chat sanitization
// ---------------------------------------------------------------------------

function isWorkerCompletionEvent(event: AgentEvent): boolean {
  return (
    event?.type === 'user' &&
    !!event?.tool_use_result &&
    typeof event.tool_use_result === 'object' &&
    typeof event.tool_use_result.agentId === 'string' &&
    typeof event.tool_use_result.status === 'string' &&
    event.tool_use_result.status !== 'async_launched'
  );
}

function isWorkerAsyncLaunchEvent(event: AgentEvent): boolean {
  return (
    event?.type === 'user' &&
    !!event?.tool_use_result &&
    typeof event.tool_use_result === 'object' &&
    typeof event.tool_use_result.agentId === 'string' &&
    event.tool_use_result.status === 'async_launched'
  );
}

function isNonHumanUserEvent(event: AgentEvent): boolean {
  const originKind = getEventOriginKind(event);
  return event?.type === 'user' && originKind !== undefined && originKind !== 'human';
}

function isSidechainEvent(event: AgentEvent): boolean {
  return (
    !!event &&
    typeof event === 'object' &&
    event.isSidechain === true &&
    typeof event.agentId === 'string' &&
    event.agentId.trim().length > 0
  );
}

function isWorkerLaunchToolUse(block: any): boolean {
  const toolName = String(block?.name || '').trim();
  return (
    block?.type === 'tool_use' &&
    toolName === 'Agent' &&
    typeof block?.id === 'string' &&
    block?.input &&
    typeof block.input === 'object' &&
    typeof block.input.prompt === 'string'
  );
}

// Strip Agent tool-use blocks from a top-level assistant event so the
// coordinator's "I'm launching workers" message shows its text but not the
// raw tool invocation JSON.
function stripWorkerLaunchBlocks(event: AgentEvent): AgentEvent | null {
  if (event?.type !== 'assistant' || !Array.isArray(event?.message?.content)) {
    return event;
  }
  const filtered = event.message.content.filter((block: any) => !isWorkerLaunchToolUse(block));
  if (filtered.length === event.message.content.length) return event;
  if (filtered.length === 0) return null;
  return { ...event, message: { ...event.message, content: filtered } };
}

// Collect all Agent tool-use IDs from the coordinator's own assistant messages.
// In coordinator mode the SDK normalises in-process worker events into plain
// assistant/user events that carry parent_tool_use_id pointing back to the
// Agent call that spawned the worker. We use these IDs to drop worker events.
function collectAgentToolUseIds(history: AgentEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of history) {
    if (event?.type !== 'assistant' || !Array.isArray(event?.message?.content)) continue;
    for (const block of event.message.content) {
      if (
        block?.type === 'tool_use' &&
        String(block?.name || '').trim() === 'Agent' &&
        typeof block?.id === 'string'
      ) {
        ids.add(block.id);
      }
    }
  }
  return ids;
}

// Remove worker-related events from main chat history.
// Workers are now a separate data source (subagent .jsonl files), so their
// events must not appear in the coordinator's chat transcript.
function sanitizeMainHistory(history: AgentEvent[]): AgentEvent[] {
  // Build the set of Agent tool-use IDs once so we can filter worker events.
  const agentToolIds = collectAgentToolUseIds(history);

  const result: AgentEvent[] = [];
  for (const event of history) {
    if (!event || typeof event !== 'object') continue;
    if (isNonHumanUserEvent(event)) continue;
    // Drop events that belong to a worker sub-agent (isSidechain path)
    if (isSidechainEvent(event)) continue;
    if (isWorkerAsyncLaunchEvent(event)) continue;
    if (isWorkerCompletionEvent(event)) continue;
    // Drop in-process worker events: the SDK normalises them from progress
    // wrappers into plain assistant/user events but attaches parent_tool_use_id
    // referencing the coordinator's Agent tool call.
    if (
      agentToolIds.size > 0 &&
      typeof event.parent_tool_use_id === 'string' &&
      agentToolIds.has(event.parent_tool_use_id)
    ) {
      continue;
    }
    // Drop user events whose message content consists only of tool_result
    // blocks for Agent calls — these are the coordinator receiving back the
    // worker results and should not appear as orphaned tool steps in the chat.
    if (
      agentToolIds.size > 0 &&
      event?.type === 'user' &&
      Array.isArray(event?.message?.content) &&
      event.message.content.length > 0 &&
      event.message.content.every(
        (block: any) =>
          block?.type === 'tool_result' &&
          typeof block?.tool_use_id === 'string' &&
          agentToolIds.has(block.tool_use_id),
      )
    ) {
      continue;
    }
    const stripped = stripWorkerLaunchBlocks(event);
    if (stripped) result.push(stripped);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Render-message builders used by the new chat UI
// ---------------------------------------------------------------------------

export function buildWorkerRenderMessagesFromSubagentEvents(
  events: AgentEvent[],
): TranscriptRenderMessage[] {
  const filtered = events.filter(
    (event) => event && typeof event === 'object' && event.type !== 'system',
  );
  return buildTranscriptRenderMessages(filtered);
}

export function buildMainChatRenderMessagesFromHistory(
  history: AgentEvent[],
): TranscriptRenderMessage[] {
  const sanitized = sanitizeMainHistory(history);
  return buildTranscriptRenderMessages(sanitized);
}

export function buildTranscriptRenderMessages(
  history: AgentEvent[],
): TranscriptRenderMessage[] {
  const state: RenderBuilderState = {
    items: [],
    currentAssistantTurn: null,
    nextId: 0,
    toolUsesById: new Map<string, ToolUseRenderMessage>(),
  };

  for (let index = 0; index < history.length; index += 1) {
    const event = history[index];
    const timestamp = safeDate(event?.timestamp);
    const userText = event?.type === 'user' ? extractUserText(event) : '';

    const userAttachments = attachmentsFromPaths(
      Array.isArray(event?.images) ? event.images : undefined,
      Array.isArray(event?.files) ? event.files : undefined,
    );

    if (
      event?.type === 'user' &&
      (userText.trim().length > 0 || (userAttachments?.length ?? 0) > 0)
    ) {
      finalizeAssistantTurn(state, { complete: true });
      addUserRenderMessage(state, timestamp, userText, userAttachments);
      continue;
    }

    if (event?.type === 'user' && Array.isArray(event?.message?.content)) {
      const turn = ensureAssistantTurn(state, timestamp);
      const resultBlocks = event.message.content.filter((block: any) => block?.type === 'tool_result');
      for (let resultIndex = 0; resultIndex < resultBlocks.length; resultIndex += 1) {
        const block = resultBlocks[resultIndex];
        const rawContent = resultBlocks.length === 1 && event?.tool_use_result !== undefined
          ? event.tool_use_result
          : block?.content;
        addToolResultMessage(state, turn, timestamp, block, rawContent);
      }
      continue;
    }

    if (event?.type === 'app_plan_state' && event?.kind === 'plan') {
      finalizeAssistantTurn(state, { complete: true });

      let content = '';
      if (event.state === 'awaiting_approval') {
        content = '执行计划已经生成，等待你确认后才会继续执行。';
      } else if (event.state === 'approved') {
        content = '已批准执行计划，任务将按计划继续。';
      } else if (event.state === 'rejected') {
        content = '已退回执行计划，当前不会继续执行。';
      }

      addSystemRenderMessage(state, timestamp, content, ['计划']);
      continue;
    }

    if (event?.type === 'stream_event') {
      const turn = ensureAssistantTurn(state, timestamp);
      const streamEvent = event?.event;

      if (
        streamEvent?.type === 'content_block_start' &&
        streamEvent.content_block?.type === 'tool_use'
      ) {
        const toolUse = ensureToolUseMessage(
          state,
          turn,
          timestamp,
          streamEvent.content_block,
        );
        toolUse.status = 'running';
        toolUse.statusText = '进行中';
      } else if (
        streamEvent?.type === 'content_block_start' &&
        streamEvent.content_block?.type === 'thinking'
      ) {
        appendThinkingItem(
          state,
          turn,
          timestamp,
          summarizeThinkingBlock(streamEvent.content_block),
          { streaming: true },
        );
      } else if (streamEvent?.type === 'content_block_delta') {
        if (
          streamEvent.delta?.type === 'text_delta' &&
          typeof streamEvent.delta.text === 'string'
        ) {
          appendAssistantTextItem(
            state,
            turn,
            timestamp,
            streamEvent.delta.text,
            { streaming: true, preserveWhitespace: true },
          );
        } else if (
          streamEvent.delta?.type === 'thinking_delta' &&
          typeof streamEvent.delta.thinking === 'string'
        ) {
          appendThinkingItem(
            state,
            turn,
            timestamp,
            streamEvent.delta.thinking,
            { streaming: true },
          );
        } else if (
          streamEvent.delta?.type === 'input_json_delta' &&
          typeof streamEvent.delta.partial_json === 'string'
        ) {
          const last = lastTurnItem(turn);
          if (last?.type === 'tool_use') {
            last.inputText = `${last.inputText || ''}${streamEvent.delta.partial_json}`;
          }
        }
      }
      continue;
    }

    if (event?.type === 'tool_progress') {
      const turn = ensureAssistantTurn(state, timestamp);
      const toolId = String(event?.parent_tool_use_id || event?.tool_use_id || '').trim();
      if (toolId) {
        ensureToolUseMessage(state, turn, timestamp, {
          id: toolId,
          tool_name: event?.tool_name || 'Tool',
          parent_tool_use_id: event?.parent_tool_use_id,
        });
        updateToolUseStatus(state, toolId, {
          status: 'running',
          statusText:
            typeof event?.elapsed_time_seconds === 'number'
              ? `运行 ${event.elapsed_time_seconds}s`
              : '进行中',
          duration:
            typeof event?.elapsed_time_seconds === 'number'
              ? event.elapsed_time_seconds * 1000
              : undefined,
          timestamp,
        });
      }
      continue;
    }

    if (event?.type === 'system') {
      const content = normalizeText(event?.content);
      if (!content) continue;
      if (state.currentAssistantTurn) {
        appendTurnMeta(state.currentAssistantTurn, content);
      } else {
        addSystemRenderMessage(state, timestamp, content);
      }
      continue;
    }

    if (event?.type === 'assistant') {
      const currentTurn = state.currentAssistantTurn;

      // Preserve streaming thinking content — the completed message often
      // contains redacted_thinking which would replace the full streamed content.
      const streamingThinking = currentTurn
        ? currentTurn.items.filter((item) => item.type === 'thinking')
        : [];

      // Multi-turn conversations: when tool results exist in the current turn,
      // finalize it before starting a new turn. Without this, resetAssistantTurn
      // discards all thinking and tool-call items from the previous response,
      // causing them to disappear from the chat after task completion.
      const hasToolResults = currentTurn
        ? currentTurn.items.some((item) => item.type === 'tool_result')
        : false;

      if (hasToolResults && currentTurn) {
        finalizeAssistantTurn(state, { complete: true });
      }

      const turn = resetAssistantTurn(state, timestamp);

      // Re-add streaming thinking that was preserved above. This prevents
      // thinking blocks from being lost when the completed message contains
      // redacted_thinking (a placeholder) instead of the full content.
      // Only re-add if the turn was not finalized (streaming scenario);
      // finalized turns already have thinking in state.items.
      if (!hasToolResults) {
        for (const item of streamingThinking) {
          pushTurnItem(turn, item);
        }
      }

      if (Array.isArray(event?.message?.content)) {
        for (const block of event.message.content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            appendAssistantTextItem(state, turn, timestamp, block.text);
          } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
            if (streamingThinking.length === 0) {
              appendThinkingItem(
                state,
                turn,
                timestamp,
                summarizeThinkingBlock(block),
              );
            }
          } else if (block.type === 'tool_use') {
            const toolUse = ensureToolUseMessage(state, turn, timestamp, block);
            toolUse.status = 'running';
            toolUse.statusText = '进行中';
          } else if (block.type === 'image' && typeof block.source === 'object') {
            const imagePath = String(block.source?.data || block.source?.url || '').trim();
            if (imagePath) {
              appendAssistantAttachments(
                state,
                turn,
                timestamp,
                [{ kind: 'image', path: imagePath }],
              );
            }
          }
        }
      } else {
        const normalizedText = normalizeTextFromContentBlocks(event?.message?.content);
        if (normalizedText) {
          appendAssistantTextItem(state, turn, timestamp, normalizedText);
        }
      }

      if (event?.error?.message) {
        appendTurnMeta(turn, `错误: ${String(event.error.message)}`);
      }
      continue;
    }

    if (event?.type === 'result') {
      const turn = ensureAssistantTurn(state, timestamp);
      if (typeof event.duration_ms === 'number') {
        appendTurnMeta(turn, `耗时 ${event.duration_ms}ms`);
      }
      if (typeof event.total_cost_usd === 'number') {
        appendTurnMeta(turn, `费用 $${event.total_cost_usd.toFixed(4)}`);
      }
      if (event.subtype && event.subtype !== 'success') {
        appendTurnMeta(turn, `状态 ${String(event.subtype)}`);
      }

      for (const item of turn.items) {
        if (
          item.type === 'tool_use' &&
          (item.status === 'running' || item.status === 'pending')
        ) {
          item.status = event.subtype === 'success' ? 'success' : 'error';
          if (!item.statusText || item.statusText === '进行中' || item.statusText.startsWith('运行 ')) {
            item.statusText = event.subtype === 'success' ? '执行完成' : '执行失败';
          }
        }
      }

      const resultText = typeof event.result === 'string' ? event.result.trim() : '';
      const hasAssistantText = turn.items.some(
        (item) => item.type === 'assistant_text' && item.content.trim().length > 0,
      );
      if (resultText && !hasAssistantText) {
        appendAssistantTextItem(state, turn, timestamp, resultText);
      }

      finalizeAssistantTurn(state, { complete: true });
      continue;
    }

    if (event?.type === 'error') {
      const turn = ensureAssistantTurn(state, timestamp);
      appendAssistantTextItem(
        state,
        turn,
        timestamp,
        String(event?.message || 'Unknown error'),
      );
      appendTurnMeta(turn, '执行失败');
      finalizeAssistantTurn(state, { complete: true });
      continue;
    }
  }

  finalizeAssistantTurn(state);
  return state.items;
}

// ---------------------------------------------------------------------------
// Public builders
// ---------------------------------------------------------------------------

// Build chat messages from a worker sub-agent's raw .jsonl events.
// The events come directly from the SDK file and are the authoritative source
// of worker content — no history-splitting or routing heuristics needed.
export function buildWorkerMessagesFromSubagentEvents(events: any[]): ChatMessage[] {
  // system events only carry the system-prompt text; skip them so they don't
  // appear as an extra message bubble in the worker panel.
  const filtered = events.filter(
    (e) => e && typeof e === 'object' && e.type !== 'system',
  );
  return buildChatMessages(filtered);
}

export function buildMainChatMessagesFromHistory(history: AgentEvent[]): ChatMessage[] {
  const sanitized = sanitizeMainHistory(history);
  // Result text is now embedded inline by buildChatMessages when processing 'result'
  // events (if the assistant had no content yet), so no separate fallback needed.
  return buildChatMessages(sanitized);
}

export function collectAgentTranscriptDebugInfo(
  history: AgentEvent[],
  workerThreads: WorkerThread[],
  mainMessages: ChatMessage[],
): AgentTranscriptDebugInfo {
  const sanitized = sanitizeMainHistory(history);

  return {
    historyLength: history.length,
    mainHistoryLength: sanitized.length,
    derivedWorkers: workerThreads.map((thread) => ({
      id: thread.id,
      title: thread.title,
      status: thread.status,
      promptPreview: previewText(thread.prompt),
      resultPreview: previewText(thread.resultText),
      messageCount: thread.messages.length,
    })),
    mainMessages: mainMessages.map((message) => ({
      role: message.role,
      contentPreview: previewText(message.content),
      meta: message.meta,
    })),
  };
}

// ---------------------------------------------------------------------------
// Core message builder — shared by main chat and worker panels
// ---------------------------------------------------------------------------

function ensureMeta(message: MutableChatMessage) {
  if (!message.meta) message.meta = [];
  return message.meta;
}

function addMeta(message: MutableChatMessage, value: string) {
  if (!value) return;
  const meta = ensureMeta(message);
  if (!meta.includes(value)) meta.push(value);
}

function ensureToolSteps(message: MutableChatMessage) {
  if (!message.toolSteps) message.toolSteps = [];
  return message.toolSteps;
}

function ensureToolStep(message: MutableChatMessage, block: any): ToolStep {
  const toolSteps = ensureToolSteps(message);
  const toolId = String(block?.id || block?.tool_use_id || block?.toolCallId || `${message.id}-tool-${toolSteps.length}`);
  const existing = toolSteps.find((entry) => entry.id === toolId);
  if (existing) {
    syncToolStep(existing, block);
    return existing;
  }

  const rawToolName = String(block?.tool_name || block?.name || block?.display_name || 'Tool').trim() || 'Tool';
  const displayName = String(block?.display_name || rawToolName || 'Tool').trim() || 'Tool';

  const step: ToolStep = {
    id: toolId,
    name: humanizeToolName(displayName),
    toolName: rawToolName,
    type: mapToolType(rawToolName),
    status: 'running',
    result: buildToolDetail(block?.input),
    inputSummary: extractInputSummary(block?.input),
    statusText: '进行中',
    input: block?.input,
  };
  toolSteps.push(step);
  return step;
}

function finalizeAssistant(message: MutableChatMessage | null) {
  if (!message) return;
  if (!message.toolSteps?.length) {
    message.toolSteps = undefined;
    message.toolsComplete = undefined;
  } else {
    message.toolsComplete = message.toolSteps.every((entry) => entry.status !== 'running' && entry.status !== 'pending');
  }
  if (!message.meta?.length) {
    message.meta = undefined;
  }
  if (typeof message.thinking === 'string') {
    const normalizedThinking = message.thinking.trim();
    message.thinking = normalizedThinking || undefined;
  }
  message._finalized = true;
}

function extractUserText(event: AgentEvent): string {
  return extractRawUserText(event);
}

export function buildChatMessages(history: AgentEvent[]): ChatMessage[] {
  const messages: MutableChatMessage[] = [];
  const toolOwners = new Map<string, MutableChatMessage>();
  let currentAssistant: MutableChatMessage | null = null;
  let turnIndex = -1;
  let assistantIndex = -1;

  const getCurrentAssistant = (timestamp: Date) => {
    if (currentAssistant && !currentAssistant._finalized) {
      if (timestamp.getTime() > currentAssistant.timestamp.getTime()) {
        currentAssistant.timestamp = timestamp;
      }
      return currentAssistant;
    }

    assistantIndex += 1;
    const assistant: MutableChatMessage = {
      id: `assistant-${assistantIndex}`,
      role: 'assistant',
      content: '',
      timestamp,
      toolSteps: [],
      toolsComplete: false,
      meta: [],
      streaming: false,
      images: [],
      files: [],
      _finalized: false,
    };
    messages.push(assistant);
    currentAssistant = assistant;
    return assistant;
  };

  for (let index = 0; index < history.length; index += 1) {
    const event = history[index];
    const timestamp = safeDate(event?.timestamp);

    const userText = event?.type === 'user' ? extractUserText(event) : '';

    if (event?.type === 'user' && userText) {
      finalizeAssistant(currentAssistant);
      turnIndex += 1;
      messages.push({
        id: `user-${turnIndex}`,
        role: 'user',
        content: userText,
        timestamp,
        images: event.images || [],
        files: event.files ? (event.files as string[]).filter((f: string) => !/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f)) : [],
      });
      currentAssistant = null;
      continue;
    }

    if (event?.type === 'user' && Array.isArray(event?.message?.content)) {
      const assistant = getCurrentAssistant(timestamp);
      const resultBlocks = event.message.content.filter((block: any) => block?.type === 'tool_result');
      if (resultBlocks.length > 0) {
        for (const block of resultBlocks) {
          const toolId = String(block.tool_use_id || '');
          const owner = (toolId && toolOwners.get(toolId)) || assistant;
          const step = ensureToolStep(owner, {
            id: toolId,
            tool_name: block.tool_name || 'Tool',
          });
          step.status = block.is_error ? 'error' : 'success';
          step.statusText = block.is_error ? '执行失败' : '执行完成';
          step.output = resultBlocks.length === 1 && event?.tool_use_result !== undefined
            ? event.tool_use_result
            : block.content;
          step.outputText = summarizeToolResultBlock(block);
          step.result = buildToolDetail(
            step.input,
            step.output !== undefined ? step.output : step.outputText,
          );

          const imagePaths = collectImagePathsFromToolResult(block.content);
          if (imagePaths.length > 0) {
            if (!owner.images) owner.images = [];
            for (const imagePath of imagePaths) {
              if (!owner.images.includes(imagePath)) {
                owner.images.push(imagePath);
              }
            }
          }
        }
      }
      continue;
    }

    if (event?.type === 'app_plan_state' && event?.kind === 'plan') {
      finalizeAssistant(currentAssistant);

      let content = '';
      if (event.state === 'awaiting_approval') {
        content = '执行计划已经生成，等待你确认后才会继续执行。';
      } else if (event.state === 'approved') {
        content = '已批准执行计划，任务将按计划继续。';
      } else if (event.state === 'rejected') {
        content = '已退回执行计划，当前不会继续执行。';
      }

      if (content) {
        assistantIndex += 1;
        messages.push({
          id: `assistant-${assistantIndex}`,
          role: 'assistant',
          content,
          timestamp,
          meta: ['计划'],
        });
      }

      currentAssistant = null;
      continue;
    }

    if (event?.type === 'stream_event') {
      const assistant = getCurrentAssistant(timestamp);
      assistant.streaming = true;
      const streamEvent = event?.event;
      if (streamEvent?.type === 'content_block_start' && streamEvent.content_block?.type === 'tool_use') {
        const step = ensureToolStep(assistant, streamEvent.content_block);
        step.status = 'running';
        step.statusText = '进行中';
        step.result = buildToolDetail(streamEvent.content_block.input);
        toolOwners.set(step.id, assistant);
      } else if (streamEvent?.type === 'content_block_start' && streamEvent.content_block?.type === 'thinking') {
        appendThinking(assistant, summarizeThinkingBlock(streamEvent.content_block));
      } else if (streamEvent?.type === 'content_block_delta') {
        if (streamEvent.delta?.type === 'text_delta' && typeof streamEvent.delta.text === 'string') {
          assistant.content += streamEvent.delta.text;
        } else if (streamEvent.delta?.type === 'thinking_delta' && typeof streamEvent.delta.thinking === 'string') {
          appendThinking(assistant, streamEvent.delta.thinking);
        } else if (streamEvent.delta?.type === 'input_json_delta') {
          const toolSteps = ensureToolSteps(assistant);
          const step = toolSteps[toolSteps.length - 1];
          if (step) {
            step.result = `${step.result || 'Input'}${step.result ? '\n' : '\n'}${streamEvent.delta.partial_json}`;
          }
        }
      }
      continue;
    }

    if (event?.type === 'tool_progress') {
      const assistant = getCurrentAssistant(timestamp);
      const toolId = String(event?.parent_tool_use_id || event?.tool_use_id || '');
      const owner = (toolId && toolOwners.get(toolId)) || assistant;
      const step = ensureToolStep(owner, {
        id: toolId,
        tool_name: event?.tool_name || 'Tool',
      });
      step.status = 'running';
      step.statusText = typeof event?.elapsed_time_seconds === 'number'
        ? `运行 ${event.elapsed_time_seconds}s`
        : '进行中';
      if (typeof event?.elapsed_time_seconds === 'number') {
        step.duration = event.elapsed_time_seconds * 1000;
      }
      continue;
    }

    if (event?.type === 'system') {
      const assistant = getCurrentAssistant(timestamp);
      const content = normalizeText(event?.content);
      if (content) {
        addMeta(assistant, content);
      }
      continue;
    }

    if (event?.type === 'assistant') {
      const currentAssistant = messages[messages.length - 1] as MutableChatMessage | undefined;
      const hasToolSteps = currentAssistant && currentAssistant.toolSteps && currentAssistant.toolSteps.some(
        (step) => step.status === 'success' || step.status === 'error',
      );

      // Preserve streaming thinking content — the completed message may contain
      // redacted_thinking which would replace the full streamed content.
      const preservedThinking = currentAssistant?.thinking || '';

      if (hasToolSteps) {
        // Multi-turn: finalize the previous assistant message (which has completed
        // tool calls) before starting a new one. This prevents tool call steps and
        // thinking from being discarded when a second response arrives.
        finalizeAssistant(currentAssistant!);
      }

      const assistant = getCurrentAssistant(timestamp);
      assistant.streaming = false;

      // Preserve streaming thinking if the new response doesn't include it.
      // Only carry over when the new response has no thinking blocks of its own
      // and the previous thinking was from streaming (not redacted).
      let preserveExistingThinking = false;
      if (!hasToolSteps && preservedThinking) {
        const hasThinkingBlock = Array.isArray(event?.message?.content) &&
          event.message.content.some(
            (block: any) => block?.type === 'thinking' || block?.type === 'redacted_thinking',
          );
        if (!hasThinkingBlock) {
          preserveExistingThinking = true;
        }
      }

      if (preserveExistingThinking) {
        assistant.thinking = preservedThinking;
      } else {
        assistant.thinking = '';
      }

      assistant.content = '';
      assistant.toolSteps = hasToolSteps ? [] : (assistant.toolSteps || []);
      assistant.meta = assistant.meta || [];
      assistant.images = [];
      assistant.files = [];
      assistant.toolsComplete = false;

      if (Array.isArray(event?.message?.content)) {
        for (const block of event.message.content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            appendText(assistant, block.text);
          } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
            appendThinking(assistant, summarizeThinkingBlock(block));
          } else if (block.type === 'tool_use') {
            const step = ensureToolStep(assistant, block);
            step.status = 'running';
            step.statusText = '进行中';
            step.result = buildToolDetail(block.input);
            toolOwners.set(step.id, assistant);
          } else if (block.type === 'image' && typeof block.source === 'object') {
            const imgSrc = block.source?.data || block.source?.url || '';
            if (imgSrc) {
              if (!assistant.images) assistant.images = [];
              if (!assistant.images.includes(imgSrc)) assistant.images.push(imgSrc);
            }
          }
        }
      }
      if (event?.error?.message) {
        addMeta(assistant, `错误: ${String(event.error.message)}`);
      }
      continue;
    }

    if (event?.type === 'result') {
      const assistant = getCurrentAssistant(timestamp);
      if (typeof event.duration_ms === 'number') addMeta(assistant, `耗时 ${event.duration_ms}ms`);
      if (typeof event.total_cost_usd === 'number') addMeta(assistant, `费用 $${event.total_cost_usd.toFixed(4)}`);
      if (event.subtype && event.subtype !== 'success') addMeta(assistant, `状态 ${String(event.subtype)}`);
      if (assistant.toolSteps?.length) {
        for (const step of assistant.toolSteps) {
          if (step.status === 'running' || step.status === 'pending') {
            step.status = event.subtype === 'success' ? 'success' : 'error';
            if (!step.statusText || step.statusText === '进行中' || step.statusText.startsWith('运行 ')) {
              step.statusText = event.subtype === 'success' ? '执行完成' : '执行失败';
            }
          }
        }
      }
      // If no assistant content was built from event stream (common in coordinator
      // mode where the final text lives only in the result event), use it directly.
      const resultText = typeof event.result === 'string' ? event.result.trim() : '';
      if (resultText && !assistant.content.trim()) {
        assistant.content = resultText;
      }
      finalizeAssistant(assistant);
      continue;
    }

    if (event?.type === 'error') {
      const assistant = getCurrentAssistant(timestamp);
      assistant.streaming = false;
      appendText(assistant, String(event?.message || 'Unknown error'));
      addMeta(assistant, '执行失败');
      finalizeAssistant(assistant);
      continue;
    }
  }

  finalizeAssistant(currentAssistant);
  return messages;
}
