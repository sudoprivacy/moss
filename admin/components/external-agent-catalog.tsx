import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalAgentVersions } from "./external-agent-versions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createAgentCatalogApi,
  type CatalogSource,
  type ImportCandidate,
  type CatalogAuditEvent,
  type CatalogRun,
} from "@/lib/api/agent-catalog";
import {
  createExternalAgentsApi,
  type ExternalAgentAdmin,
  type ExternalProviderMember,
} from "@/lib/api/external-agents";
import { externalAgentError } from "@/lib/external-agent-errors";

const stateNames: Record<string, string> = {
  draft: "草稿",
  pending_approval: "待审核",
  approved: "已批准，待发布",
  rejected: "已拒绝",
  publishing: "发布中，待核对",
  publication_unknown: "发布结果待核对",
  published: "已发布",
  archived: "已归档",
  never: "未同步",
  running: "同步中",
  succeeded: "成功",
  failed: "失败",
  available: "可连接",
  unavailable: "不可连接",
  unknown: "未知",
  supported: "支持",
  unsupported: "不支持",
  partial: "部分支持",
  provider_dependent: "取决于来源",
  none: "无",
  full: "完整",
};
const fieldNames: Record<string, string> = {
  name: "名称",
  protocol: "协议",
  external_agent_id: "外部标识",
  source_revision: "来源修订",
  revision_basis: "修订依据",
  source_digest: "来源摘要",
  parameters_digest: "描述摘要",
  adapter_version: "适配器版本",
  endpoint: "服务地址",
  input_profile: "输入形式",
  output_profile: "输出形式",
  requested_permissions: "申请的执行权限",
  capabilities: "能力",
  user_ids: "授权成员",
  data_scope: "数据范围",
  streaming: "流式",
  cancel: "取消",
  resume: "恢复",
  idempotency: "执行幂等",
  trace_export: "链路导出",
  version_pin: "远端版本锁定",
  human_approval: "远端人工介入",
};
const selectClass = "h-9 rounded-md border bg-background px-2 text-sm";
const date = (value: number | null) =>
  value === null ? "未记录" : new Date(value).toLocaleString();
const label = (value: string) => stateNames[value] ?? value;

