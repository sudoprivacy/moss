'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Activity, Loader2, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { dcClient } from '@/lib/api/client'
import { createQualityApi, type QualityQuery, type QualityRecord } from '@/lib/api/quality-core'
import { useAuth } from '@/lib/hooks/use-auth'
import {
  QUALITY_LABELS,
  qualityConfigValues,
  qualityDateRange,
  qualityRows,
  type QmsOperationTab,
} from '../qms-operations'

type Row = QualityRecord
const labels: Record<QmsOperationTab, string> = {
  overview: '总览',
  conversations: '会话质量',
  installs: '安装统计',
  performance: '性能',
  users: '用户统计',
  crashes: 'Crash',
  alerts: '告警',
  system: '配置',
}
const enumLabels: Record<string, string> = {
  unresolved: '未解决',
  resolved: '已解决',
  ignored: '已忽略',
  success: '成功',
  failed: '失败',
  error: '错误',
  fatal: '致命',
  warning: '警告',
  info: '提示',
  personal: '个人',
  enterprise: '企业',
  gt: '大于',
  gte: '大于等于',
  lt: '小于',
  lte: '小于等于',
  eq: '等于',
  neq: '不等于',
  lark: '飞书',
  email: '邮件',
  healthy: '正常',
  unhealthy: '异常',
  memory: '进程内存',
  regular: '定时聚合',
  continuous: '连续聚合',
}
const alertDefaults: Row = {
  name: '',
  type: 'conversation',
  metric: 'error_rate',
  threshold: 5,
  comparison: 'gt',
  level: 'warning',
  channels: ['lark'],
  enabled: true,
  cooldown_minutes: 30,
  description: '',
}
const userColumns = [
  'user_nickname',
  'user_phone',
  'user_id',
  'tenant_id',
  'conversation_count',
  'turn_count',
  'step_count',
  'step_type',
  'total_tokens',
  'input_tokens',
  'output_tokens',
  'avg_duration_ms',
  'avg_tokens_per_turn',
  'success_rate',
]
const date = (value: Date) =>
  `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`

export default function OperationsQualityPage() {
  const { user, activeOrgId } = useAuth()
  return <QualityWorkspace key={activeOrgId} canManage={user?.role === 'super_admin'} />
}

