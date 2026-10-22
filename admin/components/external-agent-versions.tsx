import { catalogStatusLabel } from "./external-catalog-overview";
import { ExternalTaskProfile } from "./external-task-profile";
import { ExternalAgentRegistryStatus } from "./external-agent-registry-status";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createExternalAgentsApi,
  type ExternalAgentAdmin,
  type AgentVersionsPage,
} from "@/lib/api/external-agents";
import { externalAgentError } from "@/lib/external-agent-errors";
import {
  createAgentCatalogApi,
  type CatalogVersionDetail,
  type CatalogVersionState,
} from "@/lib/api/agent-catalog";

export function ExternalAgentVersions({
  agent,
  onClose,
  onChanged,
  managed = false,
}: {
  agent: ExternalAgentAdmin;
  onClose: () => void;
  onChanged?: () => Promise<void>;
  managed?: boolean;
}) {
  const controller = useRef(new AbortController());
  const api = useMemo(
    () => createExternalAgentsApi(undefined, () => controller.current.signal),
    [],
  );
  const governance = useMemo(
    () => createAgentCatalogApi(() => controller.current.signal),
    [],
  );
  const [details, setDetails] = useState<CatalogVersionDetail[]>([]);
  const [states, setStates] = useState<CatalogVersionState[]>([]);
  const busy = useRef(false);
  const [page, setPage] = useState<AgentVersionsPage | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [revoke, setRevoke] = useState<string | null>(null);
  const reload = useCallback(
    async (after = "") => {
      const data = await api.versions(agent.id, after);
      {
        const state = await governance.agent(agent.id);
        if (!controller.current.signal.aborted) {
          setStates(state.versions);
          setDetails(state.version_details);
        }
      }
      if (!controller.current.signal.aborted)
        setPage((current) =>
          after && current
            ? { ...data, items: [...current.items, ...data.items] }
            : data,
        );
    },
    [api, agent.id, governance, managed],
  );
  useEffect(() => {
    if (controller.current.signal.aborted)
      controller.current = new AbortController();
    const current = controller.current;
    void reload().catch((cause) => {
      if (!current.signal.aborted) setError(externalAgentError(cause));
    });
    return () => current.abort();
  }, [reload]);
  async function run(
    action: () => Promise<unknown>,
    message: string,
    refresh = true,
  ) {
    if (busy.current) return;
    busy.current = true;
    setIsBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      if (refresh) {
        await reload();
        await onChanged?.();
      }
      if (!controller.current.signal.aborted) {
        setNotice(message);
        setRevoke(null);
      }
    } catch (cause) {
      if (!controller.current.signal.aborted)
        setError(externalAgentError(cause));
    } finally {
      busy.current = false;
      if (!controller.current.signal.aborted) setIsBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy.current) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{agent.name} · 版本与频道</DialogTitle>
          <DialogDescription>
            发布固定来源版本，再将 stable 或 canary
            指向该版本。新会话默认使用当前频道；已有会话保持首次使用的版本，切换版本需新建会话。
          </DialogDescription>
        </DialogHeader>
        <ExternalAgentRegistryStatus
          agentId={agent.id}
          onMigrated={() => {
            void run(() => reload(), "迁移已完成，版本目录已刷新。");
          }}
        />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        {!page ? (
          error ? (
            <Button
              variant="outline"
              disabled={isBusy}
              onClick={() => void run(() => reload(), "", false)}
            >
              重新加载
            </Button>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              正在加载版本…
            </p>
          )
        ) : (
          <>
            <p className="break-all text-xs text-muted-foreground">
              身份：nexus://{page.principal.trust_domain}/agent/
              {page.principal.agent_name}
            </p>
            <div className="space-y-2 rounded-md border p-3">
              {(["stable", "canary"] as const).map((name) => {
                const channel = page.channels.find((c) => c.name === name);
                return (
                  <p key={name} className="break-all text-sm">
                    <strong>{name}</strong>：
                    {channel
                      ? `${channel.version}${channel.enabled ? "" : "（已停用）"}`
                      : "未发布"}
                  </p>
                );
              })}
            </div>
            {!managed && (
              <form
                className="space-y-3 rounded-md border p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(
                    () =>
                      api.publishVersion(agent.id, {
                        revision: agent.revision,
                        version: label.trim(),
                        note: note.trim(),
                      }),
                    "版本已发布，可在下方选择发布频道。",
                  );
                }}
              >
                <Label htmlFor="external-version-label">
                  为当前已审核配置发布版本
                </Label>
                <Input
                  id="external-version-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  maxLength={128}
                  placeholder="例如 1.0.0 或 1.1.0-rc.1"
                  required
                  pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
                  disabled={isBusy || !agent.approved}
                />
                <Label htmlFor="external-version-note">发布或撤销说明</Label>
                <Textarea
                  id="external-version-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={2000}
                  required
                  placeholder="说明版本变化、审核依据或撤销原因"
                  disabled={isBusy}
                />
                <Button
                  type="submit"
                  disabled={
                    isBusy || !agent.approved || !label.trim() || !note.trim()
                  }
                >
                  发布不可变版本
                </Button>
                {!agent.approved && (
                  <p className="text-xs text-muted-foreground">
                    当前配置尚未审核，请先完成审核发布。
                  </p>
                )}
              </form>
            )}
            {managed && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-sm">新版本请在“待审核候选”中批准并发布。</p>
                <Label htmlFor="managed-version-note">
                  撤销 / 弃用 / 归档说明
                </Label>
                <Textarea
                  id="managed-version-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={2000}
                />
              </div>
            )}
            <div className="space-y-3">
              {!page.items.length && (
                <p className="text-sm text-muted-foreground">
                  尚未发布版本。完成当前配置审核后即可发布。
                </p>
              )}
              {page.items.map((version) => {
                const state = states.find((s) => s.version === version.version);
                const detail = details.find(
                  (d) => d.version === version.version,
                );
                const revoked = version.decisions.some(
                  (d) => d.decision === "revoked",
                );
                const approved =
                  !revoked &&
                  version.decisions.some(
                    (d) =>
                      d.decision === "approved" && d.expires_at > Date.now(),
                  );
                return (
                  <article
                    key={version.version}
                    className="space-y-2 rounded-md border p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="break-all text-sm">
                        {version.version}
                      </strong>
                      <Badge variant="outline">
                        {revoked
                          ? "已撤销"
                          : version.decisions[0]?.decision === "withdrawn"
                            ? "已撤回批准"
                            : approved
                              ? "已批准"
                              : "未批准或已过期"}
                      </Badge>
                      <Badge variant="secondary">
                        {version.snapshot.sourceManifest?.execution_revision
                          ? "执行版本锁定"
                          : "来源快照"}
                      </Badge>
                    </div>
                    <p className="break-all text-xs text-muted-foreground">
                      来源：{version.snapshot.source_digest}
                    </p>
                    {state && (
                      <p className="break-all text-xs text-muted-foreground">
                        治理状态：
                        {state.lifecycle === "published"
                          ? "已发布"
                          : state.lifecycle === "deprecated"
                            ? "已弃用，停止新任务"
                            : "已归档"}{" "}
                        ·{" "}
                        {state.provenance === "legacy_adopted"
                          ? "历史版本显式纳管，原审批记录保留"
                          : `候选：${state.candidate_id}`}
                      </p>
                    )}
                    {version.decisions.map((d) => (
                      <p key={d.id} className="text-xs text-muted-foreground">
                        {new Date(d.created_at).toLocaleString()} · {d.actor_id}{" "}
                        · {d.decision}：{d.note}
                      </p>
                    ))}
                    {version.registry && (
                      <div className="space-y-1 text-xs text-muted-foreground">
                        <Badge variant="outline">Nexus 登记签名已验证</Badge>
                        <p className="break-all">
                          登记摘要：{version.registry.registration_digest}
                        </p>
                        <p>
                          登记签名证明版本登记信息；远端执行版本保证仍取决于
                          Provider。
                        </p>
                      </div>
                    )}
                    {detail && (
                      <dl className="grid gap-2 break-all rounded bg-muted/30 p-3 text-xs sm:grid-cols-2">
                        <div>目录状态：{catalogStatusLabel(detail.status)}</div>
                        <div>
                          审批状态：{catalogStatusLabel(detail.approval_status)}
                        </div>
                        <div>
                          来源修订：
                          {detail.source_revision ?? "未记录（历史版本）"}
                        </div>
                        <div>
                          适配器版本：
                          {detail.adapter_version ?? "未记录（历史版本）"}
                        </div>
                        <div>
                          当前频道：
                          {detail.channels
                            .map(
                              (c) => c.name + (c.enabled ? "" : "（已停用）"),
                            )
                            .join("、") || "无"}
                        </div>
                        <div>来源身份：未验证</div>
                        <div className="sm:col-span-2">
                          来源摘要：{detail.source_digest}
                        </div>
                        <div className="sm:col-span-2">
                          撤销原因：{detail.revoke_reason ?? "无"}
                        </div>
                        <div className="sm:col-span-2">
                          证据级别：
                          {detail.evidence_level === "source_snapshot_only"
                            ? "仅来源快照；不能证明远端执行不可变或来源身份可信"
                            : "提供方修订约束；不代表来源身份已验证"}
                        </div>
                        {!detail.can_promote && (
                          <div className="sm:col-span-2">
                            不能切换至此版本：
                            {externalAgentError(
                              new Error(
                                detail.promotion_block ??
                                  "AGENT_VERSION_NOT_APPROVED",
                              ),
                            )}
                          </div>
                        )}
                      </dl>
                    )}
                    <p className="text-xs text-muted-foreground">
                      发布于 {new Date(version.created_at).toLocaleString()} ·{" "}
                      {version.created_by}
                    </p>
                    <ExternalTaskProfile
                      profile={
                        version.snapshot.sourceManifest?.execution_context
                      }
                    />
                    {!version.snapshot.sourceManifest?.execution_revision && (
                      <p className="text-xs text-muted-foreground">
                        此来源未提供远端不可变执行保证；运行前仍需核对来源。
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {(["stable", "canary"] as const).map((name) => (
                        <Button
                          key={name}
                          size="sm"
                          variant="outline"
                          disabled={isBusy || !detail?.can_promote}
                          onClick={() =>
                            void run(
                              () =>
                                api.moveChannel(agent.id, {
                                  name,
                                  version: version.version,
                                  revision:
                                    page.channels.find((c) => c.name === name)
                                      ?.revision ?? 0,
                                }),
                              `${name} 已切换到 ${version.version}。`,
                            )
                          }
                        >
                          设为 {name}
                        </Button>
                      ))}
                      {detail?.can_promote &&
                        page.channels.some(
                          (c) =>
                            c.name === "stable" &&
                            c.version !== version.version,
                        ) && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isBusy}
                            onClick={() =>
                              void run(
                                () =>
                                  api.moveChannel(agent.id, {
                                    name: "stable",
                                    version: version.version,
                                    revision:
                                      page.channels.find(
                                        (c) => c.name === "stable",
                                      )?.revision ?? 0,
                                  }),
                                `stable 已回滚到 ${version.version}。`,
                              )
                            }
                          >
                            回滚 stable 至此版本
                          </Button>
                        )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={isBusy || revoked}
                        onClick={() => setRevoke(version.version)}
                      >
                        撤销版本
                      </Button>
                      {managed && state && state.lifecycle !== "archived" && (
                        <>
                          {state.lifecycle !== "deprecated" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={isBusy || !note.trim()}
                              onClick={() =>
                                void run(
                                  () =>
                                    governance.lifecycle(
                                      agent.id,
                                      version.version,
                                      "deprecated",
                                      note.trim(),
                                    ),
                                  "版本已弃用，停止新任务。",
                                )
                              }
                            >
                              弃用版本
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={isBusy || !note.trim()}
                            onClick={() =>
                              void run(
                                () =>
                                  governance.lifecycle(
                                    agent.id,
                                    version.version,
                                    "archived",
                                    note.trim(),
                                  ),
                                "版本已归档，历史记录保留。",
                              )
                            }
                          >
                            归档版本
                          </Button>
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
            {page.next_cursor && (
              <Button
                variant="outline"
                disabled={isBusy}
                onClick={() => {
                  void run(
                    () => reload(page.next_cursor!),
                    "已加载更多版本。",
                    false,
                  );
                }}
              >
                加载更多版本
              </Button>
            )}
            {revoke && (
              <div className="space-y-3 rounded-md border border-destructive p-3">
                <p className="break-all text-sm">
                  确认撤销 {revoke}
                  ？此版本将禁止新任务，指向它的频道会停用。已经派发的远端任务不保证被取消。
                </p>
                <p className="text-xs text-muted-foreground">
                  请在上方填写撤销说明；撤销后不能重新批准同一版本。
                </p>
                <Button
                  variant="destructive"
                  disabled={isBusy || !note.trim()}
                  onClick={() =>
                    void run(
                      () =>
                        api.revokeVersion(agent.id, {
                          version: revoke,
                          note: note.trim(),
                        }),
                      "版本已撤销。",
                    )
                  }
                >
                  确认撤销
                </Button>
                <Button
                  variant="ghost"
                  disabled={isBusy}
                  onClick={() => setRevoke(null)}
                >
                  返回
                </Button>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
