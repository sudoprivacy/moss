import { ExternalEndpointRequests } from './external-endpoint-requests'
import { isEndpointAllowed, normalizeEndpoint } from '@/lib/external-endpoint'
import { ExternalTaskProfile } from './external-task-profile'
import { ExternalAgentUsageDetails } from './external-agent-usage-details'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Cloud, Loader2, Plus, RefreshCw } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/lib/hooks/use-auth'
import {
  createExternalAgentsApi,
  type ExternalAgentAdmin,
  type EndpointRequest,
  type ExternalTask,
  type ExternalPilotPolicy,
  type ExternalProviderAccess,
  type ExternalProviderMember,
  type OnboardExternalAgent,
} from '@/lib/api/external-agents'
import { externalAgentError } from '@/lib/external-agent-errors'
import { ExternalAgentVersions } from './external-agent-versions'

const selectClass = 'h-9 w-full rounded-md border bg-background px-3 text-sm'
const initialDraft = (): OnboardExternalAgent => ({
  request_id: crypto.randomUUID(),
  provider_kind: 'dify',
  endpoint: '',
  api_key: '',
  name: '',
  app_id: '',
  workspace_id: '',
  source_definition: '',
  decoder: 'text',
  allowed_user_ids: [],
  review_days: 7,
  review_note: '',
})
type DialogState =
  | { kind: 'create' }
  | { kind: 'edit' | 'rotate' | 'approve' | 'disable' | 'archive'; agent: ExternalAgentAdmin }
  | { kind: 'policy' }
  | { kind: 'endpointReview'; request: EndpointRequest; approved: boolean }
  | null

export default function ExternalAgentsSection({ query }: { query: string }) {
  const { user, activeOrgId } = useAuth()
  if (!user || !activeOrgId) return null
  return <ScopedExternalAgents key={`${user.id}:${activeOrgId}`} query={query} />
}

