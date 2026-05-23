"use client";

import * as React from "react";
import { ChevronRight, Folder, FolderOpen, FileText, Plus, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { FileTreeNode } from "@/types";

interface FileTreeNodeProps {
  item: FileTreeNode;
  level?: number;
  expandedPaths: Set<string>;
  selectedFilePath: string | null;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string) => void;
}

function FileTreeNodeView({
  item,
  level = 0,
  expandedPaths,
  selectedFilePath,
  onToggleFolder,
  onSelectFile,
}: FileTreeNodeProps) {
  const isOpen = expandedPaths.has(item.path);

  if (item.type === "file") {
    return (
      <div
        className={cn(
          "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
          selectedFilePath === item.path
            ? "bg-primary/10 text-foreground"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        )}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onClick={() => onSelectFile(item.path)}
      >
        <Plus className="h-3.5 w-3.5 text-amber-500 opacity-70 group-hover:opacity-100" />
        <FileText className="h-4 w-4 text-muted-foreground/70" />
        <span className="truncate">{item.name}</span>
      </div>
    );
  }

  return (
    <Collapsible open={isOpen} onOpenChange={() => onToggleFolder(item.path)}>
      <CollapsibleTrigger asChild>
        <div
          className={cn(
            "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors",
            "hover:bg-accent/50"
          )}
          style={{ paddingLeft: `${level * 16 + 8}px` }}
        >
          <ChevronRight
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform duration-200",
              isOpen && "rotate-90"
            )}
          />
          {isOpen ? (
            <FolderOpen className="h-4 w-4 text-amber-500" />
          ) : (
            <Folder className="h-4 w-4 text-amber-500" />
          )}
          <span className="truncate font-medium">{item.name}</span>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {item.children?.map((child) => (
          <FileTreeNodeView
            key={child.id}
            item={child}
            level={level + 1}
            expandedPaths={expandedPaths}
            selectedFilePath={selectedFilePath}
            onToggleFolder={onToggleFolder}
            onSelectFile={onSelectFile}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function FileTree({
  items,
  title,
  expandedPaths,
  selectedFilePath,
  onToggleFolder,
  onSelectFile,
  onRefresh,
}: {
  items: FileTreeNode[];
  title: string;
  expandedPaths: Set<string>;
  selectedFilePath: string | null;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string) => void;
  onRefresh?: () => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between px-2 py-1">
        <span className="text-sm font-medium text-foreground">{title}</span>
        {onRefresh && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            onClick={onRefresh}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {items.length === 0 ? (
        <div className="px-2 py-4 text-sm text-muted-foreground">没有匹配的文件</div>
      ) : (
        items.map((item) => (
          <FileTreeNodeView
            key={item.id}
            item={item}
            expandedPaths={expandedPaths}
            selectedFilePath={selectedFilePath}
            onToggleFolder={onToggleFolder}
            onSelectFile={onSelectFile}
          />
        ))
      )}
    </div>
  );
}
