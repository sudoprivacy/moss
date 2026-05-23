"use client";

import * as React from "react";
import {
  Search,
  X,
  RefreshCw,
  Cloud,
  FileText,
  FolderOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { FileTree } from "@/components/file-tree";
import type { FileTreeNode, WorkspacePreviewData } from "@/types";

export type PreviewTabData = WorkspacePreviewData;

function previewLabel(tab: WorkspacePreviewData): string {
  switch (tab.contentType) {
    case "markdown":
      return "Markdown";
    case "html":
      return "HTML";
    case "image":
      return "图片";
    case "pdf":
      return "PDF";
    case "word":
      return "Word";
    case "excel":
      return "Excel";
    case "ppt":
      return "PPT";
    case "diff":
      return "Diff";
    case "url":
      return "URL";
    case "text":
      return "文本";
    case "unsupported":
      return "不支持";
    case "code":
    default:
      return "代码";
  }
}

export function TaskPanel({
  collapsed,
  onToggleCollapse,
  searchQuery,
  onSearchChange,
  onRefresh,
  onOpenWorkspace,
  treeItems,
  expandedPaths,
  selectedFilePath,
  onToggleFolder,
  onSelectFile,
  previewTabs,
  activePreviewPath,
  onActivatePreview,
  previewTitle,
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onRefresh: () => void;
  onOpenWorkspace: () => void;
  treeItems: FileTreeNode[];
  expandedPaths: Set<string>;
  selectedFilePath: string | null;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string) => void;
  previewTabs: PreviewTabData[];
  activePreviewPath: string | null;
  onActivatePreview: (path: string) => void;
  previewTitle: string;
}) {
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const activePreviewTab = React.useMemo(
    () => previewTabs.find((tab) => tab.path === activePreviewPath) || previewTabs[0] || null,
    [activePreviewPath, previewTabs]
  );

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setTimeout(() => setIsRefreshing(false), 300);
    }
  };

  return (
    <div className="flex h-full flex-col bg-[linear-gradient(180deg,color-mix(in_oklab,var(--card)_96%,transparent),color-mix(in_oklab,var(--background)_94%,transparent))]">
      {collapsed ? null : (
        <>
          <div className="border-b border-border/80 px-3 py-3">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Cloud className="h-4 w-4 text-primary" />
              <span>工作空间</span>
            </div>
          </div>

          <div className="border-b border-border/80 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="搜索文件..."
                  value={searchQuery}
                  onChange={(e) => onSearchChange(e.target.value)}
                  className="h-10 rounded-xl bg-muted/50 pl-9 pr-8 text-sm placeholder:text-muted-foreground/60"
                />
                {searchQuery && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => onSearchChange("")}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>
          </div>

          <ScrollArea className="flex-1">
            <div className="space-y-3 p-3">
              <div className="rounded-[22px] border border-border/65 bg-card/72 p-2.5 shadow-[0_18px_60px_-48px_rgba(0,0,0,0.6)]">
                <FileTree
                  items={treeItems}
                  title="工作区文件"
                  expandedPaths={expandedPaths}
                  selectedFilePath={selectedFilePath}
                  onToggleFolder={onToggleFolder}
                  onSelectFile={onSelectFile}
                  onRefresh={handleRefresh}
                />
              </div>

              <div className="rounded-[22px] border border-border/65 bg-card/72 p-3 shadow-[0_18px_60px_-48px_rgba(0,0,0,0.6)]">
                <div className="mb-2.5 flex items-center gap-2">
                  <FolderOpen className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium text-foreground">预览</span>
                </div>

                <div className="mb-2.5 flex flex-wrap gap-2">
                  {previewTabs.length === 0 ? (
                    <Badge variant="secondary">未打开文件</Badge>
                  ) : (
                    previewTabs.map((tab) => (
                      <button
                        key={tab.path}
                        onClick={() => onActivatePreview(tab.path)}
                        className={cn(
                          "rounded-full border px-3 py-1 text-xs transition-colors",
                          activePreviewPath === tab.path
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                        )}
                      >
                        {tab.relativePath.split("/").pop()}
                      </button>
                    ))
                  )}
                </div>

                <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <FileText className="h-3.5 w-3.5" />
                  <span className="truncate">{previewTitle}</span>
                </div>
                {activePreviewPath ? (
                  <div className="rounded-[18px] border border-border/60 bg-background/90 p-3 text-[11px] leading-relaxed text-muted-foreground">
                    <div className="flex flex-wrap items-center gap-2">
                      {activePreviewTab ? <Badge variant="secondary">{previewLabel(activePreviewTab)}</Badge> : null}
                      <span>文件已在左侧预览抽屉打开。</span>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-[18px] border border-border/60 bg-background/90 p-3 text-[11px] leading-relaxed text-muted-foreground">
                    点击文件后会在左侧打开预览抽屉。
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>

          <div className="flex justify-end border-t border-border/80 px-3 py-2.5">
            <button
              type="button"
              className="rounded-full border border-border/70 bg-card/75 px-3 py-1.5 text-xs text-primary transition-colors hover:border-primary/35 hover:text-primary/80"
              onClick={onOpenWorkspace}
            >
              工作区预览
            </button>
          </div>
        </>
      )}
    </div>
  );
}
