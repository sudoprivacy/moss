"use client";

import * as React from "react";
import {
  ExternalLink,
  Eye,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  Globe,
  History,
  MonitorUp,
  MoreHorizontal,
  Pencil,
  Presentation,
  RotateCcw,
  Save,
  X,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { PreviewHistoryTarget, PreviewSnapshotInfo, WorkspacePreviewData } from "@/types";
import { basename, formatFileSize } from "@/components/preview/viewers/utils";
import { previewHistoryIpc } from "@/ipc/previewHistory.ipc";
import { shellIpc } from "@/ipc/shell.ipc";
import { workspaceIpc } from "@/ipc/workspace.ipc";
import { MarkdownViewer } from "@/components/preview/viewers/MarkdownViewer";
import { HTMLViewer } from "@/components/preview/viewers/HTMLViewer";
import { CodeViewer } from "@/components/preview/viewers/CodeViewer";
import { TextViewer } from "@/components/preview/viewers/TextViewer";
import { ImageViewer } from "@/components/preview/viewers/ImageViewer";
import { PDFViewer } from "@/components/preview/viewers/PDFViewer";
import { WordViewer } from "@/components/preview/viewers/WordViewer";
import { ExcelViewer } from "@/components/preview/viewers/ExcelViewer";
import { PPTViewer } from "@/components/preview/viewers/PPTViewer";
import { DiffViewer } from "@/components/preview/viewers/DiffViewer";
import { URLViewer } from "@/components/preview/viewers/URLViewer";
import { UnsupportedViewer } from "@/components/preview/viewers/UnsupportedViewer";

function getPreviewMeta(file: WorkspacePreviewData) {
  switch (file.contentType) {
    case "markdown":
      return { label: "Markdown", icon: FileText };
    case "html":
      return { label: "HTML", icon: Globe };
    case "image":
      return { label: "Image", icon: FileImage };
    case "pdf":
      return { label: "PDF", icon: FileType2 };
    case "word":
      return { label: "Word", icon: FileText };
    case "excel":
      return { label: "Excel", icon: FileSpreadsheet };
    case "ppt":
      return { label: "PPT", icon: Presentation };
    case "diff":
      return { label: "Diff", icon: FileCode2 };
    case "url":
      return { label: "URL", icon: Globe };
    case "text":
      return { label: "Text", icon: FileText };
    case "unsupported":
      return { label: "Unsupported", icon: FileType2 };
    case "code":
    default:
      return { label: "Code", icon: FileCode2 };
  }
}

function buildHistoryTarget(file: WorkspacePreviewData): PreviewHistoryTarget {
  const metadata = ((file.metadata as Record<string, unknown> | undefined) || {}) as Record<string, unknown>;
  return {
    contentType: file.contentType,
    filePath: file.path.startsWith("preview:") ? undefined : file.path,
    workspace: file.path.startsWith("preview:") ? undefined : typeof metadata.workspace === "string" ? metadata.workspace : undefined,
    fileName: basename(file.path),
    title: file.relativePath,
    language: file.language,
  };
}

function canPersistPreview(file: WorkspacePreviewData): boolean {
  const metadata = getPreviewMetadata(file);
  return (
    Boolean(file.content) &&
    metadata.previewSaveable !== false &&
    ["markdown", "html", "text", "code", "diff", "url", "unsupported"].includes(file.contentType)
  );
}

function canEditPreview(file: WorkspacePreviewData): boolean {
  const metadata = getPreviewMetadata(file);
  return (
    metadata.previewEditable !== false &&
    ["markdown", "html", "text", "code", "diff", "url", "unsupported"].includes(file.contentType)
  );
}

type PreviewDrawerMetadata = Record<string, unknown> & {
  sessionId?: string;
  workspace?: string;
  originalContent?: string;
  dirty?: boolean;
  lastSavedAt?: number;
  autoSavedAt?: number;
  draftToken?: string;
  previewEditable?: boolean;
  previewSaveable?: boolean;
  previewReason?: string;
};

function getPreviewMetadata(file: WorkspacePreviewData | null | undefined): PreviewDrawerMetadata {
  return ((file?.metadata as PreviewDrawerMetadata | undefined) || {}) as PreviewDrawerMetadata;
}

function isDirtyPreview(file: WorkspacePreviewData | null | undefined): boolean {
  return Boolean(getPreviewMetadata(file).dirty);
}

function canSavePreview(file: WorkspacePreviewData | null | undefined): boolean {
  if (!file || file.path.startsWith("preview:")) return false;
  if (!canEditPreview(file)) return false;
  const metadata = getPreviewMetadata(file);
  return typeof metadata.sessionId === "string" && metadata.sessionId.length > 0;
}

function buildDirtyMetadata(file: WorkspacePreviewData, content: string): PreviewDrawerMetadata {
  const metadata = getPreviewMetadata(file);
  const originalContent = typeof metadata.originalContent === "string" ? metadata.originalContent : "";
  return {
    ...metadata,
    originalContent,
    dirty: content !== originalContent,
    draftToken: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

function PreviewViewer({ file }: { file: WorkspacePreviewData }) {
  switch (file.contentType) {
    case "image":
      return <ImageViewer filePath={file.path} alt={file.relativePath} />;
    case "pdf":
      return <PDFViewer filePath={file.path} title={file.relativePath} />;
    case "markdown":
      return <MarkdownViewer content={file.content} />;
    case "html":
      return <HTMLViewer content={file.content} filePath={file.path} />;
    case "word":
      return <WordViewer filePath={file.path} />;
    case "excel":
      return <ExcelViewer filePath={file.path} />;
    case "ppt":
      return <PPTViewer filePath={file.path} />;
    case "diff":
      return <DiffViewer content={file.content} />;
    case "url":
      return <URLViewer url={file.content} />;
    case "code":
      return <CodeViewer content={file.content} language={file.language} />;
    case "text":
      return <TextViewer content={file.content} />;
    case "unsupported":
      return <UnsupportedViewer title="暂不支持预览" description={file.content || "当前文件类型无法在应用内展示。"} />;
    default:
      return <TextViewer content={file.content} />;
  }
}

export function PreviewDrawer({
  visible,
  tabs,
  activePath,
  onActivate,
  onUpdateTab,
  onCloseTab,
  onCloseOthers,
  onCloseAll,
  onCloseDrawer,
}: {
  visible: boolean;
  tabs: WorkspacePreviewData[];
  activePath: string | null;
  onActivate: (path: string) => void;
  onUpdateTab: (path: string, patch: Partial<WorkspacePreviewData>) => void;
  onCloseTab: (path: string) => void;
  onCloseOthers: (path: string) => void;
  onCloseAll: () => void;
  onCloseDrawer: () => void;
}) {
  const activeFile = React.useMemo(
    () => tabs.find((entry) => entry.path === activePath) || tabs[0] || null,
    [tabs, activePath]
  );
  const [historyItems, setHistoryItems] = React.useState<PreviewSnapshotInfo[]>([]);
  const [historyBusy, setHistoryBusy] = React.useState(false);
  const [actionNotice, setActionNotice] = React.useState<string | null>(null);
  const [editMode, setEditMode] = React.useState(false);
  const [saveBusy, setSaveBusy] = React.useState(false);
  const autoSavedContentRef = React.useRef<Map<string, string>>(new Map());
  const historyTarget = React.useMemo(
    () => (activeFile ? buildHistoryTarget(activeFile) : null),
    [activeFile]
  );
  const persistable = Boolean(activeFile && canPersistPreview(activeFile));
  const editable = Boolean(activeFile && canEditPreview(activeFile));
  const saveable = Boolean(activeFile && canSavePreview(activeFile));
  const dirtyTabs = React.useMemo(() => tabs.filter((tab) => isDirtyPreview(tab)), [tabs]);
  const activeMetadata = getPreviewMetadata(activeFile);
  const activeDirty = isDirtyPreview(activeFile);

  React.useEffect(() => {
    if (!activeFile || !activePath) return;
    if (activeFile.path !== activePath) {
      onActivate(activeFile.path);
    }
  }, [activeFile, activePath, onActivate]);

  React.useEffect(() => {
    if (!historyTarget || !persistable) {
      setHistoryItems([]);
      return;
    }
    let cancelled = false;
    setHistoryBusy(true);
    void previewHistoryIpc.list({ target: historyTarget })
      .then((items) => {
        if (!cancelled) setHistoryItems(items);
      })
      .catch(() => {
        if (!cancelled) setHistoryItems([]);
      })
      .finally(() => {
        if (!cancelled) setHistoryBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [historyTarget, persistable, activeFile?.path, activeFile?.content]);

  React.useEffect(() => {
    if (!actionNotice) return;
    const timer = window.setTimeout(() => setActionNotice(null), 2200);
    return () => window.clearTimeout(timer);
  }, [actionNotice]);

  React.useEffect(() => {
    setEditMode(false);
  }, [activeFile?.path]);

  React.useEffect(() => {
    if (!activeFile || !persistable) return;
    const draftToken = activeMetadata.draftToken;
    if (!draftToken) return;
    const timer = window.setTimeout(() => {
      const lastSaved = autoSavedContentRef.current.get(activeFile.path);
      if (lastSaved === activeFile.content) return;
      void previewHistoryIpc.save({
        target: buildHistoryTarget(activeFile),
        content: activeFile.content,
      }).then((snapshot) => {
        autoSavedContentRef.current.set(activeFile.path, activeFile.content);
        setHistoryItems((prev) => [snapshot, ...prev.filter((entry) => entry.id !== snapshot.id)].slice(0, 12));
        onUpdateTab(activeFile.path, {
          metadata: {
            ...activeMetadata,
            autoSavedAt: Date.now(),
          },
        });
      }).catch(() => undefined);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [activeFile, activeMetadata, persistable, onUpdateTab]);

  React.useEffect(() => {
    if (!editMode || !activeFile || !saveable) return;
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      void handleSaveToWorkspace();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [editMode, activeFile, saveable]);

  if (!visible || !activeFile) return null;

  const meta = getPreviewMeta(activeFile);
  const MetaIcon = meta.icon;
  const isVirtualPreview = activeFile.path.startsWith("preview:");

  const confirmDiscard = (targets: WorkspacePreviewData[], message: string) => {
    if (targets.length === 0) return true;
    return window.confirm(message);
  };

  const handleOpenInSystem = async () => {
    try {
      if (activeFile.contentType === "url") {
        await shellIpc.openExternal(activeFile.content);
      } else if (!isVirtualPreview) {
        await shellIpc.openFile(activeFile.path);
      } else {
        return;
      }
      setActionNotice("已打开外部预览。");
    } catch {
      setActionNotice("外部打开失败。");
    }
  };

  const handleSaveSnapshot = async () => {
    if (!persistable || !historyTarget) return;
    try {
      const payloadContent = activeFile.contentType === "url" ? activeFile.content : activeFile.content;
      const snapshot = await previewHistoryIpc.save({
        target: historyTarget,
        content: payloadContent,
      });
      autoSavedContentRef.current.set(activeFile.path, payloadContent);
      setHistoryItems((prev) => [snapshot, ...prev.filter((entry) => entry.id !== snapshot.id)]);
      setActionNotice("已保存快照。");
    } catch {
      setActionNotice("保存快照失败。");
    }
  };

  const handleLoadSnapshot = async (snapshotId: string) => {
    if (!historyTarget) return;
    try {
      const result = await previewHistoryIpc.getContent({
        target: historyTarget,
        snapshotId,
      });
      if (!result) {
        setActionNotice("历史快照不存在。");
        return;
      }
      onUpdateTab(activeFile.path, {
        content: result.content,
        contentType: activeFile.contentType,
        truncated: false,
        metadata: {
          ...buildDirtyMetadata(activeFile, result.content),
          draftToken: undefined,
        },
      });
      autoSavedContentRef.current.set(activeFile.path, result.content);
      setActionNotice("已载入历史快照。");
    } catch {
      setActionNotice("载入快照失败。");
    }
  };

  const handleEditorChange = (nextValue: string) => {
    onUpdateTab(activeFile.path, {
      content: nextValue,
      truncated: false,
      metadata: buildDirtyMetadata(activeFile, nextValue),
    });
  };

  const handleSaveToWorkspace = async () => {
    if (!saveable) return;
    const sessionId = activeMetadata.sessionId;
    if (typeof sessionId !== "string" || !sessionId) return;
    setSaveBusy(true);
    try {
      const saved = await workspaceIpc.writeFile({
        sessionId,
        filePath: activeFile.path,
        content: activeFile.content,
      });
      const nextOriginalContent = canEditPreview(saved) ? saved.content : activeFile.content;
      onUpdateTab(activeFile.path, {
        ...saved,
        content: activeFile.content,
        truncated: false,
        metadata: {
          ...(saved.metadata || {}),
          ...activeMetadata,
          originalContent: nextOriginalContent,
          dirty: false,
          draftToken: undefined,
          lastSavedAt: Date.now(),
        },
      });
      autoSavedContentRef.current.set(activeFile.path, activeFile.content);
      setActionNotice("已保存到工作区文件。");
    } catch {
      setActionNotice("保存失败。");
    } finally {
      setSaveBusy(false);
    }
  };

  const handleRevertChanges = () => {
    const originalContent = typeof activeMetadata.originalContent === "string" ? activeMetadata.originalContent : "";
    if (!activeDirty) return;
    if (!window.confirm("放弃当前未保存修改并恢复到上次保存内容？")) return;
    onUpdateTab(activeFile.path, {
      content: originalContent,
      truncated: false,
      metadata: {
        ...activeMetadata,
        dirty: false,
        draftToken: undefined,
      },
    });
    setActionNotice("已恢复到上次保存内容。");
  };

  const handleCloseTabWithConfirm = (path: string) => {
    const target = tabs.find((tab) => tab.path === path);
    if (!target) return;
    if (!confirmDiscard(isDirtyPreview(target) ? [target] : [], "当前文件有未保存修改，确认关闭？")) return;
    onCloseTab(path);
  };

  const handleCloseOthersWithConfirm = (path: string) => {
    const targets = tabs.filter((tab) => tab.path !== path && isDirtyPreview(tab));
    if (!confirmDiscard(targets, `有 ${targets.length} 个其他预览存在未保存修改，确认关闭？`)) return;
    onCloseOthers(path);
  };

  const handleCloseAllWithConfirm = () => {
    if (!confirmDiscard(dirtyTabs, `有 ${dirtyTabs.length} 个预览存在未保存修改，确认全部关闭？`)) return;
    onCloseAll();
  };

  const handleCloseDrawerWithConfirm = () => {
    if (!confirmDiscard(dirtyTabs, `有 ${dirtyTabs.length} 个预览存在未保存修改，确认关闭预览抽屉？`)) return;
    onCloseDrawer();
  };

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-border/70 bg-[linear-gradient(180deg,color-mix(in_oklab,var(--card)_94%,transparent),color-mix(in_oklab,var(--background)_92%,transparent))]">
      <div className="border-b border-border/70 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <MonitorUp className="h-4 w-4 text-primary" />
              <span>文件预览</span>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">{activeFile.relativePath}</p>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 rounded-full" onClick={handleCloseDrawerWithConfirm}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <ScrollArea className="border-b border-border/70">
        <div className="flex gap-2 px-3 py-2.5">
          {tabs.map((tab) => (
            <button
              key={tab.path}
              type="button"
              onClick={() => onActivate(tab.path)}
              className={cn(
                "group flex max-w-full shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors",
                tab.path === activeFile.path
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border/70 bg-background/70 text-muted-foreground hover:text-foreground"
              )}
            >
              <span className="truncate">{isDirtyPreview(tab) ? `*${basename(tab.path)}` : basename(tab.path)}</span>
              <span
                onClick={(event) => {
                  event.stopPropagation();
                  handleCloseTabWithConfirm(tab.path);
                }}
                className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
              >
                <X className="h-3 w-3" />
              </span>
            </button>
          ))}
        </div>
      </ScrollArea>

      <div className="flex items-center gap-2 border-b border-border/70 px-4 py-2.5 text-xs text-muted-foreground">
        <MetaIcon className="h-3.5 w-3.5" />
        <Badge variant="secondary" className="rounded-full px-2.5 py-0.5">
          {meta.label}
        </Badge>
        <span>{formatFileSize(activeFile.size)}</span>
        {activeFile.truncated ? <span>仅展示摘要</span> : null}
        {activeDirty ? <span>未保存</span> : null}
        {activeMetadata.lastSavedAt ? (
          <span>保存于 {new Date(Number(activeMetadata.lastSavedAt)).toLocaleTimeString()}</span>
        ) : null}
        {activeFile.metadata?.autoSavedAt ? (
          <span>自动保存于 {new Date(Number(activeFile.metadata.autoSavedAt)).toLocaleTimeString()}</span>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 rounded-full px-3 text-xs"
            onClick={() => void handleOpenInSystem()}
            disabled={activeFile.contentType !== "url" && isVirtualPreview}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            打开
          </Button>
          <Button
            variant={activeDirty ? "default" : "ghost"}
            size="sm"
            className="h-8 rounded-full px-3 text-xs"
            onClick={() => void handleSaveToWorkspace()}
            disabled={!saveable || !activeDirty || saveBusy}
          >
            <Save className="h-3.5 w-3.5" />
            保存
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 rounded-full px-3 text-xs"
            onClick={() => void handleSaveSnapshot()}
            disabled={!persistable}
          >
            <Save className="h-3.5 w-3.5" />
            快照
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 rounded-full px-3 text-xs"
            onClick={handleRevertChanges}
            disabled={!activeDirty}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            撤销
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 rounded-full px-3 text-xs"
            onClick={() => setEditMode((current) => !current)}
            disabled={!editable}
          >
            {editMode ? <Eye className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
            {editMode ? "查看" : "编辑"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 rounded-full px-3 text-xs" disabled={!persistable}>
                <History className="h-3.5 w-3.5" />
                历史
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <DropdownMenuLabel>预览历史</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {historyBusy ? (
                <DropdownMenuItem disabled>正在加载...</DropdownMenuItem>
              ) : historyItems.length === 0 ? (
                <DropdownMenuItem disabled>暂无历史快照</DropdownMenuItem>
              ) : (
                historyItems.slice(0, 12).map((item) => (
                  <DropdownMenuItem key={item.id} onClick={() => void handleLoadSnapshot(item.id)}>
                    <div className="min-w-0">
                      <div className="truncate">{new Date(item.createdAt).toLocaleString()}</div>
                      <div className="truncate text-xs text-muted-foreground">{formatFileSize(item.size)}</div>
                    </div>
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="rounded-full">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>标签操作</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => handleCloseTabWithConfirm(activeFile.path)}>关闭当前</DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleCloseOthersWithConfirm(activeFile.path)}>关闭其他</DropdownMenuItem>
            <DropdownMenuItem onClick={handleCloseAllWithConfirm}>关闭全部</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {actionNotice ? (
        <div className="border-b border-border/70 px-4 py-2 text-xs text-muted-foreground">
          {actionNotice}
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        {editMode && editable ? (
          <div className="h-full p-3">
            <Textarea
              value={activeFile.content}
              onChange={(event) => handleEditorChange(event.target.value)}
              className="h-full min-h-full resize-none rounded-[22px] border-border/70 bg-background/90 px-4 py-3 font-mono text-sm leading-6"
            />
          </div>
        ) : (
          <PreviewViewer file={activeFile} />
        )}
      </div>
    </div>
  );
}
