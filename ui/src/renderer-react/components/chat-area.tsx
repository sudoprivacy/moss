"use client";

import * as React from "react";
import {
  Bot,
  FileText,
  FolderOpen,
  Plus,
  Send,
  Square,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { MessageList } from "@/components/chat/message-list";
import { FilePreview } from "@/components/file-preview";
import { WorkerThreadPanel } from "@/components/worker-thread-panel";
import { pasteService } from "@/lib/paste-service";
import type { TranscriptRenderMessage, WorkerThread } from "@/lib/agent-transcript";
import { AssistantSelectionArea, type InstalledAssistant } from "@/components/assistant-selection-area";

type ComposerIntent = "chat" | "plan" | "coordinator";
type PendingPlanApproval = {
  kind: "plan";
  originalPrompt: string;
  plan: string;
  requestedAt: number;
};

type IntentOption = {
  id: ComposerIntent;
  title: string;
  description?: string;
};

const chatIntentOption: IntentOption = {
  id: "chat",
  title: "chat",
};

const intentOptions: IntentOption[] = [
  {
    id: "coordinator",
    title: "boss",
    description: "主 agent 协调多个 worker 并行执行复杂任务",
  },
  {
    id: "plan",
    title: "plan",
    description: "规划任务步骤和执行计划",
  },
];

function SessionTabBar({
  title,
  messageCount,
  leftCollapsed,
  rightCollapsed,
  onToggleLeft,
  onToggleRight,
}: {
  title: string;
  messageCount: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
}) {
  return (
    <div className="shrink-0 border-b border-border/70 bg-background/88 px-3 py-2 backdrop-blur sm:px-4">
      <div className="mx-auto flex max-w-[980px] min-w-0 items-center justify-between gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-full"
          onClick={onToggleLeft}
          aria-label={leftCollapsed ? "展开左侧栏" : "收起左侧栏"}
        >
          {leftCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </Button>

        <div className="min-w-0 max-w-[calc(100%-6rem)] rounded-full border border-border/75 bg-card/88 px-4 py-1.5 shadow-[0_14px_40px_-34px_rgba(0,0,0,0.7)]">
          <div className="flex min-w-0 items-center justify-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {title || "New Session"}
            </span>
            <span className="shrink-0 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
              {messageCount} 条
            </span>
          </div>
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-full"
          onClick={onToggleRight}
          aria-label={rightCollapsed ? "展开右侧栏" : "收起右侧栏"}
        >
          {rightCollapsed ? <PanelRightOpen className="h-4 w-4" /> : <PanelRightClose className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}

function PlanApprovalCard({
  pendingPlanApproval,
  busy,
  onApprove,
  onReject,
}: {
  pendingPlanApproval: PendingPlanApproval;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="rounded-[24px] border border-primary/25 bg-card/92 p-4 shadow-[0_18px_55px_-40px_rgba(0,0,0,0.75)]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-primary">
          执行计划待确认
        </span>
        <span className="text-xs text-muted-foreground">
          批准后将启动独立子 Agent 执行
        </span>
      </div>
      <p className="mt-3 text-sm leading-7 text-foreground">
        <span className="font-medium">需求：</span>
        {pendingPlanApproval.originalPrompt}
      </p>
      <div className="mt-3 overflow-hidden rounded-2xl border border-border/70 bg-background/75">
        <div className="border-b border-border/70 px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
          已生成的计划
        </div>
        <pre className="max-h-[18rem] overflow-auto whitespace-pre-wrap break-words px-3 py-3 text-[12px] leading-6 text-foreground">
          {pendingPlanApproval.plan}
        </pre>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          className="rounded-full px-4"
          onClick={onApprove}
          disabled={busy}
        >
          {busy ? "正在执行..." : "批准并执行"}
        </Button>
        <Button
          variant="outline"
          className="rounded-full px-4"
          onClick={onReject}
          disabled={busy}
        >
          退回计划
        </Button>
      </div>
    </div>
  );
}

function ComposerPanel({
  value,
  selectedAppName,
  loading,
  readOnlyReason,
  composerIntent,
  hasActiveSession,
  sessionId,
  attachments: externalAttachments,
  onAttachmentsChange,
  workspace,
  onWorkspaceChange,
  onChange,
  onComposerIntentChange,
  onSend,
  onStop,
  selectedAssistant,
  onClearAssistant,
  className,
}: {
  value: string;
  selectedAppName: string;
  loading: boolean;
  readOnlyReason?: string | null;
  composerIntent: ComposerIntent;
  hasActiveSession: boolean;
  sessionId?: string;
  attachments?: Array<{ name: string; path: string }>;
  onAttachmentsChange?: (attachments: Array<{ name: string; path: string }>) => void;
  workspace?: string;
  onWorkspaceChange?: (workspace: string | undefined) => void;
  onChange: (value: string) => void;
  onComposerIntentChange: (intent: ComposerIntent) => void;
  selectedAssistant?: InstalledAssistant | null;
  onClearAssistant?: () => void;
  onSend: (files?: Array<{ name: string; path: string }>) => void;
  onStop?: () => void;
  className?: string;
}) {
  const [internalAttachments, setInternalAttachments] = React.useState<Array<{ name: string; path: string }>>([]);
  const attachments = externalAttachments ?? internalAttachments;
  const setAttachments = React.useCallback((
    updater: Array<{ name: string; path: string }> | ((prev: Array<{ name: string; path: string }>) => Array<{ name: string; path: string }>)
  ) => {
    if (typeof updater === 'function') {
      if (onAttachmentsChange) {
        onAttachmentsChange(updater(externalAttachments ?? internalAttachments));
      } else {
        setInternalAttachments(updater);
      }
    } else {
      onAttachmentsChange?.(updater);
    }
  }, [onAttachmentsChange, externalAttachments, internalAttachments]);
  const composerId = React.useRef<string>('composer-' + Math.random().toString(36).slice(2));
  const isHomeComposer = !hasActiveSession;
  const submitDisabled =
    (!value.trim() && attachments.length === 0) || loading || Boolean(readOnlyReason);

  React.useEffect(() => {
    pasteService.init();
    pasteService.registerHandler(composerId.current, async (event) => {
      const handled = await pasteService.handlePaste(
        event,
        (files) => setAttachments(prev => [...prev, ...files]),
        undefined
      );
      return handled;
    });
    pasteService.setLastFocusedComponent(composerId.current);
    return () => {
      pasteService.unregisterHandler(composerId.current);
    };
  }, []);

  const handleDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    const newAttachments: Array<{ name: string; path: string }> = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const filePath = (file as File & { path?: string }).path;
      if (filePath) {
        newAttachments.push({ name: file.name, path: filePath });
      } else if (file.type.startsWith('image/')) {
        const ext = file.name.split('.').pop() || 'png';
        const fileName = file.name || `pasted_image.${ext}`;
        try {
          const arrayBuffer = await file.arrayBuffer();
          const data = Array.from(new Uint8Array(arrayBuffer));
          let savedPath: string | null = null;
          if (sessionId) {
            const result = await window.agentDesktop.fs.saveImageToWorkspace(sessionId, fileName, data) as { path: string } | { error: string };
            if ('path' in result) savedPath = result.path;
          }
          if (!savedPath) {
            const tempPath = await window.agentDesktop.fs.createTempFile(fileName);
            if (tempPath) {
              await window.agentDesktop.fs.writeFile(tempPath, data);
              savedPath = tempPath;
            }
          }
          if (savedPath) {
            newAttachments.push({ name: fileName, path: savedPath });
          }
        } catch (err) {
          console.error('Failed to save dropped image:', err);
        }
      }
    }
    if (newAttachments.length > 0) {
      setAttachments(prev => [...prev, ...newAttachments]);
    }
  };

  const handleRemoveAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const handleSelectFile = async () => {
    const files = await window.agentDesktop.pickFiles();
    if (files.length > 0) {
      setAttachments(prev => [...prev, ...files]);
    }
  };

  const handleSelectDirectory = async () => {
    const dir = await window.agentDesktop.pickDirectory();
    if (dir) {
      onWorkspaceChange?.(dir);
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const clipboardItems = e.clipboardData?.items;
    if (!clipboardItems) return;

    const newAttachments: Array<{ name: string; path: string }> = [];
    for (let i = 0; i < clipboardItems.length; i++) {
      const item = clipboardItems[i];
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          const ext = item.type.split('/')[1] || 'png';
          const fileName = file.name || `pasted_image.${ext}`;
          try {
            const arrayBuffer = await file.arrayBuffer();
            const data = Array.from(new Uint8Array(arrayBuffer));

            let savedPath: string | null = null;
            if (sessionId) {
              const result = await window.agentDesktop.fs.saveImageToWorkspace(sessionId, fileName, data) as { path: string } | { error: string };
              if ('path' in result) savedPath = result.path;
            }
            if (!savedPath) {
              // Fallback to temp file
              const tempPath = await window.agentDesktop.fs.createTempFile(fileName);
              if (tempPath) {
                await window.agentDesktop.fs.writeFile(tempPath, data);
                savedPath = tempPath;
              }
            }

            if (savedPath) {
              newAttachments.push({ name: fileName, path: savedPath });
            }
          } catch (err) {
            console.error('Failed to save pasted image:', err);
          }
        }
      }
    }
    if (newAttachments.length > 0) {
      e.preventDefault();
      setAttachments(prev => [...prev, ...newAttachments]);
    }
  };

  const handleSendClick = () => {
    const files = attachments.length > 0 ? attachments : undefined;
    onSend(files);
    setAttachments([]);
  };

  return (
    <div
      className={cn(
        "rounded-[26px] border border-border/80 bg-card/92 backdrop-blur",
        isHomeComposer
          ? "shadow-[0_24px_80px_-44px_rgba(0,0,0,0.55)]"
          : "shadow-[0_16px_54px_-38px_rgba(0,0,0,0.45)]",
        className,
      )}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="relative">
        <Textarea
          placeholder={
            readOnlyReason
              ? readOnlyReason
              : (
            isHomeComposer
              ? selectedAssistant?.name === "app-builder-assistant" && selectedAppName
                ? `描述你想如何修改 ${selectedAppName}...`
                : selectedAssistant?.name === "app-builder-assistant"
                  ? "描述你想创建或修改的 App、目标用户、交互和风格..."
                  : composerIntent === "coordinator"
                    ? "描述复杂任务，我会启动多个 worker 并行执行..."
                    : composerIntent === "plan"
                    ? "描述需求，我会先给出计划..."
                      : "输入任务、问题或想法..."
              : "继续输入消息..."
              )
          }
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={Boolean(readOnlyReason)}
          className={cn(
            "resize-none border-0 bg-transparent px-4 pt-4 text-sm leading-6 text-foreground caret-primary placeholder:text-muted-foreground/70 focus-visible:ring-0 sm:px-5",
            isHomeComposer
              ? "min-h-[160px] pb-4"
              : "min-h-[64px] max-h-[120px] overflow-y-auto pb-3 [field-sizing:fixed]",
          )}
          rows={isHomeComposer ? 5 : 2}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              if (submitDisabled) {
                return;
              }
              event.preventDefault();
              void handleSendClick();
            }
          }}
          onPaste={handlePaste}
        />

        {readOnlyReason && (
          <div className="px-4 pb-2 text-xs text-amber-600">
            当前会话不可继续输入：{readOnlyReason}
          </div>
        )}

      </div>

      {!isHomeComposer && (
        <div className="px-4 py-2 sm:px-5">
          {attachments.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {attachments.map((file, index) => (
                <FilePreview
                  key={`${file.path}-${index}`}
                  path={file.path}
                  onRemove={() => handleRemoveAttachment(index)}
                />
              ))}
            </div>
          )}

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleSelectFile}
                className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/35 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                title="选择文件"
              >
                <Plus className="h-3 w-3" />
                <FileText className="h-3.5 w-3.5" />
                <span>文件</span>
              </button>

              {selectedAssistant && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs text-primary">
                  <Bot className="h-3 w-3" />
                  <span>{selectedAssistant.displayName || selectedAssistant.name}</span>
                  <button
                    type="button"
                    onClick={onClearAssistant}
                    className="ml-0.5 rounded-full p-0.5 hover:bg-primary/20"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )}

              <span className="text-xs text-muted-foreground">模式：</span>
              {[chatIntentOption, ...intentOptions].map((option) => {
                const isSelected = composerIntent === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => onComposerIntentChange(option.id)}
                    className={cn(
                      "inline-flex items-center rounded-full border px-2 py-1 text-xs transition-colors",
                      isSelected
                        ? "border-green-500/50 bg-green-500/15 text-green-600"
                        : "border-border/70 bg-muted/35 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    )}
                  >
                    {option.title}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center justify-end gap-2">
              {loading && (
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 rounded-full"
                  onClick={onStop}
                >
                  <Square className="h-3.5 w-3.5" />
                </Button>
              )}

              <Button
                className="h-9 rounded-full px-3.5 sm:px-4"
                disabled={submitDisabled}
                onClick={handleSendClick}
              >
                <Send className="h-4 w-4" />
                发送
              </Button>
            </div>
          </div>
        </div>
      )}

      {isHomeComposer && (
        <div className="px-4 py-3 sm:px-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleSelectFile}
                className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/35 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                title="选择文件"
              >
                <Plus className="h-3 w-3" />
                <FileText className="h-3.5 w-3.5" />
                <span>文件</span>
              </button>
              <button
                type="button"
                onClick={handleSelectDirectory}
                className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/35 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                title="选择目录"
              >
                <Plus className="h-3 w-3" />
                <FolderOpen className="h-3.5 w-3.5" />
                <span>目录</span>
              </button>

              <span className="ml-2 text-xs text-muted-foreground">模式：</span>
              {[chatIntentOption, ...intentOptions].map((option) => {
                const isSelected = composerIntent === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => onComposerIntentChange(option.id)}
                    className={cn(
                      "inline-flex items-center rounded-full border px-2.5 py-1.5 text-xs transition-colors",
                      isSelected
                        ? "border-green-500/50 bg-green-500/15 text-green-600"
                        : "border-border/70 bg-muted/35 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    )}
                  >
                    {option.title}
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              {selectedAssistant && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs text-primary">
                  <Bot className="h-3 w-3" />
                  <span>{selectedAssistant.displayName || selectedAssistant.name}</span>
                  <button
                    type="button"
                    onClick={onClearAssistant}
                    className="ml-0.5 rounded-full p-0.5 hover:bg-primary/20"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )}

              {selectedAssistant?.name === "app-builder-assistant" && selectedAppName && (
                <span className="rounded-full border border-border/70 bg-muted/60 px-2.5 py-1 text-xs text-muted-foreground">
                  更新 {selectedAppName}
                </span>
              )}

              <Button
                className="h-9 rounded-full px-3.5 sm:px-4"
                disabled={submitDisabled}
                onClick={handleSendClick}
              >
                <Send className="h-4 w-4" />
                发送
              </Button>
            </div>
          </div>

          {(attachments.length > 0 || workspace) && (
            <div className="mt-3 pt-1">
              <div className="flex flex-wrap items-center gap-2">
                {attachments.map((file, index) => (
                  <span
                    key={`${file.path}-${index}`}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/70 bg-muted/60 px-2.5 py-1 text-xs text-foreground"
                  >
                    <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="max-w-[180px] truncate">{file.name}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveAttachment(index)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}

                {workspace && (
                  <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-green-500/30 bg-green-500/10 px-2.5 py-1 text-xs text-green-600">
                    <FolderOpen className="h-3 w-3 shrink-0" />
                    <span className="max-w-[220px] truncate">{workspace.split('/').pop() || workspace}</span>
                    <button
                      type="button"
                      onClick={() => onWorkspaceChange?.(undefined)}
                      className="text-green-600/60 hover:text-green-600"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

    </div>
  );
}

function HomeLanding({
  value,
  selectedAppName,
  loading,
  composerIntent,
  sessionId,
  attachments,
  onAttachmentsChange,
  workspace,
  onWorkspaceChange,
  onChange,
  onComposerIntentChange,
  onSend,
  installedAssistants,
  selectedAssistant,
  onSelectAssistant,
  onClearAssistant,
  remoteEnabled,
  newSessionMode,
  onNewSessionModeChange,
}: {
  value: string;
  selectedAppName: string;
  loading: boolean;
  composerIntent: ComposerIntent;
  sessionId?: string;
  attachments: Array<{ name: string; path: string }>;
  onAttachmentsChange: (attachments: Array<{ name: string; path: string }>) => void;
  workspace?: string;
  onWorkspaceChange: (workspace: string | undefined) => void;
  onChange: (value: string) => void;
  onComposerIntentChange: (intent: ComposerIntent) => void;
  onSend: (files?: Array<{ name: string; path: string }>) => void;
  installedAssistants?: InstalledAssistant[];
  selectedAssistant?: InstalledAssistant | null;
  onSelectAssistant?: (assistant: InstalledAssistant) => void;
  onClearAssistant?: () => void;
  remoteEnabled?: boolean;
  newSessionMode?: 'local' | 'remote-direct';
  onNewSessionModeChange?: (mode: 'local' | 'remote-direct') => void;
}) {
  return (
      <div className="flex h-full w-full min-w-0 flex-col items-center justify-center px-4 py-4 sm:px-6 sm:py-6">
      <div className="mx-auto mb-8 text-center sm:mb-10 w-full max-w-[720px]">
        <h1 className="text-2xl font-medium tracking-[-0.02em] text-foreground sm:text-3xl">
          Hi，今天有什么安排？
        </h1>
        <p className="mx-auto mt-3 max-w-[560px] text-sm leading-7 text-muted-foreground sm:text-base">
          让 moss 帮你规划任务、协同执行，或者通过助手直接开始一个新的构建目标。
        </p>
      </div>

      {remoteEnabled && (
        <div className="mx-auto mb-4 w-full max-w-[720px] flex flex-wrap justify-center gap-4">
          <button
            type="button"
            onClick={() => onNewSessionModeChange?.('local')}
            className={cn(
              "rounded-full border px-6 py-3 text-sm font-medium shadow-[0_8px_30px_-8px_rgba(0,0,0,0.4)] backdrop-blur transition-all",
              newSessionMode !== 'remote-direct'
                ? "border-green-500/50 bg-green-500/15 text-green-600 hover:bg-green-500/20 hover:-translate-y-0.5 hover:shadow-[0_14px_40px_-12px_rgba(0,0,0,0.5)]"
                : "border-border/70 bg-card/60 text-foreground hover:-translate-y-0.5 hover:bg-card/80 hover:shadow-[0_14px_40px_-12px_rgba(0,0,0,0.5)]"
            )}
          >
            本地
          </button>
          <button
            type="button"
            onClick={() => onNewSessionModeChange?.('remote-direct')}
            className={cn(
              "rounded-full border px-6 py-3 text-sm font-medium shadow-[0_8px_30px_-8px_rgba(0,0,0,0.4)] backdrop-blur transition-all",
              newSessionMode === 'remote-direct'
                ? "border-green-500/50 bg-green-500/15 text-green-600 hover:bg-green-500/20 hover:-translate-y-0.5 hover:shadow-[0_14px_40px_-12px_rgba(0,0,0,0.5)]"
                : "border-border/70 bg-card/60 text-foreground hover:-translate-y-0.5 hover:bg-card/80 hover:shadow-[0_14px_40px_-12px_rgba(0,0,0,0.5)]"
            )}
          >
            远程
          </button>
        </div>
      )}

      <ComposerPanel
        value={value}
        selectedAppName={selectedAppName}
        loading={loading}
        composerIntent={composerIntent}
        hasActiveSession={false}
        sessionId={sessionId}
        attachments={attachments}
        onAttachmentsChange={onAttachmentsChange}
        workspace={workspace}
        onWorkspaceChange={onWorkspaceChange}
        onChange={onChange}
        onComposerIntentChange={onComposerIntentChange}
        onSend={onSend}
        selectedAssistant={selectedAssistant ?? null}
        onClearAssistant={onClearAssistant}
        className="w-full max-w-[720px]"
      />
      {installedAssistants && onSelectAssistant && (
      <div className="mx-auto mt-8 w-full max-w-[720px] min-w-0">
          <AssistantSelectionArea
            assistants={installedAssistants}
            selectedAssistant={selectedAssistant ?? null}
            onSelectAssistant={onSelectAssistant}
          />
        </div>
      )}
    </div>
  );
}

export function ChatArea({
  messages,
  value,
  selectedAppName,
  loading,
  readOnlyReason,
  hasActiveSession,
  sessionTitle,
  sessionMessageCount,
  sessionId,
  sessionWorkspace,
  pendingPlanApproval,
  planDecisionBusy,
  leftCollapsed,
  rightCollapsed,
  composerIntent,
  workerThreads,
  archivedWorkerRounds,
  activeWorkerThreadId,
  onChange,
  onComposerIntentChange,
  onToggleLeftSidebar,
  onToggleRightSidebar,
  onApprovePlan,
  onRejectPlan,
  onSend,
  onStop,
  onToggleWorkerThread,
  installedAssistants,
  selectedAssistant,
  onSelectAssistant,
  onClearAssistant,
  remoteEnabled,
  newSessionMode,
  onNewSessionModeChange,
}: {
  messages: TranscriptRenderMessage[];
  value: string;
  selectedAppName: string;
  loading: boolean;
  readOnlyReason?: string | null;
  hasActiveSession: boolean;
  sessionTitle: string;
  sessionMessageCount: number;
  sessionId?: string;
  sessionWorkspace?: string;
  pendingPlanApproval: PendingPlanApproval | null;
  planDecisionBusy: boolean;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  composerIntent: ComposerIntent;
  workerThreads: WorkerThread[];
  archivedWorkerRounds: WorkerThread[][];
  activeWorkerThreadId: string | null;
  onChange: (value: string) => void;
  onComposerIntentChange: (intent: ComposerIntent) => void;
  onToggleLeftSidebar: () => void;
  onToggleRightSidebar: () => void;
  onApprovePlan: () => void;
  onRejectPlan: () => void;
  onSend: (files?: Array<{ name: string; path: string }>, workspace?: string) => void;
  onStop: () => void;
  onToggleWorkerThread: (threadId: string | null) => void;
  installedAssistants?: InstalledAssistant[];
  selectedAssistant?: InstalledAssistant | null;
  onSelectAssistant?: (assistant: InstalledAssistant) => void;
  onClearAssistant?: () => void;
  remoteEnabled?: boolean;
  newSessionMode?: 'local' | 'remote-direct';
  onNewSessionModeChange?: (mode: 'local' | 'remote-direct') => void;
}) {
  const bottomRef = React.useRef<HTMLDivElement | null>(null);
  const [attachments, setAttachments] = React.useState<Array<{ name: string; path: string }>>([]);
  const [workspace, setWorkspace] = React.useState<string | undefined>();

  React.useEffect(() => {
    if (hasActiveSession) {
      setAttachments([]);
      setWorkspace(undefined);
    }
  }, [hasActiveSession]);

  const handleHomeLandingSend = (files: Array<{ name: string; path: string }> | undefined) => {
    onSend(files, workspace);
  };

  if (!hasActiveSession) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col bg-[radial-gradient(circle_at_top_left,rgba(58,191,129,0.12),transparent_24%),radial-gradient(circle_at_80%_10%,rgba(255,176,32,0.1),transparent_24%),var(--background)]">
        <HomeLanding
          value={value}
          selectedAppName={selectedAppName}
          loading={loading}
          composerIntent={composerIntent}
          sessionId={sessionId}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          workspace={workspace}
          onWorkspaceChange={setWorkspace}
          onChange={onChange}
          onComposerIntentChange={onComposerIntentChange}
          onSend={handleHomeLandingSend}
          installedAssistants={installedAssistants}
          selectedAssistant={selectedAssistant ?? null}
          onSelectAssistant={onSelectAssistant}
          onClearAssistant={onClearAssistant ?? (() => {})}
          remoteEnabled={remoteEnabled}
          newSessionMode={newSessionMode}
          onNewSessionModeChange={onNewSessionModeChange}
        />
        <div className="shrink-0 px-3 pb-4 sm:px-4" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-[radial-gradient(circle_at_top_left,rgba(58,191,129,0.08),transparent_22%),var(--background)]">
      <SessionTabBar
        title={sessionTitle}
        messageCount={sessionMessageCount}
        leftCollapsed={leftCollapsed}
        rightCollapsed={rightCollapsed}
        onToggleLeft={onToggleLeftSidebar}
        onToggleRight={onToggleRightSidebar}
      />

      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <div className="min-w-0">
          <MessageList messages={messages} bottomRef={bottomRef} workspace={sessionWorkspace} loading={loading} />
          {pendingPlanApproval && (
            <div className="mx-auto w-full max-w-[980px] px-3 pb-3 sm:px-4 sm:pb-4">
              <PlanApprovalCard
                pendingPlanApproval={pendingPlanApproval}
                busy={planDecisionBusy || loading}
                onApprove={onApprovePlan}
                onReject={onRejectPlan}
              />
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="shrink-0 min-w-0 bg-background/94 px-3 py-3 backdrop-blur sm:px-4">
        <div className="mx-auto max-w-[980px] min-w-0">
          <WorkerThreadPanel
            threads={workerThreads}
            archivedRounds={archivedWorkerRounds}
            activeThreadId={activeWorkerThreadId}
            onToggleThread={onToggleWorkerThread}
          />
          <ComposerPanel
            value={value}
            selectedAppName={selectedAppName}
            loading={loading}
            readOnlyReason={readOnlyReason}
            composerIntent={composerIntent}
            hasActiveSession
            sessionId={sessionId}
            onChange={onChange}
            onComposerIntentChange={onComposerIntentChange}
            onSend={onSend}
            onStop={onStop}
            selectedAssistant={selectedAssistant ?? null}
            onClearAssistant={onClearAssistant}
          />
        </div>
      </div>
    </div>
  );
}
