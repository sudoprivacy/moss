'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, BadgeDollarSign, RefreshCw, RotateCcw, Search } from 'lucide-react'
import { toast } from 'sonner'

import { DashboardLayout } from '@/components/dashboard-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  getRechargeOrders,
  getRechargeRecords,
  getRechargeStats,
  retryRechargeOrder,
  syncPendingRechargeOrders,
  syncRechargeOrder,
  type RechargeOrder,
  type RechargeRecord,
  type RechargeStats,
} from '@/lib/api/operations-billing'

type Filters = {
  orderNo: string
  userPhone: string
  status: string
  syncStatus: string
}

const STATUS_OPTIONS = [
  { value: 'all', label: '全部订单状态' },
  { value: '0', label: '待支付' },
  { value: '1', label: '支付中' },
  { value: '2', label: '支付成功' },
  { value: '3', label: '支付失败' },
  { value: '4', label: '已退款' },
  { value: '5', label: '已取消' },
]

const SYNC_OPTIONS = [
  { value: 'all', label: '全部同步状态' },
  { value: 'NONE', label: '未同步' },
  { value: 'PROCESSING', label: '同步中' },
  { value: 'SYNCED', label: '已同步' },
  { value: 'SYNC_FAILED', label: '同步失败' },
  { value: 'SYNC_UNKNOWN', label: '结果未知' },
  { value: 'SYNC_INVALID', label: '金额异常' },
]

const numberFormatter = new Intl.NumberFormat('zh-CN')
const moneyFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

function formatNumber(value: number | null | undefined): string {
  return numberFormatter.format(Math.round(value ?? 0))
}

function formatMoney(value: number | null | undefined): string {
  return moneyFormatter.format(value ?? 0)
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '-'
  const at = Date.parse(value)
  if (!Number.isFinite(at)) return value
  return new Date(at).toLocaleString('zh-CN', { hour12: false })
}

function syncBadge(syncStatus: string, syncError?: string | null) {
  const variant =
    syncStatus === 'SYNCED' ? 'default'
      : syncStatus === 'SYNC_UNKNOWN' || syncStatus === 'SYNC_FAILED' || syncStatus === 'SYNC_INVALID' ? 'destructive'
        : 'secondary'
  return (
    <div className="flex flex-col gap-1">
      <Badge variant={variant}>{syncStatus}</Badge>
      {syncError ? <span className="max-w-[220px] truncate text-xs text-muted-foreground">{syncError}</span> : null}
    </div>
  )
}

function StatCard({ title, value, description }: { title: string; value: string; description: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  )
}

