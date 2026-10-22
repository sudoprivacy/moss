import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  createAgentCatalogApi,
  type CatalogEntry,
  type CatalogFilters,
  type CatalogSource,
} from "@/lib/api/agent-catalog";
import type { ExternalAgentAdmin } from "@/lib/api/external-agents";
import { externalAgentError } from "@/lib/external-agent-errors";
const labels: Record<string, string> = {
  draft: "草稿",
  pending_approval: "待审核",
  approved: "已批准",
  published: "已发布",
  active: "已启用",
  deprecated: "已弃用",
  revoked: "已撤销",
  archived: "已归档",
  unavailable: "不可用",
  unapproved: "未批准",
  expired: "审批已过期",
  withdrawn: "已撤回批准",
  enabled: "来源已启用",
  disabled: "来源已停用",
  available: "可连接",
  unknown: "未知",
  supported: "支持",
  unsupported: "不支持",
  partial: "部分",
  provider_dependent: "取决于来源",
  full: "完整",
  none: "无",
  dify: "Dify",
  http: "HTTP",
  openai_compatible: "OpenAI compatible",
  mcp: "MCP",
  a2a: "A2A",
  streaming: "流式",
  cancel: "取消",
  resume: "恢复",
  idempotency: "执行幂等",
  version_pin: "版本锁定",
  human_approval: "远端人工介入",
  trace_export: "链路导出",
  external_hosted: "外部托管",
};
export const catalogStatusLabel = (status: string) => labels[status] ?? status;
const date = (at: number | null) =>
  at === null ? "未记录" : new Date(at).toLocaleString();
