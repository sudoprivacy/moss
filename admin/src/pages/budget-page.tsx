'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import {
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from 'recharts'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { getDepartments, getUsers } from '@/lib/api/auth'
import { hasScope } from '@/lib/api/client'
import { getBudgetStats } from '@/lib/api/sessions'
import { useAuth } from '@/lib/hooks/use-auth'
import type { AuthDepartment, AuthUser, BudgetAgentStats, BudgetStatsResponse } from '@/lib/api/types'

type BudgetDisplayAgent = BudgetAgentStats & {
  chartKey: string
  label: string
}
import {
  Coins,
  RefreshCw,
  Search,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react'
import { toast } from 'sonner'

type Granularity = 'day' | 'week' | 'month'
type ViewMode = 'user' | 'department' | 'agent'

type BudgetDisplayDept = {
  departmentId: string | null
  departmentName: string
  chartKey: string
  label: string
  userCount: number
  sessionCount: number
  lastActiveAt: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  totalTokens: number
  costUSD: number
}

type BudgetDisplayUser = BudgetStatsResponse['users'][number] & {
  chartKey: string
  label: string
}

type BudgetChartRow = {
  label: string
  rangeLabel: string
  totalTokens: number
} & Record<string, number | string>

const GRANULARITY_OPTIONS: Array<{ value: Granularity; label: string }> = [
  { value: 'day', label: '按日' },
  { value: 'week', label: '按周' },
  { value: 'month', label: '按月' },
]

const CHART_COLORS = [
  '#2563eb',
  '#0f766e',
  '#ea580c',
  '#7c3aed',
  '#dc2626',
  '#0891b2',
  '#65a30d',
  '#c2410c',
  '#be123c',
  '#4f46e5',
  '#0f766e',
  '#a16207',
]

const numberFormatter = new Intl.NumberFormat('zh-CN')
const compactNumberFormatter = new Intl.NumberFormat('zh-CN', {
  notation: 'compact',
  maximumFractionDigits: 1,
})
const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

function formatTokens(value: number): string {
  return numberFormatter.format(Math.round(value))
}

function formatCompactTokens(value: number): string {
  if (value === 0) {
    return '0'
  }
  return compactNumberFormatter.format(Math.round(value))
}

function formatCostUSD(value: number): string {
  if (value === 0) {
    return usdFormatter.format(0)
  }
  if (value < 0.01) {
    return `$${value.toFixed(4)}`
  }
  return usdFormatter.format(value)
}

function formatTimestamp(value: number | null): string {
  if (!value) {
    return '-'
  }
  return format(new Date(value), 'yyyy-MM-dd HH:mm')
}

function formatBucketLabel(start: number, granularity: Granularity): string {
  switch (granularity) {
    case 'day':
      return format(new Date(start), 'MM-dd')
    case 'week':
      return format(new Date(start), 'MM-dd')
    case 'month':
      return format(new Date(start), 'yyyy-MM')
  }
}

function formatBucketRange(
  start: number,
  end: number,
  granularity: Granularity,
): string {
  switch (granularity) {
    case 'day':
      return format(new Date(start), 'yyyy-MM-dd')
    case 'week':
      return `${format(new Date(start), 'yyyy-MM-dd')} 至 ${format(new Date(end - 1), 'yyyy-MM-dd')}`
    case 'month':
      return format(new Date(start), 'yyyy-MM')
  }
}

function BudgetSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[...Array(4)].map((_, index) => (
          <Card key={index}>
            <CardHeader>
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-28" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-4 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[360px] w-full" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-36" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-96 w-full" />
        </CardContent>
      </Card>
    </div>
  )
}

function StatCard({
  title,
  value,
  description,
  icon: Icon,
}: {
  title: string
  value: string
  description: string
  icon: typeof Coins
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {title}
          </CardTitle>
          <div className="text-2xl font-semibold tracking-tight">{value}</div>
        </div>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  )
}

export default function BudgetPage() {
  const { scopes } = useAuth()
  const [budgetStats, setBudgetStats] = useState<BudgetStatsResponse | null>(null)
  const [users, setUsers] = useState<AuthUser[]>([])
  const [departments, setDepartments] = useState<AuthDepartment[]>([])
  const [granularity, setGranularity] = useState<Granularity>('day')
  const [searchQuery, setSearchQuery] = useState('')
  const [viewMode, setViewMode] = useState<ViewMode>('user')
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const canListUsers = hasScope(scopes, 'admin:users')

  const fetchData = useCallback(async () => {
    try {
      const [budgetRes, usersRes, deptsRes] = await Promise.all([
        getBudgetStats(),
        canListUsers ? getUsers() : Promise.resolve(null),
        canListUsers ? getDepartments() : Promise.resolve(null),
      ])
      setBudgetStats(budgetRes)
      setUsers(usersRes?.users ?? [])
      setDepartments(deptsRes?.departments ?? [])
    } catch (error) {
      console.error('Failed to fetch budget stats:', error)
      toast.error('获取预算统计失败')
    } finally {
      setIsLoading(false)
      setIsRefreshing(false)
    }
  }, [canListUsers])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const userNameMap = useMemo(
    () => new Map(users.map(user => [user.id, user.name])),
    [users],
  )

  const displayUsers = useMemo<BudgetDisplayUser[]>(() => {
    if (!budgetStats) {
      return []
    }

    const keyword = searchQuery.trim().toLowerCase()
    return budgetStats.users
      .filter(user => {
        if (!keyword) {
          return true
        }
        const label = userNameMap.get(user.userId) || user.userId
        return (
          label.toLowerCase().includes(keyword) ||
          user.userId.toLowerCase().includes(keyword)
        )
      })
      .map((user, index) => ({
        ...user,
        chartKey: `user_${index}`,
        label: userNameMap.get(user.userId) || user.userId.slice(0, 8),
      }))
  }, [budgetStats, searchQuery, userNameMap])

  const userDeptMap = useMemo(
    () => new Map(users.map((u) => [u.id, u.departmentId ?? null])),
    [users],
  )

  const allDepts = useMemo<BudgetDisplayDept[]>(() => {
    if (!budgetStats) return []
    const deptMap = new Map<string | null, BudgetDisplayDept>()

    for (const userStat of budgetStats.users) {
      const deptId = userDeptMap.get(userStat.userId) ?? null
      const dept = departments.find((d) => d.id === deptId) ?? null
      const deptName = dept?.name ?? '未分配部门'

      if (!deptMap.has(deptId)) {
        deptMap.set(deptId, {
          departmentId: deptId,
          departmentName: deptName,
          chartKey: '',
          label: deptName,
          userCount: 0,
          sessionCount: 0,
          lastActiveAt: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalTokens: 0,
          costUSD: 0,
        })
      }

      const entry = deptMap.get(deptId)!
      entry.userCount += 1
      entry.sessionCount += userStat.sessionCount
      entry.lastActiveAt = Math.max(entry.lastActiveAt, userStat.lastActiveAt)
      entry.inputTokens += userStat.inputTokens
      entry.outputTokens += userStat.outputTokens
      entry.cacheReadInputTokens += userStat.cacheReadInputTokens
      entry.cacheCreationInputTokens += userStat.cacheCreationInputTokens
      entry.totalTokens += userStat.totalTokens
      entry.costUSD += userStat.costUSD
    }

    return Array.from(deptMap.values())
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .map((d, index) => ({ ...d, chartKey: `dept_${index}` }))
  }, [budgetStats, userDeptMap, departments])

  const displayDepts = useMemo<BudgetDisplayDept[]>(() => {
    const keyword = searchQuery.trim().toLowerCase()
    if (!keyword) return allDepts
    return allDepts.filter((d) => d.departmentName.toLowerCase().includes(keyword))
  }, [allDepts, searchQuery])

  const allAgents = useMemo<BudgetDisplayAgent[]>(() => {
    if (!budgetStats) return []
    return budgetStats.agents.map((a, index) => ({
      ...a,
      chartKey: `agent_${index}`,
      label: a.assistantName,
    }))
  }, [budgetStats])

  const displayAgents = useMemo<BudgetDisplayAgent[]>(() => {
    const keyword = searchQuery.trim().toLowerCase()
    if (!keyword) return allAgents
    return allAgents.filter((a) => a.assistantName.toLowerCase().includes(keyword))
  }, [allAgents, searchQuery])

  const chartConfig = useMemo(() => {
    return Object.fromEntries(
      displayUsers.map((user, index) => [
        user.chartKey,
        { label: user.label, color: CHART_COLORS[index % CHART_COLORS.length] },
      ]),
    )
  }, [displayUsers])

  const chartData = useMemo<BudgetChartRow[]>(() => {
    if (!budgetStats) return []
    return budgetStats.trends[granularity].map(bucket => {
      const row: BudgetChartRow = {
        label: formatBucketLabel(bucket.start, granularity),
        rangeLabel: formatBucketRange(bucket.start, bucket.end, granularity),
        totalTokens: bucket.totalTokens,
      }
      const usageByUser = new Map(bucket.users.map(u => [u.userId, u.totalTokens]))
      for (const user of displayUsers) {
        row[user.chartKey] = usageByUser.get(user.userId) ?? 0
      }
      return row
    })
  }, [budgetStats, displayUsers, granularity])

  const deptChartConfig = useMemo(() => {
    return Object.fromEntries(
      allDepts.map((dept, index) => [
        dept.chartKey,
        { label: dept.label, color: CHART_COLORS[index % CHART_COLORS.length] },
      ]),
    )
  }, [allDepts])

  const deptChartData = useMemo<BudgetChartRow[]>(() => {
    if (!budgetStats) return []
    return budgetStats.trends[granularity].map(bucket => {
      const row: BudgetChartRow = {
        label: formatBucketLabel(bucket.start, granularity),
        rangeLabel: formatBucketRange(bucket.start, bucket.end, granularity),
        totalTokens: bucket.totalTokens,
      }
      // group bucket users by dept
      const deptTotals = new Map<string | null, number>()
      for (const bucketUser of bucket.users) {
        const deptId = userDeptMap.get(bucketUser.userId) ?? null
        deptTotals.set(deptId, (deptTotals.get(deptId) ?? 0) + bucketUser.totalTokens)
      }
      for (const dept of allDepts) {
        row[dept.chartKey] = deptTotals.get(dept.departmentId) ?? 0
      }
      return row
    })
  }, [budgetStats, allDepts, granularity, userDeptMap])

  const agentChartConfig = useMemo(() => {
    return Object.fromEntries(
      allAgents.map((agent, index) => [
        agent.chartKey,
        { label: agent.label, color: CHART_COLORS[index % CHART_COLORS.length] },
      ]),
    )
  }, [allAgents])

  const agentChartData = useMemo<BudgetChartRow[]>(() => {
    if (!budgetStats) return []
    return budgetStats.trends[granularity].map(bucket => {
      const row: BudgetChartRow = {
        label: formatBucketLabel(bucket.start, granularity),
        rangeLabel: formatBucketRange(bucket.start, bucket.end, granularity),
        totalTokens: bucket.totalTokens,
      }
      const usageByAgent = new Map(bucket.agents.map(a => [a.assistantName, a.totalTokens]))
      for (const agent of allAgents) {
        row[agent.chartKey] = usageByAgent.get(agent.assistantName) ?? 0
      }
      return row
    })
  }, [budgetStats, allAgents, granularity])

  const handleRefresh = () => {
    setIsRefreshing(true)
    fetchData()
  }

  if (isLoading) {
    return (
      <DashboardLayout
        title="预算管理"
        description="按用户查看 Token 消耗与使用趋势"
      >
        <BudgetSkeleton />
      </DashboardLayout>
    )
  }

  const VIEW_MODES: Array<{ value: ViewMode; label: string }> = [
    { value: 'user', label: '按用户' },
    { value: 'department', label: '按部门' },
    { value: 'agent', label: '按智能体' },
  ]

  return (
    <DashboardLayout
      title="预算管理"
      description="按用户分组展示 Token 消耗，并支持按日、周、月查看趋势变化"
    >
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatCard
            title="总 Token 消耗"
            value={formatTokens(budgetStats?.summary.totalTokens ?? 0)}
            description="当前统计范围内全部用户累计 Token"
            icon={Coins}
          />
          <StatCard
            title="累计费用"
            value={formatCostUSD(budgetStats?.summary.costUSD ?? 0)}
            description="根据模型计费口径估算"
            icon={Wallet}
          />
          <StatCard
            title="覆盖用户数"
            value={String(budgetStats?.summary.userCount ?? 0)}
            description="当前预算统计中涉及的用户"
            icon={Users}
          />
          <StatCard
            title="会话数"
            value={String(budgetStats?.summary.sessionCount ?? 0)}
            description={`最近活跃：${formatTimestamp(budgetStats?.summary.lastActivityAt ?? null)}`}
            icon={TrendingUp}
          />
        </div>

        <div className="flex items-center gap-2">
          <div className="flex rounded-md border">
            {VIEW_MODES.map((mode) => (
              <Button
                key={mode.value}
                variant={viewMode === mode.value ? 'default' : 'ghost'}
                size="sm"
                className="rounded-none first:rounded-l-md last:rounded-r-md"
                onClick={() => { setViewMode(mode.value); setSearchQuery('') }}
              >
                {mode.label}
              </Button>
            ))}
          </div>
        </div>

        {viewMode === 'user' && (<>
        <Card>
          <CardHeader className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="space-y-1">
              <CardTitle>用量趋势图</CardTitle>
              <CardDescription>
                展示当前筛选用户在不同时间粒度下的 Token 用量变化
              </CardDescription>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative min-w-[220px]">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="搜索用户名称或 ID"
                  className="pl-9"
                />
              </div>
              <div className="flex rounded-md border">
                {GRANULARITY_OPTIONS.map(option => (
                  <Button
                    key={option.value}
                    variant={granularity === option.value ? 'default' : 'ghost'}
                    size="sm"
                    className="rounded-none first:rounded-l-md last:rounded-r-md"
                    onClick={() => setGranularity(option.value)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={isRefreshing}
              >
                <RefreshCw
                  className={`mr-2 size-4 ${isRefreshing ? 'animate-spin' : ''}`}
                />
                刷新
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">筛选后用户数：{displayUsers.length}</Badge>
              <Badge variant="outline">
                粒度：{GRANULARITY_OPTIONS.find(option => option.value === granularity)?.label}
              </Badge>
            </div>

            {displayUsers.length > 0 ? (
              <ChartContainer
                config={chartConfig}
                className="h-[360px] w-full aspect-auto"
              >
                <LineChart data={chartData} margin={{ left: 12, right: 12 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={false}
                    minTickGap={24}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={72}
                    tickFormatter={value => formatCompactTokens(Number(value))}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        indicator="line"
                        labelFormatter={(_, payload) => {
                          const data = payload?.[0]?.payload as
                            | BudgetChartRow
                            | undefined
                          return data?.rangeLabel ?? ''
                        }}
                      />
                    }
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                  {displayUsers.map(user => (
                    <Line
                      key={user.chartKey}
                      dataKey={user.chartKey}
                      type="monotone"
                      stroke={`var(--color-${user.chartKey})`}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  ))}
                </LineChart>
              </ChartContainer>
            ) : (
              <div className="flex h-[360px] items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
                当前筛选条件下暂无用户用量数据
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>用户 Token 消耗明细</CardTitle>
            <CardDescription>
              按用户分组统计当前已归档会话中的 Token 使用情况
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>用户</TableHead>
                    <TableHead className="text-right">总 Token</TableHead>
                    <TableHead className="text-right">输入</TableHead>
                    <TableHead className="text-right">输出</TableHead>
                    <TableHead className="text-right">缓存命中</TableHead>
                    <TableHead className="text-right">缓存写入</TableHead>
                    <TableHead className="text-right">费用</TableHead>
                    <TableHead className="text-right">会话数</TableHead>
                    <TableHead className="text-right">最近活跃</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {displayUsers.map(user => (
                    <TableRow key={user.userId}>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <span className="font-medium">{user.label}</span>
                          <span className="text-xs text-muted-foreground font-mono">
                            {user.userId}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatTokens(user.totalTokens)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatTokens(user.inputTokens)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatTokens(user.outputTokens)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatTokens(user.cacheReadInputTokens)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatTokens(user.cacheCreationInputTokens)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCostUSD(user.costUSD)}
                      </TableCell>
                      <TableCell className="text-right">{user.sessionCount}</TableCell>
                      <TableCell className="text-right">
                        {formatTimestamp(user.lastActiveAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {displayUsers.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={9}
                        className="py-10 text-center text-muted-foreground"
                      >
                        当前没有匹配的用户预算数据
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
        </>)}

        {viewMode === 'department' && (<>
        <Card>
          <CardHeader className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="space-y-1">
              <CardTitle>用量趋势图</CardTitle>
              <CardDescription>
                展示当前筛选部门在不同时间粒度下的 Token 用量变化
              </CardDescription>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative min-w-[220px]">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索部门名称"
                  className="pl-9"
                />
              </div>
              <div className="flex rounded-md border">
                {GRANULARITY_OPTIONS.map(option => (
                  <Button
                    key={option.value}
                    variant={granularity === option.value ? 'default' : 'ghost'}
                    size="sm"
                    className="rounded-none first:rounded-l-md last:rounded-r-md"
                    onClick={() => setGranularity(option.value)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
              <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing}>
                <RefreshCw className={`mr-2 size-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                刷新
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">筛选后部门数：{displayDepts.length}</Badge>
              <Badge variant="outline">粒度：{GRANULARITY_OPTIONS.find(o => o.value === granularity)?.label}</Badge>
            </div>
            {allDepts.length > 0 ? (
              <ChartContainer config={deptChartConfig} className="h-[360px] w-full aspect-auto">
                <LineChart data={deptChartData} margin={{ left: 12, right: 12 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} />
                  <YAxis tickLine={false} axisLine={false} width={72} tickFormatter={value => formatCompactTokens(Number(value))} />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        indicator="line"
                        labelFormatter={(_, payload) => {
                          const data = payload?.[0]?.payload as BudgetChartRow | undefined
                          return data?.rangeLabel ?? ''
                        }}
                      />
                    }
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                  {allDepts.map(dept => (
                    <Line
                      key={dept.chartKey}
                      dataKey={dept.chartKey}
                      type="monotone"
                      stroke={`var(--color-${dept.chartKey})`}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  ))}
                </LineChart>
              </ChartContainer>
            ) : (
              <div className="flex h-[360px] items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
                当前筛选条件下暂无部门用量数据
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>部门 Token 消耗明细</CardTitle>
            <CardDescription>按部门汇总统计当前已归档会话中的 Token 使用情况</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>部门</TableHead>
                    <TableHead className="text-right">总 Token</TableHead>
                    <TableHead className="text-right">输入</TableHead>
                    <TableHead className="text-right">输出</TableHead>
                    <TableHead className="text-right">缓存命中</TableHead>
                    <TableHead className="text-right">缓存写入</TableHead>
                    <TableHead className="text-right">费用</TableHead>
                    <TableHead className="text-right">用户数</TableHead>
                    <TableHead className="text-right">会话数</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {displayDepts.map((dept) => (
                    <TableRow key={dept.departmentId ?? '__none__'}>
                      <TableCell className="font-medium">{dept.departmentName}</TableCell>
                      <TableCell className="text-right font-medium">{formatTokens(dept.totalTokens)}</TableCell>
                      <TableCell className="text-right">{formatTokens(dept.inputTokens)}</TableCell>
                      <TableCell className="text-right">{formatTokens(dept.outputTokens)}</TableCell>
                      <TableCell className="text-right">{formatTokens(dept.cacheReadInputTokens)}</TableCell>
                      <TableCell className="text-right">{formatTokens(dept.cacheCreationInputTokens)}</TableCell>
                      <TableCell className="text-right">{formatCostUSD(dept.costUSD)}</TableCell>
                      <TableCell className="text-right">{dept.userCount}</TableCell>
                      <TableCell className="text-right">{dept.sessionCount}</TableCell>
                    </TableRow>
                  ))}
                  {displayDepts.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                        当前没有匹配的部门预算数据
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
        </>)}

        {viewMode === 'agent' && (<>
        <Card>
          <CardHeader className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="space-y-1">
              <CardTitle>用量趋势图</CardTitle>
              <CardDescription>
                展示当前筛选智能体在不同时间粒度下的 Token 用量变化
              </CardDescription>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative min-w-[220px]">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索智能体名称"
                  className="pl-9"
                />
              </div>
              <div className="flex rounded-md border">
                {GRANULARITY_OPTIONS.map(option => (
                  <Button
                    key={option.value}
                    variant={granularity === option.value ? 'default' : 'ghost'}
                    size="sm"
                    className="rounded-none first:rounded-l-md last:rounded-r-md"
                    onClick={() => setGranularity(option.value)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
              <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing}>
                <RefreshCw className={`mr-2 size-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                刷新
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">筛选后智能体数：{displayAgents.length}</Badge>
              <Badge variant="outline">粒度：{GRANULARITY_OPTIONS.find(o => o.value === granularity)?.label}</Badge>
            </div>
            {allAgents.length > 0 ? (
              <ChartContainer config={agentChartConfig} className="h-[360px] w-full aspect-auto">
                <LineChart data={agentChartData} margin={{ left: 12, right: 12 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} />
                  <YAxis tickLine={false} axisLine={false} width={72} tickFormatter={value => formatCompactTokens(Number(value))} />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        indicator="line"
                        labelFormatter={(_, payload) => {
                          const data = payload?.[0]?.payload as BudgetChartRow | undefined
                          return data?.rangeLabel ?? ''
                        }}
                      />
                    }
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                  {allAgents.map(agent => (
                    <Line
                      key={agent.chartKey}
                      dataKey={agent.chartKey}
                      type="monotone"
                      stroke={`var(--color-${agent.chartKey})`}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  ))}
                </LineChart>
              </ChartContainer>
            ) : (
              <div className="flex h-[360px] items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
                当前筛选条件下暂无智能体用量数据
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>智能体 Token 消耗明细</CardTitle>
            <CardDescription>按智能体汇总统计当前已归档会话中的 Token 使用情况</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>智能体</TableHead>
                    <TableHead className="text-right">总 Token</TableHead>
                    <TableHead className="text-right">输入</TableHead>
                    <TableHead className="text-right">输出</TableHead>
                    <TableHead className="text-right">缓存命中</TableHead>
                    <TableHead className="text-right">缓存写入</TableHead>
                    <TableHead className="text-right">费用</TableHead>
                    <TableHead className="text-right">会话数</TableHead>
                    <TableHead className="text-right">最近活跃</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {displayAgents.map((agent) => (
                    <TableRow key={agent.assistantName}>
                      <TableCell className="font-medium">{agent.assistantName}</TableCell>
                      <TableCell className="text-right font-medium">{formatTokens(agent.totalTokens)}</TableCell>
                      <TableCell className="text-right">{formatTokens(agent.inputTokens)}</TableCell>
                      <TableCell className="text-right">{formatTokens(agent.outputTokens)}</TableCell>
                      <TableCell className="text-right">{formatTokens(agent.cacheReadInputTokens)}</TableCell>
                      <TableCell className="text-right">{formatTokens(agent.cacheCreationInputTokens)}</TableCell>
                      <TableCell className="text-right">{formatCostUSD(agent.costUSD)}</TableCell>
                      <TableCell className="text-right">{agent.sessionCount}</TableCell>
                      <TableCell className="text-right">{formatTimestamp(agent.lastActiveAt)}</TableCell>
                    </TableRow>
                  ))}
                  {displayAgents.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                        当前没有匹配的智能体预算数据
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
        </>)}
      </div>
    </DashboardLayout>
  )
}
