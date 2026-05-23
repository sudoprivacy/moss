"use client";

import * as React from "react";
import { ExternalLink, History, MonitorPlay, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AppVersion, StoredApp } from "../types";

function formatTimestamp(timestamp: number) {
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function AppIcon({ icon, name }: { icon: string; name: string }) {
  if (!icon) {
    return (
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <MonitorPlay className="h-5 w-5" />
      </div>
    );
  }
  // icon is a data URI like "data:image/svg+xml,<svg>...</svg>"
  const svgContent = icon.replace(/^data:image\/svg\+xml,?/, '');
  return (
    <div
      className="h-10 w-10 shrink-0 overflow-hidden rounded-xl"
      dangerouslySetInnerHTML={{ __html: svgContent }}
    />
  );
}

export function AppsPanel({
  apps,
  versionsByApp,
  onLaunch,
  onDelete,
  onIterate,
  onLoadVersions,
  onRollback,
}: {
  apps: StoredApp[];
  versionsByApp: Record<string, AppVersion[]>;
  onLaunch: (name: string) => void;
  onDelete: (name: string) => void;
  onIterate: (name: string) => void;
  onLoadVersions: (name: string) => void;
  onRollback: (name: string, versionId: string) => void;
}) {
  const [expandedAppName, setExpandedAppName] = React.useState<string | null>(null);

  const toggleVersions = (name: string) => {
    setExpandedAppName((current) => {
      const next = current === name ? null : name;
      if (next === name) {
        onLoadVersions(name);
      }
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[radial-gradient(circle_at_top_left,rgba(58,191,129,0.08),transparent_20%),var(--background)]">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {apps.length === 0 ? (
          <div className="flex min-h-[320px] items-center justify-center">
            <div className="max-w-lg rounded-[32px] border border-border/80 bg-card/80 px-8 py-10 text-center shadow-[0_26px_80px_-42px_rgba(0,0,0,0.65)]">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <MonitorPlay className="h-6 w-6" />
              </div>
              <h2 className="mt-5 text-xl font-semibold text-foreground">还没有生成的 App</h2>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">
                回到聊天视图，输入需求后点“生成 App”。生成成功后会自动保存到本地，并在这里可再次打开。
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 2xl:grid-cols-3">
            {apps.map((app) => (
              <div
                key={app.name}
                className="rounded-[28px] border border-border/80 bg-card/72 p-5 shadow-[0_20px_70px_-48px_rgba(0,0,0,0.65)]"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 min-w-0">
                    <AppIcon icon={app.icon} name={app.name} />
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-semibold text-foreground">
                        {app.title || app.name}
                      </h2>
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">
                        {app.description || "未填写描述"}
                      </p>
                    </div>
                  </div>
                  <div className="rounded-full border border-border/80 bg-background/80 px-2.5 py-1 text-[11px] text-muted-foreground shrink-0">
                    {app.width} × {app.height}
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                  <span className="rounded-full border border-border/70 px-2 py-1">
                    {app.resizable ? "可缩放" : "固定尺寸"}
                  </span>
                  <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-600 dark:text-emerald-300">
                    当前版本 {app.currentVersion || "---"}
                  </span>
                  <span className="rounded-full border border-border/70 px-2 py-1">
                    {app.versionCount || 0} 个版本
                  </span>
                  {app.latestVersion && app.latestVersion !== app.currentVersion && (
                    <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-600 dark:text-amber-300">
                      最新快照 {app.latestVersion}
                    </span>
                  )}
                  <span className="rounded-full border border-border/70 px-2 py-1">
                    更新于 {formatTimestamp(app.updatedAt)}
                  </span>
                </div>

                <div className="mt-5 flex items-center gap-2">
                  <Button className="gap-2 rounded-xl" onClick={() => onLaunch(app.name)}>
                    <ExternalLink className="h-4 w-4" />
                    打开
                  </Button>
                  <Button variant="outline" className="gap-2 rounded-xl" onClick={() => onIterate(app.name)}>
                    <Pencil className="h-4 w-4" />
                    继续迭代
                  </Button>
                  <Button variant="outline" className="gap-2 rounded-xl" onClick={() => toggleVersions(app.name)}>
                    <History className="h-4 w-4" />
                    版本
                  </Button>
                  <Button variant="outline" className="gap-2 rounded-xl" onClick={() => onDelete(app.name)}>
                    <Trash2 className="h-4 w-4" />
                    删除
                  </Button>
                </div>

                {expandedAppName === app.name && (
                  <div className="mt-4 rounded-[22px] border border-border/70 bg-background/60 p-3">
                    <div className="mb-2 text-xs font-medium text-muted-foreground">版本历史</div>
                    {(versionsByApp[app.name] || []).length === 0 ? (
                      <div className="text-xs text-muted-foreground">还没有加载到版本，或当前只有初始版本。</div>
                    ) : (
                      <div className="space-y-2">
                        {versionsByApp[app.name].map((version) => (
                          <div
                            key={version.id}
                            className="flex items-center justify-between gap-3 rounded-2xl border border-border/70 px-3 py-2"
                          >
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-foreground">
                                <span>{version.version}</span>
                                {version.isCurrent && (
                                  <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-300">
                                    当前
                                  </span>
                                )}
                                {version.isLatest && (
                                  <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-600 dark:text-amber-300">
                                    最新快照
                                  </span>
                                )}
                                <span className="truncate">{version.reason}</span>
                              </div>
                              <div className="truncate text-[11px] text-muted-foreground">
                                {formatTimestamp(version.createdAt)} · {version.note || version.description || "无备注"}
                              </div>
                            </div>
                            <Button
                              variant="outline"
                              className="h-8 gap-1.5 px-2 text-xs"
                              disabled={version.isCurrent}
                              onClick={() => onRollback(app.name, version.id)}
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              {version.isCurrent ? "当前版本" : "回滚"}
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
