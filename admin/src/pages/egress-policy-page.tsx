import { useCallback, useEffect, useState } from "react";
import { parseEgressPolicy, type EgressPolicy } from "@sudo/egress-policy";
import { RefreshCw, Save, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { DashboardLayout } from "@/components/dashboard-layout";
import { ConfigScopeSelect } from "@/components/settings/config-scope-select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  applyEgressPolicy,
  getEgressPolicy,
  inheritEgressPolicy,
  saveEgressPolicy,
  type EgressPolicyView,
} from "@/lib/api/egress-policy";
import type { ConfigScope } from "@/lib/api/types";
import { useAuth } from "@/lib/hooks/use-auth";
import { useSettingsNavigationGuard } from "@/lib/hooks/use-settings-navigation-guard";

const MODE_LABELS = {
  redact: "脱敏后发送",
  deny: "发现敏感内容时拒绝",
  observe: "仅记录检测结果",
} as const;
const STATE_LABELS = {
  applied: "已生效",
  pending: "等待生效",
  error: "未能生效",
} as const;

export default function EgressPolicyPage() {
  const { user, activeOrgId } = useAuth();
  const [selectedScope, setScope] = useState<ConfigScope>("organization");
  const isPlatformAllowed = user?.role === "super_admin";
  const scope = isPlatformAllowed ? selectedScope : "organization";
  return (
    <ScopedEgressPolicy
      key={`${activeOrgId}:${scope}`}
      scope={scope}
      isPlatformAllowed={isPlatformAllowed}
      onScopeChange={setScope}
    />
  );
}

