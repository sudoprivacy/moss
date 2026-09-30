'use client'

/**
 * Zone 管理页（§8.8 / MOSS-ADMIN）。
 *
 * UI 七项区分（R2.3）：
 *  1. "解绑 Org 访问"（detach，只撤访问）与"删除 Zone 数据"（deprovision，
 *     二次输入 Zone ID + 异步 operation）分列为不同入口与确认强度；
 *  2. Zone ID（不可变身份，等宽展示）与显示名（observed display_name）分列；
 *  3. desired（本地业务意图）与 observed（Nexus 对账快照）分列；
 *  4. grant status/expiry/source（最近一次对账的真实 source）单独展示；
 *  5. operation 查询面板（step/error/retry）支持故障恢复；
 *  6. runtime health：observed zone status + revision + 最近对账时间；
 *  7. 挂起/恢复（可逆管理动作）与 deprovision（不可逆数据删除）分开。
 */
import { useCallback, useEffect, useState } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getMe, getOrganizations } from '@/lib/api/auth'
import type { AuthOrgWithCounts } from '@/lib/api/types'
import {
  addZoneBinding, cancelZoneRuntimeRun, deprovisionZone, detachZoneBinding, getZoneOperation,
  listAvailableZones, listZoneBindings, refreshZoneBinding, zoneLifecycle,
  type ZoneBinding, type ZoneLifecycleConfirmed, type ZoneOperation,
} from '@/lib/api/zones'
import { RefreshCw, Unlink, Loader2, ShieldAlert, PauseCircle, PlayCircle, Search, Plus, HelpCircle } from 'lucide-react'
import { toast } from 'sonner'

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline'

function desiredBadge(state: string): BadgeVariant {
  if (state === 'bound') return 'default'
  return 'secondary'
}

function syncBadge(status: string): BadgeVariant {
  if (status === 'active') return 'default'
  if (status === 'unknown' || status === 'sync_failed') return 'destructive'
  return 'secondary'
}

/** purpose 已注册值（契约 x-known-values 的开放注册表，前端为封闭下拉——契约注册新值时需同步）。 */
const PURPOSE_OPTIONS: Array<{ value: string; tip: string }> = [
  { value: 'default', tip: '组织默认主 Zone：每组织唯一，用户会话默认落地于此' },
  { value: 'office', tip: '办公数据域 Zone（预留标签）：对应 Zone 部署属性 data_domain=office，当前无特殊行为。注意：非 default 绑定当前仅用于授权管理（撤销/审计），会话路由与 delegation 仅消费 default Zone' },
  { value: 'core', tip: '核心数据域 Zone（预留标签）：对应 data_domain=core，当前无特殊行为。注意：非 default 绑定当前仅用于授权管理（撤销/审计），会话路由与 delegation 仅消费 default Zone' },
  { value: 'shared', tip: '多组织共享 Zone：用于一个 Zone 绑定多个组织的场景。注意：非 default 绑定当前仅用于授权管理（撤销/审计），会话路由与 delegation 仅消费 default Zone' },
]

/** zones 路由的错误经 HttpError(JSON.stringify({code,message})) 通道透传，前端需解包取 message。 */
function zoneErrMsg(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as { message?: string }
      if (parsed.message) return parsed.message
    } catch { /* 回退原文 */ }
  }
  return raw
}

/** ZONE_DELETE_BLOCKED 的 blocker 清单（nexus details 结构，B-1）。 */
interface ZoneDeleteBlockers {
  grants?: Array<{ grant_id: string; grantee?: Record<string, unknown> }>
  runs?: Array<{ pid: string; session_id: string; state: string }>
  mounts?: Array<{ mount_id: string }>
}

function zoneBlockersOf(error: unknown): ZoneDeleteBlockers | null {
  const details = (error as { details?: unknown } | null)?.details
  if (typeof details !== 'object' || details === null) return null
  return details as ZoneDeleteBlockers
}

