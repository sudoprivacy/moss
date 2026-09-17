'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, Bell, Bug, CheckCircle2, Database, Eye, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, Users } from 'lucide-react'
import { toast } from 'sonner'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { operationsApi } from '@/lib/api/operations'
import { crashIssueActions, type QmsOperationTab } from '../qms-operations'

type JsonRecord = Record<string, unknown>
type AlertDialogState = { mode: 'create' | 'edit'; item?: JsonRecord } | null

const tabLabels: Record<QmsOperationTab, string> = {
  overview: '总览', conversations: '会话', installs: '安装', performance: '性能',
  users: '用户', crashes: 'Crash', alerts: '告警', system: '系统',
}

export default function OperationsQualityPage() {
  const [tab, setTab] = useState<QmsOperationTab>('overview')
  const [data, setData] = useState<unknown>(null)
  const [secondary, setSecondary] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dimension, setDimension] = useState('all')
  const [metric, setMetric] = useState('all')
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [detail, setDetail] = useState<JsonRecord | null>(null)
  const [alertDialog, setAlertDialog] = useState<AlertDialogState>(null)
  const [alertJson, setAlertJson] = useState('{}')
  const [systemConfigJson, setSystemConfigJson] = useState('{}')
  const [notificationJson, setNotificationJson] = useState('{}')

  const range = useMemo(() => ({
    startTime: startTime ? new Date(`${startTime}T00:00:00`).getTime() : undefined,
    endTime: endTime ? new Date(`${endTime}T23:59:59`).getTime() : undefined,
  }), [endTime, startTime])

  const load = useCallback(async () => {
    setLoading(true); setSecondary(null)
    try {
      if (tab === 'overview') setData((await operationsApi.getQualityOverview(range)).data)
      if (tab === 'conversations') {
        const [trend, errors] = await Promise.all([
          operationsApi.getConversationTrend({ ...range, dimension: dimension === 'all' ? undefined : dimension }),
          operationsApi.getConversationErrorTrend(range),
        ])
        setData(trend.data); setSecondary(errors.data)
      }
      if (tab === 'installs') setData((await operationsApi.getInstallTrend({ ...range, dimension: dimension === 'all' ? undefined : dimension })).data)
      if (tab === 'performance') setData((await operationsApi.getPerformanceTrend({ ...range, metric: metric === 'all' ? undefined : metric })).data)
      if (tab === 'users') {
        const [conversations, turns, steps, realtime] = await Promise.all([
          operationsApi.listQualityUserStats('conversations', { ...range, limit: 100 }),
          operationsApi.listQualityUserStats('turns', { ...range, limit: 100 }),
          operationsApi.listQualityUserStats('steps', { ...range, limit: 100 }),
          operationsApi.getQualityUserRealtime(range),
        ])
        setData({ conversations: conversations.data, turns: turns.data, steps: steps.data, realtime: realtime.data })
      }
      if (tab === 'crashes') {
        const [issues, summary, trend] = await Promise.all([
          operationsApi.listCrashIssues({ limit: 100 }), operationsApi.getCrashStatsSummary(), operationsApi.getCrashStatsTrend(30),
        ])
        setData(issues.data); setSecondary({ summary: summary.data, trend: trend.data })
      }
      if (tab === 'alerts') {
        const [configs, history] = await Promise.all([operationsApi.listAlertConfigs(), operationsApi.listQualityAlerts({ limit: 100 })])
        setData(configs.data); setSecondary(history.data)
      }
      if (tab === 'system') {
        const [health, stats, config, notifications, tasks, raw, aggregation] = await Promise.all([
          operationsApi.getQualitySystemHealth(), operationsApi.getQmsSystemStats(), operationsApi.getQmsSystemConfig(),
          operationsApi.getQmsNotifications(), operationsApi.getQmsTasks(), operationsApi.getQmsRawStats(), operationsApi.getQmsAggregationInfo(),
        ])
        setData({ health, stats: stats.data, tasks: tasks.data, raw: raw.data, aggregation: aggregation.data })
        setSystemConfigJson(JSON.stringify(config.data ?? {}, null, 2))
        setNotificationJson(JSON.stringify(notifications.data ?? {}, null, 2))
      }
    } catch (error) { setData(null); toast.error(error instanceof Error ? error.message : '获取质量数据失败') }
    finally { setLoading(false) }
  }, [dimension, metric, range, tab])

  useEffect(() => { void load() }, [load])

  const action = async (operation: () => Promise<unknown>, message: string) => {
    setSaving(true)
    try { await operation(); toast.success(message); setDetail(null); await load() }
    catch (error) { toast.error(error instanceof Error ? error.message : '操作失败'); throw error }
    finally { setSaving(false) }
  }

  const openCrash = async (row: JsonRecord) => {
    setSaving(true)
    try { setDetail(asRecord((await operationsApi.getCrashIssue(Number(row.id))).data)) }
    catch (error) { toast.error(error instanceof Error ? error.message : '获取 Crash 详情失败') }
    finally { setSaving(false) }
  }

  const openUser = async (row: JsonRecord) => {
    const userId = String(row.user_id ?? row.userId ?? row.id ?? '')
    if (!userId) return
    setSaving(true)
    try { setDetail(asRecord((await operationsApi.getQualityUserDetail(userId, range)).data)) }
    catch (error) { toast.error(error instanceof Error ? error.message : '获取用户详情失败') }
    finally { setSaving(false) }
  }

  const saveAlert = async () => {
    if (!alertDialog) return
    try {
      const value = parseJsonObject(alertJson)
      await action(
        () => alertDialog.mode === 'create' ? operationsApi.createAlertConfig(value) : operationsApi.updateAlertConfig(String(alertDialog.item?.id), value),
        alertDialog.mode === 'create' ? '告警配置已创建' : '告警配置已更新',
      )
      setAlertDialog(null)
    } catch (error) { if (error instanceof SyntaxError) toast.error('告警配置必须是 JSON 对象') }
  }

  const saveSystem = async () => {
    try {
      const config = parseJsonObject(systemConfigJson)
      const notifications = parseJsonObject(notificationJson)
      await action(async () => {
        for (const [key, value] of Object.entries(config)) await operationsApi.updateQmsSystemConfig(key, value)
        await operationsApi.updateQmsNotifications(notifications)
      }, 'QMS 系统配置已保存')
    } catch (error) { if (error instanceof SyntaxError) toast.error('系统配置必须是 JSON 对象') }
  }

  const rows = tab === 'users' ? recordsFrom(asRecord(data).conversations) : recordsFrom(data)
  return (
    <DashboardLayout title="质量管理" description="统一管理会话质量、安装性能、Crash、告警和 QMS 生命周期">
      <Tabs value={tab} onValueChange={value => { setTab(value as QmsOperationTab); setDetail(null) }} className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><TabsList className="h-auto flex-wrap justify-start">{Object.entries(tabLabels).map(([value, label]) => <TabsTrigger key={value} value={value}>{label}</TabsTrigger>)}</TabsList><Button variant="outline" size="icon" title="刷新" onClick={() => void load()}><RefreshCw className="size-4" /></Button></div>
        {['overview', 'conversations', 'installs', 'performance', 'users'].includes(tab) ? <div className="flex flex-wrap gap-2"><Input className="w-40" type="date" value={startTime} onChange={event => setStartTime(event.target.value)} /><Input className="w-40" type="date" value={endTime} onChange={event => setEndTime(event.target.value)} />{tab === 'conversations' || tab === 'installs' ? <Select value={dimension} onValueChange={setDimension}><SelectTrigger className="w-40"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">总体</SelectItem><SelectItem value="platform">按平台</SelectItem><SelectItem value="version">按版本</SelectItem></SelectContent></Select> : null}{tab === 'performance' ? <Input className="w-48" value={metric === 'all' ? '' : metric} onChange={event => setMetric(event.target.value || 'all')} placeholder="指标名称" /> : null}</div> : null}

        <TabsContent value="overview">{loading ? <Loading /> : <Overview value={asRecord(data)} />}</TabsContent>
        <TabsContent value="conversations" className="space-y-4">{loading ? <Loading /> : <><DataTable rows={recordsFrom(data)} empty="暂无会话趋势" /><h3 className="text-sm font-semibold">错误趋势</h3><DataTable rows={recordsFrom(secondary)} empty="暂无错误趋势" /></>}</TabsContent>
        <TabsContent value="installs">{loading ? <Loading /> : <DataTable rows={recordsFrom(data)} empty="暂无安装统计" />}</TabsContent>
        <TabsContent value="performance">{loading ? <Loading /> : <DataTable rows={recordsFrom(data)} empty="暂无性能指标" />}</TabsContent>
        <TabsContent value="users" className="space-y-4">{loading ? <Loading /> : <><DataTable rows={rows} empty="暂无用户统计" actionLabel="详情" onAction={openUser} /><div className="grid gap-4 xl:grid-cols-3"><DataPanel title="Turn 统计" value={asRecord(data).turns} /><DataPanel title="Step 统计" value={asRecord(data).steps} /><DataPanel title="实时统计" value={asRecord(data).realtime} /></div></>}</TabsContent>
        <TabsContent value="crashes" className="space-y-4">{loading ? <Loading /> : <><Overview value={asRecord(asRecord(secondary).summary)} /><DataTable rows={recordsFrom(data)} empty="暂无 Crash 问题" actions={row => crashIssueActions(String(row.status)).map(item => ({ label: item === 'detail' ? '详情' : item === 'resolve' ? '解决' : '忽略', run: () => item === 'detail' ? openCrash(row) : action(() => item === 'resolve' ? operationsApi.resolveCrashIssue(Number(row.id)) : operationsApi.ignoreCrashIssue(Number(row.id)), item === 'resolve' ? 'Crash 已解决' : 'Crash 已忽略') }))} /><DataPanel title="近 30 天趋势" value={asRecord(secondary).trend} /></>}</TabsContent>
        <TabsContent value="alerts" className="space-y-4">{loading ? <Loading /> : <><div className="flex justify-end"><Button onClick={() => { setAlertJson('{}'); setAlertDialog({ mode: 'create' }) }}><Plus className="mr-2 size-4" />新建告警</Button></div><DataTable rows={recordsFrom(data)} empty="暂无告警配置" actions={row => [{ label: '编辑', run: () => { setAlertJson(JSON.stringify(row, null, 2)); setAlertDialog({ mode: 'edit', item: row }) } }, { label: '测试', run: () => action(() => operationsApi.testAlertConfig(String(row.id)), '测试告警已发送') }, { label: '删除', run: () => action(() => operationsApi.deleteAlertConfig(String(row.id)), '告警配置已删除') }]} /><h3 className="text-sm font-semibold">告警历史</h3><DataTable rows={recordsFrom(secondary)} empty="暂无告警历史" actions={row => row.acknowledged ? [] : [{ label: '确认', run: () => action(() => operationsApi.acknowledgeQualityAlert(Number(row.id)), '告警已确认') }]} /></>}</TabsContent>
        <TabsContent value="system" className="space-y-4">{loading ? <Loading /> : <><Overview value={asRecord(asRecord(data).health)} /><div className="grid gap-4 xl:grid-cols-2"><DataPanel title="系统统计" value={asRecord(data).stats} /><DataPanel title="聚合状态" value={asRecord(data).aggregation} /><DataPanel title="后台任务" value={asRecord(data).tasks} /><DataPanel title="数据表统计" value={asRecord(data).raw} /></div><div className="grid gap-4 xl:grid-cols-2"><JsonEditor title="系统配置" value={systemConfigJson} onChange={setSystemConfigJson} /><JsonEditor title="通知配置" value={notificationJson} onChange={setNotificationJson} /></div><div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => { void action(() => operationsApi.testQmsNotification('lark'), '飞书测试通知已发送').catch(() => undefined) }}>测试飞书</Button><Button variant="outline" onClick={() => { void action(() => operationsApi.testQmsNotification('email'), '邮件测试通知已发送').catch(() => undefined) }}>测试邮件</Button><Button variant="outline" onClick={() => { void action(() => operationsApi.runQualityAggregation(), '聚合任务已执行').catch(() => undefined) }}><Database className="mr-2 size-4" />立即聚合</Button><Button onClick={() => void saveSystem()} disabled={saving}>{saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}保存配置</Button></div></>}</TabsContent>
      </Tabs>

      <Dialog open={detail !== null} onOpenChange={open => { if (!open) setDetail(null) }}><DialogContent className="sm:max-w-3xl"><DialogHeader><DialogTitle>详细信息</DialogTitle></DialogHeader><DataPanel title="" value={detail} /><DialogFooter><Button onClick={() => setDetail(null)}>关闭</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={alertDialog !== null} onOpenChange={open => { if (!open) setAlertDialog(null) }}><DialogContent><DialogHeader><DialogTitle>{alertDialog?.mode === 'create' ? '新建告警配置' : '编辑告警配置'}</DialogTitle><DialogDescription>字段与 QMS 告警配置模型一致。</DialogDescription></DialogHeader><JsonEditor title="配置 JSON" value={alertJson} onChange={setAlertJson} /><DialogFooter><Button variant="outline" onClick={() => setAlertDialog(null)}>取消</Button><Button disabled={saving} onClick={() => void saveAlert()}>保存</Button></DialogFooter></DialogContent></Dialog>
    </DashboardLayout>
  )
}