interface Props {
  agents: ExternalAgentAdmin[];
  endpoints: string[];
  onChanged: () => Promise<void>;
  onManaged: (sources: CatalogSource[]) => void;
}
export function ExternalAgentCatalog({
  agents,
  endpoints,
  onChanged,
  onManaged,
}: Props) {
  const abort = useRef(new AbortController());
  const api = useMemo(
    () => createAgentCatalogApi(() => abort.current.signal),
    [],
  );
  const releases = useMemo(
    () => createExternalAgentsApi(undefined, () => abort.current.signal),
    [],
  );
  const [sources, setSources] = useState<CatalogSource[]>([]);
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [audit, setAudit] = useState<CatalogAuditEvent[]>([]);
  const [cursors, setCursors] = useState<{
    sources: string | null;
    candidates: string | null;
    audit: string | null;
  }>({ sources: null, candidates: null, audit: null });
  const [tab, setTab] = useState<"sources" | "candidates" | "audit">("sources");
  const [search, setSearch] = useState("");
  const [protocol, setProtocol] = useState("");
  const [status, setStatus] = useState("");
  const [owner, setOwner] = useState("");
  const [hasWarning, setHasWarning] = useState(false);
  const [capability, setCapability] = useState("");
  const [observability, setObservability] = useState("");
  const [allManaged, setAllManaged] = useState<CatalogSource[]>([]);
  const filters = useMemo(
    () => ({
      search,
      protocol,
      status,
      owner,
      warning: hasWarning ? "true" : "",
      capability,
      observability,
    }),
    [search, protocol, status, owner, hasWarning, capability, observability],
  );
  const [isBusy, setIsBusy] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sourceToEdit, setSourceToEdit] = useState<CatalogSource | null>(null);
  const [versionAgent, setVersionAgent] = useState<ExternalAgentAdmin | null>(
    null,
  );
  const [candidateSource, setCandidateSource] = useState<CatalogSource | null>(
    null,
  );
  const [candidate, setCandidate] = useState<ImportCandidate | null>(null);
  const [decisionNote, setDecisionNote] = useState("");
  const [days, setDays] = useState(7);
  const [runSource, setRunSource] = useState<CatalogSource | null>(null);
  const [runs, setRuns] = useState<CatalogRun[]>([]);
  const [runCursor, setRunCursor] = useState<string | null>(null);
  const [legacyId, setLegacyId] = useState("");
  const agentRevision = agents.map((a) => a.id + ":" + a.revision).join(",");
  const loadGeneration = useRef(0);
  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const [s, c, a, managed] = await Promise.all([
      api.sources("", filters),
      api.candidates("", "", filters),
      api.audit("", "", { search }),
      api.managed(agents.map((agent) => agent.id)),
    ]);
    if (abort.current.signal.aborted || generation !== loadGeneration.current)
      return;
    const all = managed;
    setSources(s.items);
    onManaged(all);
    setAllManaged(all);
    setCandidates(c.items);
    setAudit(a.items);
    setCursors({
      sources: s.next_cursor,
      candidates: c.next_cursor,
      audit: a.next_cursor,
    });
  }, [api, onManaged, filters, search, agentRevision]);
  useEffect(() => {
    if (abort.current.signal.aborted) abort.current = new AbortController();
    const current = abort.current;
    const timer = setTimeout(() => {
      void load().catch((e) => {
        if (!current.signal.aborted) setError(externalAgentError(e));
      });
    }, 200);
    return () => {
      clearTimeout(timer);
      ++loadGeneration.current;
      current.abort();
    };
  }, [load]);
  async function run(
    action: () => Promise<unknown>,
    message = "",
    reload = true,
  ) {
    if (busy.current) return;
    busy.current = true;
    setIsBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      if (!abort.current.signal.aborted) {
        if (reload) await load();
        if (message) setNotice(message);
      }
    } catch (e) {
      if (!abort.current.signal.aborted) setError(externalAgentError(e));
    } finally {
      busy.current = false;
      if (!abort.current.signal.aborted) setIsBusy(false);
    }
  }
  async function more() {
    const after = cursors[tab];
    if (!after) return;
    if (tab === "sources") {
      const page = await api.sources(after, filters);
      const next = [...sources, ...page.items];
      setSources(next);
      setCursors((c) => ({ ...c, sources: page.next_cursor }));
    } else if (tab === "candidates") {
      const page = await api.candidates(after, "", filters);
      setCandidates((c) => [...c, ...page.items]);
      setCursors((c) => ({ ...c, candidates: page.next_cursor }));
    } else {
      const page = await api.audit(after, "", { search });
      setAudit((a) => [...a, ...page.items]);
      setCursors((c) => ({ ...c, audit: page.next_cursor }));
    }
  }
  const filteredSources = sources;
  const filteredCandidates = candidates;
  const options = [
    "agent-http.sudo.dev/v1alpha1",
    "openai-chat-completions/v1",
    "mcp/2025-06-18",
    "a2a/0.3.0",
    "dify/chat-messages",
  ];
  const activeSource = candidateSource;
  const attachable = agents.filter(
    (a) => !allManaged.some((s) => s.catalog_id === a.id) && !a.archived,
  );
  return (
    <section
      aria-label="来源、候选与审计"
      className="space-y-4 rounded-lg border bg-background p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="font-semibold">来源、候选与审计</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            同步生成待审核候选。批准、发布和频道切换分别记录，来源变更不会覆盖历史版本。
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={isBusy}
          onClick={() => void run(load)}
        >
          刷新治理记录
        </Button>
      </div>
      <div
        role="tablist"
        aria-label="外部智能体治理"
        className="flex flex-wrap gap-2 border-b pb-3"
      >
        {(["sources", "candidates", "audit"] as const).map((name) => (
          <Button
            key={name}
            role="tab"
            aria-selected={tab === name}
            variant={tab === name ? "default" : "ghost"}
            onClick={() => {
              setTab(name);
              setStatus("");
            }}
          >
            {
              {
                sources: "来源连接",
                candidates: "待审核候选",
                audit: "审计记录",
              }[name]
            }
          </Button>
        ))}
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label="搜索治理记录"
          className="max-w-xs"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="名称、标识或地址"
        />
        {tab !== "audit" && (
          <>
            <select
              aria-label="按协议筛选"
              className={selectClass}
              value={protocol}
              onChange={(e) => setProtocol(e.target.value)}
            >
              <option value="">所有协议</option>
              {options.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            <select
              aria-label="按状态筛选"
              className={selectClass}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">所有状态</option>
              {(tab === "sources"
                ? ["enabled", "disabled", "unknown", "available", "unavailable"]
                : [
                    "draft",
                    "pending_approval",
                    "approved",
                    "published",
                    "rejected",
                    "publication_unknown",
                    "archived",
                  ]
              ).map((s) => (
                <option key={s} value={s}>
                  {s === "enabled"
                    ? "已启用"
                    : s === "disabled"
                      ? "已停用"
                      : label(s)}
                </option>
              ))}
            </select>
            {tab === "sources" && (
              <Input
                aria-label="按负责人筛选"
                className="max-w-48"
                placeholder="负责人 ID"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
              />
            )}
            <select
              aria-label="按支持能力筛选"
              className={selectClass}
              value={capability}
              onChange={(e) => setCapability(e.target.value)}
            >
              <option value="">所有能力</option>
              {[
                "streaming",
                "cancel",
                "resume",
                "idempotency",
                "version_pin",
                "human_approval",
              ].map((c) => (
                <option key={c} value={c}>
                  支持{fieldNames[c]}
                </option>
              ))}
            </select>
            <select
              aria-label="按可观测性筛选"
              className={selectClass}
              value={observability}
              onChange={(e) => setObservability(e.target.value)}
            >
              <option value="">所有可观测性</option>
              {["full", "partial", "none", "unknown"].map((c) => (
                <option key={c} value={c}>
                  {label(c)}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={hasWarning}
                onChange={(e) => setHasWarning(e.target.checked)}
              />
              仅含警告
            </label>
          </>
        )}
      </div>
      {tab === "sources" && (
        <>
          {attachable.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded bg-muted/40 p-3">
              <select
                aria-label="选择已有接入"
                className={selectClass}
                value={legacyId}
                onChange={(e) => setLegacyId(e.target.value)}
              >
                <option value="">选择已有接入，补建来源管理</option>
                {attachable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={isBusy || !legacyId}
                onClick={() =>
                  void run(async () => {
                    const a = agents.find((a) => a.id === legacyId)!;
                    await api.attach(a.id, a.revision);
                    setLegacyId("");
                  }, "已纳入候选管理，原有版本与频道保留。")
                }
              >
                添加来源管理
              </Button>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="p-2">来源 / 协议</th>
                  <th className="p-2">同步与可用性</th>
                  <th className="p-2">范围与凭据</th>
                  <th className="p-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredSources.map((s) => (
                  <tr key={s.id} className="border-b align-top">
                    <td className="space-y-1 p-2">
                      <strong>{s.name}</strong>
                      <div className="text-xs">{s.protocol}</div>
                      <div className="max-w-xs break-all text-xs text-muted-foreground">
                        {s.endpoint}
                      </div>
                      <div className="text-xs">
                        外部标识：{s.external_agent_id}
                      </div>
                      <div className="text-xs">适配器：{s.adapter_version}</div>
                    </td>
                    <td className="space-y-1 p-2">
                      <Badge variant={s.enabled ? "secondary" : "outline"}>
                        {s.enabled ? "已启用" : "已停用"}
                      </Badge>
                      <div>
                        {label(s.availability)} · {label(s.last_sync_status)}
                      </div>
                      <div className="text-xs">{date(s.last_sync_at)}</div>
                      <div className="text-xs">警告 {s.warning_count}</div>
                      {s.last_error && (
                        <p className="max-w-xs text-xs text-destructive">
                          {externalAgentError(new Error(s.last_error))}
                        </p>
                      )}
                    </td>
                    <td className="max-w-xs space-y-1 break-all p-2 text-xs text-muted-foreground">
                      <div>组织：{s.org_id}</div>
                      <div>Zone：{s.zone_id ?? "未记录"}</div>
                      <div>负责人：{s.owner_id}</div>
                      <div>凭据引用：{s.credential_reference}</div>
                      <div>
                        地址：
                        {endpoints.includes(s.endpoint)
                          ? "在批准范围内"
                          : "当前未获批准"}
                      </div>
                    </td>
                    <td className="p-2">
                      <div className="flex max-w-sm flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isBusy}
                          onClick={() =>
                            void run(async () => {
                              await api.test(s.id);
                            }, "连接测试通过；未执行业务任务。")
                          }
                        >
                          测试连接
                        </Button>
                        <Button
                          size="sm"
                          disabled={isBusy || !s.enabled}
                          onClick={() =>
                            void run(async () => {
                              const result = await api.sync(s);
                              if (result.error) throw new Error(result.error);
                              setTab("candidates");
                            }, "同步完成，可查看候选及校验报告。")
                          }
                        >
                          同步 / 重新导入
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={isBusy}
                          onClick={() => setSourceToEdit(s)}
                        >
                          编辑来源
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={isBusy}
                          onClick={() =>
                            void run(
                              async () => {
                                await api.update(s, { enabled: !s.enabled });
                                await onChanged();
                              },
                              s.enabled
                                ? "来源已停用，新任务将被拒绝。"
                                : "来源已重新启用，已撤销版本仍保持撤销。",
                            )
                          }
                        >
                          {s.enabled ? "停用来源" : "启用来源"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={isBusy}
                          onClick={() =>
                            void run(
                              async () => {
                                const page = await api.runs(s.catalog_id);
                                setRuns(page.items);
                                setRunCursor(page.next_cursor);
                                setRunSource(s);
                              },
                              "",
                              false,
                            )
                          }
                        >
                          执行记录
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={isBusy}
                          onClick={() =>
                            void run(
                              async () =>
                                setVersionAgent(
                                  (await api.agent(s.catalog_id)).agent,
                                ),
                              "",
                              false,
                            )
                          }
                        >
                          版本与频道
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!filteredSources.length && (
            <p className="py-4 text-sm text-muted-foreground">
              暂无匹配来源。使用“接入外部智能体”配置新的来源，或为已有接入补建来源管理。
            </p>
          )}
        </>
      )}
      {tab === "candidates" && (
        <div className="divide-y">
          {filteredCandidates.map((c) => (
            <div
              key={c.id}
              className="flex flex-wrap items-start justify-between gap-3 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-sm">{c.snapshot.name}</strong>
                  <Badge variant="outline">{label(c.status)}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {c.snapshot.protocol} · {date(c.created_at)} ·{" "}
                  {c.changes.length} 项差异 · {c.validation.warnings.length}{" "}
                  项警告
                </p>
                <p className="mt-1 break-all text-xs">
                  来源修订：
                  {c.snapshot.source_revision ?? "来源未提供，以内容摘要区分"}
                </p>
                <p className="break-all text-xs text-muted-foreground">
                  {c.snapshot.source_digest}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={isBusy}
                onClick={() =>
                  void run(
                    async () => {
                      setCandidateSource(await api.source(c.source_id));
                      setCandidate(c);
                      setDecisionNote("");
                    },
                    "",
                    false,
                  )
                }
              >
                查看差异与审核
              </Button>
            </div>
          ))}
          {!filteredCandidates.length && (
            <p className="py-4 text-sm text-muted-foreground">
              暂无匹配候选。请在来源连接中同步或重新导入。
            </p>
          )}
        </div>
      )}
      {tab === "audit" && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b">
                <th className="p-2">时间 / 操作</th>
                <th className="p-2">操作者与范围</th>
                <th className="p-2">关联记录</th>
                <th className="p-2">结果</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((a) => (
                <tr key={a.id} className="border-b align-top">
                  <td className="p-2">
                    {date(a.at)}
                    <div className="mt-1 font-medium">{a.action}</div>
                  </td>
                  <td className="max-w-xs break-all p-2">
                    {a.actor_id}
                    <div>组织：{a.org_id}</div>
                    <div>Zone：{a.zone_id ?? "未记录"}</div>
                  </td>
                  <td className="max-w-xs space-y-1 break-all p-2">
                    {a.source_id && <div>来源：{a.source_id}</div>}
                    {a.candidate_id && <div>候选：{a.candidate_id}</div>}
                    {a.version && <div>版本：{a.version}</div>}
                    {a.task_id && <div>任务：{a.task_id}</div>}
                    <div>智能体：{a.catalog_id ?? "组织策略"}</div>
                    {a.provider_run_id && (
                      <div>Provider Run：{a.provider_run_id}</div>
                    )}
                    {a.provider_response_id && (
                      <div>Provider Response：{a.provider_response_id}</div>
                    )}
                    {a.context && (
                      <details>
                        <summary>执行时协议与能力</summary>
                        <div>
                          {a.context.protocol} · {a.context.adapter_version}
                        </div>
                        <div>
                          来源修订：{a.context.source_revision ?? "未提供"}
                        </div>
                        <div>{a.context.source_digest}</div>
                        {Object.entries(a.context.capabilities).map(
                          ([key, value]) => (
                            <div key={key}>
                              {fieldNames[key] ?? key}：{label(value)}
                            </div>
                          ),
                        )}
                      </details>
                    )}
                  </td>
                  <td className="max-w-xs p-2">
                    {label(a.result)}
                    {a.reason && (
                      <p className="mt-1 text-destructive">
                        {a.result === "unknown"
                          ? "执行或发布结果待核对；请核对原操作，不要重发。"
                          : externalAgentError(new Error(a.reason))}
                      </p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-muted-foreground">
            审计记录操作与关联标识，业务输入输出及密钥不会显示在此处。历史未记录的操作不会补造成已验证事实。
          </p>
        </div>
      )}
      {cursors[tab] && (
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            disabled={isBusy}
            onClick={() => void run(more, "", false)}
          >
            加载更多治理记录
          </Button>
          <span className="text-xs text-muted-foreground">
            筛选应用于全部记录，按创建时间由新到旧分页。
          </span>
        </div>
      )}
      {versionAgent && (
        <ExternalAgentVersions
          agent={versionAgent}
          managed
          onClose={() => setVersionAgent(null)}
        />
      )}
      {runSource && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setRunSource(null);
          }}
        >
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>{runSource.name} · 执行记录</DialogTitle>
              <DialogDescription>
                显示此组织的运行关联信息。用户输入输出在用户自己的对话中查看；此处不会提供原始业务内容。
              </DialogDescription>
            </DialogHeader>
            {!runs.length && (
              <p className="text-sm text-muted-foreground">暂无执行记录</p>
            )}
            {runs.map((r) => (
              <details key={r.task_id} className="rounded border p-3 text-xs">
                <summary className="cursor-pointer">
                  {date(r.created_at)} · {label(r.status)} · {r.task_id}
                </summary>
                <div className="mt-3 grid gap-2 break-all sm:grid-cols-2">
                  <div>Task：{r.task_id}</div>
                  <div>Attempt：{r.attempt_id ?? "未派发"}</div>
                  <div>Session：{r.session_id}</div>
                  <div>用户：{r.user_id}</div>
                  <div>版本：{r.version ?? "未记录"}</div>
                  <div>来源修订：{r.source_revision ?? "未提供"}</div>
                  <div>协议：{r.protocol ?? "未记录"}</div>
                  <div>适配器：{r.adapter_version ?? "未记录"}</div>
                  <div>Provider Run ID：{r.provider_run_id ?? "未提供"}</div>
                  <div>
                    Provider Response ID：{r.provider_response_id ?? "未提供"}
                  </div>
                  <div>可观测性：{label(r.observability ?? "unknown")}</div>
                  <div>
                    版本证据：
                    {r.version_evidence === "provider_revision_fenced"
                      ? "提供方修订约束"
                      : "仅来源快照，不能证明远端不可变"}
                  </div>
                  <div className="sm:col-span-2">
                    来源摘要：{r.source_digest}
                  </div>
                  {r.capabilities &&
                    Object.entries(r.capabilities).map(([k, v]) => (
                      <div key={k}>
                        {fieldNames[k] ?? k}：{label(v)}
                      </div>
                    ))}
                  {r.error_code && (
                    <p className="text-destructive sm:col-span-2">
                      {externalAgentError(new Error(r.error_code))}
                    </p>
                  )}
                  {r.status === "unknown" && (
                    <p className="sm:col-span-2">
                      执行结果未知，不会自动重发；请核对提供方记录。
                    </p>
                  )}
                </div>
              </details>
            ))}
            {runCursor && (
              <Button
                disabled={isBusy}
                variant="outline"
                onClick={() =>
                  void run(
                    async () => {
                      const page = await api.runs(
                        runSource.catalog_id,
                        runCursor,
                      );
                      setRuns((r) => [...r, ...page.items]);
                      setRunCursor(page.next_cursor);
                    },
                    "",
                    false,
                  )
                }
              >
                加载更多执行记录
              </Button>
            )}
          </DialogContent>
        </Dialog>
      )}
      {sourceToEdit && (
        <SourceEditor
          source={sourceToEdit}
          endpoints={endpoints}
          onClose={() => setSourceToEdit(null)}
          onSave={async (change) => {
            await api.update(sourceToEdit, change);
            setSourceToEdit(null);
            await load();
          }}
        />
      )}
      {candidate && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !isBusy) setCandidate(null);
          }}
        >
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>{candidate.snapshot.name} · 候选审核</DialogTitle>
              <DialogDescription>
                审核固定的来源快照。发布后仍需明确设置频道，用户才会默认选中该版本。
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-wrap gap-2">
              <Badge>{label(candidate.status)}</Badge>
              <Badge variant="outline">{candidate.snapshot.protocol}</Badge>
              <Badge variant="outline">
                {candidate.snapshot.adapter_version}
              </Badge>
            </div>
            <dl className="grid gap-2 break-all text-xs sm:grid-cols-2">
              <div>
                来源修订：{candidate.snapshot.source_revision ?? "来源未提供"}
              </div>
              <div>
                输入 / 输出：{candidate.snapshot.input_profile} /{" "}
                {candidate.snapshot.output_profile}
              </div>
              <div className="sm:col-span-2">
                来源摘要：{candidate.snapshot.source_digest}
              </div>
              <div>连接地址：{candidate.snapshot.endpoint}</div>
              <div>校验规则：{candidate.validation.rule_version}</div>
              <div>校验时间：{date(candidate.validation.validated_at)}</div>
              <div>授权成员：{candidate.snapshot.user_ids.join("、")}</div>
              <div className="sm:col-span-2">
                网络策略摘要：{candidate.validation.policy_digest}
                ；仅允许此组织已批准的服务地址，禁止重定向。
              </div>
              <div className="sm:col-span-2">
                申请的执行权限：
                {candidate.snapshot.requested_permissions
                  ? JSON.stringify(candidate.snapshot.requested_permissions)
                  : "无临时模型或工具执行凭据"}
              </div>
            </dl>
            <div className="grid grid-cols-2 gap-2 rounded-md bg-muted/30 p-3 text-xs sm:grid-cols-3">
              {Object.entries(candidate.snapshot.capabilities).map(([k, v]) => (
                <div key={k}>
                  {fieldNames[k] ?? k}：{label(v)}
                </div>
              ))}
            </div>
            <div>
              <h5 className="mb-2 text-sm font-medium">校验报告</h5>
              <p className="text-xs">
                已通过：{candidate.validation.checks.join(" · ")}
              </p>
              {candidate.validation.warnings.map((w) => (
                <p key={w} className="mt-1 text-xs text-amber-700">
                  {(
                    {
                      SOURCE_IDENTITY_UNVERIFIED: "来源身份尚无可信证明",
                      REMOTE_VERSION_NOT_IMMUTABLE:
                        "来源快照不能保证远端代码或提示词不可变",
                      SOURCE_REVISION_UNAVAILABLE: "远端未提供真实修订号",
                      DIFY_REMOTE_PROMPT_NOT_OBSERVABLE:
                        "Dify API 不能核对远端提示词，更新后须重新上传定义",
                    } as Record<string, string>
                  )[w] ?? w}
                </p>
              ))}
            </div>
            <div>
              <h5 className="mb-2 text-sm font-medium">与上一候选的差异</h5>
              <div className="max-h-56 overflow-auto rounded border">
                <table className="w-full table-fixed text-left text-xs">
                  <thead>
                    <tr>
                      <th className="w-1/5 p-2">字段</th>
                      <th className="p-2">之前</th>
                      <th className="p-2">本次</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidate.changes.map((c) => (
                      <tr key={c.field} className="border-t align-top">
                        <td className="p-2">
                          {fieldNames[c.field] ?? c.field}
                        </td>
                        <td className="break-all p-2 text-muted-foreground">
                          {c.before ?? "首次导入"}
                        </td>
                        <td className="break-all p-2">{c.after ?? "无"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {candidate.decisions.length > 0 && (
              <div>
                <h5 className="text-sm font-medium">审批记录</h5>
                {candidate.decisions.map((d, i) => (
                  <p key={i} className="mt-1 text-xs">
                    {date(d.at)} · {d.actor_id} · {d.action}：{d.note}
                  </p>
                ))}
              </div>
            )}
            <Label htmlFor="candidate-review-note">审核说明</Label>
            <Textarea
              id="candidate-review-note"
              value={decisionNote}
              maxLength={2000}
              onChange={(e) => setDecisionNote(e.target.value)}
            />
            <select
              aria-label="候选批准有效期"
              className={selectClass}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              {[1, 3, 7].map((d) => (
                <option key={d} value={d}>
                  {d} 天
                </option>
              ))}
            </select>
            {candidate.publication_error && (
              <Alert variant="destructive">
                <AlertDescription>
                  {externalAgentError(new Error(candidate.publication_error))}
                  。请核对原发布记录；不会重新创建版本。
                </AlertDescription>
              </Alert>
            )}
            <div className="flex flex-wrap gap-2">
              {candidate.status === "draft" && (
                <Button
                  disabled={isBusy || !decisionNote.trim()}
                  onClick={() =>
                    void run(async () =>
                      setCandidate(
                        await api.decide(
                          candidate,
                          "submit",
                          decisionNote,
                          days,
                        ),
                      ),
                    )
                  }
                >
                  提交审核
                </Button>
              )}
              {candidate.status === "pending_approval" && (
                <>
                  <Button
                    disabled={isBusy || !decisionNote.trim()}
                    onClick={() =>
                      void run(async () =>
                        setCandidate(
                          await api.decide(
                            candidate,
                            "approve",
                            decisionNote,
                            days,
                          ),
                        ),
                      )
                    }
                  >
                    批准候选
                  </Button>
                  <Button
                    variant="outline"
                    disabled={isBusy || !decisionNote.trim()}
                    onClick={() =>
                      void run(async () =>
                        setCandidate(
                          await api.decide(candidate, "reject", decisionNote),
                        ),
                      )
                    }
                  >
                    拒绝候选
                  </Button>
                </>
              )}
              {candidate.status === "approved" && (
                <Button
                  disabled={isBusy}
                  onClick={() =>
                    void run(async () => {
                      setCandidate(await api.publish(candidate));
                      await onChanged();
                    })
                  }
                >
                  发布固定版本
                </Button>
              )}
              {["publishing", "publication_unknown"].includes(
                candidate.status,
              ) && (
                <>
                  <Button
                    disabled={isBusy}
                    onClick={() =>
                      void run(async () => {
                        setCandidate(await api.reconcile(candidate));
                        await onChanged();
                      })
                    }
                  >
                    核对原发布结果
                  </Button>
                  <Button
                    variant="outline"
                    disabled={isBusy || !decisionNote.trim()}
                    onClick={() =>
                      void run(async () =>
                        setCandidate(
                          await api.decide(candidate, "abandon", decisionNote),
                        ),
                      )
                    }
                  >
                    封存本次发布
                  </Button>
                  <p className="w-full text-xs text-muted-foreground">
                    封存只阻止此版本在 Moss
                    执行，不会重发发布，也不代表远端发布已取消。恢复导入请重新发起审核。
                  </p>
                </>
              )}
              {candidate.status === "published" && (
                <>
                  <p className="w-full break-all text-xs">
                    已发布：{candidate.published_version}
                  </p>
                  {(["stable", "canary"] as const).map((channel) => (
                    <Button
                      key={channel}
                      variant="outline"
                      disabled={isBusy}
                      onClick={() =>
                        void run(async () => {
                          const page = await releases.versions(
                            candidate.catalog_id,
                          );
                          await releases.moveChannel(candidate.catalog_id, {
                            name: channel,
                            version: candidate.published_version!,
                            revision:
                              page.channels.find((c) => c.name === channel)
                                ?.revision ?? 0,
                          });
                        }, `频道 ${channel} 已更新。`)
                      }
                    >
                      设为 {channel}
                    </Button>
                  ))}
                </>
              )}
              {["draft", "pending_approval", "approved", "rejected"].includes(
                candidate.status,
              ) && (
                <Button
                  variant="ghost"
                  disabled={isBusy || !decisionNote.trim()}
                  onClick={() =>
                    void run(async () =>
                      setCandidate(
                        await api.decide(candidate, "archive", decisionNote),
                      ),
                    )
                  }
                >
                  归档候选
                </Button>
              )}
              {activeSource &&
                ["rejected", "archived", "approved", "published"].includes(
                  candidate.status,
                ) && (
                  <Button
                    variant="outline"
                    disabled={isBusy || !decisionNote.trim()}
                    onClick={() =>
                      void run(async () => {
                        const r = await api.sync(
                          await api.source(activeSource.id),
                          true,
                          decisionNote,
                        );
                        if (r.error) throw new Error(r.error);
                        setCandidate(null);
                      }, "已创建新的审核轮次，旧决定保留。")
                    }
                  >
                    重新发起审核
                  </Button>
                )}
              {activeSource && (
                <Button
                  variant="ghost"
                  disabled={isBusy || !activeSource.enabled}
                  onClick={() =>
                    void run(async () => {
                      const r = await api.sync(activeSource);
                      if (r.error) throw new Error(r.error);
                      setCandidate(null);
                    }, "已重新校验；如内容或配置变化，请审核新候选。")
                  }
                >
                  重新校验来源
                </Button>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

function SourceEditor({
  source,
  endpoints,
  onClose,
  onSave,
}: {
  source: CatalogSource;
  endpoints: string[];
  onClose: () => void;
  onSave: (change: {
    name: string;
    endpoint: string;
    allowed_user_ids: string[];
    review_note: string;
    source_definition?: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState(source.name),
    [endpoint, setEndpoint] = useState(source.endpoint);
  const [definition, setDefinition] = useState<string | undefined>(),
    [filename, setFilename] = useState("");
  const [ids, setIds] = useState(source.allowed_user_ids),
    [note, setNote] = useState(source.review_note);
  const [search, setSearch] = useState(""),
    [members, setMembers] = useState<ExternalProviderMember[]>([]);
  const [memberCursor, setMemberCursor] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0);
  const memberRequest = useRef(new AbortController());
  const memberGeneration = useRef(0);
  const [isLoadingMembers, setIsLoadingMembers] = useState(false);
  useEffect(() => {
    const controller = new AbortController(),
      current = ++memberGeneration.current,
      api = createExternalAgentsApi(undefined, controller.signal);
    memberRequest.current = controller;
    setIsLoadingMembers(false);
    const timer = setTimeout(() => {
      void api
        .membersPage(search)
        .then((p) => {
          if (controller.signal.aborted || current !== memberGeneration.current)
            return;
          setMembers(p.items);
          setMemberCursor(p.next_cursor);
        })
        .catch(() => {
          if (!controller.signal.aborted) setError("成员列表加载失败");
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search]);
  async function loadMembers() {
    if (!memberCursor || isLoadingMembers) return;
    const controller = memberRequest.current,
      current = memberGeneration.current;
    setIsLoadingMembers(true);
    try {
      const page = await createExternalAgentsApi(
        undefined,
        controller.signal,
      ).membersPage(search, memberCursor);
      if (controller.signal.aborted || current !== memberGeneration.current)
        return;
      setMembers((m) => [...m, ...page.items]);
      setMemberCursor(page.next_cursor);
    } catch {
      if (!controller.signal.aborted) setError("成员列表加载失败");
    } finally {
      if (!controller.signal.aborted && current === memberGeneration.current)
        setIsLoadingMembers(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isBusy) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>编辑来源</DialogTitle>
          <DialogDescription>
            修改会使旧候选校验失效。同步并审核发布后才更新执行配置；立即停止新任务请使用“停用来源”。
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Label htmlFor="catalog-source-name">名称</Label>
        <Input
          id="catalog-source-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
        />
        <Label htmlFor="catalog-source-endpoint">已批准的服务地址</Label>
        <select
          id="catalog-source-endpoint"
          className={selectClass}
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
        >
          {[...new Set([source.endpoint, ...endpoints])].map((e) => (
            <option key={e} value={e}>
              {e}
              {endpoints.includes(e) ? "" : "（当前未批准）"}
            </option>
          ))}
        </select>
        <Label htmlFor="catalog-source-definition">更新接入说明（可选）</Label>
        <Input
          id="catalog-source-definition"
          type="file"
          accept=".json,.yaml,.yml"
          onChange={async (e) => {
            const file = e.target.files?.[0],
              current = ++generation.current;
            if (!file) return;
            if (file.size > 256 * 1024) {
              setError("接入说明不能超过 256 KB");
              return;
            }
            const value = await file.text();
            if (generation.current !== current) return;
            setDefinition(value);
            setFilename(file.name);
          }}
        />
        <p className="text-xs text-muted-foreground">
          {filename || "保留已保存的定义；同步会重新读取来源描述。"}
        </p>
        <Label htmlFor="catalog-member-search">授权成员</Label>
        <Input
          id="catalog-member-search"
          placeholder="搜索组织成员"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="max-h-36 overflow-auto rounded border p-2">
          {members.map((m) => (
            <label key={m.id} className="flex gap-2 py-1 text-sm">
              <input
                type="checkbox"
                checked={ids.includes(m.id)}
                onChange={(e) =>
                  setIds((v) =>
                    e.target.checked
                      ? [...v, m.id]
                      : v.filter((id) => id !== m.id),
                  )
                }
              />
              {m.name}
            </label>
          ))}
        </div>
        {memberCursor && (
          <Button
            size="sm"
            variant="ghost"
            disabled={isLoadingMembers}
            onClick={() => void loadMembers()}
          >
            加载更多成员
          </Button>
        )}
        <p className="break-all text-xs text-muted-foreground">
          已选 {ids.length} 人：
          {ids
            .map((id) => members.find((m) => m.id === id)?.name ?? id)
            .join("、")}
        </p>
        <Label htmlFor="catalog-source-note">用途及审核说明</Label>
        <Textarea
          id="catalog-source-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
        />
        <Button
          disabled={
            isBusy ||
            !name.trim() ||
            !ids.length ||
            !note.trim() ||
            !endpoints.includes(endpoint)
          }
          onClick={async () => {
            setIsBusy(true);
            setError("");
            try {
              await onSave({
                name,
                endpoint,
                allowed_user_ids: ids,
                review_note: note,
                ...(definition ? { source_definition: definition } : {}),
              });
            } catch (e) {
              setError(externalAgentError(e));
            } finally {
              setIsBusy(false);
            }
          }}
        >
          保存来源配置
        </Button>
      </DialogContent>
    </Dialog>
  );
}