export default function ZonesPage() {
  const [role, setRole] = useState<string>('')
  const [bindings, setBindings] = useState<ZoneBinding[]>([])
  const [availableZones, setAvailableZones] = useState<Array<{ zone_id: string; purpose: string }>>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const [detachTarget, setDetachTarget] = useState<ZoneBinding | null>(null)
  const [deprovisionTarget, setDeprovisionTarget] = useState<ZoneBinding | null>(null)
  const [deprovisionBlockers, setDeprovisionBlockers] = useState<ZoneDeleteBlockers | null>(null)
  const [cancellingPid, setCancellingPid] = useState<string | null>(null)
  const [confirmInput, setConfirmInput] = useState('')
  const [operationId, setOperationId] = useState('')
  const [operation, setOperation] = useState<ZoneOperation | null>(null)
  const [operationLoading, setOperationLoading] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [addOrgId, setAddOrgId] = useState('')
  const [addZoneId, setAddZoneId] = useState('')
  const [addPurpose, setAddPurpose] = useState('shared')
  const [addZoneNew, setAddZoneNew] = useState(false)
  const [organizations, setOrganizations] = useState<AuthOrgWithCounts[]>([])
  const [orgsLoadState, setOrgsLoadState] = useState<'loading' | 'ready' | 'failed'>('loading')

  const onAddBinding = async () => {
    try {
      const created = await addZoneBinding({ org_id: addOrgId.trim(), zone_id: addZoneId.trim(), purpose: addPurpose })
      toast.success(`绑定已创建（pending，异步收敛）：${created.zone_id}`)
      setAddOpen(false); setAddOrgId(''); setAddZoneId(''); setAddPurpose('shared'); setAddZoneNew(false)
      await reload()
    } catch (error) {
      toast.error(`创建失败：${zoneErrMsg(error)}`)
    }
  }

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [me, zones] = await Promise.all([getMe(), listAvailableZones().catch(() => ({ zones: [] }))])
      setRole(me.user?.role ?? '')
      setAvailableZones(zones.zones)
      // 组织列表仅供 super_admin 的添加绑定弹窗使用（接口 requireSuperAdmin）；
      // 用 getMe() 的局部返回值判断（role state 在本闭包内是旧值）。
      if (me.user?.role === 'super_admin') {
        try {
          const orgs = await getOrganizations()
          setOrganizations(orgs.organizations)
          setOrgsLoadState('ready')
        } catch {
          setOrgsLoadState('failed')
          toast.error('组织列表加载失败，org 选择已降级为手输')
        }
      }
      // 普通用户无 binding 列表权限（403）——只展示可用 Zone
      try {
        const list = await listZoneBindings()
        setBindings(list.bindings)
      } catch {
        setBindings([])
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const onRefresh = async (binding: ZoneBinding) => {
    setRefreshing(binding.binding_id)
    try {
      const updated = await refreshZoneBinding(binding.binding_id)
      setBindings((prev) => prev.map((b) => (b.binding_id === updated.binding_id ? updated : b)))
      toast.success(`对账完成：${updated.zone_id} → ${updated.sync_status}`)
    } catch (error) {
      toast.error(`对账失败：${zoneErrMsg(error)}`)
    } finally {
      setRefreshing(null)
    }
  }

  const onDetach = async () => {
    if (!detachTarget) return
    try {
      await detachZoneBinding(detachTarget.binding_id)
      toast.success(`已提交解绑（generation 递增，异步撤销访问）：${detachTarget.zone_id}`)
      setDetachTarget(null)
      await reload()
    } catch (error) {
      toast.error(`解绑失败：${zoneErrMsg(error)}`)
    }
  }

  const onDeprovision = async () => {
    if (!deprovisionTarget) return
    try {
      const op = await deprovisionZone(deprovisionTarget.zone_id, confirmInput.trim())
      toast.success(`deprovision 已受理（operation ${op.operation_id}，异步执行，可用下方面板跟踪）`)
      setDeprovisionTarget(null)
      setDeprovisionBlockers(null)
      setConfirmInput('')
      setOperation(op)
    } catch (error) {
      const blockers = zoneBlockersOf(error)
      setDeprovisionBlockers(blockers)
      toast.error(`deprovision 失败：${zoneErrMsg(error)}`)
    }
  }

  /** B-1：解除 ZONE_DELETE_BLOCKED 的 runtime blocker（terminate 终止 / park 隔离）。 */
  const onCancelBlockerRun = async (pid: string, mode: 'terminate' | 'pending') => {
    setCancellingPid(pid)
    try {
      const result = await cancelZoneRuntimeRun(pid, mode)
      toast.success(`runtime ${result.pid} 已${mode === 'terminate' ? '终止' : '隔离'}（state: ${result.state}），请重试删除`)
      setDeprovisionBlockers((prev) =>
        prev ? { ...prev, runs: (prev.runs ?? []).filter((r) => r.pid !== pid) } : prev,
      )
    } catch (error) {
      toast.error(`runtime 取消失败：${zoneErrMsg(error)}`)
    } finally {
      setCancellingPid(null)
    }
  }

  /** 静默对账：只更新行数据（observed_zone_status 上屏），不弹逐行 toast（避免与"已生效"语义矛盾的噪声）。 */
  const silentReconcile = async (zoneId: string) => {
    const rows = bindings.filter(b => b.zone_id === zoneId)
    let failed = false
    for (const row of rows) {
      try {
        const updated = await refreshZoneBinding(row.binding_id)
        setBindings((prev) => prev.map((b) => (b.binding_id === updated.binding_id ? updated : b)))
      } catch { failed = true }
    }
    if (failed) toast.error('部分行自动对账失败，可手动点击行首刷新')
  }

  const onLifecycle = async (zoneId: string, action: 'suspend' | 'resume') => {
    try {
      const result = await zoneLifecycle(zoneId, action)
      if ('operation_id' in result) {
        setOperation(result)
        if (result.state === 'succeeded') {
          // Nexus lifecycle 同步执行：收到 succeeded 即已生效 → 自动对账该 Zone 的全部绑定行
          toast.success(`${action} 已生效（operation ${result.operation_id}）`)
          await silentReconcile(zoneId)
        } else {
          toast.success(`${action} 已受理（operation ${result.operation_id}，可用下方操作面板跟踪）`)
        }
      } else {  // ZoneLifecycleConfirmed：unknown 后读收敛确认已生效
        toast.success(`${action} 已生效（zone 状态：${result.zone_status}）`)
        await silentReconcile(zoneId)
      }
    } catch (error) {
      toast.error(`${action} 失败：${zoneErrMsg(error)}`)
    }
  }

  const onQueryOperation = async () => {
    const id = operationId.trim()
    if (!id) return
    setOperationLoading(true)
    try {
      setOperation(await getZoneOperation(id))
    } catch (error) {
      toast.error(`查询失败：${zoneErrMsg(error)}`)
    } finally {
      setOperationLoading(false)
    }
  }

  // 添加绑定弹窗的即时预检（只把活动绑定算重复：detach 后的行仍出现在列表，但语义不同）
  const zoneCandidates = [...new Set(bindings.map(b => b.zone_id))]
  const trimmedOrg = addOrgId.trim()
  const trimmedZone = addZoneId.trim()
  const duplicate = bindings.find(b => b.org_id === trimmedOrg && b.zone_id === trimmedZone
    && b.purpose === addPurpose && b.desired_state === 'bound')
  const detachedSameCombo = bindings.find(b => b.org_id === trimmedOrg && b.zone_id === trimmedZone
    && b.purpose === addPurpose && b.desired_state !== 'bound')
  const sameOrgZone = bindings.find(b => b.org_id === trimmedOrg && b.zone_id === trimmedZone
    && b.purpose !== addPurpose && b.desired_state === 'bound')

  return (
    <DashboardLayout title="Zone 管理" description="Zone、绑定、授权与操作的管理与故障恢复">
      {loading ? (
        <div className="flex min-h-[320px] items-center justify-center">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-6">
          <section className="rounded-lg border p-4">
            <h3 className="mb-2 text-sm font-semibold">我的可用 Zone</h3>
            {availableZones.length === 0 ? (
              <p className="text-sm text-muted-foreground">当前组织暂无可用 Zone（绑定未激活或未配置）。</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {availableZones.map((z) => (
                  <Badge key={z.zone_id} variant="outline">{z.zone_id}（{z.purpose}）</Badge>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-lg border">
            <div className="flex items-center justify-between border-b p-4">
              <h3 className="text-sm font-semibold">组织绑定（desired ↔ observed）</h3>
              <div className="flex gap-2">
                {role === 'super_admin' ? (
                  <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
                    <Plus className="mr-1 size-4" /> 添加绑定
                  </Button>
                ) : null}
                <Button variant="outline" size="sm" onClick={() => void reload()}>
                  <RefreshCw className="mr-1 size-4" /> 刷新列表
                </Button>
              </div>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Zone ID（不可变）</TableHead>
                  <TableHead>显示名（observed）</TableHead>
                  <TableHead>用途</TableHead>
                  <TableHead>desired</TableHead>
                  <TableHead>observed / 同步</TableHead>
                  <TableHead>grant（status / 到期 / source）</TableHead>
                  <TableHead>最近对账</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bindings.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground">
                      {role === 'super_admin' ? '暂无绑定' : '无权查看绑定列表（普通用户仅见可用 Zone）'}
                    </TableCell>
                  </TableRow>
                ) : bindings.map((b) => (
                  <TableRow key={b.binding_id}>
                    <TableCell className="font-mono text-xs">{b.zone_id}</TableCell>
                    <TableCell>{b.observed_display_name ?? '—'}</TableCell>
                    <TableCell>
                      {b.purpose}{b.is_default ? '（默认）' : ''}
                      {!b.is_default && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <HelpCircle className="ml-1 inline size-3.5 text-muted-foreground" />
                          </TooltipTrigger>
                          <TooltipContent className="max-w-72">
                            仅授权管理：该绑定当前仅用于授权管理（撤销/审计）；会话路由与 delegation 仅消费 default Zone。按 Zone 消费为后续 work item。
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell><Badge variant={desiredBadge(b.desired_state)}>{b.desired_state}</Badge></TableCell>
                    <TableCell className="space-x-1">
                      <Badge variant={syncBadge(b.sync_status)}>{b.sync_status}</Badge>
                      {b.observed_zone_status ? <Badge variant="outline">zone: {b.observed_zone_status}</Badge> : null}
                      {b.last_error_code ? <Badge variant="destructive">{b.last_error_code}</Badge> : null}
                    </TableCell>
                    <TableCell className="text-xs">
                      {b.nexus_grant_id ? (
                        <>
                          <div>{b.observed_grant_status ?? '—'} · {b.observed_grant_source ?? '—'}</div>
                          <div className="text-muted-foreground">{b.grant_expires_at ?? '无到期'}</div>
                        </>
                      ) : '—'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {b.observed_at != null ? (
                        <div>对账于 {Math.max(0, Math.round((Date.now() - b.observed_at) / 60_000))} 分钟前</div>
                      ) : '—'}
                      <div>{new Date(b.updated_at).toLocaleString()}</div>
                      {b.observed_revision ? <div>rev {b.observed_revision.slice(0, 8)}</div> : null}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="outline" size="sm" disabled={refreshing === b.binding_id}
                          onClick={() => void onRefresh(b)}
                        >
                          {refreshing === b.binding_id ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                        </Button>
                        {b.desired_state === 'bound' ? (
                          <Button variant="outline" size="sm" onClick={() => setDetachTarget(b)}>
                            <Unlink className="mr-1 size-4" /> 解绑访问
                          </Button>
                        ) : null}
                        {role === 'super_admin' ? (
                          <>
                            <Button variant="outline" size="sm" onClick={() => void onLifecycle(b.zone_id, 'suspend')}>
                              <PauseCircle className="mr-1 size-4" /> 挂起
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => void onLifecycle(b.zone_id, 'resume')}>
                              <PlayCircle className="mr-1 size-4" /> 恢复
                            </Button>
                            <Button variant="destructive" size="sm" onClick={() => { setDeprovisionTarget(b); setConfirmInput(''); setDeprovisionBlockers(null) }}>
                              <ShieldAlert className="mr-1 size-4" /> 删除 Zone 数据
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>

          <section className="rounded-lg border p-4">
            <h3 className="mb-2 text-sm font-semibold">操作跟踪（operation step / error / retry）</h3>
            <div className="flex gap-2">
              <Input
                placeholder="operation_id（创建/解绑/挂起/删除返回）"
                value={operationId} onChange={(e) => setOperationId(e.target.value)}
                className="font-mono"
              />
              <Button size="sm" onClick={() => void onQueryOperation()} disabled={operationLoading}>
                {operationLoading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              </Button>
            </div>
            {operation ? (
              <div className="mt-3 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
                <div><span className="text-muted-foreground">operation：</span><span className="font-mono text-xs">{operation.operation_id}</span></div>
                <div><span className="text-muted-foreground">action：</span>{operation.action}</div>
                <div><span className="text-muted-foreground">state：</span><Badge variant={operation.state === 'succeeded' ? 'default' : operation.state === 'failed' ? 'destructive' : 'secondary'}>{operation.state}</Badge></div>
                <div><span className="text-muted-foreground">step：</span>{operation.step || '—'}</div>
                <div><span className="text-muted-foreground">retryable：</span>{String(operation.retryable)}</div>
                {operation.error ? <div className="col-span-2"><span className="text-muted-foreground">error：</span><span className="font-mono">{operation.error.code}</span> · {operation.error.message}</div> : null}
              </div>
            ) : null}
          </section>
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={(open) => { setAddOpen(open); if (!open) setAddZoneNew(false) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加组织绑定</DialogTitle>
            <DialogDescription>
              将 Zone 绑定到组织（一个 Org 多 Zone / 一个 Zone 多 Org 均合法）。
              选择现有 Zone，或输入新 Zone ID（新 Zone 将由绑定异步创建）；绑定异步收敛（grant 由 Moss 侧派生）。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <div className="mb-1 text-xs text-muted-foreground">org_id（组织）</div>
              {orgsLoadState === 'ready' && organizations.length > 0 ? (
                <Select value={addOrgId} onValueChange={setAddOrgId}>
                  <SelectTrigger><SelectValue placeholder="选择组织" /></SelectTrigger>
                  <SelectContent>
                    {organizations.map(o => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : orgsLoadState === 'loading' ? (
                <Select disabled>
                  <SelectTrigger><SelectValue placeholder="组织加载中…" /></SelectTrigger>
                  <SelectContent />
                </Select>
              ) : (
                <Input
                  placeholder="org_id（组织列表加载失败或为空，请手输）"
                  value={addOrgId} onChange={(e) => setAddOrgId(e.target.value)}
                  className="font-mono"
                />
              )}
            </div>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">zone_id（不可变身份）</div>
              {addZoneNew ? (
                <div className="flex items-center gap-2">
                  <Input
                    placeholder="新 zone_id（3-63 位小写字母数字与连字符）"
                    value={addZoneId} onChange={(e) => setAddZoneId(e.target.value)}
                    className="font-mono"
                  />
                  <Button variant="outline" size="sm" onClick={() => { setAddZoneNew(false); setAddZoneId('') }}>
                    从现有选择
                  </Button>
                </div>
              ) : (
                <Select
                  value={addZoneId}
                  onValueChange={(v) => {
                    if (v === '__new__') { setAddZoneNew(true); setAddZoneId('') } else setAddZoneId(v)
                  }}
                >
                  <SelectTrigger><SelectValue placeholder="选择 Zone" /></SelectTrigger>
                  <SelectContent>
                    {zoneCandidates.map(z => <SelectItem key={z} value={z} className="font-mono">{z}</SelectItem>)}
                    <SelectItem value="__new__">输入新 Zone ID…</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
            <div>
              <div className="mb-1 flex items-center gap-1">
                <span className="text-xs text-muted-foreground">purpose（用途）</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className="size-3.5 cursor-help text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent className="w-96">
                    <div className="space-y-1 text-xs">
                      {PURPOSE_OPTIONS.map(o => (
                        <div key={o.value}>
                          <span className="font-mono font-semibold">{o.value}</span>：{o.tip}
                        </div>
                      ))}
                    </div>
                  </TooltipContent>
                </Tooltip>
              </div>
              <Select value={addPurpose} onValueChange={setAddPurpose}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PURPOSE_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.value}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {duplicate ? <p className="text-xs text-destructive">该绑定已存在（用途：{duplicate.purpose}）</p> : null}
            {detachedSameCombo ? <p className="text-xs text-yellow-600">该组合存在已解绑的历史绑定（后端将拒绝重复创建）</p> : null}
            {!duplicate && sameOrgZone ? <p className="text-xs text-yellow-600">该组织已绑定此 Zone（用途：{sameOrgZone.purpose}），将以新用途追加绑定</p> : null}
            {addPurpose !== 'default' ? <p className="text-xs text-muted-foreground">非 default 用途的绑定当前仅用于授权管理（撤销/审计）；会话路由与 delegation 仅消费 default Zone</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>取消</Button>
            <Button disabled={!addOrgId.trim() || !addZoneId.trim() || duplicate !== undefined} onClick={() => void onAddBinding()}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={detachTarget !== null} onOpenChange={(open) => !open && setDetachTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>解绑 Org 访问</DialogTitle>
            <DialogDescription>
              只解除该组织对 Zone 的访问（撤销 grant，异步生效），<b>不删除 Zone 内任何数据</b>。
              需要删除数据请使用"删除 Zone 数据"（需二次确认）。
            </DialogDescription>
          </DialogHeader>
          <div className="text-sm">
            目标：<span className="font-mono text-xs">{detachTarget?.zone_id}</span>（generation {detachTarget?.generation} → {((detachTarget?.generation ?? 0) + 1)}）
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetachTarget(null)}>取消</Button>
            <Button onClick={() => void onDetach()}>确认解绑</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deprovisionTarget !== null} onOpenChange={(open) => !open && setDeprovisionTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除 Zone 数据（不可逆）</DialogTitle>
            <DialogDescription>
              这会发起异步 deprovision：撤销全部授权、卸载挂载、按副本回执删除物理数据。
              删除后，曾绑定此 Zone 的组织新会话将不再受 Zone 管控（数据仅落 moss 本地；如部署启用 MOSS_REQUIRE_ZONE 则此类组织将无法创建会话）。
              存在 blocker（活跃授权/挂载/会话）时操作会被拒绝或等待，可随后用 operation 面板跟踪。
              请输入完整 Zone ID 二次确认。
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder={deprovisionTarget?.zone_id ?? ''}
            value={confirmInput}
            onChange={(e) => setConfirmInput(e.target.value)}
            className="font-mono"
          />
          {deprovisionBlockers && (
            <div className="rounded border border-destructive/40 bg-destructive/5 p-3 text-xs space-y-2">
              <div className="font-medium">删除被阻止——活动依赖清单（解除后重试）：</div>
              {(deprovisionBlockers.grants ?? []).map((g) => (
                <div key={g.grant_id} className="flex items-center gap-2">
                  <Badge variant="destructive">grant</Badge>
                  <span className="font-mono">{g.grant_id}</span>
                  <span className="text-muted-foreground">于本页对该组织执行「解绑访问」撤销 grant</span>
                </div>
              ))}
              {(deprovisionBlockers.runs ?? []).map((r) => (
                <div key={r.pid} className="flex items-center gap-2 flex-wrap">
                  <Badge variant="destructive">runtime</Badge>
                  <span className="font-mono">{r.pid}</span>
                  <span className="text-muted-foreground">session {r.session_id.slice(0, 8)}… · {r.state}</span>
                  <Button
                    size="sm" variant="destructive" disabled={cancellingPid === r.pid}
                    onClick={() => void onCancelBlockerRun(r.pid, 'terminate')}
                  >终止</Button>
                  <Button
                    size="sm" variant="outline" disabled={cancellingPid === r.pid}
                    onClick={() => void onCancelBlockerRun(r.pid, 'pending')}
                  >隔离 (park)</Button>
                </div>
              ))}
              {(deprovisionBlockers.mounts ?? []).map((m) => (
                <div key={m.mount_id} className="flex items-center gap-2">
                  <Badge variant="destructive">mount</Badge>
                  <span className="font-mono">{m.mount_id}</span>
                  <span className="text-muted-foreground">请先在 Nexus 侧卸载该挂载</span>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeprovisionTarget(null)}>取消</Button>
            <Button variant="destructive" disabled={confirmInput.trim() !== deprovisionTarget?.zone_id} onClick={() => void onDeprovision()}>
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}
