'use client'

/**
 * Zone 管理页（§8.8 / MOSS-ADMIN）。
 *
 * UI 七项区分（R2.3）：
 *  1. "解绑 Org 访问"（detach，只撤访问）与"删除 Zone 数据"（deprovision，
 *     二次输入 Zone ID + 异步 operation）分列为不同入口与确认强度；
 *  2. Zone ID（不可变身份，等宽展示）与显示名（observed display_name）分列；
 *  3. desired（本地业务意图）与 observed（Nexus 对账快照）分列；
 *  4. grant status/expiry/source（source=moss_org_binding）单独展示；
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
import { getMe } from '@/lib/api/auth'
import {
  addZoneBinding, deprovisionZone, detachZoneBinding, getZoneOperation,
  listAvailableZones, listZoneBindings, refreshZoneBinding, zoneLifecycle,
  type ZoneBinding, type ZoneOperation,
} from '@/lib/api/zones'
import { RefreshCw, Unlink, Loader2, ShieldAlert, PauseCircle, PlayCircle, Search, Plus } from 'lucide-react'
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

export default function ZonesPage() {
  const [role, setRole] = useState<string>('')
  const [bindings, setBindings] = useState<ZoneBinding[]>([])
  const [availableZones, setAvailableZones] = useState<Array<{ zone_id: string; purpose: string }>>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const [detachTarget, setDetachTarget] = useState<ZoneBinding | null>(null)
  const [deprovisionTarget, setDeprovisionTarget] = useState<ZoneBinding | null>(null)
  const [confirmInput, setConfirmInput] = useState('')
  const [operationId, setOperationId] = useState('')
  const [operation, setOperation] = useState<ZoneOperation | null>(null)
  const [operationLoading, setOperationLoading] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [addOrgId, setAddOrgId] = useState('')
  const [addZoneId, setAddZoneId] = useState('')
  const [addPurpose, setAddPurpose] = useState('shared')

  const onAddBinding = async () => {
    try {
      const created = await addZoneBinding({ org_id: addOrgId.trim(), zone_id: addZoneId.trim(), purpose: addPurpose })
      toast.success(`绑定已创建（pending，异步收敛）：${created.zone_id}`)
      setAddOpen(false); setAddOrgId(''); setAddZoneId(''); setAddPurpose('shared')
      await reload()
    } catch (error) {
      toast.error(`创建失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [me, zones] = await Promise.all([getMe(), listAvailableZones().catch(() => ({ zones: [] }))])
      setRole(me.user?.role ?? '')
      setAvailableZones(zones.zones)
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
      toast.error(`对账失败：${error instanceof Error ? error.message : String(error)}`)
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
      toast.error(`解绑失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const onDeprovision = async () => {
    if (!deprovisionTarget) return
    try {
      const op = await deprovisionZone(deprovisionTarget.zone_id, confirmInput.trim())
      toast.success(`deprovision 已受理（operation ${op.operation_id}，异步执行，可用下方面板跟踪）`)
      setDeprovisionTarget(null)
      setConfirmInput('')
      setOperation(op)
    } catch (error) {
      toast.error(`deprovision 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const onLifecycle = async (zoneId: string, action: 'suspend' | 'resume') => {
    try {
      const op = await zoneLifecycle(zoneId, action)
      toast.success(`${action} 已受理（operation ${op.operation_id}）`)
      setOperation(op)
    } catch (error) {
      toast.error(`${action} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const onQueryOperation = async () => {
    const id = operationId.trim()
    if (!id) return
    setOperationLoading(true)
    try {
      setOperation(await getZoneOperation(id))
    } catch (error) {
      toast.error(`查询失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setOperationLoading(false)
    }
  }

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
                    <TableCell>{b.purpose}{b.is_default ? '（默认）' : ''}</TableCell>
                    <TableCell><Badge variant={desiredBadge(b.desired_state)}>{b.desired_state}</Badge></TableCell>
                    <TableCell className="space-x-1">
                      <Badge variant={syncBadge(b.sync_status)}>{b.sync_status}</Badge>
                      {b.observed_zone_status ? <Badge variant="outline">zone: {b.observed_zone_status}</Badge> : null}
                      {b.last_error_code ? <Badge variant="destructive">{b.last_error_code}</Badge> : null}
                    </TableCell>
                    <TableCell className="text-xs">
                      {b.nexus_grant_id ? (
                        <>
                          <div>{b.observed_grant_status ?? '—'} · moss_org_binding</div>
                          <div className="text-muted-foreground">{b.grant_expires_at ?? '无到期'}</div>
                        </>
                      ) : '—'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(b.updated_at).toLocaleString()}
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
                            <Button variant="destructive" size="sm" onClick={() => { setDeprovisionTarget(b); setConfirmInput('') }}>
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
              </div>
            ) : null}
          </section>
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加组织绑定</DialogTitle>
            <DialogDescription>
              将一个已存在的 Zone 绑定到组织（一个 Org 多 Zone / 一个 Zone 多 Org 均合法）。
              Zone 需已在 Nexus 侧存在；绑定异步收敛（grant 由 Moss 侧派生）。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input placeholder="org_id" value={addOrgId} onChange={(e) => setAddOrgId(e.target.value)} className="font-mono" />
            <Input placeholder="zone_id（不可变身份）" value={addZoneId} onChange={(e) => setAddZoneId(e.target.value)} className="font-mono" />
            <Input placeholder="purpose（shared/office/core/…）" value={addPurpose} onChange={(e) => setAddPurpose(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>取消</Button>
            <Button disabled={!addOrgId.trim() || !addZoneId.trim()} onClick={() => void onAddBinding()}>创建</Button>
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