function ScopedExternalAgents({ query }: { query: string }) {
  const controller = useRef(new AbortController())
  const api = useMemo(() => createExternalAgentsApi(undefined, () => controller.current.signal), [controller])
  const [access, setAccess] = useState<ExternalProviderAccess | null>(null)
  const [agents, setAgents] = useState<ExternalAgentAdmin[]>([])
  const [agentCursor, setAgentCursor] = useState<string | null>(null)
  const [members, setMembers] = useState<ExternalProviderMember[]>([])
  const [memberSearch, setMemberSearch] = useState('')
  const [memberCursor, setMemberCursor] = useState<string | null>(null)
  const [isMembersLoading, setIsMembersLoading] = useState(false)
  const memberGeneration = useRef(0)
  const [policy, setPolicy] = useState<ExternalPilotPolicy>({ enabled: false, endpoints: [], revision: 0 })
  const [isLoading, setIsLoading] = useState(true)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [dialog, setDialog] = useState<DialogState>(null)
  const [versionAgent, setVersionAgent] = useState<ExternalAgentAdmin | null>(null)
  const [draft, setDraft] = useState<OnboardExternalAgent>(initialDraft)
  const [step, setStep] = useState(0)
  const [endpointMode, setEndpointMode] = useState<'existing' | 'new'>('existing')
  const [endpointNote, setEndpointNote] = useState('')
  const [endpointRequests, setEndpointRequests] = useState<EndpointRequest[]>([])
  const [endpointCursor, setEndpointCursor] = useState<string | null>(null)
  const [dialogNotice, setDialogNotice] = useState('')
  const [fileName, setFileName] = useState('')
  const [newKey, setNewKey] = useState('')
  const [reviewDays, setReviewDays] = useState(7)
  const [isPolicyEnabled, setIsPolicyEnabled] = useState(false)
  const [endpoints, setEndpoints] = useState('')
  const isBusyRef = useRef(false)
  const fileGeneration = useRef(0)
  const isLive = () => !controller.current.signal.aborted

  const onReload = useCallback(async () => {
    const current = controller.current
    const permissions = await api.access()
    if (current.signal.aborted) return
    setAccess(permissions)
    if (!permissions.can_manage) return
    const [rows, settings, requests] = await Promise.all([api.listPage(), api.policy(), api.endpointRequests()])
    if (current.signal.aborted) return
    setAgents(rows.items)
    setAgentCursor(rows.next_cursor)
    setPolicy(settings)
    setEndpointRequests(requests.items)
    setEndpointCursor(requests.next_cursor)
  }, [api, controller])

  useEffect(() => {
    if (controller.current.signal.aborted) controller.current = new AbortController()
    const current = controller.current
    void onReload()
      .catch((cause) => {
        if (!current.signal.aborted) setError(externalAgentError(cause))
      })
      .finally(() => {
        if (!current.signal.aborted) setIsLoading(false)
      })
    return () => {
      current.abort()
      fileGeneration.current++
    }
  }, [onReload])

  const onMembers = useCallback(async (search: string, after = '') => {
    const generation = ++memberGeneration.current
    setIsMembersLoading(true)
    try {
      const page = await api.membersPage(search, after)
      if (generation !== memberGeneration.current || controller.current.signal.aborted) return
      setMembers(page.items)
      setMemberCursor(page.next_cursor)
    } catch (cause) {
      if (generation === memberGeneration.current && !controller.current.signal.aborted) setError(externalAgentError(cause))
    } finally {
      if (generation === memberGeneration.current && !controller.current.signal.aborted) setIsMembersLoading(false)
    }
  }, [api, controller])
  useEffect(() => {
    if (!dialog) return
    const timer = setTimeout(() => { void onMembers(memberSearch) }, 250)
    return () => { clearTimeout(timer); memberGeneration.current++ }
  }, [dialog, memberSearch, onMembers])

  async function onRun(operation: () => Promise<void>) {
    if (isBusyRef.current || !isLive()) return
    isBusyRef.current = true
    setIsBusy(true)
    setError('')
    setNotice('')
    try {
      await operation()
    } catch (cause) {
      if (isLive()) setError(externalAgentError(cause))
    } finally {
      isBusyRef.current = false
      if (isLive()) setIsBusy(false)
    }
  }

  function clearDialog() {
    fileGeneration.current++
    setDialog(null)
    setDialogNotice('')
    setDraft(initialDraft())
    setNewKey('')
    setFileName('')
    setError('')
  }
  function onOpen(next: NonNullable<DialogState>) {
    if (isBusyRef.current) return
    setError('')
    setNotice('')
    setStep(0)
    setDialogNotice('')
    setEndpointNote('')
    setEndpointMode(policy.endpoints.length ? 'existing' : 'new')
    setFileName('')
    setNewKey('')
    setReviewDays(7)
    setDraft(
      next.kind === 'edit'
        ? { ...initialDraft(), ...next.agent, provider_kind: next.agent.provider as 'dify' | 'custom_http', api_key: '', source_definition: '' }
        : { ...initialDraft(), endpoint: policy.endpoints[0] ?? '' },
    )
    setIsPolicyEnabled(policy.enabled)
    setEndpoints(policy.endpoints.join('\n'))
    setDialog(next)
  }
  async function onFile(file?: File) {
    const generation = ++fileGeneration.current
    setDraft((current) => ({ ...current, source_definition: '' }))
    setFileName('')
    if (!file) return
    if (file.size > (draft.provider_kind === 'custom_http' ? 65536 : 256000)) {
      setError(externalAgentError(new Error(draft.provider_kind === 'custom_http' ? 'MANIFEST_TOO_LARGE' : 'DEFINITION_TOO_LARGE')))
      return
    }
    try {
      const source = await file.text()
      if (!isLive() || fileGeneration.current !== generation) return
      const manifest = draft.provider_kind === 'custom_http' ? JSON.parse(source) as { external_agent_id?: unknown; name?: unknown } : null
      setDraft((current) => ({ ...current, source_definition: source, ...(manifest ? { app_id: typeof manifest.external_agent_id === 'string' ? manifest.external_agent_id : '', workspace_id: 'custom-http', name: current.name || (typeof manifest.name === 'string' ? manifest.name : '') } : {}) }))
      setFileName(file.name)
      setError('')
    } catch {
      if (isLive() && fileGeneration.current === generation)
        setError(externalAgentError(new Error(draft.provider_kind === 'custom_http' ? 'INVALID_CUSTOM_MANIFEST' : 'DEFINITION_READ_FAILED')))
    }
  }
  const isMetadataReady = Boolean(draft.name.trim() && draft.allowed_user_ids.length && draft.review_note.trim())
  const isDefinitionReady =
    isMetadataReady && Boolean(draft.app_id.trim() && draft.workspace_id.trim() && draft.source_definition)
  const endpointAllowed = isEndpointAllowed(draft.endpoint, policy.endpoints)
  const needsEndpointRequest = !endpointAllowed && !access?.can_manage_policy
  const isConfirmDisabled =
    isBusy ||
    (dialog?.kind === 'create'
      ? step === 0
        ? !draft.endpoint.trim() || (!endpointAllowed && !endpointNote.trim()) || (!needsEndpointRequest && (!policy.enabled || !access?.credential_storage_available || !draft.api_key.trim() || (draft.provider_kind === 'custom_http' && !draft.source_definition)))
        : !isDefinitionReady
      : dialog?.kind === 'endpointReview'
        ? !endpointNote.trim()
      : dialog?.kind === 'edit'
        ? !isMetadataReady || (dialog.agent.definition_evidence === 'digest_only' && !draft.source_definition)
        : dialog?.kind === 'rotate'
          ? !newKey.trim()
          : false)

  async function onSubmit() {
    if (!dialog || isConfirmDisabled) return
    await onRun(async () => {
      if (dialog.kind === 'create' && step === 0) {
        setDialogNotice('')
        if (!endpointAllowed) {
          if (!access?.can_manage_policy) {
            const result = await api.requestEndpoint({ endpoint: draft.endpoint, reason: endpointNote })
            if (!isLive()) return
            setPolicy(result.policy)
            setDraft(current => ({ ...current, endpoint: normalizeEndpoint(current.endpoint), api_key: '' }))
            setDialogNotice(result.request ? '地址申请已提交，等待超级管理员审核。申请中不保存 API Key；批准后请刷新并测试连接。' : '该地址已在允许范围内，请填写 API Key 后测试连接。')
            await onReload()
            return
          }
          const result = await api.approveEndpoint({ endpoint: draft.endpoint, note: endpointNote, policy_revision: policy.revision })
          if (!isLive()) return
          setPolicy(result.policy)
          setDraft(current => ({ ...current, endpoint: normalizeEndpoint(current.endpoint) }))
          setDialogNotice('地址已加入当前组织的允许范围。若连接测试失败，可修正 API Key 后重试；地址批准会保留。')
          await onReload()
          if (!isLive()) return
        }
        const inspection = await api.inspect({ endpoint: draft.endpoint, api_key: draft.api_key, provider_kind: draft.provider_kind, ...(draft.provider_kind === 'custom_http' ? { source_definition: draft.source_definition } : {}) })
        if (!isLive()) return
        setDraft((current) => ({ ...current, name: current.name || inspection.name }))
        setStep(1)
        return
      }
      let message = '配置已更新。'
      if (dialog.kind === 'create') {
        await api.onboard(draft)
        message = '配置已保存，审核发布后授权用户即可使用。'
      } else if (dialog.kind === 'endpointReview') {
        await api.reviewEndpoint({ id: dialog.request.id, revision: dialog.request.revision, policy_revision: policy.revision, approved: dialog.approved, note: endpointNote })
        message = dialog.approved ? '服务地址已批准。组织管理员可刷新后测试连接；组织启用状态未改变。' : '地址申请已拒绝，申请人可查看审核说明。'
      } else if (dialog.kind === 'edit') {
        await api.update(dialog.agent.id, {
          revision: dialog.agent.revision,
          name: draft.name,
          decoder: draft.decoder,
          allowed_user_ids: draft.allowed_user_ids,
          review_days: draft.review_days,
          review_note: draft.review_note,
          ...(draft.source_definition ? { source_definition: draft.source_definition } : {}),
        })
        message = '配置已保存，发布状态已撤销，请重新审核。'
      } else if (dialog.kind === 'rotate') {
        await api.rotate(dialog.agent.id, { revision: dialog.agent.revision, api_key: newKey })
        message = '密钥已更换，请重新审核发布。'
      } else if (dialog.kind === 'archive') {
        await api.archive(dialog.agent.id, dialog.agent.revision)
        message = '智能体已归档，历史会话保留。'
      } else if (dialog.kind === 'policy') {
        await api.savePolicy({
          enabled: isPolicyEnabled,
          endpoints: endpoints
            .split('\n')
            .map((value) => value.trim())
            .filter(Boolean),
          revision: policy.revision,
        })
        message = '当前组织的外部接入范围已保存。'
      } else {
        const approved = dialog.kind === 'approve'
        await api.review(dialog.agent.id, {
          approved,
          revision: dialog.agent.revision,
          ...(approved ? { review_days: reviewDays } : {}),
        })
        message = approved ? '已发布，授权用户可在 SudoWork 的专属智能体中开始对话。' : '已停用，新的任务将被拒绝。'
      }
      if (!isLive()) return
      clearDialog()
      setNotice(message)
      await onReload()
    })
  }

  if (access && !access.can_manage) return null
  const visibleAgents = agents.filter((agent) =>
    agent.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  )
  const selected = dialog && 'agent' in dialog ? dialog.agent : null
  const title =
    dialog?.kind === 'endpointReview'
      ? dialog.approved ? '批准服务地址' : '拒绝地址申请'
    : dialog?.kind === 'create'
      ? '接入外部智能体'
      : dialog?.kind === 'edit'
        ? '编辑外部智能体'
        : dialog?.kind === 'rotate'
          ? '更换密钥'
          : dialog?.kind === 'policy'
            ? '配置外部接入范围'
            : dialog?.kind === 'approve'
              ? '审核发布外部智能体'
              : dialog?.kind === 'disable'
                ? '停用外部智能体'
                : '归档外部智能体'
  const confirmLabel =
    dialog?.kind === 'create'
      ? step === 0
        ? endpointAllowed ? '测试连接并继续' : access?.can_manage_policy ? '批准地址并测试连接' : '提交地址申请'
        : '保存待审核配置'
      : dialog?.kind === 'endpointReview'
        ? dialog.approved ? '确认批准地址' : '确认拒绝申请'
      : dialog?.kind === 'approve'
        ? '确认发布'
        : dialog?.kind === 'disable'
          ? '确认停用'
          : dialog?.kind === 'archive'
            ? '确认归档'
            : '保存'

  const metadataFields = (
    <>
      <Field id="external-name" label="智能体名称">
        <Input
          id="external-name"
          value={draft.name}
          maxLength={200}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </Field>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">允许使用的用户</legend>
        <Input aria-label="搜索组织成员" placeholder="按姓名或邮箱搜索" maxLength={100} value={memberSearch} onChange={event => setMemberSearch(event.target.value)} />
        <p className="text-xs text-muted-foreground">已选择 {draft.allowed_user_ids.length} 位成员；翻页和搜索会保留选择。</p>
        <div className="flex flex-wrap gap-2">{draft.allowed_user_ids.filter(id => !members.some(member => member.id === id)).map(id => <Button key={id} type="button" variant="outline" size="sm" onClick={() => setDraft({ ...draft, allowed_user_ids: draft.allowed_user_ids.filter(value => value !== id) })}>移除 {id}</Button>)}</div>
        <div className="grid max-h-40 grid-cols-2 gap-3 overflow-y-auto rounded-md border p-3">
          {members.map((member) => (
            <label key={member.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.allowed_user_ids.includes(member.id)}
                onCheckedChange={(checked) =>
                  setDraft({
                    ...draft,
                    allowed_user_ids: checked
                      ? [...draft.allowed_user_ids, member.id]
                      : draft.allowed_user_ids.filter((id) => id !== member.id),
                  })
                }
              />
              {member.name}
            </label>
          ))}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={isMembersLoading} onClick={() => void onMembers(memberSearch)}>第一页</Button>
          <Button type="button" variant="outline" size="sm" disabled={isMembersLoading || !memberCursor} onClick={() => void onMembers(memberSearch, memberCursor ?? '')}>下一页</Button>
        </div>
        <p className="text-xs text-muted-foreground">每页最多 50 位，只允许选择当前组织的有效成员。</p>
      </fieldset>
      <Field id="external-decoder" label="结果格式">
        <select
          id="external-decoder"
          className={selectClass}
          value={draft.decoder}
          onChange={(event) => setDraft({ ...draft, decoder: event.target.value as OnboardExternalAgent['decoder'] })}
        >
          <option value="text">直接显示文本</option>
          <option value="reply_actions_v1">提取 JSON 中的 reply</option>
        </select>
      </Field>
      <Field id="external-review-note" label="审核说明" hint="说明用途、合成测试数据范围及发布定义核对结果。">
        <Textarea
          id="external-review-note"
          value={draft.review_note}
          maxLength={1024}
          onChange={(event) => setDraft({ ...draft, review_note: event.target.value })}
        />
      </Field>
    </>
  )

  return (
    <section aria-label="外部托管智能体" className="space-y-4 border-b pb-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-semibold">
            <Cloud className="size-4" />
            外部托管<Badge variant="secondary">{agents.length}</Badge>
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            由组织接入和发布，在外部平台执行。授权成员可在 SudoWork 的专属智能体中对话。
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="icon"
            aria-label="刷新外部智能体"
            disabled={isBusy}
            onClick={() => void onRun(onReload)}
          >
            <RefreshCw className="size-4" />
          </Button>
          <Button
            disabled={isLoading || isBusy || !access?.can_manage}
            onClick={() => onOpen({ kind: 'create' })}
          >
            <Plus className="mr-2 size-4" />
            接入外部智能体
          </Button>
        </div>
      </div>
      {isLoading ? (
        <div role="status" className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          正在加载外部接入…
        </div>
      ) : access?.can_manage ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md bg-muted/40 px-3 py-2 text-sm">
          <Badge variant="outline">{policy.enabled ? '试点已启用' : '试点未启用'}</Badge>
          <span className="min-w-0 flex-1 break-all text-muted-foreground">
            {policy.endpoints.join(' · ') || '尚未配置服务地址'}
          </span>
          {access.can_manage_policy ? (
            <Button size="sm" variant="ghost" disabled={isBusy} onClick={() => onOpen({ kind: 'policy' })}>
              配置接入范围
            </Button>
          ) : null}
        </div>
      ) : null}
      {access?.can_manage && !access.credential_storage_available ? (
        <Feedback error>凭据服务不可用，请检查 Moss 的 Nexus Secret 服务。</Feedback>
      ) : null}
      {access?.can_manage && !policy.enabled && !access.can_manage_policy ? (
        <Feedback>请平台管理员为当前组织启用试点并配置允许的外部服务地址。</Feedback>
      ) : null}
      {access?.can_manage ? <ExternalEndpointRequests items={endpointRequests} endpoints={policy.endpoints} canReview={Boolean(access.can_manage_policy)} busy={isBusy} cursor={endpointCursor}
        onReview={(request, approved) => onOpen({ kind: 'endpointReview', request, approved })}
        onFirst={() => void onRun(onReload)}
        onNext={() => void onRun(async () => {
          const page = await api.endpointRequests(endpointCursor ?? '')
          if (!isLive()) return
          setEndpointRequests(page.items)
          setEndpointCursor(page.next_cursor)
        })} /> : null}
      {access?.can_manage ? <UnknownExternalTasks api={api} /> : null}
      {error && !dialog ? <Feedback error>{error}</Feedback> : null}
      {notice ? <Feedback>{notice}</Feedback> : null}
      {agentCursor && <Button type="button" variant="outline" disabled={isBusy} onClick={() => void onRun(async () => {
        const page = await api.listPage(agentCursor)
        setAgents(current => [...new Map([...current, ...page.items].map(agent => [agent.id, agent])).values()])
        setAgentCursor(page.next_cursor)
      })}>加载更多智能体</Button>}
      <div className="grid gap-4 md:grid-cols-2">
        {visibleAgents.map((agent) => {
          const isPublished = agent.approved && agent.review_expires_at > Date.now()
          return (
            <article key={agent.id} aria-label={agent.name} className="space-y-3 rounded-xl border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <h4 className="font-semibold">{agent.name}</h4>
                <div className="flex shrink-0 gap-2">
                  <Badge variant="outline">{agent.provider === 'custom_http' ? agent.protocol ?? '自研 HTTP' : 'Dify'}</Badge>
                  <Badge variant={isPublished ? 'default' : 'secondary'}>
                    {isPublished ? '已发布' : agent.approved ? '审核已到期' : '未发布'}
                  </Badge>
                </div>
              </div>
              {agent.credential_state === 'updating' ? (
                <Feedback>正在更新凭据；中断的操作会自动核对，恢复后仍需审核发布。</Feedback>
              ) : null}
              {agent.credential_state === 'rotation_required' ? (
                <Feedback error>上次凭据更新未能确认，请更换密钥后重新审核。</Feedback>
              ) : null}
              {agent.definition_evidence === 'digest_only' ? (
                <Feedback>应用定义需要重新核验。请编辑并上传包含工作流功能配置的完整定义，再审核发布。</Feedback>
              ) : null}
              <p className="break-all text-sm text-muted-foreground">{agent.endpoint}</p>
              <p className="text-sm">
                授权用户：
                {agent.allowed_user_ids.map((id) => members.find((member) => member.id === id)?.name ?? id).join('、')}
              </p>
              {agent.approved ? (
                <p className="text-xs text-muted-foreground">
                  有效期至 {new Date(agent.review_expires_at).toLocaleString()}
                </p>
              ) : null}
              <ExternalAgentUsageDetails agent={agent} />
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">接入详情</summary>
                <dl className="mt-2 space-y-1 break-all text-xs">
                  <dt>{agent.provider === 'custom_http' ? '服务智能体标识' : 'App ID'}</dt>
                  <dd>{agent.app_id}</dd>
                  {agent.provider !== 'custom_http' ? <><dt>Workspace ID</dt><dd>{agent.workspace_id}</dd></> : null}
                  <dt>定义摘要</dt>
                  <dd>{agent.source_digest}</dd>
                  <dt>审核说明</dt>
                  <dd>{agent.review_note}</dd>
                </dl>
                <p className="mt-2 text-xs text-muted-foreground">密钥保存在凭据服务，不会回显。应用与工作区身份尚未验证，仅允许管理员核对后的合成数据试点，不支持强来源审计。</p>
              </details>
              <div className="flex flex-wrap gap-2 border-t pt-3">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isBusy}
                  onClick={() =>
                    void onRun(async () => {
                      await api.test(agent.id)
                      if (isLive()) setNotice('连接成功，应用参数符合当前试点要求；应用身份仍未验证。')
                    })
                  }
                >
                  测试连接
                </Button>
                <Button size="sm" variant="outline" disabled={isBusy} onClick={() => onOpen({ kind: 'edit', agent })}>
                  编辑配置
                </Button>
                {!isPublished ? (
                  <Button
                    size="sm"
                    disabled={
                      isBusy ||
                      !policy.enabled ||
                      agent.credential_state === 'updating' ||
                      agent.credential_state === 'rotation_required'
                    }
                    onClick={() => onOpen({ kind: 'approve', agent })}
                  >
                    审核发布
                  </Button>
                ) : null}
                {agent.approved ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isBusy}
                    onClick={() => onOpen({ kind: 'disable', agent })}
                  >
                    停用
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={isBusy || !access?.credential_storage_available}
                  onClick={() => onOpen({ kind: 'rotate', agent })}
                >
                  更换密钥
                </Button>
                <Button size="sm" variant="outline" disabled={isBusy} onClick={() => setVersionAgent(agent)}>版本与频道</Button>
                <Button size="sm" variant="ghost" disabled={isBusy} onClick={() => onOpen({ kind: 'archive', agent })}>
                  归档
                </Button>
              </div>
            </article>
          )
        })}
      </div>
      {!isLoading && access?.can_manage && !visibleAgents.length ? (
        <p className="rounded-lg border border-dashed p-5 text-center text-sm text-muted-foreground">
          {query.trim() ? '没有匹配的外部智能体' : '尚未接入外部智能体，接入并审核后可供授权成员使用。'}
        </p>
      ) : null}
      {versionAgent && <ExternalAgentVersions key={versionAgent.id} agent={versionAgent} onClose={() => setVersionAgent(null)} />}
      <Dialog
        open={Boolean(dialog)}
        onOpenChange={(open) => {
          if (!open && !isBusyRef.current) clearDialog()
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {selected?.name ||
                (dialog?.kind === 'endpointReview' ? '仅批准当前组织的网络访问范围，不会自动启用组织或发布智能体。' : dialog?.kind === 'policy'
                  ? '网络接入范围由平台管理员维护，组织管理员负责本组织的接入和发布。'
                  : '将已发布的外部智能体接入当前组织。仅用于已审核的合成数据试点。')}
            </DialogDescription>
          </DialogHeader>
          {error ? <Feedback error>{error}</Feedback> : null}
          {dialogNotice ? <Feedback>{dialogNotice}</Feedback> : null}
          <fieldset disabled={isBusy} className="min-w-0 space-y-4">
            {dialog?.kind === 'create' ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {step === 0 ? '1 / 2 · 平台与连接' : '2 / 2 · 定义与授权'}
                </p>
                {step === 0 ? (
                  <>
                    <Field id="external-provider" label="执行平台">
                      <select id="external-provider" className={selectClass} value={draft.provider_kind ?? 'dify'} onChange={(event) => {
                        fileGeneration.current++
                        setFileName('')
                        setDraft({ ...draft, provider_kind: event.target.value as 'dify' | 'custom_http', source_definition: '', app_id: '', workspace_id: '', name: '' })
                      }}>
                        <option value="dify">Dify</option>
                        <option value="custom_http">协议接入（HTTP / OpenAI / MCP / A2A）</option>
                      </select>
                    </Field>
                    {draft.provider_kind === 'custom_http' ? (
                      <Field id="external-manifest" label="接入说明文件（Manifest）" hint="上传服务提供的 JSON 接入文件，最大 64 KB。测试连接会核对服务当前说明与文件是否一致。">
                        <Input id="external-manifest" type="file" accept=".json" onChange={(event) => void onFile(event.target.files?.[0])} />
                        {fileName ? <p className="text-xs text-muted-foreground">已读取：{fileName}</p> : null}
                        {draft.provider_kind === 'custom_http' && <ExternalTaskProfile source={draft.source_definition} />}
                      </Field>
                    ) : null}
                    <Field id="external-endpoint-mode" label="服务 API 地址来源">
                      <select id="external-endpoint-mode" className={selectClass} value={endpointMode} onChange={event => {
                        const mode = event.target.value as 'existing' | 'new'
                        setEndpointMode(mode)
                        setDialogNotice('')
                        setDraft({ ...draft, endpoint: mode === 'existing' ? policy.endpoints[0] ?? '' : '', api_key: '' })
                      }}>
                        <option value="existing" disabled={!policy.endpoints.length}>选择已批准地址</option>
                        <option value="new">填写新地址</option>
                      </select>
                    </Field>
                    <Field id="external-endpoint" label="服务 API 地址" hint="填写服务的固定 IP 地址，以 /v1 结尾，例如 http://10.0.1.158:8089/v1。Dify 可在应用的“访问 API”页面查看。">
                      {endpointMode === 'existing' ? <select id="external-endpoint" className={selectClass} value={draft.endpoint} onChange={event => { setDialogNotice(''); setDraft({ ...draft, endpoint: event.target.value, api_key: '' }) }}>
                        {draft.endpoint && !endpointAllowed && <option value={draft.endpoint}>{draft.endpoint}（已移出允许范围）</option>}
                        {policy.endpoints.map(endpoint => <option key={endpoint} value={endpoint}>{endpoint}</option>)}
                      </select> : <Input id="external-endpoint" value={draft.endpoint} maxLength={1024} placeholder="http://10.0.1.158:8089/v1" onChange={event => { setDialogNotice(''); setDraft({ ...draft, endpoint: event.target.value, api_key: '' }) }} />}
                      <p className="text-xs text-muted-foreground">{endpointAllowed ? '地址已批准，可直接测试连接。' : access?.can_manage_policy ? '你是超级管理员，确认后将批准此地址并测试连接。' : '新地址需超级管理员批准。提交申请不会连接远端服务，也不会提交 API Key。'}</p>
                    </Field>
                    {!endpointAllowed && <Field id="external-endpoint-note" label={access?.can_manage_policy ? '地址批准说明' : '地址申请说明'} hint="填写服务用途与归属，请勿填写密钥。">
                      <Textarea id="external-endpoint-note" value={endpointNote} maxLength={1000} onChange={event => setEndpointNote(event.target.value)} />
                    </Field>}
                    {!policy.enabled && <Feedback>当前组织尚未启用外部接入。组织管理员可以先申请地址；超级管理员需在“配置接入范围”中显式启用后才能测试。</Feedback>}
                    <Button type="button" variant="outline" size="sm" onClick={() => void onRun(onReload)}>刷新地址审批状态</Button>
                    <Field
                      id="external-api-key"
                      label="服务 API Key"
                      hint={draft.provider_kind === 'custom_http' ? '使用服务提供的访问密钥。保存后加密存储，不会回显。' : '在 Dify 应用的“访问 API”页面获取。保存后加密存储，不会回显。'}
                    >
                      <Input
                        id="external-api-key"
                        type="password"
                        disabled={needsEndpointRequest}
                        autoComplete="new-password"
                        value={draft.api_key}
                        onChange={(event) => setDraft({ ...draft, api_key: event.target.value })}
                      />
                    </Field>
                  </>
                ) : (
                  <>
                    {draft.provider_kind === 'custom_http' ? <Feedback>已核对接入说明。服务智能体：{draft.app_id}。能力以已审核协议声明为准。OpenAI、MCP、A2A 当前为单轮文本；每次发送独立执行，不传递历史对话。</Feedback> : <>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field id="external-app-id" label="声明的 Dify App ID" hint="测试连接不能证明密钥与填写的应用、工作区和上传定义属于同一来源，请核对实际发布内容。">
                        <Input
                          id="external-app-id"
                          value={draft.app_id}
                          onChange={(event) => setDraft({ ...draft, app_id: event.target.value })}
                        />
                      </Field>
                      <Field id="external-workspace-id" label="声明的 Dify Workspace ID">
                        <Input
                          id="external-workspace-id"
                          value={draft.workspace_id}
                          onChange={(event) => setDraft({ ...draft, workspace_id: event.target.value })}
                        />
                      </Field>
                    </div>
                    <Field
                      id="external-definition"
                      label="应用定义文件"
                      hint="上传完整 Dify YAML / JSON，最大 256 KB，需包含 workflow.features。仅支持 Start → LLM → Answer，不支持附件、工具或知识库。请在 Dify 核对实际发布内容；上传文件不构成远端版本锁定。"
                    >
                      <Input
                        id="external-definition"
                        type="file"
                        accept=".yaml,.yml,.json"
                        onChange={(event) => void onFile(event.target.files?.[0])}
                      />
                      {fileName ? <p className="text-xs text-muted-foreground">已读取：{fileName}</p> : null}

                    </Field>
                    </>}
                    {metadataFields}
                  </>
                )}
              </>
            ) : null}
            {dialog?.kind === 'edit' ? (
              <>
                <Feedback>保存会撤销发布状态，需重新审核后才能执行新任务。</Feedback>
                <Field id="external-definition-update" label="重新上传应用定义" hint={draft.provider_kind === 'custom_http' ? '上传更新的 JSON Manifest，服务智能体标识必须保持不变。留空保留当前说明；保存后需要重新审核。' : '旧定义需重新上传；已核验定义可留空保留。文件必须包含工作流功能配置，且需人工核对当前 Dify 发布内容。'}>
                  <Input id="external-definition-update" type="file" accept=".yaml,.yml,.json" onChange={(event) => void onFile(event.target.files?.[0])} />
                  {fileName ? <p className="text-xs text-muted-foreground">已读取：{fileName}</p> : null}
                        {draft.provider_kind === 'custom_http' && <ExternalTaskProfile source={draft.source_definition} />}
                </Field>
                {metadataFields}
              </>
            ) : null}
            {dialog?.kind === 'rotate' ? (
              <>
                <Feedback>验证新密钥后将停用此智能体并替换凭据。完成后需重新审核发布。</Feedback>
                <Field id="external-new-key" label="新的服务 API Key">
                  <Input
                    id="external-new-key"
                    type="password"
                    autoComplete="new-password"
                    value={newKey}
                    onChange={(event) => setNewKey(event.target.value)}
                  />
                </Field>
              </>
            ) : null}
            {dialog?.kind === 'endpointReview' ? <>
              <p className="break-all text-sm font-medium">{dialog.request.endpoint}</p>
              <p className="break-words text-sm">申请说明：{dialog.request.reason}</p>
              <Field id="external-endpoint-review-note" label="审核说明">
                <Textarea id="external-endpoint-review-note" value={endpointNote} maxLength={1000} onChange={event => setEndpointNote(event.target.value)} />
              </Field>
            </> : null}
            {dialog?.kind === 'policy' ? (
              <>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={isPolicyEnabled} onCheckedChange={(value) => setIsPolicyEnabled(value === true)} />
                  启用当前组织试点
                </label>
                <Field
                  id="external-policy-endpoints"
                  label="允许的服务 API 地址"
                  hint="每行一个完整固定 IP 地址，以 /v1 结尾。"
                >
                  <Textarea
                    id="external-policy-endpoints"
                    value={endpoints}
                    onChange={(event) => setEndpoints(event.target.value)}
                  />
                </Field>
              </>
            ) : null}
            {dialog?.kind === 'approve' ? (
              <>
                <p className="text-sm">
                  请核对定义与外部平台当前发布内容一致，并确认授权用户。发布后这些用户可发起任务。
                </p>
                <div className="space-y-2 rounded-md bg-muted/40 p-3 text-sm">
                  <p>{selected?.review_note}</p>
                  <p>
                    授权用户：
                    {selected?.allowed_user_ids
                      .map((id) => members.find((member) => member.id === id)?.name ?? id)
                      .join('、')}
                  </p>
                  <p className="break-all">App ID：{selected?.app_id}</p>
                  <p className="break-all text-xs">定义摘要：{selected?.source_digest}</p>
                </div>
                <Field id="external-validity" label="发布有效期">
                  <select
                    id="external-validity"
                    className={selectClass}
                    value={reviewDays}
                    onChange={(event) => setReviewDays(Number(event.target.value))}
                  >
                    {[1, 3, 7].map((days) => (
                      <option value={days} key={days}>
                        {days} 天
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            ) : null}
            {dialog?.kind === 'disable' ? (
              <p className="text-sm">停用将阻止新任务，已发往外部平台的任务不会因此取消。既有会话保留。</p>
            ) : null}
            {dialog?.kind === 'archive' ? (
              <p className="text-sm">归档后智能体将退出接入目录，无法再发起任务。既有会话保留，无法恢复接入。Moss 创建的专用凭据会被清理；引用的已有凭据由其所有者管理，不会删除。</p>
            ) : null}
          </fieldset>
          <DialogFooter>
            <Button variant="outline" disabled={isBusy} onClick={clearDialog}>
              取消
            </Button>
            {dialog?.kind === 'create' && step === 1 ? (
              <Button variant="outline" disabled={isBusy} onClick={() => setStep(0)}>
                上一步
              </Button>
            ) : null}
            <Button disabled={isConfirmDisabled} onClick={() => void onSubmit()}>
              {isBusy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
function Feedback({ error, children }: { error?: boolean; children: ReactNode }) {
  return (
    <Alert variant={error ? 'destructive' : 'default'}>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}

function UnknownExternalTasks({ api }: { api: ReturnType<typeof createExternalAgentsApi> }) {
  const [tasks, setTasks] = useState<ExternalTask[]>([])
  const [selected, setSelected] = useState<ExternalTask | null>(null)
  const [note, setNote] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState('')
  const onRefresh = useCallback(async () => {
    setTasks(await api.unknownTasks())
  }, [api])
  useEffect(() => {
    let isActive = true
    void api
      .unknownTasks()
      .then((rows) => {
        if (isActive) setTasks(rows)
      })
      .catch((cause) => {
        if (isActive) setError(externalAgentError(cause))
      })
    return () => {
      isActive = false
    }
  }, [api])
  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label="待核对的外部任务">
      <div className="flex items-center justify-between">
        <h4 className="font-medium">待核对的外部任务（{tasks.length}）</h4>
        <Button
          size="sm"
          variant="outline"
          disabled={isBusy}
          onClick={() => void onRefresh().catch((cause) => setError(externalAgentError(cause)))}
        >
          刷新任务
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        结果未知的任务不会自动重发。请在外部平台
        核对运行记录后填写结论并关闭本地会话；此操作不会取消远端任务或将其标记为成功。
      </p>
      {error ? <Feedback error>{error}</Feedback> : null}
      {tasks.map((task) => (
        <div key={task.id} className="flex items-center justify-between gap-2 text-sm">
          <span className="break-all">
            {task.agent_name} · {task.id}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setSelected(task)
              setNote('')
              setError('')
            }}
          >
            核对并关闭
          </Button>
        </div>
      ))}
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open && !isBusy) setSelected(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>核对外部任务</DialogTitle>
            <DialogDescription>
              请核对远端运行记录，记录结果。关闭后保留原始 unknown 状态与历史，用户需新建对话，原会话不会解锁或重放。
            </DialogDescription>
          </DialogHeader>
          <pre className="overflow-auto whitespace-pre-wrap text-xs">
            {JSON.stringify(selected?.provider_refs, null, 2)}
          </pre>
          <Label htmlFor="external-reconcile-note">核对依据和结论（至少 10 个字符）</Label>
          <Textarea
            id="external-reconcile-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={2000}
          />
          <DialogFooter>
            <Button
              disabled={isBusy || note.trim().length < 10}
              onClick={() => {
                if (!selected) return
                setIsBusy(true)
                void api
                  .reconcileTask(selected.id, note)
                  .then(async () => {
                    setSelected(null)
                    await onRefresh()
                  })
                  .catch((cause) => setError(externalAgentError(cause)))
                  .finally(() => setIsBusy(false))
              }}
            >
              记录核对并关闭会话
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
