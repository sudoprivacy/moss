import { Link } from 'react-router-dom'
import { AgentAssetSuspension } from './agent-asset-suspension'
import { AgentHostedUnknownTasks } from './agent-hosted-unknown-tasks'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Download, Plus, RefreshCw, X } from 'lucide-react'
import { AgentDiscoverySection } from './agent-discovery-section'
import { AgentHostedArtifacts } from './agent-hosted-artifacts'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/lib/hooks/use-auth'
import {
  createInventoryApi,
  exportInventory,
  type AssetMetadata,
  type AssetRecord,
  type AssetHistory,
  type InventoryAccess,
  type InventoryInput,
  type InventoryMember,
} from '@/lib/api/agent-inventory'
import { createExternalAgentsApi, type ExternalAgentAdmin } from '@/lib/api/external-agents'
import {
  assetStatuses,
  evidenceStatuses,
  inventoryError,
  recommendationLabels,
  riskLabels,
} from '@/lib/agent-inventory-labels'

const selectClass = 'h-9 w-full rounded-md border bg-background px-3 text-sm'
const platforms = ['dify', 'langgraph', 'openai', 'mcp', 'a2a', 'http', 'native', 'saas', 'other'] as const
const hostingLabels = { external_hosted: '外部托管', internal_hosted: '内部托管', public_saas: '公有 SaaS（仅登记）' }
type Action = 'edit' | 'submit' | 'approve' | 'return' | 'suspend' | 'link' | 'merge'
type DialogState = { action: Action; asset: AssetRecord | null; requestId: string; newId: string }
const initialMetadata = (access: InventoryAccess): AssetMetadata => ({
  name: '',
  source_platform: 'dify',
  source_instance: '',
  source_agent_id: '',
  owner_user_id: access.can_own ? access.user_id : '',
  department_id: access.department_id,
  purpose: '',
  domain: 'office',
  hosting: 'external_hosted',
  requested_level: 'L1',
  data_connections: [],
  tool_refs: [],
  model_paths: [],
  risk_note: '',
})
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  )
}
export default function AgentInventorySection({ query }: { query: string }) {
  const { user, activeOrgId } = useAuth()
  if (!user || !activeOrgId) return null
  return <ScopedInventory key={`${user.id}:${activeOrgId}`} query={query} />
}