function ScopedEgressPolicy({
  scope,
  isPlatformAllowed,
  onScopeChange,
}: {
  scope: ConfigScope;
  isPlatformAllowed: boolean;
  onScopeChange(scope: ConfigScope): void;
}) {
  const [view, setView] = useState<EgressPolicyView | null>(null);
  const [draft, setDraft] = useState<EgressPolicy | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const isDirty = Boolean(
    view && draft && JSON.stringify(view.policy) !== JSON.stringify(draft),
  );
  const isAnalyzerRequired = Boolean(
    draft &&
    Object.values(draft.businessPolicy).some(
      (value) => Array.isArray(value) && value.some((item) => item.trim()),
    ),
  );
  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);
  const discard = useCallback(() => {
    if (view) setDraft(structuredClone(view.policy));
  }, [view]);
  const confirmDiscard = useSettingsNavigationGuard(isDirty, isSaving, discard);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const result = await getEgressPolicy(scope);
      setView(result);
      setDraft(structuredClone(result.policy));
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "无法读取出口保护策略",
      );
    } finally {
      setIsLoading(false);
    }
  }, [scope]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (
      !view?.runtimes.some(
        (runtime) => runtime.state === "pending" && runtime.isPresent,
      )
    )
      return;
    let isCurrent = true;
    const timer = setInterval(() => {
      void getEgressPolicy(scope)
        .then((result) => {
          if (isCurrent) setView(result);
        })
        .catch(() => {
          if (isCurrent) setError("暂时无法读取生效状态，请刷新重试");
        });
    }, 3000);
    return () => {
      isCurrent = false;
      clearInterval(timer);
    };
  }, [scope, view?.runtimes]);

  async function update(
    operation: () => Promise<EgressPolicyView>,
    message: string,
  ) {
    if (isSaving) return;
    setIsSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await operation();
      setView(result);
      setDraft(structuredClone(result.policy));
      setNotice(message);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "无法保存出口保护策略",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function onSave() {
    if (!draft) return;
    const clean = (values: string[]) =>
      values.map((value) => value.trim()).filter(Boolean);
    try {
      const policy = parseEgressPolicy({
        ...draft,
        modelMounts: clean(draft.modelMounts),
        a2aMounts: clean(draft.a2aMounts),
        analyzer: draft.analyzer
          ? { ...draft.analyzer, entities: clean(draft.analyzer.entities) }
          : null,
        businessPolicy: {
          ...draft.businessPolicy,
          protected_terms: clean(draft.businessPolicy.protected_terms),
          protected_markers: clean(draft.businessPolicy.protected_markers),
          public_organizations: clean(
            draft.businessPolicy.public_organizations,
          ),
        },
      });
      await update(
        () => saveEgressPolicy(scope, policy),
        "策略已保存，下方显示各运行时的实际生效状态。",
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "请检查策略内容");
    }
  }

  async function onChangeScope(next: ConfigScope) {
    if (next !== scope && !isSaving && (await confirmDiscard()))
      onScopeChange(next);
  }
  const headerActions = (
    <Button
      variant="outline"
      size="sm"
      aria-label="刷新"
      disabled={isSaving || isLoading}
      onClick={() => {
        void confirmDiscard().then((isConfirmed) => {
          if (isConfirmed) void load();
        });
      }}
    >
      <RefreshCw className="size-4" />
      <span className="hidden sm:inline">刷新</span>
    </Button>
  );

  return (
    <DashboardLayout
      title="数据出口保护"
      description={
        <>
          <span className="hidden sm:inline">
            控制发送到外部模型或跨域智能体的内容。云端默认关闭，开启后按所选策略检查。
          </span>
          <span className="sm:hidden">云端默认关闭</span>
        </>
      }
      headerActions={headerActions}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {isDirty
              ? "有未保存的修改"
              : view
                ? `保存的策略版本：${view.policy.revision}`
                : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            {scope === "organization" && view && !view.isInherited ? (
              <Button
                variant="outline"
                disabled={isSaving}
                onClick={() => {
                  void confirmDiscard().then((isConfirmed) => {
                    if (isConfirmed)
                      void update(
                        () => inheritEgressPolicy(view.policy.revision),
                        "已恢复继承平台策略。",
                      );
                  });
                }}
              >
                恢复继承
              </Button>
            ) : null}
            <Button
              type="submit"
              form="egress-policy-form"
              disabled={!draft || isSaving || isLoading || !isDirty}
            >
              <Save className="size-4" />
              {isSaving ? "正在保存…" : "保存策略"}
            </Button>
          </div>
        </div>
      }
    >
      <form
        id="egress-policy-form"
        className="mx-auto w-full max-w-5xl space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave();
        }}
      >
        <ConfigScopeSelect
          scope={scope}
          allowPlatform={isPlatformAllowed}
          disabled={isSaving}
          onChange={(value) => void onChangeScope(value)}
        />
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>操作未完成</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {notice ? (
          <Alert role="status">
            <ShieldCheck className="size-4" />
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}
        {isLoading ? (
          <div role="status" aria-label="正在加载出口保护策略">
            <Skeleton className="h-60" />
          </div>
        ) : draft && view ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle>出口保护策略</CardTitle>
                <CardDescription>
                  {scope === "platform"
                    ? "没有独立配置的组织继承此策略。"
                    : view.isInherited
                      ? "当前继承平台策略；保存后成为本组织的独立配置。"
                      : "当前组织使用独立配置。"}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <Label htmlFor="egress-enabled">启用出口保护</Label>
                    <p className="mt-1 text-sm text-muted-foreground">
                      生效范围由下方的出口路径决定，本地 GPU
                      路径应保留在范围之外。
                    </p>
                  </div>
                  <Switch
                    id="egress-enabled"
                    checked={draft.enabled}
                    disabled={isSaving}
                    onCheckedChange={(enabled) =>
                      setDraft({ ...draft, enabled })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="egress-mode">发现敏感内容时</Label>
                  <Select
                    value={draft.mode}
                    disabled={isSaving}
                    onValueChange={(mode) => {
                      if (
                        mode === "redact" ||
                        mode === "deny" ||
                        mode === "observe"
                      )
                        setDraft({ ...draft, mode });
                    }}
                  >
                    <SelectTrigger id="egress-mode" className="w-full sm:w-80">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(MODE_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-sm text-muted-foreground">
                    脱敏模式在检测故障或无法安全脱敏时拒绝该次外发；本地会话保留原文。
                  </p>
                  {draft.mode === "observe" ? (
                    <Alert>
                      <AlertDescription>
                        仅记录模式会发送原文，包括检测到的敏感内容和检测失败时的请求。
                      </AlertDescription>
                    </Alert>
                  ) : null}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>检测范围</CardTitle>
                <CardDescription>
                  每行一项。路径由部署确定，只有经过这些 Nexus
                  挂载的调用会被检查。
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-5 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="egress-model-mounts">外部模型路径</Label>
                  <Textarea
                    id="egress-model-mounts"
                    disabled={isSaving}
                    value={draft.modelMounts.join("\n")}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        modelMounts: event.target.value.split("\n"),
                      })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="egress-a2a-mounts">跨域消息路径</Label>
                  <Textarea
                    id="egress-a2a-mounts"
                    disabled={isSaving}
                    value={draft.a2aMounts.join("\n")}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        a2aMounts: event.target.value.split("\n"),
                      })
                    }
                  />
                  <p className="text-sm text-muted-foreground">
                    跨域消息接入验收完成后再配置，普通本地会话应保留在范围之外。
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>本地语义识别与业务规则</CardTitle>
                <CardDescription>
                  原生证件号和凭据规则始终参与启用范围内的检查。公司名、姓名和业务名单可使用本地分析器。
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="egress-analyzer">使用本地分析器</Label>
                  <Switch
                    id="egress-analyzer"
                    checked={draft.analyzer !== null}
                    disabled={isSaving || isAnalyzerRequired}
                    onCheckedChange={(enabled) => {
                      setDraft({
                        ...draft,
                        analyzer: enabled
                          ? {
                              url: "http://127.0.0.1:59080",
                              language: "zh",
                              scoreThreshold: 0.5,
                              entities: ["PERSON", "LOCATION", "ORGANIZATION"],
                              timeoutMs: 10000,
                            }
                          : null,
                      });
                    }}
                  />
                </div>
                {isAnalyzerRequired ? (
                  <p className="text-sm text-muted-foreground">
                    业务规则需要本地分析器；清空下方规则后可关闭分析器。顶部的出口保护开关可暂停全部检测并保留规则。
                  </p>
                ) : null}
                {draft.analyzer ? (
                  <div className="space-y-5">
                    <div className="space-y-2">
                      <Label htmlFor="egress-analyzer-url">
                        本地分析器地址
                      </Label>
                      <Input
                        id="egress-analyzer-url"
                        type="url"
                        disabled={isSaving}
                        value={draft.analyzer.url}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            analyzer: {
                              ...draft.analyzer!,
                              url: event.target.value,
                            },
                          })
                        }
                      />
                      <p className="text-sm text-muted-foreground">
                        分析器需要部署在运行时的本地回环地址。
                      </p>
                    </div>
                    <details className="rounded-lg border p-4">
                      <summary className="cursor-pointer text-sm font-medium">
                        识别参数
                      </summary>
                      <div className="mt-4 grid gap-5 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="egress-language">识别语言</Label>
                          <Select
                            disabled={isSaving}
                            value={draft.analyzer.language}
                            onValueChange={(language) => {
                              if (language === "zh" || language === "en")
                                setDraft({
                                  ...draft,
                                  analyzer: { ...draft.analyzer!, language },
                                });
                            }}
                          >
                            <SelectTrigger id="egress-language">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="zh">中文</SelectItem>
                              <SelectItem value="en">英语</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="egress-threshold">
                            最低置信度（0–1）
                          </Label>
                          <Input
                            id="egress-threshold"
                            type="number"
                            min={0}
                            max={1}
                            step="any"
                            disabled={isSaving}
                            value={draft.analyzer.scoreThreshold}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                analyzer: {
                                  ...draft.analyzer!,
                                  scoreThreshold: Number(event.target.value),
                                },
                              })
                            }
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="egress-timeout">
                            检测超时（毫秒）
                          </Label>
                          <Input
                            id="egress-timeout"
                            type="number"
                            min={1}
                            max={60000}
                            step={1}
                            disabled={isSaving}
                            value={draft.analyzer.timeoutMs}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                analyzer: {
                                  ...draft.analyzer!,
                                  timeoutMs: Number(event.target.value),
                                },
                              })
                            }
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="egress-entities">
                            识别类型（每行一项）
                          </Label>
                          <Textarea
                            id="egress-entities"
                            disabled={isSaving}
                            value={draft.analyzer.entities.join("\n")}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                analyzer: {
                                  ...draft.analyzer!,
                                  entities: event.target.value.split("\n"),
                                },
                              })
                            }
                          />
                          <p className="text-sm text-muted-foreground">
                            留空使用分析器支持的全部类型；默认识别人名、地点和组织。
                          </p>
                        </div>
                      </div>
                    </details>
                    <div className="grid gap-5 md:grid-cols-2">
                      {(
                        [
                          ["protected_terms", "保护的客户、合同或内部术语"],
                          ["public_organizations", "允许公开的公司名"],
                          ["protected_markers", "整段保护标记"],
                        ] as const
                      ).map(([field, label]) => (
                        <div key={field} className="space-y-2">
                          <Label htmlFor={`egress-${field}`}>{label}</Label>
                          <Textarea
                            id={`egress-${field}`}
                            disabled={isSaving}
                            value={draft.businessPolicy[field].join("\n")}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                businessPolicy: {
                                  ...draft.businessPolicy,
                                  [field]: event.target.value.split("\n"),
                                },
                              })
                            }
                          />
                        </div>
                      ))}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      每行一个精确值，保护规则优先于公开公司例外。语义识别质量仍需用本组织语料验收。
                    </p>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>实际生效状态</CardTitle>
                  <CardDescription>
                    以运行时回报为准。等待生效时，运行时仍使用上一版策略。
                  </CardDescription>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isSaving || isDirty}
                  onClick={() =>
                    void update(
                      () => applyEgressPolicy(scope),
                      "已重试下发策略。",
                    )
                  }
                >
                  重试下发
                </Button>
              </CardHeader>
              <CardContent>
                {view.runtimes.length ? (
                  <div className="space-y-3">
                    {view.runtimes.map((runtime) => (
                      <div
                        key={`${runtime.ownerId}:${runtime.allocationId}`}
                        className="rounded-lg border p-4"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="break-all text-sm">
                            {runtime.ownerId} · {runtime.allocationId}
                          </span>
                          <span
                            className={
                              runtime.state === "error"
                                ? "text-sm text-destructive"
                                : "text-sm"
                            }
                          >
                            {runtime.isPresent
                              ? STATE_LABELS[runtime.state]
                              : "尚未创建运行时"}
                          </span>
                        </div>
                        {runtime.isPresent ? (
                          <p className="mt-2 text-sm text-muted-foreground">
                            {runtime.status
                              ? `${runtime.status.enabled ? "保护已开启" : "保护已关闭"} · ${MODE_LABELS[runtime.status.mode]} · 已生效版本 ${runtime.appliedRevision}`
                              : "尚未取得运行时策略状态"}
                          </p>
                        ) : null}
                        {runtime.error || runtime.status?.error ? (
                          <p className="mt-2 text-sm text-destructive">
                            {runtime.error || runtime.status?.error}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    此范围还没有运行时，新运行时会采用保存的策略。
                  </p>
                )}
              </CardContent>
            </Card>
          </>
        ) : null}
      </form>
    </DashboardLayout>
  );
}