const filterOptions: [keyof CatalogFilters, string, string[]][] = [
  ["provider", "Provider", ["dify", "http", "openai_compatible", "mcp", "a2a"]],
  [
    "protocol",
    "协议",
    [
      "dify/chat-messages",
      "agent-http.sudo.dev/v1alpha1",
      "openai-chat-completions/v1",
      "mcp/2025-06-18",
      "a2a/0.3.0",
    ],
  ],
  [
    "status",
    "目录状态",
    [
      "draft",
      "pending_approval",
      "approved",
      "published",
      "active",
      "deprecated",
      "revoked",
      "archived",
      "unavailable",
    ],
  ],
  [
    "approval_status",
    "审批状态",
    [
      "unapproved",
      "pending_approval",
      "approved",
      "expired",
      "withdrawn",
      "revoked",
    ],
  ],
  [
    "source_state",
    "来源状态",
    ["enabled", "disabled", "available", "unavailable", "unknown"],
  ],
  ["execution_mode", "执行模式", ["external_hosted"]],
  ["observability", "可观测性", ["full", "partial", "none", "unknown"]],
  [
    "capability",
    "支持能力",
    [
      "streaming",
      "cancel",
      "resume",
      "idempotency",
      "version_pin",
      "human_approval",
    ],
  ],
];
interface Props {
  agents: ExternalAgentAdmin[];
  onVersion: (agent: ExternalAgentAdmin) => void;
  onSource: (source: CatalogSource) => void;
  onRuns: (source: CatalogSource) => Promise<void>;
}
export function ExternalCatalogOverview({
  agents,
  onVersion,
  onSource,
  onRuns,
}: Props) {
  const [query, setQuery] = useState<CatalogFilters>({}),
    [rows, setRows] = useState<CatalogEntry[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [epoch, setEpoch] = useState(0);
  const controller = useRef(new AbortController()),
    generation = useRef(0);
  const api = useMemo(
    () => createAgentCatalogApi(() => controller.current.signal),
    [],
  );
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    const id = ++generation.current;
    setRows([]);
    setCursor(null);
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      void api
        .entries("", query)
        .then((page) => {
          if (!current.signal.aborted && id === generation.current) {
            setRows(page.items);
            setCursor(page.next_cursor);
          }
        })
        .catch((e) => {
          if (!current.signal.aborted) setError(externalAgentError(e));
        })
        .finally(() => {
          if (!current.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      current.abort();
    };
  }, [api, query, epoch, agents]);
  const update = (field: keyof CatalogFilters, value: string) =>
    setQuery((q) => ({ ...q, [field]: value }));
  async function more() {
    if (!cursor || loading) return;
    const id = generation.current;
    setLoading(true);
    setError("");
    try {
      const page = await api.entries(cursor, query);
      if (id === generation.current) {
        setRows((r) => [...r, ...page.items]);
        setCursor(page.next_cursor);
      }
    } catch (e) {
      if (id === generation.current && !controller.current.signal.aborted)
        setError(externalAgentError(e));
    } finally {
      if (id === generation.current && !controller.current.signal.aborted)
        setLoading(false);
    }
  }
  return (
    <section aria-label="智能体目录" className="space-y-3">
      <p className="text-xs text-muted-foreground">
        组织范围随页面顶部当前组织切换。目录状态由服务端核对版本、频道和准入；“已启用”仍需授权成员才能执行。运行时会再次核验。
      </p>
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label="搜索智能体目录"
          className="max-w-56"
          placeholder="名称、标识或地址"
          value={query.search ?? ""}
          onChange={(e) => update("search", e.target.value)}
        />
        {filterOptions.map(([key, title, options]) => (
          <select
            key={key}
            aria-label={`目录按${title}筛选`}
            className="h-9 rounded border bg-background px-2 text-sm"
            value={query[key] ?? ""}
            onChange={(e) => update(key, e.target.value)}
          >
            <option value="">所有{title}</option>
            {options.map((value) => (
              <option key={value} value={value}>
                {catalogStatusLabel(value)}
              </option>
            ))}
          </select>
        ))}
        <Input
          aria-label="目录按负责人筛选"
          className="max-w-48"
          placeholder="负责人 ID"
          value={query.owner ?? ""}
          onChange={(e) => update("owner", e.target.value)}
        />
        <Input
          aria-label="目录按 Zone 筛选"
          className="max-w-56"
          placeholder="Zone ID / unassigned"
          value={query.zone ?? ""}
          onChange={(e) => update("zone", e.target.value)}
        />
        {(["warning", "drift"] as const).map((k) => (
          <label className="flex items-center gap-2 text-sm" key={k}>
            <input
              type="checkbox"
              checked={query[k] === "true"}
              onChange={(e) => update(k, e.target.checked ? "true" : "")}
            />
            {k === "warning" ? "仅含警告" : "仅来源漂移"}
          </label>
        ))}
        <Button variant="ghost" onClick={() => setQuery({})}>
          重置目录筛选
        </Button>
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => setEpoch((e) => e + 1)}
        >
          刷新目录
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {loading && (
        <p role="status" className="text-sm">
          正在核对目录状态…
        </p>
      )}
      {!loading && !error && !rows.length && (
        <p className="text-sm text-muted-foreground">
          {cursor
            ? "本页无匹配项，继续加载以检查后续来源。"
            : "没有匹配的智能体。已有接入可在来源连接中添加来源管理。"}
        </p>
      )}
      <div className="grid gap-3 xl:grid-cols-2">
        {rows.map((e) => (
          <article
            aria-label={`目录 ${e.name}`}
            key={e.catalog_id}
            className="space-y-3 rounded-lg border p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <strong>{e.name}</strong>
              <Badge variant={e.is_selectable ? "default" : "secondary"}>
                {catalogStatusLabel(e.status)}
              </Badge>
              <Badge variant="outline">{catalogStatusLabel(e.provider)}</Badge>
            </div>
            <dl className="grid gap-2 break-all text-xs sm:grid-cols-2">
              <div>协议：{e.protocol}</div>
              <div>外部标识：{e.external_agent_id}</div>
              <div>审批：{catalogStatusLabel(e.approval_status)}</div>
              <div>已发布版本：{e.published_version ?? "无"}</div>
              <div>来源绑定：{e.source?.id ?? "尚未纳管"}</div>
              <div>来源修订：{e.source_revision ?? "未记录"}</div>
              <div>适配器：{e.adapter_version ?? "未记录"}</div>
              <div>执行模式：外部托管</div>
              <div>负责人：{e.owner_id ?? "未记录"}</div>
              <div>组织：{e.org_id}</div>
              <div>Zone：{e.zone_id ?? "未分配"}</div>
              <div>可观测性：{catalogStatusLabel(e.observability)}</div>
              <div>最近运行：{date(e.last_run_at)}</div>
              <div>
                警告：{e.warning_count} · 来源漂移：{e.has_drift ? "有" : "无"}
              </div>
              <div className="sm:col-span-2">来源摘要：{e.source_digest}</div>
              <div className="sm:col-span-2">
                频道：
                {e.channels
                  .map(
                    (c) =>
                      `${c.name} → ${c.version}${c.enabled ? "" : "（已停用）"}`,
                  )
                  .join("；") || "未设置"}
              </div>
              {Object.entries(e.capabilities).map(([k, v]) => (
                <div key={k}>
                  {catalogStatusLabel(k)}：{catalogStatusLabel(v)}
                </div>
              ))}
            </dl>
            {!e.is_selectable && (
              <p className="text-xs text-muted-foreground">
                当前不可供成员选择：
                {e.admission_error
                  ? externalAgentError(new Error(e.admission_error))
                  : "尚未授权成员"}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void api
                    .agent(e.catalog_id)
                    .then((result) => onVersion(result.agent))
                    .catch((cause) => {
                      if (!controller.current.signal.aborted)
                        setError(externalAgentError(cause));
                    });
                }}
              >
                版本与频道
              </Button>
              {e.source && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onSource(e.source!)}
                  >
                    来源绑定
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void onRuns(e.source!).catch((cause) => {
                        if (!controller.current.signal.aborted)
                          setError(externalAgentError(cause));
                      });
                    }}
                  >
                    执行记录
                  </Button>
                </>
              )}
            </div>
          </article>
        ))}
      </div>
      {cursor && (
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => void more()}
        >
          继续加载目录
        </Button>
      )}
    </section>
  );
}