export default function OperationsBillingPage() {
  const [stats, setStats] = useState<RechargeStats | null>(null)
  const [orders, setOrders] = useState<RechargeOrder[]>([])
  const [records, setRecords] = useState<RechargeRecord[]>([])
  const [ordersTotal, setOrdersTotal] = useState(0)
  const [recordsTotal, setRecordsTotal] = useState(0)
  const [ordersPage, setOrdersPage] = useState(1)
  const [recordsPage, setRecordsPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [actingKey, setActingKey] = useState<string | null>(null)
  const [filters, setFilters] = useState<Filters>({
    orderNo: '',
    userPhone: '',
    status: 'all',
    syncStatus: 'all',
  })

  const pageSize = 20

  const queryParams = useMemo(() => ({
    page: ordersPage,
    pageSize,
    status: filters.status === 'all' ? undefined : filters.status,
    sync_status: filters.syncStatus === 'all' ? undefined : filters.syncStatus,
    order_no: filters.orderNo.trim() || undefined,
    user_phone: filters.userPhone.trim() || undefined,
  }), [filters, ordersPage])

  const recordParams = useMemo(() => ({
    page: recordsPage,
    pageSize,
    order_no: filters.orderNo.trim() || undefined,
    user_phone: filters.userPhone.trim() || undefined,
  }), [filters.orderNo, filters.userPhone, recordsPage])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [nextStats, nextOrders, nextRecords] = await Promise.all([
        getRechargeStats(),
        getRechargeOrders(queryParams),
        getRechargeRecords(recordParams),
      ])
      setStats(nextStats)
      setOrders(nextOrders.list)
      setOrdersTotal(nextOrders.total)
      setRecords(nextRecords.list)
      setRecordsTotal(nextRecords.total)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载支付运营数据失败')
    } finally {
      setLoading(false)
    }
  }, [queryParams, recordParams])

  useEffect(() => {
    void load()
  }, [load])

  const updateFilter = (key: keyof Filters, value: string) => {
    setFilters(prev => ({ ...prev, [key]: value }))
    setOrdersPage(1)
    setRecordsPage(1)
  }

  const act = async (key: string, work: () => Promise<unknown>, successMessage: string) => {
    setActingKey(key)
    try {
      await work()
      toast.success(successMessage)
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败')
    } finally {
      setActingKey(null)
    }
  }

  return (
    <DashboardLayout
      title="计费运营"
      description="处理 Sudowork 兼容充值订单、充值记录和 SudoRouter 到账同步。"
    >
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-4">
          {loading && !stats ? (
            [...Array(4)].map((_, index) => <Skeleton key={index} className="h-28 rounded-lg" />)
          ) : (
            <>
              <StatCard title="成功订单" value={formatNumber(stats?.total.success_count)} description={`全部订单 ${formatNumber(stats?.total.orders)} 笔`} />
              <StatCard title="实收金额" value={`¥${formatMoney(stats?.total.amount_cny)}`} description={`约 $${formatMoney(stats?.total.amount_usd)}`} />
              <StatCard title="发放积分" value={formatNumber(stats?.total.points)} description={`赠送 ${formatNumber(stats?.total.bonus)} 积分`} />
              <StatCard title="今日订单" value={formatNumber(stats?.today.orders)} description={`今日 ¥${formatMoney(stats?.today.amount_cny)}`} />
            </>
          )}
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <BadgeDollarSign className="size-4" />
                支付异常处理
              </CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                `SYNC_UNKNOWN` 和金额异常订单不会自动重试，需要先核对富友与 SudoRouter。
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void load()} disabled={loading}>
                <RefreshCw className="size-4" />
                刷新
              </Button>
              <Button
                onClick={() => void act('sync-all', syncPendingRechargeOrders, '待处理订单同步完成')}
                disabled={actingKey !== null}
              >
                <RefreshCw className="size-4" />
                同步待处理订单
              </Button>
            </div>
          </CardHeader>
        </Card>

        <div className="flex flex-wrap gap-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="订单号"
              value={filters.orderNo}
              onChange={event => updateFilter('orderNo', event.target.value)}
            />
          </div>
          <Input
            className="min-w-[180px] flex-1"
            placeholder="用户手机号"
            value={filters.userPhone}
            onChange={event => updateFilter('userPhone', event.target.value)}
          />
          <Select value={filters.status} onValueChange={value => updateFilter('status', value)}>
            <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filters.syncStatus} onValueChange={value => updateFilter('syncStatus', value)}>
            <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {SYNC_OPTIONS.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <Tabs defaultValue="orders" className="space-y-4">
          <TabsList>
            <TabsTrigger value="orders">订单管理</TabsTrigger>
            <TabsTrigger value="records">充值记录</TabsTrigger>
          </TabsList>

          <TabsContent value="orders">
            <Card>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>订单</TableHead>
                        <TableHead>用户</TableHead>
                        <TableHead>金额</TableHead>
                        <TableHead>积分</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead>同步</TableHead>
                        <TableHead>创建时间</TableHead>
                        <TableHead className="text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {orders.map(order => (
                        <TableRow key={order.order_no}>
                          <TableCell className="font-mono text-xs">{order.order_no}</TableCell>
                          <TableCell>
                            <div>{order.user_nickname || order.user_phone || order.user_id}</div>
                            <div className="text-xs text-muted-foreground">{order.user_phone || order.user_id}</div>
                          </TableCell>
                          <TableCell>
                            <div>¥{formatMoney(order.amount_cny)}</div>
                            <div className="text-xs text-muted-foreground">{order.payment_method}</div>
                          </TableCell>
                          <TableCell>{formatNumber(order.points)}</TableCell>
                          <TableCell><Badge variant={order.status === 2 ? 'default' : order.status === 3 ? 'destructive' : 'secondary'}>{order.status_text}</Badge></TableCell>
                          <TableCell>{syncBadge(order.sync_status, order.sync_error)}</TableCell>
                          <TableCell>{formatTime(order.created_at)}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                              {order.sync_status === 'SYNC_UNKNOWN' || order.sync_status === 'SYNC_INVALID' ? (
                                <Button variant="outline" size="sm" disabled>
                                  <AlertTriangle className="size-4" />
                                  人工核对
                                </Button>
                              ) : (
                                <>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={actingKey !== null}
                                    onClick={() => void act(`sync:${order.order_no}`, () => syncRechargeOrder(order.order_no), '订单状态同步完成')}
                                  >
                                    <RefreshCw className="size-4" />
                                    同步
                                  </Button>
                                  {order.sync_status === 'SYNC_FAILED' ? (
                                    <Button
                                      size="sm"
                                      disabled={actingKey !== null}
                                      onClick={() => void act(`retry:${order.order_no}`, () => retryRechargeOrder(order.order_no), '订单到账重试成功')}
                                    >
                                      <RotateCcw className="size-4" />
                                      重试
                                    </Button>
                                  ) : null}
                                </>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                      {!loading && orders.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={8} className="h-28 text-center text-muted-foreground">暂无订单</TableCell>
                        </TableRow>
                      ) : null}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
            <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
              <span>共 {ordersTotal} 笔</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={ordersPage <= 1} onClick={() => setOrdersPage(page => Math.max(1, page - 1))}>上一页</Button>
                <Button variant="outline" size="sm" disabled={ordersPage * pageSize >= ordersTotal} onClick={() => setOrdersPage(page => page + 1)}>下一页</Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="records">
            <Card>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>来源</TableHead>
                        <TableHead>订单</TableHead>
                        <TableHead>用户</TableHead>
                        <TableHead>金额</TableHead>
                        <TableHead>积分</TableHead>
                        <TableHead>同步</TableHead>
                        <TableHead>时间</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {records.map(record => (
                        <TableRow key={record.id}>
                          <TableCell><Badge variant="secondary">{record.source_text}</Badge></TableCell>
                          <TableCell className="font-mono text-xs">{record.order_no}</TableCell>
                          <TableCell>{record.user_phone || record.user_id}</TableCell>
                          <TableCell className={record.amount_cny < 0 ? 'text-destructive' : undefined}>¥{formatMoney(record.amount_cny)}</TableCell>
                          <TableCell className={record.points < 0 ? 'text-destructive' : undefined}>{formatNumber(record.points)}</TableCell>
                          <TableCell>{syncBadge(record.sync_status, record.sync_error)}</TableCell>
                          <TableCell>{formatTime(record.created_at)}</TableCell>
                        </TableRow>
                      ))}
                      {!loading && records.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="h-28 text-center text-muted-foreground">暂无充值记录</TableCell>
                        </TableRow>
                      ) : null}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
            <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
              <span>共 {recordsTotal} 条</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={recordsPage <= 1} onClick={() => setRecordsPage(page => Math.max(1, page - 1))}>上一页</Button>
                <Button variant="outline" size="sm" disabled={recordsPage * pageSize >= recordsTotal} onClick={() => setRecordsPage(page => page + 1)}>下一页</Button>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  )
}