function ScopedInventory({ query }: { query: string }) {
  const { user } = useAuth()
  const controller = useRef(new AbortController())
  const api = useMemo(() => createInventoryApi(undefined, () => controller.current.signal), [])
  const external = useMemo(() => createExternalAgentsApi(undefined, () => controller.current.signal), [])
  const [access, setAccess] = useState<InventoryAccess | null>(null)
  const [rows, setRows] = useState<AssetRecord[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [status, setStatus] = useState('all')
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [draft, setDraft] = useState<AssetMetadata | null>(null)
  const [reason, setReason] = useState('')
  const [targetId, setTargetId] = useState('')
  const [members, setMembers] = useState<InventoryMember[]>([])
  const [memberSearch, setMemberSearch] = useState('')
  const [memberCursor, setMemberCursor] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<ExternalAgentAdmin[]>([])
  const [catalogCursor, setCatalogCursor] = useState<string | null>(null)
  const [details, setDetails] = useState<AssetRecord | null>(null)
  const [hostedAsset, setHostedAsset] = useState<AssetRecord | null>(null)
  const [history, setHistory] = useState<AssetHistory | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const detailGeneration = useRef(0)
  const memberGeneration = useRef(0)

  const reload = useCallback(async () => {
    const page = await api.list()
    setRows(page.items)
    setCursor(page.next_cursor)
  }, [api])
  useEffect(() => {
    if (controller.current.signal.aborted) controller.current = new AbortController()
    const current = controller.current
    void api
      .access()
      .then(async (result) => {
        if (current.signal.aborted) return
        setAccess(result)
        if (result.configured) await reload()
      })
      .catch((cause) => {
        if (!current.signal.aborted) setError(inventoryError(cause))
      })
      .finally(() => {
        if (!current.signal.aborted) setLoading(false)
      })
    return () => {
      current.abort()
      detailGeneration.current++
      memberGeneration.current++
    }
  }, [api, reload])

  const loadMembers = useCallback(
    async (search: string, after = '') => {
      const generation = ++memberGeneration.current
      try {
        const page = await api.members(search, after)
        if (generation !== memberGeneration.current) return
        setMembers((current) => (after ? [...current, ...page.items] : page.items))
        setMemberCursor(page.next_cursor)
      } catch (cause) {
        if (!controller.current.signal.aborted && generation === memberGeneration.current)
          setError(inventoryError(cause))
      }
    },
    [api],
  )
  useEffect(() => {
    if (dialog?.action !== 'edit' || !access?.can_manage) return
    const timeout = setTimeout(() => {
      void loadMembers(memberSearch)
    }, 250)
    return () => {
      clearTimeout(timeout)
      memberGeneration.current++
    }
  }, [dialog?.action, access?.can_manage, memberSearch, loadMembers])

  const perform = async (operation: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await operation()
    } catch (cause) {
      if (!controller.current.signal.aborted) setError(inventoryError(cause))
    } finally {
      if (!controller.current.signal.aborted) setBusy(false)
    }
  }
  const open = (action: Action, asset: AssetRecord | null = null) => {
    if (!access) return
    setDialog({ action, asset, requestId: crypto.randomUUID(), newId: crypto.randomUUID() })
    setDraft(asset ? structuredClone(asset.metadata) : initialMetadata(access))
    setReason('')
    setTargetId('')
    setMemberSearch('')
    setError('')
    setNotice('')
    if (action === 'link')
      void perform(async () => {
        const page = await external.listPage()
        setCatalog(page.items)
        setCatalogCursor(page.next_cursor)
      })
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!dialog || !draft) return
    await perform(async () => {
      const common = {
        asset_id: dialog.asset?.id ?? dialog.newId,
        request_id: dialog.requestId,
        expected_revision: dialog.asset?.revision ?? 0,
      }
      let command: InventoryInput
      if (dialog.action === 'edit')
        command = {
          ...common,
          kind: 'SaveAsset',
          metadata: {
            ...draft,
            tool_refs: (draft.tool_refs ?? []).map((value) => value.trim()).filter(Boolean),
            model_paths: (draft.model_paths ?? []).map((value) => value.trim()).filter(Boolean),
          },
        }
      else if (dialog.action === 'submit') command = { ...common, kind: 'SubmitAsset' }
      else if (dialog.action === 'approve' || dialog.action === 'return')
        command = {
          ...common,
          kind: 'ReviewAsset',
          decision: dialog.action === 'approve' ? 'approve' : 'return',
          reason,
        }
      else if (dialog.action === 'suspend') command = { ...common, kind: 'SuspendAsset', reason }
      else if (dialog.action === 'link') command = { ...common, kind: 'LinkAsset', catalog_id: targetId }
      else {
        const target = rows.find((row) => row.id === targetId)
        if (!target) throw new Error('AGENT_ASSET_NOT_FOUND')
        command = {
          ...common,
          kind: 'MergeAsset',
          target_asset_id: target.id,
          target_revision: target.revision,
          reason,
        }
      }
      const result = await api.command(command)
      detailGeneration.current++
      setDialog(null)
      setDetails(dialog.action === 'suspend' ? result : null)
      setHistory(null)
      setNotice(`已保存：${result.metadata.name}，${assetStatuses[result.status]}。`)
      await reload()
    })
  }
  const inspect = async (asset: AssetRecord) => {
    const generation = ++detailGeneration.current
    setDetails(asset)
    setHistory(null)
    setDetailLoading(true)
    setError('')
    try {
      const [fresh, events] = await Promise.all([api.get(asset.id), api.history(asset.id)])
      if (generation === detailGeneration.current) {
        setDetails(fresh)
        setHistory(events)
      }
    } catch (cause) {
      if (!controller.current.signal.aborted && generation === detailGeneration.current) setError(inventoryError(cause))
    } finally {
      if (!controller.current.signal.aborted && generation === detailGeneration.current) setDetailLoading(false)
    }
  }
  const changeDraft = (patch: Partial<AssetMetadata>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current))
  const filtered = rows.filter(
    (row) =>
      (status === 'all' || row.status === status) &&
      [
        row.metadata.name,
        row.owner_display_name ?? '',
        row.metadata.owner_user_id,
        row.metadata.source_platform,
        row.metadata.source_agent_id,
      ].some((value) => (value ?? '').toLowerCase().includes(query.toLowerCase())),
  )
  if (loading) return <p role="status">正在读取智能体台账…</p>

  return (
    <section className="space-y-4" aria-label="智能体台账">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{access?.can_manage ? '组织智能体台账' : '我负责的智能体登记'}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            汇总来源、负责人、所在域和纳管证据。登记审核通过后，还需完成验收、授权与发布才能调用。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {access?.can_manage && <Button variant="outline" asChild><Link to="/mcp/servers/enterprise">管理工具授权</Link></Button>}
          <Button variant="outline" disabled={busy || !access?.configured} onClick={() => void perform(reload)}>
            <RefreshCw className="mr-2 size-4" />
            刷新台账
          </Button>
          <Button
            variant="outline"
            disabled={busy || !access?.configured}
            onClick={() =>
              void perform(async () => {
                const content = await exportInventory(api, controller.current.signal)
                const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }))
                const anchor = document.createElement('a')
                anchor.href = url
                anchor.download = `agent-inventory-${new Date().toISOString().slice(0, 10)}.json`
                anchor.click()
                setTimeout(() => URL.revokeObjectURL(url), 1000)
              })
            }
          >
            <Download className="mr-2 size-4" />
            导出 JSON
          </Button>
          <Button
            disabled={busy || !access?.configured || (!access.can_manage && !access.can_own)}
            onClick={() => open('edit')}
          >
            <Plus className="mr-2 size-4" />
            登记智能体
          </Button>
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription role="alert">{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {access?.can_manage && access.hosted_tasks_available && <AgentHostedUnknownTasks api={api} />}
      {access?.configured && <AgentDiscoverySection api={api} access={access} onChange={reload} />}
      {!access?.configured ? (
        <Alert>
          <AlertDescription>当前组织尚未开通统一台账，请联系组织管理员配置 Registry。</AlertDescription>
        </Alert>
      ) : (
        <>
          <Field label="登记状态">
            <select
              className={`${selectClass} max-w-48`}
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="all">全部状态</option>
              {Object.entries(assetStatuses).map(([key, value]) => (
                <option key={key} value={key}>
                  {value}
                </option>
              ))}
            </select>
          </Field>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/40">
                <tr>
                  {['智能体／来源', '负责人／部门', '域／托管位置', '纳管情况', '登记状态', '操作'].map((label) => (
                    <th className="p-3 font-medium" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((asset) => (
                  <tr key={asset.id} className="border-t align-top">
                    <td className="p-3">
                      <button
                        className="text-left font-medium underline underline-offset-4"
                        onClick={() => void inspect(asset)}
                      >
                        {asset.metadata.name}
                      </button>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {asset.metadata.source_platform} · {asset.metadata.source_agent_id}
                      </p>
                    </td>
                    <td className="p-3 break-all">
                      {asset.owner_display_name ?? asset.metadata.owner_user_id ?? '待认领'}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {asset.department_display_name ?? asset.metadata.department_id ?? '未分配部门'}
                      </p>
                    </td>
                    <td className="p-3">
                      {(asset.effective_domain ?? asset.metadata.domain) === 'core' ? '核心域' : '办公域'}
                      <p className="mt-1 text-xs text-muted-foreground">{hostingLabels[asset.metadata.hosting]}</p>
                    </td>
                    <td className="p-3">
                      <Badge variant="outline">实际 {asset.actual_level}</Badge>
                      <p className="mt-1 text-xs">
                        建议 {asset.recommended_level} · {riskLabels[asset.risk]}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {evidenceStatuses[asset.evidence_status ?? 'none']}
                      </p>
                    </td>
                    <td className="p-3">
                      {assetStatuses[asset.status]}
                      {asset.review_reason && (
                        <p className="mt-1 max-w-52 whitespace-pre-wrap text-xs text-muted-foreground">
                          {asset.review_reason}
                        </p>
                      )}
                    </td>
                    <td className="p-3">
                      <div className="flex max-w-72 flex-wrap gap-1">
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void inspect(asset)}>
                          详情
                        </Button>
                        {asset.metadata.hosting === 'internal_hosted' && ['dify', 'langgraph'].includes(asset.metadata.source_platform) && (
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setHostedAsset(asset)}>托管制品</Button>
                        )}
                        {asset.status !== 'merged' && (
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => open('edit', asset)}>
                            {asset.status === 'discovered' ? '认领／补充' : '编辑'}
                          </Button>
                        )}
                        {['draft', 'returned', 'discovered', 'suspended'].includes(asset.status) && (
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => open('submit', asset)}>
                            提交审核
                          </Button>
                        )}
                        {access.can_manage && asset.status === 'submitted' && (
                          <>
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => open('approve', asset)}>
                              审核通过
                            </Button>
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => open('return', asset)}>
                              退回
                            </Button>
                          </>
                        )}
                        {access.can_manage && !['merged', 'suspended'].includes(asset.status) && (
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => open('suspend', asset)}>
                            停用
                          </Button>
                        )}
                        {access.can_manage && asset.status !== 'merged' && !asset.principal && (
                          <>
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => open('link', asset)}>
                              关联目录
                            </Button>
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => open('merge', asset)}>
                              合并
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!filtered.length && (
              <p className="p-8 text-center text-muted-foreground">当前已加载的记录中没有匹配项。</p>
            )}
          </div>
          {cursor && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const page = await api.list(cursor)
                  setRows((current) => [
                    ...current,
                    ...page.items.filter((item) => !current.some((row) => row.id === item.id)),
                  ])
                  setCursor(page.next_cursor)
                })
              }
            >
              加载更多台账记录
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            已加载 {rows.length} 条。筛选作用于已加载记录；导出包含当前权限范围内的全部记录，并保留每条记录的修订号。
          </p>
        </>
      )}

      {hostedAsset && <AgentHostedArtifacts key={hostedAsset.id} asset={hostedAsset} canManage={access?.can_manage === true} onClose={() => setHostedAsset(null)} />}
      <Dialog
        open={!!dialog}
        onOpenChange={(value) => {
          if (!value && !busy) setDialog(null)
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {dialog?.action === 'edit'
                ? '登记信息'
                : (
                    {
                      submit: '提交 IT 审核',
                      approve: '审核通过',
                      return: '退回补正',
                      suspend: '停用智能体',
                      link: '关联目录身份',
                      merge: '合并重复记录',
                    } as Record<string, string>
                  )[dialog?.action ?? '']}
            </DialogTitle>
            <DialogDescription>
              {dialog?.asset?.metadata.name ?? '填写智能体来源与业务范围。凭据请在受保护的连接管理中配置。'}
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={(event) => void submit(event)}>
            <fieldset disabled={busy} className="space-y-4">
              {dialog?.action === 'edit' && draft && (
                <>
                  {dialog.asset?.status === 'approved' && (
                    <Alert>
                      <AlertDescription>修改登记信息后将重新审核，现有验收需与新内容重新匹配。</AlertDescription>
                    </Alert>
                  )}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="智能体名称">
                      <Input
                        required
                        maxLength={200}
                        value={draft.name}
                        onChange={(event) => changeDraft({ name: event.target.value })}
                      />
                    </Field>
                    <Field label="来源平台">
                      <select
                        className={selectClass}
                        value={draft.source_platform}
                        disabled={!!dialog.asset}
                        onChange={(event) =>
                          changeDraft({ source_platform: event.target.value as AssetMetadata['source_platform'] })
                        }
                      >
                        {platforms.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="平台实例标识">
                      <Input
                        required
                        maxLength={300}
                        disabled={!!dialog.asset}
                        value={draft.source_instance}
                        onChange={(event) => changeDraft({ source_instance: event.target.value })}
                        placeholder="例如 dify-office"
                      />
                    </Field>
                    <Field label="原平台智能体 ID">
                      <Input
                        required
                        maxLength={150}
                        pattern="[A-Za-z0-9][A-Za-z0-9_.:@-]*"
                        disabled={!!dialog.asset}
                        value={draft.source_agent_id}
                        onChange={(event) => changeDraft({ source_agent_id: event.target.value })}
                      />
                    </Field>
                    {access?.can_manage ? (
                      <div className="space-y-2">
                        <Field label="搜索负责人">
                          <Input
                            value={memberSearch}
                            onChange={(event) => setMemberSearch(event.target.value)}
                            placeholder="姓名或邮箱"
                          />
                        </Field>
                        <Field label="负责人">
                          <select
                            required
                            className={selectClass}
                            value={draft.owner_user_id ?? ''}
                            onChange={(event) => {
                              const owner = members.find((item) => item.id === event.target.value)
                              if (owner) changeDraft({ owner_user_id: owner.id, department_id: owner.department_id })
                            }}
                          >
                            <option value="">选择当前组织成员</option>
                            {draft.owner_user_id && !members.some((member) => member.id === draft.owner_user_id) && (
                              <option value={draft.owner_user_id ?? ''}>{draft.owner_user_id}</option>
                            )}
                            {members.map((member) => (
                              <option key={member.id} value={member.id}>
                                {member.name}（{member.id}）
                              </option>
                            ))}
                          </select>
                        </Field>
                        {memberCursor && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => void loadMembers(memberSearch, memberCursor)}
                          >
                            更多成员
                          </Button>
                        )}
                      </div>
                    ) : (
                      <Field label="负责人">
                        <Input readOnly value={user?.displayName || user?.name || draft.owner_user_id || ''} />
                      </Field>
                    )}
                    <Field label="所属部门（来自账号资料）">
                      <Input readOnly value={draft.department_id ?? '未分配部门'} />
                    </Field>
                    <Field label="所在域">
                      <select
                        className={selectClass}
                        value={draft.domain}
                        onChange={(event) => changeDraft({ domain: event.target.value as 'office' | 'core' })}
                      >
                        <option value="office">办公域</option>
                        <option value="core">核心域</option>
                      </select>
                    </Field>
                    <Field label="运行位置">
                      <select
                        className={selectClass}
                        value={draft.hosting}
                        onChange={(event) =>
                          changeDraft({
                            hosting: event.target.value as AssetMetadata['hosting'],
                            ...(event.target.value === 'public_saas' ? { requested_level: 'L0' } : {}),
                          })
                        }
                      >
                        {Object.entries(hostingLabels).map(([key, value]) => (
                          <option key={key} value={key}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="申请等级">
                      <select
                        className={selectClass}
                        value={draft.requested_level}
                        disabled={draft.hosting === 'public_saas'}
                        onChange={(event) =>
                          changeDraft({ requested_level: event.target.value as AssetMetadata['requested_level'] })
                        }
                      >
                        {['L0', 'L1', 'L2', 'L3'].map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Field label="业务用途">
                    <Textarea
                      required
                      maxLength={2000}
                      value={draft.purpose}
                      onChange={(event) => changeDraft({ purpose: event.target.value })}
                    />
                  </Field>
                  <div className="space-y-3">
                    <p className="text-sm font-medium">数据连接与动作</p>
                    {(draft.data_connections ?? []).map((connection, index) => (
                      <div key={index} className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
                        <Field label={`数据引用 ${index + 1}`}>
                          <Input
                            required
                            maxLength={500}
                            value={connection.reference}
                            onChange={(event) =>
                              changeDraft({
                                data_connections: draft.data_connections!.map((value, i) =>
                                  i === index ? { ...value, reference: event.target.value } : value,
                                ),
                              })
                            }
                          />
                        </Field>
                        <Field label="数据密级">
                          <select
                            className={selectClass}
                            value={connection.classification}
                            onChange={(event) =>
                              changeDraft({
                                data_connections: draft.data_connections!.map((value, i) =>
                                  i === index
                                    ? {
                                        ...value,
                                        classification: event.target.value as typeof connection.classification,
                                      }
                                    : value,
                                ),
                              })
                            }
                          >
                            {Object.entries({
                              public: '公开',
                              internal: '内部',
                              confidential: '敏感',
                              core: '核心',
                            }).map(([key, label]) => (
                              <option key={key} value={key}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <div className="flex flex-wrap gap-3 text-sm">
                          {(['read', 'write', 'delete', 'export'] as const).map((action) => (
                            <label className="flex items-center gap-1" key={action}>
                              <input
                                type="checkbox"
                                checked={connection.actions.includes(action)}
                                onChange={(event) =>
                                  changeDraft({
                                    data_connections: draft.data_connections!.map((value, i) =>
                                      i === index
                                        ? {
                                            ...value,
                                            actions: event.target.checked
                                              ? [...value.actions, action]
                                              : value.actions.filter((item) => item !== action),
                                          }
                                        : value,
                                    ),
                                  })
                                }
                              />
                              {{ read: '读取', write: '写入', delete: '删除', export: '导出' }[action]}
                            </label>
                          ))}
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            changeDraft({ data_connections: draft.data_connections!.filter((_, i) => i !== index) })
                          }
                        >
                          <X className="mr-1 size-3" />
                          移除连接
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      disabled={(draft.data_connections?.length ?? 0) >= 64}
                      onClick={() =>
                        changeDraft({
                          data_connections: [
                            ...(draft.data_connections ?? []),
                            { reference: '', classification: 'internal', actions: ['read'] },
                          ],
                        })
                      }
                    >
                      添加数据连接
                    </Button>
                  </div>
                  <Field label="工具引用（每行一项）">
                    <Textarea
                      value={(draft.tool_refs ?? []).join('\n')}
                      onChange={(event) => changeDraft({ tool_refs: event.target.value.split('\n') })}
                    />
                  </Field>
                  <Field label="模型路径（每行一项）">
                    <Textarea
                      value={(draft.model_paths ?? []).join('\n')}
                      onChange={(event) => changeDraft({ model_paths: event.target.value.split('\n') })}
                      placeholder="例如 Router 上已配置的模型名称"
                    />
                  </Field>
                  <Field label="风险与未纳管路径">
                    <Textarea
                      maxLength={2000}
                      value={draft.risk_note ?? ''}
                      onChange={(event) => changeDraft({ risk_note: event.target.value })}
                    />
                  </Field>
                </>
              )}
              {dialog?.action === 'submit' && (
                <p className="text-sm">将当前登记信息提交 IT 审核。申请等级不会自动成为实际等级。</p>
              )}
              {dialog?.action === 'approve' && (
                <p className="text-sm">
                  确认负责人、所在域、数据和模型路径。无有效验收证据时，审核通过后的实际等级仍为 L0。
                </p>
              )}
              {dialog?.action === 'suspend' && (
                <p className="text-sm">关闭受控调用入口，并持续核对任务身份、模型凭证和托管运行资源的回收进度。在途远端任务保留真实状态，不会被直接标记为已取消。</p>
              )}
              {dialog?.action === 'link' && (
                <>
                  <Field label="已接入的外部托管智能体">
                    <select
                      className={selectClass}
                      required
                      value={targetId}
                      onChange={(event) => setTargetId(event.target.value)}
                    >
                      <option value="">选择目录中的智能体</option>
                      {catalog.map((item) => (
                        <option value={item.id} key={item.id}>
                          {item.name}（{item.id}）
                        </option>
                      ))}
                    </select>
                  </Field>
                  {catalogCursor && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        void perform(async () => {
                          const page = await external.listPage(catalogCursor)
                          setCatalog((current) => [...current, ...page.items])
                          setCatalogCursor(page.next_cursor)
                        })
                      }
                    >
                      更多目录智能体
                    </Button>
                  )}
                  <p className="text-sm text-muted-foreground">
                    关联后，该身份的发布和调用受台账准入约束。身份关联不可更换。
                  </p>
                </>
              )}
              {dialog?.action === 'merge' && (
                <>
                  <Field label="保留的目标记录">
                    <select
                      className={selectClass}
                      required
                      value={targetId}
                      onChange={(event) => setTargetId(event.target.value)}
                    >
                      <option value="">从已加载记录中选择</option>
                      {rows
                        .filter((row) => row.id !== dialog.asset?.id && row.status !== 'merged' && !row.principal)
                        .map((row) => (
                          <option key={row.id} value={row.id}>
                            {row.metadata.name}（{row.id}）
                          </option>
                        ))}
                    </select>
                  </Field>
                  <p className="text-sm text-muted-foreground">
                    发现证据合并到目标记录，原记录保留合并去向；目标记录需要重新审核。
                  </p>
                </>
              )}
              {dialog && ['approve', 'return', 'suspend', 'merge'].includes(dialog.action) && (
                <Field label="处理说明">
                  <Textarea
                    required
                    maxLength={2000}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </Field>
              )}
            </fieldset>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setDialog(null)}>
                取消
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? '正在保存…' : '确认'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!details}
        onOpenChange={(value) => {
          if (!value) {
            setDetails(null)
            detailGeneration.current++
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{details?.metadata.name}</DialogTitle>
            <DialogDescription>登记信息、验收与操作记录</DialogDescription>
          </DialogHeader>
          {detailLoading && <p role="status">正在读取最新记录…</p>}
          {details && (
            <div className="space-y-4 text-sm">
              <div className="flex flex-wrap gap-2">
                <Badge>{assetStatuses[details.status]}</Badge>
                <Badge variant="outline">
                  实际 {details.actual_level}／建议 {details.recommended_level}
                </Badge>
                <Badge variant="outline">{riskLabels[details.risk]}</Badge>
              </div>
              <p>{details.metadata.purpose}</p>
              {access?.can_manage && <AgentAssetSuspension key={details.id} api={api} assetId={details.id} />}
              <dl className="grid gap-2 break-all sm:grid-cols-[8rem_1fr]">
                <dt>台账 ID／修订</dt>
                <dd>
                  {details.id}／{details.revision}
                </dd>
                <dt>来源实例</dt>
                <dd>{details.metadata.source_instance}</dd>
                <dt>目录身份</dt>
                <dd>
                  {details.principal ? `${details.principal.trust_domain}/${details.principal.agent_name}` : '尚未关联'}
                </dd>
                <dt>工具</dt>
                <dd>{details.metadata.tool_refs?.join('、') || '未申报'}</dd>
                <dt>模型路径</dt>
                <dd>{details.metadata.model_paths?.join('、') || '未申报'}</dd>
                <dt>成本</dt>
                <dd>等待 Router 可信计量；缺失数据不记为零。</dd>
                <dt>风险说明</dt>
                <dd>{details.metadata.risk_note || '无补充'}</dd>
              </dl>
              <div>
                <h3 className="mb-1 font-medium">等级建议</h3>
                {details.recommendation_reasons.map((reason) => (
                  <p key={reason}>{recommendationLabels[reason] ?? reason}</p>
                ))}
              </div>
              {!!details.metadata.data_connections?.length && (
                <div>
                  <h3 className="font-medium">数据与动作</h3>
                  {details.metadata.data_connections.map((item, i) => (
                    <p key={i} className="break-all">
                      {item.reference} · {item.classification} · {item.actions.join(', ')}
                    </p>
                  ))}
                </div>
              )}
              <div>
                <h3 className="font-medium">验收：{evidenceStatuses[details.evidence_status ?? 'none']}</h3>
                {details.acceptance ? (
                  <dl className="grid gap-1 break-all">
                    <dt>版本摘要</dt>
                    <dd>{details.acceptance.spec_digest}</dd>
                    <dt>有效期</dt>
                    <dd>{new Date(details.acceptance.expires_at).toLocaleString()}</dd>
                    <dt>数据集／Rubric</dt>
                    <dd>
                      {details.acceptance.dataset_digest ?? '不适用'}／{details.acceptance.rubric_digest ?? '不适用'}
                    </dd>
                    <dt>迁移前／后得分</dt>
                    <dd>
                      {details.acceptance.before_score ?? '无'}／{details.acceptance.after_score ?? '无'}
                    </dd>
                  </dl>
                ) : (
                  <p>尚无受信任的运行验收报告。</p>
                )}
              </div>
              <div>
                <h3 className="font-medium">发现证据</h3>
                {details.observations.length ? (
                  details.observations.map((item, i) => (
                    <p className="break-all" key={i}>
                      {item.source} · {item.source_id} · {item.record_id} ·{' '}
                      {new Date(item.observed_at).toLocaleString()}
                      <br />
                      {item.snapshot_digest}
                    </p>
                  ))
                ) : (
                  <p>负责人手工登记，尚无自动发现证据。</p>
                )}
              </div>
              <div>
                <h3 className="font-medium">操作记录</h3>
                {history?.events.map((item) => (
                  <p key={item.revision} className="my-1 break-all">
                    #{item.revision} · {item.operation} · {item.initiated_by} ·{' '}
                    {new Date(item.created_at).toLocaleString()} {item.reason}
                  </p>
                ))}
                {history?.next_revision != null && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const id = details.id,
                          generation = detailGeneration.current
                        const page = await api.history(id, history.next_revision!)
                        if (generation === detailGeneration.current)
                          setHistory((current) =>
                            current ? { ...page, events: [...current.events, ...page.events] } : page,
                          )
                      })
                    }
                  >
                    更多操作记录
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}
