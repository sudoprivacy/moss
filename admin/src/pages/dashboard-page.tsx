'use client'

import { useEffect, useState, useCallback, type ComponentType, type ReactNode } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ChartContainer, ChartTooltipContent } from '@/components/ui/chart'
import { getDashboardStats, getSessions } from '@/lib/api/sessions'
import { getUsers, getDepartments } from '@/lib/api/auth'
import { ApiRequestError, hasAnyScope, hasScope } from '@/lib/api/client'
import { useAuth } from '@/lib/hooks/use-auth'
import { Users, MessageSquare, Coins, RefreshCw, Calendar, TrendingUp, Bot, Building2 } from 'lucide-react'
import {
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
} from 'recharts'
import ReactECharts from 'echarts-for-react'
import type {
  Session,
  AuthUser,
  AuthDepartment,
  DashboardStatsResponse,
} from '@/lib/api/types'
import { Link } from 'react-router-dom'
import { format, subDays, startOfDay, endOfDay, isWithinInterval } from 'date-fns'

const chartConfig = {
  sessions: { label: '会话数', color: 'hsl(var(--chart-1))' },
  tokens: { label: 'Token消耗', color: 'hsl(var(--chart-2))' },
}

const STATUS_COLORS = {
  active: '#22c55e',
  creating: '#f59e0b',
  detached: '#6366f1',
  ended: '#94a3b8',
  terminated: '#ef4444',
  failed: '#ef4444',
  lost: '#f97316',
}

const STATUS_LABELS: Record<string, string> = {
  active: '进行中',
  creating: '创建中',
  detached: '已断开',
  ended: '已结束',
  terminated: '已终止',
  failed: '失败',
  lost: '丢失',
}

