'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, CheckCircle2, Database, RefreshCw, ShieldAlert, Users } from 'lucide-react'
import { toast } from 'sonner'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { operationsApi } from '@/lib/api/operations'

type QualityTab = 'overview' | 'users' | 'crashes' | 'alerts' | 'system'
type JsonRecord = Record<string, unknown>

export default function OperationsQualityPage() {
  const [tab, setTab] = useState<QualityTab>('overview')
  const [data, setData] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      if (tab === 'overview') setData((await operationsApi.getQualityOverview()).data)
      if (tab === 'users') setData((await operationsApi.getQualityLeaderboard('conversations', { limit: 50 })).data)
      if (tab === 'crashes') setData((await operationsApi.listCrashIssues({ limit: 50 })).data)
      if (tab === 'alerts') setData((await operationsApi.listQualityAlerts({ limit: 50 })).data)
      if (tab === 'system') setData(await operationsApi.getQualitySystemHealth())
    } catch (error) {
      setData(null)
      toast.error(error instanceof Error ? error.message : '获取质量数据失败')
    } finally {
      setLoading(false)
    }
  }, [tab])

  useEffect(() => { void load() }, [load])

  const records = useMemo(() => normalizeRecords(data), [data])
  const action = async (kind: 'alert' | 'crash' | 'aggregate', id?: number) => {
    try {
      if (kind === 'alert' && id !== undefined) await operationsApi.acknowledgeQualityAlert(id)
      if (kind === 'crash' && id !== undefined) await operationsApi.resolveCrashIssue(id)
      if (kind === 'aggregate') await operationsApi.runQualityAggregation()
      toast.success(kind === 'aggregate' ? '聚合任务已执行' : '状态已更新')
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败')
    }
  }

  return (
    <DashboardLayout title="质量管理" description="统一查看本地与云端任务的质量、崩溃和告警数据">
      <Tabs value={tab} onValueChange={value => setTab(value as QualityTab)} className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList className="h-auto flex-wrap justify-start"><TabsTrigger value="overview">总览</TabsTrigger><TabsTrigger value="users">用户统计</TabsTrigger><TabsTrigger value="crashes">崩溃</TabsTrigger><TabsTrigger value="alerts">告警</TabsTrigger><TabsTrigger value="system">系统</TabsTrigger></TabsList>
          <Button variant="outline" size="icon" title="刷新" onClick={() => void load()}><RefreshCw className="size-4" /></Button>
        </div>
        <TabsContent value="overview">{loading ? <Loading /> : <Overview value={asRecord(data)} />}</TabsContent>
        <TabsContent value="users">{loading ? <Loading /> : <RecordTable rows={records} empty="暂无用户质量数据" />}</TabsContent>
        <TabsContent value="crashes">{loading ? <Loading /> : <RecordTable rows={records} empty="暂无崩溃问题" actionLabel="解决" onAction={row => void action('crash', numericId(row))} />}</TabsContent>
        <TabsContent value="alerts">{loading ? <Loading /> : <RecordTable rows={records} empty="暂无告警" actionLabel="确认" onAction={row => void action('alert', numericId(row))} />}</TabsContent>
        <TabsContent value="system"><div className="space-y-4">{loading ? <Loading /> : <Overview value={asRecord(data)} />}<Button onClick={() => void action('aggregate')}><Database className="mr-2 size-4" />立即聚合</Button></div></TabsContent>
      </Tabs>
    </DashboardLayout>
  )
}

function Loading() {
  return <div className="space-y-3">{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-14 w-full" />)}</div>
}

function Overview({ value }: { value: JsonRecord }) {
  const entries = Object.entries(value).filter(([, item]) => item == null || typeof item !== 'object').slice(0, 12)
  if (entries.length === 0) return <div className="rounded-md border py-12 text-center text-muted-foreground">暂无质量汇总数据</div>
  const icons = [Activity, Users, ShieldAlert, CheckCircle2]
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{entries.map(([key, item], index) => { const Icon = icons[index % icons.length]!; return <Card key={key}><CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-medium">{label(key)}</CardTitle><Icon className="size-4 text-muted-foreground" /></CardHeader><CardContent className="text-2xl font-semibold">{formatValue(item)}</CardContent></Card> })}</div>
}

function RecordTable({ rows, empty, actionLabel, onAction }: { rows: JsonRecord[]; empty: string; actionLabel?: string; onAction?: (row: JsonRecord) => void }) {
  const columns = Array.from(new Set(rows.flatMap(row => Object.keys(row)))).slice(0, 7)
  return <div className="overflow-x-auto rounded-md border"><Table><TableHeader><TableRow>{columns.map(column => <TableHead key={column}>{label(column)}</TableHead>)}{actionLabel ? <TableHead>操作</TableHead> : null}</TableRow></TableHeader><TableBody>{rows.map((row, index) => <TableRow key={String(row.id ?? index)}>{columns.map(column => <TableCell key={column} className="max-w-64 truncate">{column === 'status' || column === 'level' ? <Badge variant="outline">{formatValue(row[column])}</Badge> : formatValue(row[column])}</TableCell>)}{actionLabel ? <TableCell><Button variant="ghost" size="sm" disabled={numericId(row) === undefined} onClick={() => onAction?.(row)}>{actionLabel}</Button></TableCell> : null}</TableRow>)}{rows.length === 0 ? <TableRow><TableCell colSpan={Math.max(columns.length + (actionLabel ? 1 : 0), 1)} className="py-12 text-center text-muted-foreground">{empty}</TableCell></TableRow> : null}</TableBody></Table></div>
}

function normalizeRecords(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.filter(item => item && typeof item === 'object') as JsonRecord[]
  const record = asRecord(value)
  for (const key of ['items', 'list', 'data', 'rows']) {
    if (Array.isArray(record[key])) return record[key] as JsonRecord[]
  }
  return []
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function numericId(row: JsonRecord): number | undefined {
  const value = Number(row.id)
  return Number.isInteger(value) ? value : undefined
}

function label(value: string): string {
  return value.replaceAll('_', ' ')
}

function formatValue(value: unknown): string {
  if (value == null || value === '') return '-'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