function QualityWorkspace({ canManage }: { canManage: boolean }) {
  const [tab, setTab] = useState<QmsOperationTab>('overview')
  const [scope, setScope] = useState<'organization' | 'platform'>('organization')
  const [data, setData] = useState<Row>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [start, setStart] = useState(() => date(new Date(Date.now() - 6 * 86400000)))
  const [end, setEnd] = useState(() => date(new Date()))
  const [filters, setFilters] = useState<QualityQuery>({ dimension: 'all' })
  const api = useMemo(
    () =>
      createQualityApi(dcClient, scope, { tenant_id: scope === 'platform' ? filters.tenant_id : undefined }),
    [scope, filters.tenant_id],
  )
  const [page, setPage] = useState(0)
  const [userType, setUserType] = useState('conversations')
  const [leaderboard, setLeaderboard] = useState('conversations')
  const [detail, setDetail] = useState<Row | null>(null)
  const [alertForm, setAlertForm] = useState<Row | null>(null)
  const [config, setConfig] = useState<Record<string, string>>({})
  const [originalConfig, setOriginalConfig] = useState<Record<string, string>>({})
  const [notifications, setNotifications] = useState<Row>({})
  const [backfillDays, setBackfillDays] = useState(7)
  const requestId = useRef(0)
  const size = 25
  const filter = (key: string, value: string) => {
    setFilters((previous) => ({ ...previous, [key]: value === 'all' ? undefined : value }))
    setPage(0)
  }
  const changeTab = (value: string) => {
    setTab(value as QmsOperationTab)
    setPage(0)
    setFilters({ dimension: 'all' })
    setDetail(null)
  }

  const load = useCallback(async () => {
    const id = ++requestId.current
    setLoading(true)
    setError('')
    setData({})
    try {
      const range = qualityDateRange(start, end)
      const tenant = { tenant_id: scope === 'platform' ? filters.tenant_id : undefined }
      const query = { ...range, ...filters, ...tenant }
      let result: Row = {}
      if (tab === 'overview') result = { overview: (await api.get('dashboard/overview', query)).data }
      if (['conversations', 'installs', 'performance'].includes(tab)) {
        const kind = tab === 'performance' ? 'perf' : tab
        const [trend, dimensions, overview, errors] = await Promise.all([
          api.get(`dashboard/${kind}/trend`, query),
          api.get(`dashboard/${kind}/dimensions`, { ...range, ...tenant }),
          api.get('dashboard/overview', query),
          tab === 'conversations'
            ? api.get('dashboard/conversations/errors/trend', query)
            : Promise.resolve(null),
        ])
        result = {
          trend: trend.data,
          dimensions: dimensions.data,
          overview: overview.data,
          errors: errors?.data,
        }
      }
      if (tab === 'users') {
        const [rows, realtime, leaders] = await Promise.all([
          api.get(`user-stats/${userType}`, { ...query, limit: size, offset: page * size }),
          api.get('user-stats/realtime', query),
          api.get(`user-stats/leaderboard/${leaderboard}`, { ...query, limit: 10 }),
        ])
        result = { rows: rows.data, realtime: realtime.data, leaders: leaders.data }
      }
      if (tab === 'crashes') {
        const [issues, summary, trend, distribution] = await Promise.all([
          api.get('crash/issues', { ...filters, ...tenant, limit: size, offset: page * size }),
          api.get('crash/stats/summary', tenant),
          api.get('crash/stats/trend', { ...tenant, days: 30 }),
          api.get('crash/stats/distribution', { ...tenant, by: filters.by || 'type' }),
        ])
        result = {
          rows: issues.data,
          total: issues.total,
          overview: summary.data,
          trend: trend.data,
          distribution: distribution.data,
        }
      }
      if (tab === 'alerts') {
        const [configs, history] = await Promise.all([
          api.get('alerts/configs', tenant),
          api.get('alerts/history', { ...query, limit: size, offset: page * size }),
        ])
        result = { rows: configs.data, history: history.data }
      }
      if (tab === 'system') {
        const [health, stats, settings, notification, tasks, raw, aggregation, codes] = await Promise.all([
          api.get('system/health'),
          api.get('system/stats'),
          api.get('system/config'),
          api.get('system/notifications'),
          api.get('system/tasks'),
          api.get('system/raw-stats'),
          api.get('system/aggregation-info'),
          api.get('system/error-codes'),
        ])
        result = {
          health,
          stats: stats.data,
          settings: settings.data,
          tasks: tasks.data,
          raw: raw.data,
          aggregation: aggregation.data,
          codes: codes.data,
        }
        if (id === requestId.current) {
          const values = qualityConfigValues(settings.data)
          setConfig(values)
          setOriginalConfig(values)
          setNotifications(record(notification.data))
        }
      }
      if (id === requestId.current) setData(result)
    } catch (cause) {
      if (id === requestId.current) setError(cause instanceof Error ? cause.message : '加载质量数据失败')
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [api, tab, start, end, filters, scope, page, userType, leaderboard])
  useEffect(() => {
    void load()
    return () => {
      requestId.current++
    }
  }, [load])

  const action = async (operation: () => Promise<unknown>, message: string) => {
    if (saving) return false
    setSaving(true)
    try {
      await operation()
      toast.success(message)
      setDetail(null)
      await load()
      return true
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '操作失败')
      return false
    } finally {
      setSaving(false)
    }
  }
  async function openDetail(kind: 'user' | 'crash' | 'event', row: Row) {
    setSaving(true)
    try {
      const resource =
        kind === 'user'
          ? `user-stats/users/${encodeURIComponent(String(row.user_id))}`
          : `crash/${kind === 'event' ? 'events' : 'issues'}/${row.id}`
      const response = await api.get(resource, {
        ...qualityDateRange(start, end),
        tenant_id: String(row.tenant_id || filters.tenant_id || ''),
      })
      setDetail({ kind, ...record(response.data), ...(response.events ? { events: response.events } : {}) })
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '获取详情失败')
    } finally {
      setSaving(false)
    }
  }
  async function saveAlert() {
    if (!alertForm) return
    const { id, ...value } = alertForm
    if (!String(value.name).trim() || !String(value.metric).trim()) {
      toast.error('请填写告警名称和指标')
      return
    }
    const saved = await action(
      () => (id ? api.put(`alerts/configs/${id}`, value) : api.post('alerts/configs', value)),
      '告警配置已保存',
    )
    if (saved) setAlertForm(null)
  }
  async function saveConfig() {
    await action(async () => {
      for (const [key, value] of Object.entries(config))
        if (value !== originalConfig[key])
          await api.put(`system/config/${encodeURIComponent(key)}`, { value })
      await api.put('system/notifications', notifications)
    }, '配置已保存')
  }
  function period(days: number) {
    setStart(date(new Date(Date.now() - (days - 1) * 86400000)))
    setEnd(date(new Date()))
    setPage(0)
  }
  const dimensions = record(data.dimensions)
  const overview = record(data.overview)
  const rows = qualityRows(data.rows)
  const notification = (section: string, key: string, value: unknown) =>
    setNotifications((previous) => ({
      ...previous,
      [section]: { ...record(previous[section]), [key]: value },
    }))

  return (
    <DashboardLayout title="质量管理" description="客户端会话质量、用户使用、安装、性能与崩溃监控">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted-foreground">数据范围</span>
          {canManage ? (
            <Choice
              label="数据范围"
              value={scope}
              options={{ organization: '当前组织', platform: '所有组织' }}
              onChange={(value) => {
                setScope(value as typeof scope)
                setPage(0)
                setDetail(null)
              }}
            />
          ) : (
            <Badge variant="outline">当前组织 · 只读</Badge>
          )}
          {scope === 'platform' ? (
            <Input
              aria-label="企业代码"
              className="w-48"
              placeholder="按企业代码筛选"
              value={String(filters.tenant_id ?? '')}
              onChange={(event) => filter('tenant_id', event.target.value)}
            />
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            disabled={loading || saving}
            onClick={() => void load()}
          >
            <RefreshCw className={`mr-2 size-4 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/operations/sudowork-settings">客户端上报设置</Link>
          </Button>
        </div>
        <Tabs value={tab} onValueChange={changeTab} className="space-y-5">
          <TabsList className="h-auto flex-wrap justify-start">
            {Object.entries(labels)
              .filter(([key]) => canManage || !['alerts', 'system'].includes(key))
              .map(([key, title]) => (
                <TabsTrigger key={key} value={key}>
                  {title}
                </TabsTrigger>
              ))}
          </TabsList>
          {!['system', 'crashes'].includes(tab) ? (
            <div className="flex flex-wrap items-end gap-3">
              <Field title="开始日期">
                <Input
                  aria-label="开始日期"
                  type="date"
                  value={start}
                  onChange={(event) => {
                    setStart(event.target.value)
                    setPage(0)
                  }}
                />
              </Field>
              <Field title="结束日期">
                <Input
                  aria-label="结束日期"
                  type="date"
                  value={end}
                  onChange={(event) => {
                    setEnd(event.target.value)
                    setPage(0)
                  }}
                />
              </Field>
              {[1, 7, 30].map((days) => (
                <Button key={days} variant="outline" size="sm" onClick={() => period(days)}>
                  {days === 1 ? '今天' : `近 ${days} 天`}
                </Button>
              ))}
            </div>
          ) : null}
          {['conversations', 'installs', 'performance'].includes(tab) ? (
            <div className="flex flex-wrap gap-3">
              <Choice
                label="统计维度"
                value={String(filters.dimension || 'all')}
                options={{ all: '总体', platform: '按平台', version: '按版本' }}
                onChange={(value) => filter('dimension', value)}
              />
              <Choice
                label="平台"
                value={String(filters.platform || 'all')}
                options={{
                  all: '全部平台',
                  ...Object.fromEntries(
                    qualityRows(dimensions.platforms).map((row) => [
                      String(row.platform),
                      String(row.platform),
                    ]),
                  ),
                }}
                onChange={(value) => filter('platform', value)}
              />
              <Choice
                label="版本"
                value={String(filters.version || 'all')}
                options={options(dimensions.versions, '全部版本')}
                onChange={(value) => filter('version', value)}
              />
              {tab === 'performance' ? (
                <Choice
                  label="性能指标"
                  value={String(filters.metric || 'all')}
                  options={options(dimensions.metrics, '全部指标')}
                  onChange={(value) => filter('metric', value)}
                />
              ) : null}
              {tab === 'installs' ? (
                <Choice
                  label="安装类型"
                  value={String(filters.install_type || 'all')}
                  options={options(dimensions.install_types, '全部类型')}
                  onChange={(value) => filter('install_type', value)}
                />
              ) : null}
              {tab === 'conversations' ? (
                <Input
                  aria-label="错误码"
                  className="w-40"
                  value={String(filters.error_code ?? '')}
                  onChange={(event) => filter('error_code', event.target.value)}
                  placeholder="错误码，如 E001"
                />
              ) : null}
            </div>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>质量数据加载失败</AlertTitle>
              <AlertDescription>
                {error}
                <div className="mt-3 flex gap-3">
                  <Button size="sm" variant="outline" onClick={() => void load()}>
                    重试
                  </Button>
                  {canManage ? (
                    <Button asChild size="sm" variant="outline">
                      <Link to="/settings/server-credentials">检查服务凭据</Link>
                    </Button>
                  ) : null}
                </div>
              </AlertDescription>
            </Alert>
          ) : loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((item) => (
                <Skeleton key={item} className="h-24 w-full" />
              ))}
            </div>
          ) : (
            <>
              <TabsContent value="overview" className="space-y-5">
                <Section title="会话概览">
                  <Metrics value={record(overview.conversations)} />
                </Section>
                <Section title="错误概览">
                  <Metrics value={record(overview.errors)} />
                  <DataTable
                    rows={qualityRows(record(overview.errors).top_errors)}
                    columns={['error_code', 'count', 'last_occurrence', 'trend']}
                  />
                </Section>
                <Section title="性能指标">
                  <DataTable
                    rows={qualityRows(record(overview.performance).metrics)}
                    columns={['metric', 'count', 'avg', 'p50', 'p90', 'p95', 'p99', 'trend']}
                  />
                </Section>
                <Section title="安装概览">
                  <Metrics value={record(overview.installs)} />
                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <DataTable rows={qualityRows(record(overview.installs).by_version)} />
                    <DataTable rows={qualityRows(record(overview.installs).by_platform)} />
                  </div>
                </Section>
                <Section title="Crash 概览">
                  <Metrics value={record(overview.crashes)} />
                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <DataTable rows={qualityRows(record(overview.crashes).by_type)} />
                    <DataTable rows={qualityRows(record(overview.crashes).by_platform)} />
                  </div>
                </Section>
              </TabsContent>
              <TabsContent value="conversations" className="space-y-5">
                <Metrics value={record(overview.conversations)} />
                <Trend
                  title="会话趋势"
                  rows={qualityRows(data.trend)}
                  metrics={['success_count', 'error_count', 'user_cancel_count']}
                />
                <DataTable rows={qualityRows(data.trend)} />
                <Trend title="错误趋势" rows={qualityRows(data.errors)} metrics={['count']} />
                <DataTable rows={qualityRows(data.errors)} />
              </TabsContent>
              <TabsContent value="installs" className="space-y-5">
                <Metrics value={record(overview.installs)} />
                <Trend
                  title="安装趋势"
                  rows={qualityRows(data.trend)}
                  metrics={['success_count', 'failed_count']}
                />
                <DataTable rows={qualityRows(data.trend)} />
              </TabsContent>
              <TabsContent value="performance" className="space-y-5">
                <DataTable rows={qualityRows(record(overview.performance).metrics)} />
                <Trend title="性能趋势" rows={qualityRows(data.trend)} metrics={['p50', 'p90', 'p95']} />
                <DataTable rows={qualityRows(data.trend)} />
              </TabsContent>
              <TabsContent value="users" className="space-y-5">
                <Metrics value={record(data.realtime)} />
                <div className="flex flex-wrap gap-3">
                  <Choice
                    label="统计类型"
                    value={userType}
                    options={{ conversations: '会话统计', turns: '轮次统计', steps: '步骤统计' }}
                    onChange={(value) => {
                      setUserType(value)
                      setPage(0)
                    }}
                  />
                  <Choice
                    label="登录模式"
                    value={String(filters.login_mode || 'all')}
                    options={{ all: '全部登录模式', personal: '个人', enterprise: '企业' }}
                    onChange={(value) => filter('login_mode', value)}
                  />
                  <Input
                    className="w-48"
                    aria-label="用户 ID"
                    placeholder="用户 ID"
                    value={String(filters.user_id || '')}
                    onChange={(event) => filter('user_id', event.target.value)}
                  />
                  {userType === 'steps' ? (
                    <Input
                      className="w-48"
                      aria-label="步骤类型"
                      placeholder="步骤类型"
                      value={String(filters.step_type || '')}
                      onChange={(event) => filter('step_type', event.target.value)}
                    />
                  ) : null}
                </div>
                <DataTable
                  rows={rows}
                  columns={userColumns}
                  actions={(row) => (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={saving}
                      onClick={() => void openDetail('user', row)}
                    >
                      详情
                    </Button>
                  )}
                />
                <Pager page={page} size={size} hasNext={rows.length === size} onChange={setPage} />
                <Section title="用户排行榜">
                  <Choice
                    label="排行榜"
                    value={leaderboard}
                    options={{
                      conversations: '会话数',
                      turns: '轮次数',
                      steps: '步骤数',
                      tokens: 'Token 用量',
                    }}
                    onChange={setLeaderboard}
                  />
                  <div className="mt-4">
                    <DataTable
                      rows={qualityRows(data.leaders)}
                      columns={['rank', 'user_nickname', 'user_phone', 'user_id', 'tenant_id', 'value']}
                      actions={(row) => (
                        <Button variant="ghost" size="sm" onClick={() => void openDetail('user', row)}>
                          详情
                        </Button>
                      )}
                    />
                  </div>
                </Section>
              </TabsContent>
              <TabsContent value="crashes" className="space-y-5">
                <Metrics value={overview} />
                <div className="flex flex-wrap gap-3">
                  <Choice
                    label="问题状态"
                    value={String(filters.status || 'all')}
                    options={{ all: '全部状态', unresolved: '未解决', resolved: '已解决', ignored: '已忽略' }}
                    onChange={(value) => filter('status', value)}
                  />
                  <Choice
                    label="Crash 类型"
                    value={String(filters.type || 'all')}
                    options={{
                      all: '全部类型',
                      js_exception: 'JS 异常',
                      native_crash: '原生崩溃',
                      renderer_crash: '渲染进程崩溃',
                    }}
                    onChange={(value) => filter('type', value)}
                  />
                  <Choice
                    label="严重级别"
                    value={String(filters.level || 'all')}
                    options={{ all: '全部级别', error: '错误', fatal: '致命' }}
                    onChange={(value) => filter('level', value)}
                  />
                  <Input
                    aria-label="Crash 版本"
                    className="w-40"
                    placeholder="版本"
                    value={String(filters.version || '')}
                    onChange={(event) => filter('version', event.target.value)}
                  />
                </div>
                <DataTable
                  rows={rows}
                  columns={[
                    'title',
                    'type',
                    'status',
                    'level',
                    'count',
                    'user_count',
                    'last_seen',
                    'last_release',
                    'assigned_to',
                  ]}
                  actions={(row) => (
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={saving}
                        onClick={() => void openDetail('crash', row)}
                      >
                        详情
                      </Button>
                      {canManage && row.status === 'unresolved' ? (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={saving}
                            onClick={() =>
                              void action(() => api.post(`crash/issues/${row.id}/resolve`), '问题已解决')
                            }
                          >
                            解决
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={saving}
                            onClick={() =>
                              void action(() => api.post(`crash/issues/${row.id}/ignore`), '问题已忽略')
                            }
                          >
                            忽略
                          </Button>
                        </>
                      ) : null}
                    </div>
                  )}
                />
                <Pager page={page} size={size} total={Number(data.total || 0)} onChange={setPage} />
                <Trend title="近 30 天 Crash 趋势" rows={qualityRows(data.trend)} metrics={['count']} />
                <Section title="Crash 分布">
                  <Choice
                    label="分布维度"
                    value={String(filters.by || 'type')}
                    options={{ type: '按类型', platform: '按平台', version: '按版本' }}
                    onChange={(value) => filter('by', value)}
                  />
                  <div className="mt-4">
                    <DataTable rows={qualityRows(data.distribution)} />
                  </div>
                </Section>
              </TabsContent>
              <TabsContent value="alerts" className="space-y-5">
                <div className="flex justify-end">
                  <Button onClick={() => setAlertForm({ ...alertDefaults })}>
                    <Plus className="mr-2 size-4" />
                    新建告警
                  </Button>
                </div>
                <DataTable
                  rows={rows}
                  columns={[
                    'name',
                    'type',
                    'metric',
                    'threshold',
                    'comparison',
                    'level',
                    'channels',
                    'enabled',
                    'cooldown_minutes',
                  ]}
                  actions={(row) => (
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setAlertForm({ ...alertDefaults, ...row })}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={saving}
                        onClick={() =>
                          void action(() => api.post(`alerts/configs/${row.id}/test`), '测试已执行')
                        }
                      >
                        测试
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={saving}
                        onClick={() => {
                          if (window.confirm(`删除告警“${row.name}”？`))
                            void action(() => api.delete(`alerts/configs/${row.id}`), '告警已删除')
                        }}
                      >
                        删除
                      </Button>
                    </div>
                  )}
                />
                <Section title="告警历史">
                  <DataTable
                    rows={qualityRows(data.history)}
                    columns={[
                      'name',
                      'type',
                      'level',
                      'message',
                      'value',
                      'sent_at',
                      'success',
                      'acknowledged',
                    ]}
                    actions={(row) =>
                      !row.acknowledged ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={saving}
                          onClick={() =>
                            void action(() => api.post(`alerts/history/${row.id}/acknowledge`), '告警已确认')
                          }
                        >
                          确认
                        </Button>
                      ) : null
                    }
                  />
                  <Pager
                    page={page}
                    size={size}
                    total={Number(record(data.history).total || 0)}
                    onChange={setPage}
                  />
                </Section>
              </TabsContent>
              <TabsContent value="system" className="space-y-5">
                <Section title="服务状态">
                  <Metrics value={record(data.health)} />
                  <p className="text-sm text-muted-foreground">
                    存储使用 Moss PostgreSQL，统计通过后台任务聚合。
                  </p>
                </Section>
                <Section title="本实例内存队列">
                  <Metrics value={record(record(data.stats).queue)} />
                  <p className="text-sm text-muted-foreground">
                    待写入的遥测仅保存在本实例内存中。正常停机会尝试排空；进程崩溃或强制退出会丢失尚未写入的数据。
                  </p>
                </Section>
                <Section title="后台任务">
                  <DataTable
                    rows={qualityRows(data.tasks)}
                    columns={['name', 'last_run', 'next_run', 'running', 'last_error']}
                  />
                  <div className="mt-4 flex flex-wrap gap-3">
                    <Button
                      variant="outline"
                      disabled={saving}
                      onClick={() => void action(() => api.post('system/aggregation/run'), '聚合已完成')}
                    >
                      立即聚合
                    </Button>
                    <Input
                      aria-label="历史回填天数"
                      type="number"
                      className="w-24"
                      min={1}
                      max={30}
                      value={backfillDays}
                      onChange={(event) => setBackfillDays(Number(event.target.value))}
                    />
                    <Button
                      variant="outline"
                      disabled={saving || backfillDays < 1 || backfillDays > 30}
                      onClick={() =>
                        void action(
                          () => api.post('system/aggregation/backfill', { days: backfillDays }),
                          '统计数据已重算',
                        )
                      }
                    >
                      重算最近统计（天）
                    </Button>
                  </div>
                </Section>
                <Section title="数据存储">
                  <Metrics value={record(data.stats)} />
                  <DataTable
                    rows={qualityRows(data.raw)}
                    columns={['label', 'table', 'count', 'earliest', 'latest']}
                  />
                </Section>
                <Section title="系统配置">
                  <div className="grid gap-4 md:grid-cols-2">
                    {qualityRows(data.settings).map((row) => (
                      <Field key={String(row.key)} title={String(row.description || row.key)}>
                        <Input
                          aria-label={String(row.key)}
                          disabled={String(row.value) === '******'}
                          value={config[String(row.key)] ?? ''}
                          onChange={(event) =>
                            setConfig((previous) => ({ ...previous, [String(row.key)]: event.target.value }))
                          }
                        />
                      </Field>
                    ))}
                  </div>
                  {!qualityRows(data.settings).length ? (
                    <p className="text-sm text-muted-foreground">
                      当前使用部署默认配置。上报地址和开关在“客户端上报设置”中管理。
                    </p>
                  ) : null}
                </Section>
                <Section title="通知配置">
                  <div className="grid gap-6 lg:grid-cols-2">
                    <div className="space-y-4">
                      <Field title="飞书 Webhook">
                        <Input
                          type="password"
                          aria-label="飞书 Webhook"
                          value={String(record(notifications.lark).webhookUrl || '')}
                          onChange={(event) => notification('lark', 'webhookUrl', event.target.value)}
                        />
                      </Field>
                      <Button
                        variant="outline"
                        disabled={saving}
                        onClick={() =>
                          void action(() => api.post('system/notifications/test/lark'), '飞书测试通知已发送')
                        }
                      >
                        测试已保存的飞书配置
                      </Button>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      {[
                        ['smtpHost', 'SMTP 服务器'],
                        ['smtpPort', 'SMTP 端口'],
                        ['smtpUser', 'SMTP 用户'],
                        ['smtpPass', 'SMTP 密码'],
                        ['from', '发件人'],
                        ['to', '收件人'],
                      ].map(([key, title]) => (
                        <Field key={key} title={title}>
                          <Input
                            aria-label={title}
                            type={key === 'smtpPass' ? 'password' : key === 'smtpPort' ? 'number' : 'text'}
                            value={String(record(notifications.email)[key] ?? '')}
                            onChange={(event) =>
                              notification(
                                'email',
                                key,
                                key === 'smtpPort' ? Number(event.target.value) : event.target.value,
                              )
                            }
                          />
                        </Field>
                      ))}
                      <Button
                        variant="outline"
                        disabled={saving}
                        onClick={() =>
                          void action(() => api.post('system/notifications/test/email'), '邮件测试通知已发送')
                        }
                      >
                        测试已保存的邮件配置
                      </Button>
                    </div>
                  </div>
                  <div className="mt-5 flex justify-end">
                    <Button disabled={saving} onClick={() => void saveConfig()}>
                      {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}保存配置
                    </Button>
                  </div>
                </Section>
                <Section title="错误码定义">
                  <DataTable rows={qualityRows(data.codes)} />
                </Section>
              </TabsContent>
            </>
          )}
        </Tabs>
      </div>
      <Dialog
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) setDetail(null)
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>
              {detail?.kind === 'user'
                ? '用户使用详情'
                : detail?.kind === 'event'
                  ? 'Crash 事件详情'
                  : 'Crash 问题详情'}
            </DialogTitle>
            <DialogDescription>当前数据范围内的详细记录</DialogDescription>
          </DialogHeader>
          {detail ? (
            <>
              <Detail value={detail} />
              {detail.kind === 'crash' ? (
                <>
                  <DataTable
                    rows={qualityRows(detail.events)}
                    columns={['id', 'timestamp', 'version', 'platform', 'user_nickname', 'error_message']}
                    actions={(row) => (
                      <Button variant="ghost" size="sm" onClick={() => void openDetail('event', row)}>
                        事件详情
                      </Button>
                    )}
                  />
                  {canManage ? (
                    <div className="flex gap-3">
                      <Input
                        aria-label="负责人"
                        placeholder="负责人"
                        value={String(detail.assigned_to || '')}
                        onChange={(event) => setDetail({ ...detail, assigned_to: event.target.value })}
                      />
                      <Button
                        disabled={saving}
                        onClick={() =>
                          void action(
                            () =>
                              api.put(`crash/issues/${detail.id}`, {
                                assigned_to: detail.assigned_to || null,
                              }),
                            '负责人已保存',
                          )
                        }
                      >
                        保存负责人
                      </Button>
                      <Button
                        variant="outline"
                        disabled={saving}
                        onClick={() =>
                          void action(
                            () => api.put(`crash/issues/${detail.id}`, { status: 'unresolved' }),
                            '问题已重新打开',
                          )
                        }
                      >
                        重新打开
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetail(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={alertForm !== null}
        onOpenChange={(open) => {
          if (!open) setAlertForm(null)
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{alertForm?.id ? '编辑告警' : '新建告警'}</DialogTitle>
            <DialogDescription>达到阈值后，通过选定渠道发送通知。</DialogDescription>
          </DialogHeader>
          {alertForm ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {['name', 'metric', 'description'].map((key) => (
                <Field key={key} title={QUALITY_LABELS[key]}>
                  <Input
                    aria-label={QUALITY_LABELS[key]}
                    value={String(alertForm[key] || '')}
                    disabled={key === 'metric' && Boolean(alertForm.id)}
                    onChange={(event) => setAlertForm({ ...alertForm, [key]: event.target.value })}
                  />
                </Field>
              ))}
              <Field title="类型">
                <Choice
                  label="告警类型"
                  value={String(alertForm.type)}
                  disabled={Boolean(alertForm.id)}
                  options={{
                    perf: '性能',
                    error: '错误',
                    conversation: '会话',
                    install: '安装',
                    crash: 'Crash',
                  }}
                  onChange={(value) => setAlertForm({ ...alertForm, type: value })}
                />
              </Field>
              {['threshold', 'cooldown_minutes'].map((key) => (
                <Field key={key} title={QUALITY_LABELS[key]}>
                  <Input
                    aria-label={QUALITY_LABELS[key]}
                    type="number"
                    min={0}
                    value={String(alertForm[key] ?? 0)}
                    onChange={(event) => setAlertForm({ ...alertForm, [key]: Number(event.target.value) })}
                  />
                </Field>
              ))}
              <Choice
                label="比较方式"
                value={String(alertForm.comparison)}
                options={{
                  gt: '大于',
                  gte: '大于等于',
                  lt: '小于',
                  lte: '小于等于',
                  eq: '等于',
                  neq: '不等于',
                }}
                onChange={(value) => setAlertForm({ ...alertForm, comparison: value })}
              />
              <Choice
                label="告警级别"
                value={String(alertForm.level)}
                options={{ info: '提示', warning: '警告', error: '错误', critical: '严重' }}
                onChange={(value) => setAlertForm({ ...alertForm, level: value })}
              />
              <div className="flex items-center gap-3">
                <Switch
                  aria-label="启用告警"
                  checked={Boolean(alertForm.enabled)}
                  onCheckedChange={(enabled) => setAlertForm({ ...alertForm, enabled })}
                />
                <Label>启用告警</Label>
              </div>
              <div className="flex gap-4">
                {['lark', 'email'].map((channel) => (
                  <label key={channel} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={(alertForm.channels as string[]).includes(channel)}
                      onChange={(event) =>
                        setAlertForm({
                          ...alertForm,
                          channels: event.target.checked
                            ? [...(alertForm.channels as string[]), channel]
                            : (alertForm.channels as string[]).filter((value) => value !== channel),
                        })
                      }
                    />
                    {enumLabels[channel]}
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-2">
                指标示例：error_rate、error_count、avg_duration、failure_count、crash_count；性能指标使用客户端上报的指标名称。
              </p>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAlertForm(null)}>
              取消
            </Button>
            <Button disabled={saving} onClick={() => void saveAlert()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}

function record(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {}
}
function options(value: unknown, all: string) {
  return {
    all,
    ...Object.fromEntries((Array.isArray(value) ? value : []).map((item) => [String(item), String(item)])),
  }
}
function Field({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{title}</Label>
      {children}
    </div>
  )
}
function Choice({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: string
  options: Record<string, string>
  onChange(value: string): void
  disabled?: boolean
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={label} className="w-auto min-w-36">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(options).map(([key, title]) => (
          <SelectItem key={key} value={key}>
            {title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  )
}
function display(value: unknown, key = ''): string {
  if (value == null || value === '') return '—'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (/(?:_at|_seen|_run|occurrence|timestamp|earliest|latest)$/.test(key)) {
    const parsed = new Date(value as string | number)
    if (Number.isFinite(parsed.getTime())) return parsed.toLocaleString('zh-CN')
  }
  if (typeof value === 'number') return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
  if (Array.isArray(value)) return value.map((item) => display(item)).join('、')
  if (typeof value === 'object') return JSON.stringify(value)
  return enumLabels[String(value)] || String(value)
}
function Metrics({ value }: { value: Row }) {
  const entries = Object.entries(value).filter(([, item]) => item !== null && typeof item !== 'object')
  if (!entries.length) return <p className="text-sm text-muted-foreground">暂无统计数据</p>
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {entries.map(([key, item]) => (
        <div key={key} className="rounded-lg border bg-muted/20 p-4">
          <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
            {QUALITY_LABELS[key] || key}
            <Activity className="size-4 opacity-50" />
          </div>
          <div className="mt-2 text-2xl font-semibold tabular-nums">{display(item, key)}</div>
        </div>
      ))}
    </div>
  )
}
function DataTable({
  rows,
  columns,
  actions,
}: {
  rows: Row[]
  columns?: string[]
  actions?: (row: Row) => ReactNode
}) {
  const keys = columns
    ? columns.filter((key) => rows.some((row) => key in row))
    : [...new Set(rows.flatMap((row) => Object.keys(row)))].filter(
        (key) =>
          key !== 'tenant_id' && !rows.some((row) => row[key] !== null && typeof row[key] === 'object'),
      )
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {keys.map((key) => (
              <TableHead key={key} className="whitespace-nowrap">
                {QUALITY_LABELS[key] || key}
              </TableHead>
            ))}
            {actions ? <TableHead>操作</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={`${String(row.id ?? row.user_id ?? index)}-${index}`}>
              {keys.map((key) => (
                <TableCell key={key} className="max-w-96 break-words">
                  {key === 'status' || key === 'level' ? (
                    <Badge variant="outline">{display(row[key], key)}</Badge>
                  ) : (
                    display(row[key], key)
                  )}
                </TableCell>
              ))}
              {actions ? <TableCell>{actions(row)}</TableCell> : null}
            </TableRow>
          ))}
          {!rows.length ? (
            <TableRow>
              <TableCell
                colSpan={Math.max(keys.length + (actions ? 1 : 0), 1)}
                className="py-10 text-center text-muted-foreground"
              >
                所选范围暂无数据
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  )
}
function Pager({
  page,
  size,
  total,
  hasNext,
  onChange,
}: {
  page: number
  size: number
  total?: number
  hasNext?: boolean
  onChange(page: number): void
}) {
  return (
    <div className="flex items-center justify-end gap-3 text-sm text-muted-foreground">
      <span>{total === undefined ? `第 ${page + 1} 页` : `共 ${total} 条 · 第 ${page + 1} 页`}</span>
      <Button variant="outline" size="sm" disabled={!page} onClick={() => onChange(page - 1)}>
        上一页
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={total === undefined ? !hasNext : (page + 1) * size >= total}
        onClick={() => onChange(page + 1)}
      >
        下一页
      </Button>
    </div>
  )
}
function Trend({ title, rows, metrics }: { title: string; rows: Row[]; metrics: string[] }) {
  const groups = new Map<string, Row>()
  const series = new Map<string, string>()
  for (const row of rows) {
    const day = String(row.date).slice(0, 10)
    const point = groups.get(day) || { date: day }
    const group = [
      row.metric,
      row.error_code,
      row.type,
      row.platform,
      row.arch,
      row.version,
      row.install_type,
    ]
      .filter(Boolean)
      .join(' / ')
    for (const metric of metrics) {
      const key = `${group} ${metric}`
      series.set(key, `${group} ${QUALITY_LABELS[metric] || metric}`.trim())
      point[key] = Number(row[metric] || 0)
    }
    groups.set(day, point)
  }
  const colors = ['#16816a', '#e25d4a', '#5e70d8', '#d99824', '#8d56b3', '#2c92b2']
  return (
    <Section title={title}>
      {rows.length ? (
        <div className="h-72 w-full">
          <ResponsiveContainer>
            <LineChart
              data={[...groups.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)))}
            >
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} width={65} />
              <Tooltip />
              <Legend />
              {[...series].map(([key, name], index) => (
                <Line
                  key={key}
                  dataKey={key}
                  name={name}
                  stroke={colors[index % colors.length]}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">所选范围暂无趋势数据</p>
      )}
    </Section>
  )
}
function Detail({ value }: { value: Row }) {
  return (
    <div className="space-y-4">
      {Object.entries(value)
        .filter(([key]) => !['kind', 'events'].includes(key))
        .map(([key, item]) => (
          <div key={key}>
            <Label className="text-muted-foreground">{QUALITY_LABELS[key] || key}</Label>
            {Array.isArray(item) && item.some((row) => row && typeof row === 'object') ? (
              <DataTable rows={qualityRows(item)} />
            ) : item && typeof item === 'object' ? (
              <Detail value={record(item)} />
            ) : /stack|context/.test(key) ? (
              <Textarea readOnly rows={8} className="mt-2 font-mono text-xs" value={display(item)} />
            ) : (
              <p className="mt-1 break-words text-sm">{display(item, key)}</p>
            )}
          </div>
        ))}
    </div>
  )
}
