"use client";

import * as React from "react";
import {
  LayoutGrid,
  Monitor,
  MoonStar,
  PenSquare,
  Pin,
  Search,
  Settings,
  SunMedium,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";

export interface SidebarSession {
  id: string;
  title: string;
  preview: string;
  time: string;
  workspaceLabel: string;
  messageCount: number;
  busy: boolean;
  isPinned?: boolean;
  agentMode?: 'local' | 'remote-direct';
}

interface AppSidebarProps {
  sessions: SidebarSession[];
  activeSessionId: string | null;
  activeView: "chat" | "apps" | "settings" | "snake";
  appsCount: number;
  themeMode: "dark" | "light" | "system";
  collapsed: boolean;
  searchQuery: string;
  localEnabled?: boolean;
  remoteEnabled?: boolean;
  newSessionMode?: 'local' | 'remote-direct';
  onChangeView: (view: "chat" | "apps" | "settings") => void;
  onChangeTheme: (theme: "dark" | "light" | "system") => void;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onNewSessionModeChange?: (mode: 'local' | 'remote-direct') => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, newTitle: string) => void;
  onTogglePin: (sessionId: string) => void;
  onToggleCollapse: () => void;
  onSearchChange: (query: string) => void;
}

function SessionItem({
  session,
  isActive,
  onClick,
  onDelete,
  onRename,
  onTogglePin,
}: {
  session: SidebarSession;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
  onRename: (newTitle: string) => void;
  onTogglePin: () => void;
}) {
  const [isEditing, setIsEditing] = React.useState(false);
  const [editValue, setEditValue] = React.useState(session.title);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const handleRename = () => {
    setEditValue(session.title);
    setIsEditing(true);
  };

  const handleConfirmRename = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== session.title) {
      onRename(trimmed);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleConfirmRename();
    } else if (e.key === 'Escape') {
      setIsEditing(false);
      setEditValue(session.title);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
      className={cn(
        "group relative w-full max-w-full overflow-hidden rounded-xl border px-2 py-1 pr-14 text-left transition-colors",
        isActive
          ? "border-primary/25 bg-primary/10 shadow-[0_8px-24px_-24px_rgba(0,0,0,0.65)]"
          : "border-transparent bg-transparent hover:border-sidebar-border/70 hover:bg-sidebar-accent/80",
      )}
    >
      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none whitespace-nowrap",
            session.busy
              ? "bg-primary/14 text-primary"
              : "bg-sidebar-accent text-sidebar-foreground/60",
          )}
        >
          {session.messageCount}
        </span>
        {session.isPinned && <Pin className="h-3 w-3 shrink-0 text-primary" />}
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleConfirmRename}
            onKeyDown={handleKeyDown}
            onClick={(e) => e.stopPropagation()}
            className="min-w-0 flex-1 rounded border border-primary/50 bg-background px-1 text-[13px] font-medium leading-5 text-sidebar-foreground outline-none focus:border-primary"
          />
        ) : (
          <span className="block w-0 min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-sidebar-foreground">
            {session.title}
          </span>
        )}
      </div>
      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-6 w-6 shrink-0 rounded-lg"
              onClick={(event) => event.stopPropagation()}
            >
              <Settings className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-40"
            onClick={(event) => event.stopPropagation()}
          >
            <DropdownMenuItem onClick={onTogglePin}>
              <Pin className="mr-2 h-4 w-4" />
              {session.isPinned ? "取消置顶" : "置顶会话"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleRename}>
              <PenSquare className="mr-2 h-4 w-4" />
              重命名
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" onClick={onDelete}>
              <Trash2 className="mr-2 h-4 w-4" />
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function ThemeButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-sidebar-accent text-sidebar-foreground/65 hover:bg-sidebar-accent/80 hover:text-sidebar-foreground",
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function AppSidebar({
  sessions,
  activeSessionId,
  activeView,
  appsCount,
  themeMode,
  collapsed,
  searchQuery,
  localEnabled = true,
  remoteEnabled = false,
  newSessionMode = 'local',
  onChangeView,
  onChangeTheme,
  onSelectSession,
  onNewSession,
  onNewSessionModeChange,
  onDeleteSession,
  onRenameSession,
  onTogglePin,
  onToggleCollapse,
  onSearchChange,
}: AppSidebarProps) {
  const showModePicker = remoteEnabled;

  const filteredSessions = sessions.filter((session) =>
    session.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // 根据当前选择的模式过滤会话
  const localSessions = filteredSessions.filter((s) => !s.agentMode || s.agentMode === 'local');
  const remoteSessions = filteredSessions.filter((s) => s.agentMode === 'remote-direct');

  // 当有切换器时，根据选择的模式显示对应会话
  // 无切换器时（只有本地），显示所有会话
  const displaySessions = showModePicker
    ? (newSessionMode === 'remote-direct' ? remoteSessions : localSessions)
    : filteredSessions;

  const pinnedSessions = displaySessions.filter((session) => session.isPinned);
  const recentSessions = displaySessions.filter((session) => !session.isPinned);
  const orderedSessions = [...pinnedSessions, ...recentSessions];

  return (
    <div className="flex h-full min-h-0 min-w-0 w-full max-w-full flex-col bg-sidebar/96 text-sidebar-foreground backdrop-blur overflow-hidden">
      <div className={cn("border-b border-sidebar-border/80", collapsed ? "px-2 py-3" : "px-3 py-3")}>
        <div className={cn("flex items-center", collapsed ? "justify-center" : "justify-between gap-3")}>
          {!collapsed ? (
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <img src="./build/icon.png" alt="Moss" className="h-5 w-5 rounded-sm object-contain" />
                <div className="text-sm font-semibold lowercase tracking-[0.14em] text-sidebar-foreground">
                  moss
                </div>
              </div>
            </div>
          ) : (
            <img src="./build/icon.png" alt="Moss" className="h-5 w-5 rounded-sm object-contain" />
          )}
        </div>

        <Button
          variant="outline"
          className={cn(
            "mt-3 h-9 rounded-xl border-sidebar-border bg-sidebar-accent/60 px-3 text-sm text-sidebar-accent-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            collapsed ? "w-full justify-center px-0" : "w-full justify-center",
          )}
          onClick={onNewSession}
        >
          <PenSquare className="h-4 w-4" />
          {!collapsed && "新会话"}
        </Button>

        {!collapsed && showModePicker && (
          <div className="mt-2 flex rounded-xl bg-sidebar-accent/50 p-0.5 gap-0.5">
            <button
              type="button"
              onClick={() => onNewSessionModeChange?.('local')}
              className={cn(
                "flex-1 rounded-[10px] py-1 text-[12px] font-medium transition-colors",
                newSessionMode !== 'remote-direct'
                  ? "bg-sidebar text-sidebar-foreground shadow-sm"
                  : "text-sidebar-foreground/55 hover:text-sidebar-foreground",
              )}
            >
              本地
            </button>
            <button
              type="button"
              onClick={() => onNewSessionModeChange?.('remote-direct')}
              className={cn(
                "flex-1 rounded-[10px] py-1 text-[12px] font-medium transition-colors",
                newSessionMode === 'remote-direct'
                  ? "bg-sidebar text-sidebar-foreground shadow-sm"
                  : "text-sidebar-foreground/55 hover:text-sidebar-foreground",
              )}
            >
              远程
            </button>
          </div>
        )}
      </div>

      {collapsed ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col items-center gap-1.5 p-2">
            {orderedSessions.map((session) => (
              <button
                key={session.id}
                onClick={() => onSelectSession(session.id)}
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-colors",
                  activeSessionId === session.id
                    ? "bg-primary/20 text-primary"
                    : "bg-sidebar-accent/60 text-sidebar-foreground hover:bg-sidebar-accent"
                )}
                title={session.title}
              >
                {session.title.charAt(0).toUpperCase()}
              </button>
            ))}
          </div>
        </ScrollArea>
      ) : (
        <>
          <div className="border-b border-sidebar-border px-3 py-2">
            <div className="flex min-w-0 items-center justify-between text-[11px] uppercase tracking-[0.2em] text-sidebar-foreground/40">
              <span className="truncate">会话</span>
              <span>{orderedSessions.length}</span>
            </div>
            <div className="relative mt-2">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="搜索..."
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                className="h-7 rounded-lg bg-sidebar-accent/50 pl-8 pr-7 text-xs placeholder:text-muted-foreground/60"
              />
              {searchQuery && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="absolute right-0 top-1/2 h-7 w-7 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => onSearchChange("")}
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-1.5 p-2 max-w-full overflow-hidden">
              {orderedSessions.length > 0 ? (
                orderedSessions.map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    isActive={activeSessionId === session.id}
                    onClick={() => onSelectSession(session.id)}
                    onDelete={() => onDeleteSession(session.id)}
                    onRename={(newTitle) => onRenameSession(session.id, newTitle)}
                    onTogglePin={() => onTogglePin(session.id)}
                  />
                ))
              ) : (
                <div className="rounded-xl border border-dashed border-sidebar-border px-4 py-4 text-sm text-sidebar-foreground/55">
                  {showModePicker && newSessionMode === 'remote-direct' ? '暂无远程会话' : '还没有历史会话'}
                </div>
              )}
            </div>
          </ScrollArea>
        </>
      )}

      <div className="border-t border-sidebar-border px-2.5 py-2.5">
        <div className={cn("grid gap-2", collapsed ? "grid-cols-1" : "grid-cols-2")}>
          <Button
            variant={activeView === "apps" ? "secondary" : "ghost"}
            className={cn("rounded-xl", collapsed ? "justify-center px-0 h-8 w-8" : "justify-start")}
            onClick={() => onChangeView("apps")}
          >
            <LayoutGrid className="h-4 w-4" />
            {!collapsed && (
              <>
                Apps
                <span className="ml-auto text-[11px] text-muted-foreground">{appsCount}</span>
              </>
            )}
          </Button>
          <Button
            variant={activeView === "settings" ? "secondary" : "ghost"}
            className={cn("rounded-xl", collapsed ? "justify-center px-0 h-8 w-8" : "justify-start")}
            onClick={() => onChangeView("settings")}
          >
            <Settings className="h-4 w-4" />
            {!collapsed && "设置"}
          </Button>
        </div>
      </div>
    </div>
  );
}