function Loading() { return <div className="space-y-3">{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-14 w-full" />)}</div> }

function Overview({ value }: { value: JsonRecord }) {
  const entries = Object.entries(value).filter(([, item]) => item == null || typeof item !== 'object').slice(0, 12)
  if (entries.length === 0) return <div className="rounded-md border py-12 text-center text-muted-foreground">暂无汇总数据</div>
  const icons = [Activity, Users, Bug, CheckCircle2, Bell]
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{entries.map(([key, item], index) => { const Icon = icons[index % icons.length]!; return <Card key={key}><CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-medium">{label(key)}</CardTitle><Icon className="size-4 text-muted-foreground" /></CardHeader><CardContent className="text-2xl font-semibold">{formatValue(item)}</CardContent></Card> })}</div>
}

function DataTable({ rows, empty, actionLabel, onAction, actions }: { rows: JsonRecord[]; empty: string; actionLabel?: string; onAction?: (row: JsonRecord) => void; actions?: (row: JsonRecord) => Array<{ label: string; run(): unknown }> }) {
  const columns = Array.from(new Set(rows.flatMap(row => Object.keys(row)))).slice(0, 8)
  return <div className="overflow-x-auto rounded-md border"><Table><TableHeader><TableRow>{columns.map(column => <TableHead key={column}>{label(column)}</TableHead>)}{actionLabel || actions ? <TableHead>操作</TableHead> : null}</TableRow></TableHeader><TableBody>{rows.map((row, index) => <TableRow key={String(row.id ?? index)}>{columns.map(column => <TableCell key={column} className="max-w-64 truncate">{column === 'status' || column === 'level' ? <Badge variant="outline">{formatValue(row[column])}</Badge> : formatValue(row[column])}</TableCell>)}{actionLabel || actions ? <TableCell><div className="flex gap-1">{actionLabel ? <Button variant="ghost" size="sm" onClick={() => onAction?.(row)}><Eye className="mr-1 size-4" />{actionLabel}</Button> : null}{actions?.(row).map(action => <Button key={action.label} variant="ghost" size="sm" onClick={() => { void action.run() }}>{action.label === '编辑' ? <Pencil className="mr-1 size-4" /> : action.label === '删除' ? <Trash2 className="mr-1 size-4" /> : null}{action.label}</Button>)}</div></TableCell> : null}</TableRow>)}{rows.length === 0 ? <TableRow><TableCell colSpan={Math.max(columns.length + (actionLabel || actions ? 1 : 0), 1)} className="py-12 text-center text-muted-foreground"><Search className="mx-auto mb-2 size-7 opacity-50" />{empty}</TableCell></TableRow> : null}</TableBody></Table></div>
}

function DataPanel({ title, value }: { title: string; value: unknown }) { return <div className="rounded-md border p-4">{title ? <h3 className="mb-3 text-sm font-semibold">{title}</h3> : null}<pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(value ?? {}, null, 2)}</pre></div> }
function JsonEditor({ title, value, onChange }: { title: string; value: string; onChange(value: string): void }) { return <div className="space-y-2"><Label>{title}</Label><Textarea rows={12} className="font-mono text-xs" value={value} onChange={event => onChange(event.target.value)} /></div> }
function recordsFrom(value: unknown): JsonRecord[] { if (Array.isArray(value)) return value.filter(item => item && typeof item === 'object') as JsonRecord[]; const record = asRecord(value); for (const key of ['items', 'list', 'data', 'rows']) if (Array.isArray(record[key])) return record[key] as JsonRecord[]; return [] }
function asRecord(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {} }
function parseJsonObject(value: string): JsonRecord { const parsed = JSON.parse(value) as unknown; if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SyntaxError('object required'); return parsed as JsonRecord }
function label(value: string): string { return value.replaceAll('_', ' ') }
function formatValue(value: unknown): string { if (value == null || value === '') return '-'; if (typeof value === 'object') return JSON.stringify(value); return String(value) }