function StatCard({
  title,
  value,
  icon: Icon,
  description,
  trend,
}: {
  title: string
  value: string | number
  icon: ComponentType<{ className?: string }>
  description?: ReactNode
  trend?: number
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {description && <div className="mt-1 text-xs text-muted-foreground">{description}</div>}
        {trend !== undefined && trend !== 0 && (
          <div className={`mt-1 text-xs ${trend > 0 ? 'text-green-500' : 'text-red-500'}`}>
            {trend > 0 ? '+' : ''}{trend}%
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function SkeletonCard() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-4" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-16 mb-2" />
        <Skeleton className="h-3 w-20" />
      </CardContent>
    </Card>
  )
}

const DATE_RANGES = [
  { label: '今天', days: 0 },
  { label: '近7天', days: 7 },
  { label: '近30天', days: 30 },
  { label: '全部', days: -1 },
]

export default function DashboardPage() {
  const { scopes } = useAuth()
  const [sessions, setSessions] = useState<Session[]>([])
  const [users, setUsers] = useState<AuthUser[]>([])
  const [departments, setDepartments] = useState<AuthDepartment[]>([])
  const [dashboardStats, setDashboardStats] = useState<DashboardStatsResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [dateRange, setDateRange] = useState(7)
  const canListSessions = hasAnyScope(scopes, ['sessions:list', 'sessions:list:any'])
  const canListUsers = hasScope(scopes, 'admin:users')

  const getStatsQuery = useCallback((days: number) => {
    if (days === -1) {
      return undefined
    }

    const now = new Date()
    return {
      from: subDays(startOfDay(now), days).getTime(),
      to: endOfDay(now).getTime(),
    }
  }, [])

  const fetchData = useCallback(async () => {
    try {
      const [sessionsRes, usersRes, departmentsRes, statsRes] = await Promise.all([
        canListSessions ? getSessions() : Promise.resolve(null),
        canListUsers ? getUsers() : Promise.resolve(null),
        canListUsers ? getDepartments() : Promise.resolve(null),
        canListSessions ? getDashboardStats(getStatsQuery(dateRange)) : Promise.resolve(null),
      ])
      setSessions(sessionsRes?.sessions ?? [])
      setUsers(usersRes?.users ?? [])
      setDepartments(departmentsRes?.departments ?? [])
      setDashboardStats(statsRes)
    } catch (error) {
      if (!(error instanceof ApiRequestError && error.status === 401)) {
        console.error('Failed to fetch data:', error)
      }
    } finally {
      setIsLoading(false)
      setIsRefreshing(false)
    }
  }, [canListSessions, canListUsers, dateRange, getStatsQuery])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Auto refresh every 30 seconds for active sessions
  useEffect(() => {
    const interval = setInterval(() => {
      setIsRefreshing(true)
      fetchData()
    }, 30000)
    return () => clearInterval(interval)
  }, [fetchData])

  const handleRefresh = () => {
    setIsRefreshing(true)
    fetchData()
  }

  // Filter sessions by date range
  const filteredSessions = sessions.filter((session) => {
    if (dateRange === -1) return true
    const sessionDate = new Date(session.createdAt)
    const now = new Date()
    const start = subDays(startOfDay(now), dateRange)
    return isWithinInterval(sessionDate, { start, end: endOfDay(now) })
  })

  // Stats
  const totalSessions = filteredSessions.length
  const activeSessions = filteredSessions.filter((s) =>
    ['creating', 'active', 'detached'].includes(s.status)
  ).length
  const assistantStats = dashboardStats?.assistants ?? []
  // Count total sessions with assistantName and active sessions among them
  const totalAssistantSessions = assistantStats.reduce((sum, a) => sum + a.totalSessions, 0)
  const activeAssistantSessions = assistantStats.reduce((sum, a) => sum + a.activeSessions, 0)
  const totalUsers = users.length
  const activeUsers = new Set(filteredSessions.filter(s => ['creating', 'active', 'detached'].includes(s.status)).map(s => s.userId)).size
  const tokenUsage = dashboardStats?.usage ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 0,
  }

  // Sessions by date
  const sessionsByDate = filteredSessions.reduce((acc, session) => {
    const date = format(new Date(session.createdAt), 'MM-dd')
    if (!acc[date]) {
      acc[date] = { date, sessions: 0 }
    }
    acc[date].sessions++
    return acc
  }, {} as Record<string, { date: string; sessions: number }>)
  const chartData = Object.values(sessionsByDate).slice(-14)

  // Sessions by status for pie chart
  const sessionsByStatus = Object.entries(
    filteredSessions.reduce((acc, session) => {
      acc[session.status] = (acc[session.status] || 0) + 1
      return acc
    }, {} as Record<string, number>)
  ).map(([status, count]) => ({
    name: STATUS_LABELS[status] || status,
    value: count,
    status,
    color: STATUS_COLORS[status as keyof typeof STATUS_COLORS] || '#94a3b8',
  }))

  // User ranking
  const userStats = Array.from(
    filteredSessions.reduce((acc, session) => {
      const userId = session.userId
      if (!acc.has(userId)) {
        acc.set(userId, { userId, sessions: 0, active: 0 })
      }
      const stats = acc.get(userId)!
      stats.sessions++
      if (session.status === 'active') stats.active++
      return acc
    }, new Map<string, { userId: string; sessions: number; active: number }>())
  )
    .map(([, stats]) => ({
      ...stats,
      name: users.find((u) => u.id === stats.userId)?.name || stats.userId.slice(0, 8),
    }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 5)

  // Department ranking
  const departmentStats = Array.from(
    filteredSessions.reduce((acc, session) => {
      const user = users.find((u) => u.id === session.userId)
      const deptId = user?.departmentId || 'unknown'
      if (!acc.has(deptId)) {
        acc.set(deptId, { departmentId: deptId, sessions: 0, users: new Set() })
      }
      const stats = acc.get(deptId)!
      stats.sessions++
      stats.users.add(session.userId)
      return acc
    }, new Map<string, { departmentId: string; sessions: number; users: Set<string> }>())
  )
    .map(([, stats]) => ({
      name: departments.find((d) => d.id === stats.departmentId)?.name || (stats.departmentId === 'unknown' ? '未分配部门' : stats.departmentId.slice(0, 8)),
      sessions: stats.sessions,
      userCount: stats.users.size,
    }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 10)

  const getUserName = (userId: string) => {
    const u = users.find((us) => us.id === userId)
    return u?.name || userId.slice(0, 8)
  }

  if (isLoading) {
    return (
      <DashboardLayout title="数据看板">
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {[...Array(4)].map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Card><CardContent className="p-6"><Skeleton className="h-[300px]" /></CardContent></Card>
            <Card><CardContent className="p-6"><Skeleton className="h-[300px]" /></CardContent></Card>
          </div>
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout title="数据看板">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            {DATE_RANGES.map((range) => (
              <Button
                key={range.days}
                variant={dateRange === range.days ? 'default' : 'outline'}
                size="sm"
                onClick={() => setDateRange(range.days)}
              >
                <Calendar className="size-3 mr-1" />
                {range.label}
              </Button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing}>
            <RefreshCw className={`size-3 mr-1 ${isRefreshing ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        </div>

        {/* Stats Cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title="用户分身"
            value={`${activeUsers}/${totalUsers}`}
            icon={Users}
            description="活跃 / 总数"
          />
          <StatCard
            title="总 Token 消耗"
            value={tokenUsage.totalTokens.toLocaleString()}
            icon={Coins}
            description={
              <div className="space-y-1">
                <p>输入 {tokenUsage.inputTokens.toLocaleString()} · 输出 {tokenUsage.outputTokens.toLocaleString()}</p>
                <p>
                  缓存读 {tokenUsage.cacheReadInputTokens.toLocaleString()} · 写 {tokenUsage.cacheCreationInputTokens.toLocaleString()}
                </p>
              </div>
            }
          />
          <StatCard title="总会话数" value={totalSessions} icon={MessageSquare} description={`活跃 ${activeSessions}`} />
          <StatCard title="智能体会话" value={`${activeAssistantSessions}/${totalAssistantSessions}`} icon={Bot} description="活跃 / 总数" />
        </div>

        {/* Charts */}
        <div className="grid gap-4 md:grid-cols-3">
          {/* Session Trend */}
          <Card className="md:col-span-2">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="size-4" />
                会话趋势
              </CardTitle>
            </CardHeader>
            <CardContent>
              {chartData.length > 0 ? (
                <ChartContainer config={chartConfig} className="h-[250px] w-full">
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <ChartTooltipContent />
                    <Line
                      type="monotone"
                      dataKey="sessions"
                      stroke="var(--color-sessions)"
                      strokeWidth={2}
                      dot={{ fill: 'var(--color-sessions)', strokeWidth: 0 }}
                    />
                  </LineChart>
                </ChartContainer>
              ) : (
                <div className="h-[250px] flex items-center justify-center text-muted-foreground border rounded-lg">
                  <div className="text-center">
                    <MessageSquare className="size-8 mx-auto mb-2 opacity-50" />
                    <p>暂无数据</p>
                    <p className="text-xs mt-1">在选中的时间范围内没有会话记录</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Session Status Distribution */}
          <Card>
            <CardHeader>
              <CardTitle>状态分布</CardTitle>
            </CardHeader>
            <CardContent>
              {sessionsByStatus.length > 0 ? (
                <ChartContainer config={chartConfig} className="h-[250px]">
                  <PieChart>
                    <Pie
                      data={sessionsByStatus}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={80}
                    >
                      {sessionsByStatus.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <ChartTooltipContent />
                    <Legend />
                  </PieChart>
                </ChartContainer>
              ) : (
                <div className="h-[250px] flex items-center justify-center text-muted-foreground">
                  暂无数据
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* User Ranking */}
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="size-4" />
                用户排行
              </CardTitle>
            </CardHeader>
            <CardContent>
              {userStats.length > 0 ? (
                <div className="space-y-4">
                  {userStats.map((stat, index) => (
                    <div key={stat.userId} className="flex items-center gap-4">
                      <div className="flex items-center justify-center size-8 rounded-full bg-primary/10 text-primary font-medium">
                        {index + 1}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{stat.name}</span>
                          <div className="flex gap-4 text-sm text-muted-foreground">
                            <span>{stat.sessions} 会话</span>
                            <span className="text-green-500">{stat.active} 活跃</span>
                          </div>
                        </div>
                        <div className="mt-1 h-2 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-primary rounded-full transition-all"
                            style={{ width: `${(stat.sessions / userStats[0].sessions) * 100}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-8 text-center text-muted-foreground">
                  暂无用户数据
                </div>
              )}
            </CardContent>
          </Card>

          {/* Department Ranking */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Building2 className="size-4" />
                各部门用量排行
              </CardTitle>
            </CardHeader>
            <CardContent>
              {departmentStats.length > 0 ? (
                <ReactECharts
                  style={{ height: 300 }}
                  option={{
                    tooltip: {
                      trigger: 'axis',
                      axisPointer: { type: 'shadow' }
                    },
                    grid: {
                      left: 40,
                      right: 20,
                      top: 20,
                      bottom: 60
                    },
                    xAxis: {
                      type: 'category',
                      data: departmentStats.map(d => d.name),
                      axisLine: { show: false },
                      axisTick: { show: false },
                      axisLabel: { interval: 0, rotate: 30 }
                    },
                    yAxis: {
                      type: 'value',
                      axisLine: { show: false },
                      axisTick: { show: false },
                      splitLine: { lineStyle: { type: 'dashed' } }
                    },
                    series: [{
                      type: 'bar',
                      data: departmentStats.map(d => d.sessions),
                      barMaxWidth: 40,
                      itemStyle: {
                        borderRadius: [4, 4, 0, 0],
                        color: {
                          type: 'linear',
                          x: 0, y: 0, x2: 0, y2: 1,
                          colorStops: [
                            { offset: 0, color: '#83bff6' },
                            { offset: 0.5, color: '#188df0' },
                            { offset: 1, color: '#188df0' }
                          ]
                        }
                      },
                      label: {
                        show: true,
                        position: 'top',
                        formatter: '{c}',
                        color: '#666'
                      }
                    }]
                  }}
                />
              ) : (
                <div className="h-[300px] flex items-center justify-center text-muted-foreground">
                  <div className="text-center">
                    <Building2 className="size-8 mx-auto mb-2 opacity-50" />
                    <p>暂无部门数据</p>
                    <p className="text-xs mt-1">请先创建部门并分配用户</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Assistant Stats */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="size-4" />
              智能体会话统计
            </CardTitle>
          </CardHeader>
          <CardContent>
            {assistantStats.length > 0 ? (
              <ReactECharts
                style={{ height: 300 }}
                option={{
                  tooltip: {
                    trigger: 'axis',
                    axisPointer: { type: 'shadow' }
                  },
                  grid: {
                    left: 40,
                    right: 20,
                    top: 20,
                    bottom: 60
                  },
                  xAxis: {
                    type: 'category',
                    data: assistantStats.map(a => a.displayName),
                    axisLine: { show: false },
                    axisTick: { show: false },
                    axisLabel: { interval: 0, rotate: 30 }
                  },
                  yAxis: {
                    type: 'value',
                    axisLine: { show: false },
                    axisTick: { show: false },
                    splitLine: { lineStyle: { type: 'dashed' } }
                  },
                  series: [{
                    type: 'bar',
                    data: assistantStats.map(a => a.totalSessions),
                    barMaxWidth: 40,
                    itemStyle: {
                      borderRadius: [4, 4, 0, 0],
                      color: {
                        type: 'linear',
                        x: 0, y: 0, x2: 0, y2: 1,
                        colorStops: [
                          { offset: 0, color: '#83bff6' },
                          { offset: 0.5, color: '#188df0' },
                          { offset: 1, color: '#188df0' }
                        ]
                      }
                    },
                    label: {
                      show: true,
                      position: 'top',
                      formatter: '{c}',
                      color: '#666'
                    }
                  }]
                }}
              />
            ) : (
              <div className="h-[300px] flex items-center justify-center text-muted-foreground">
                <div className="text-center">
                  <Bot className="size-8 mx-auto mb-2 opacity-50" />
                  <p>暂无智能体会话数据</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Sessions */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>最近会话</CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/sessions">查看全部</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {filteredSessions.length > 0 ? (
              <div className="space-y-4">
                {filteredSessions
                  .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                  .slice(0, 5)
                  .map((session) => (
                  <div
                    key={session.sessionId}
                    className="flex items-center justify-between py-2 border-b last:border-0"
                  >
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm">{session.sessionId.slice(0, 12)}...</span>
                        <Badge
                          variant="secondary"
                          className="text-xs"
                        >
                          {session.runtime.type}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{getUserName(session.userId)}</span>
                        <span>{format(new Date(session.createdAt), 'MM-dd HH:mm')}</span>
                      </div>
                    </div>
                    <Badge
                      variant={
                        session.status === 'active'
                          ? 'default'
                          : session.status === 'ended'
                          ? 'secondary'
                          : 'outline'
                      }
                    >
                      {STATUS_LABELS[session.status] || session.status}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-muted-foreground">
                <MessageSquare className="size-8 mx-auto mb-2 opacity-50" />
                <p>暂无会话记录</p>
                <p className="text-xs mt-1">创建第一个会话开始使用</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
