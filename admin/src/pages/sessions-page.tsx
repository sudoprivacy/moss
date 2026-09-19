'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import {
  ListEmptyState,
  ListError,
  ListSkeleton,
  ListStatusBadge,
  ListSummary,
  ListSurface,
  ListToolbar,
  type ListStatusTone,
} from '@/components/list-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { getSessions, terminateSession } from '@/lib/api/sessions'
import { getUsers } from '@/lib/api/auth'
import { getInstalledAgents } from '@/lib/api/agent-hub'
import type { InstalledAgentInfo } from '@/lib/api/agent-hub'
import type { Session, AuthUser } from '@/lib/api/types'
import { cn, resolveOwnerName } from '@/lib/utils'
import { Search, ArrowRight, Loader2, MessageSquare, Power, RefreshCw } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { format, subDays, startOfDay, endOfDay, isWithinInterval } from 'date-fns'

const statusConfig: Record<string, { label: string; tone: ListStatusTone }> = {
  active: { label: '进行中', tone: 'positive' },
  creating: { label: '创建中', tone: 'neutral' },
  detached: { label: '已断开', tone: 'neutral' },
  ended: { label: '已结束', tone: 'neutral' },
  terminated: { label: '已终止', tone: 'danger' },
  failed: { label: '失败', tone: 'danger' },
  lost: { label: '丢失', tone: 'danger' },
}

const channelPlatforms: Record<string, string> = {
  telegram: 'Telegram',
  lark: '飞书',
  dingtalk: '钉钉',
  wechat: '微信',
  wecom: '企业微信',
}

const DATE_RANGES = [
  { label: '今天', days: 0 },
  { label: '近7天', days: 7 },
  { label: '近30天', days: 30 },
  { label: '全部', days: -1 },
]

export default function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [users, setUsers] = useState<AuthUser[]>([])
  const [installedAgents, setInstalledAgents] = useState<InstalledAgentInfo[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [userFilter, setUserFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [agentFilter, setAgentFilter] = useState<string>('all')
  const [dateRange, setDateRange] = useState(7)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [terminatingId, setTerminatingId] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoadError(null)
    try {
      const [sessionsRes, agentsRes] = await Promise.all([getSessions(), getInstalledAgents()])
      setSessions(sessionsRes.sessions)
      setInstalledAgents(agentsRes)
      setHasLoaded(true)
      // getUsers requires admin:users scope; non-admin users can still view sessions
      try {
        const usersRes = await getUsers()
        setUsers(usersRes.users)
      } catch {
        // Non-admin users: sessions show userId directly
      }
    } catch (error) {
      console.error('Failed to fetch data:', error)
      setLoadError(error instanceof Error ? error.message : '会话数据暂时不可用，请稍后重试。')
      toast.error('获取会话列表失败')
    } finally {
      setIsLoading(false)
      setIsRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  const handleRefresh = () => {
    setIsRefreshing(true)
    void fetchData()
  }

  const agentsByName = useMemo(
    () => new Map(installedAgents.map(agent => [agent.name, agent])),
    [installedAgents],
  )

  const agentNames = Array.from(new Set([
    ...installedAgents.map((a) => a.name),
    ...sessions.map((s) => s.assistantName ?? null).filter((n): n is string => n !== null),
  ]))

  const filteredSessions = sessions
    .filter((session) => {
      const matchesSearch =
        session.sessionId.toLowerCase().includes(searchQuery.toLowerCase()) ||
        session.userId.toLowerCase().includes(searchQuery.toLowerCase())
      const matchesUser = userFilter === 'all' || session.userId === userFilter
      const matchesStatus = statusFilter === 'all' || session.status === statusFilter
      const matchesAgent = agentFilter === 'all' || session.assistantName === agentFilter

      const sessionDate = new Date(session.createdAt)
      const now = new Date()
      const start = subDays(startOfDay(now), dateRange)
      const matchesDate = dateRange === -1 || isWithinInterval(sessionDate, { start, end: endOfDay(now) })

      return matchesSearch && matchesUser && matchesStatus && matchesDate && matchesAgent
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  const clearFilters = () => {
    setSearchQuery('')
    setUserFilter('all')
    setStatusFilter('all')
    setAgentFilter('all')
    setDateRange(-1)
  }

  const handleTerminate = async (sessionId: string) => {
    if (!confirm('确定要终止这个会话吗？')) return
    setTerminatingId(sessionId)
    try {
      await terminateSession(sessionId)
      toast.success('会话已终止')
      setSessions(previous => previous.map(session =>
        session.sessionId === sessionId
          ? { ...session, status: 'terminated', desiredState: 'terminated' as const }
          : session,
      ))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '终止会话失败')
    } finally {
      setTerminatingId(null)
    }
  }

  const getUserName = (session: Session) =>
    resolveOwnerName(users, session.userId, session.userName)

  return (
    <DashboardLayout title="会话管理" description="查看运行中的会话与历史记录，按用户、智能体和时间筛选。">
      <div className="min-w-0 space-y-4">
        <ListToolbar
          aria-label="会话筛选"
          actions={
            <Button variant="outline" onClick={handleRefresh} disabled={isLoading || isRefreshing}>
              <RefreshCw className={cn('size-3.5', isRefreshing && 'animate-spin motion-reduce:animate-none')} aria-hidden="true" />
              刷新
            </Button>
          }
        >
          <div className="relative w-full sm:min-w-52 sm:max-w-80 sm:flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              aria-label="搜索 Session ID 或用户 ID"
              placeholder="搜索 Session ID 或用户 ID"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={userFilter} onValueChange={setUserFilter}>
            <SelectTrigger aria-label="筛选会话用户" className="min-w-0 flex-1 basis-32 sm:w-36 sm:flex-none sm:basis-auto">
              <SelectValue placeholder="筛选用户" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部用户</SelectItem>
              {users.map(user => <SelectItem key={user.id} value={user.id}>{user.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger aria-label="筛选会话状态" className="min-w-0 flex-1 basis-32 sm:w-32 sm:flex-none sm:basis-auto">
              <SelectValue placeholder="筛选状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              {Object.entries(statusConfig).map(([key, config]) => <SelectItem key={key} value={key}>{config.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={agentFilter} onValueChange={setAgentFilter}>
            <SelectTrigger aria-label="筛选会话智能体" className="min-w-0 flex-1 basis-32 sm:w-40 sm:flex-none sm:basis-auto">
              <SelectValue placeholder="筛选智能体" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部智能体</SelectItem>
              {agentNames.map(name => (
                <SelectItem key={name} value={name}>
                  {agentsByName.get(name)?.displayName || name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ListToolbar>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="group" aria-label="会话创建时间范围" className="inline-flex max-w-full gap-0.5 rounded-md border bg-muted/40 p-0.5">
            {DATE_RANGES.map(range => (
              <Button
                key={range.days}
                variant="ghost"
                size="sm"
                aria-pressed={dateRange === range.days}
                className={cn('h-8 rounded-sm px-3 text-xs text-muted-foreground', dateRange === range.days && 'bg-background text-primary shadow-xs hover:bg-background')}
                onClick={() => setDateRange(range.days)}
              >
                {range.label}
              </Button>
            ))}
          </div>
          <span className="text-xs text-muted-foreground">按创建时间倒序</span>
        </div>

        {loadError ? (
          <ListError
            title="无法加载会话列表"
            description={hasLoaded ? `刷新失败，仍显示上次成功加载的数据。${loadError}` : loadError}
            onRetry={handleRefresh}
            retrying={isRefreshing}
          />
        ) : null}

        {isLoading || (!hasLoaded && isRefreshing) ? <ListSkeleton label="正在加载会话列表" /> : hasLoaded ? (
          <ListSurface
            aria-label="会话列表"
            aria-busy={isRefreshing}
            footer={
              <ListSummary className="justify-between">
                <span>显示 <strong className="font-medium tabular-nums text-foreground">{filteredSessions.length}</strong> / {sessions.length} 个可见会话</span>
                <span>其中进行中 <strong className="font-medium tabular-nums text-foreground">{filteredSessions.filter(session => session.status === 'active').length}</strong></span>
              </ListSummary>
            }
          >
            {filteredSessions.length === 0 ? (
              <ListEmptyState
                icon={sessions.length ? <Search /> : <MessageSquare />}
                title={sessions.length ? '没有匹配的会话' : '暂无会话'}
                description={sessions.length ? '尝试调整用户、状态、智能体或创建时间范围。' : '客户端或集成渠道创建会话后，记录会显示在这里。'}
                action={sessions.length ? <Button variant="outline" size="sm" onClick={clearFilters}>清除筛选</Button> : undefined}
              />
            ) : (
              <Table className="min-w-[880px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>会话</TableHead>
                    <TableHead>用户</TableHead>
                    <TableHead>运行时</TableHead>
                    <TableHead>模式</TableHead>
                    <TableHead>创建时间</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredSessions.map(session => {
                    const config = statusConfig[session.status] || { label: session.status, tone: 'neutral' as const }
                    const isTerminating = terminatingId === session.sessionId
                    const agent = session.assistantName ? agentsByName.get(session.assistantName) : undefined
                    const userName = getUserName(session)
                    return (
                      <TableRow key={session.sessionId}>
                        <TableCell>
                          <Link to={`/sessions/${session.sessionId}`} title={session.sessionId} className="font-mono text-xs font-medium hover:text-primary">
                            {session.sessionId.slice(0, 12)}…
                          </Link>
                          {session.assistantName ? <div className="mt-1 max-w-48 truncate text-xs text-muted-foreground" title={agent?.displayName || session.assistantName}>{agent?.displayName || session.assistantName}</div> : null}
                        </TableCell>
                        <TableCell><span className="block max-w-40 truncate" title={userName}>{userName}</span></TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1.5">
                            <div className="flex items-center gap-1">
                              <Badge variant="secondary" className="font-normal">{session.runtime.type}</Badge>
                              {session.source && channelPlatforms[session.source] ? <Badge variant="outline" className="font-normal text-muted-foreground">{channelPlatforms[session.source]}</Badge> : null}
                            </div>
                            {session.runtime.dockerImage ? <span className="max-w-40 truncate text-xs text-muted-foreground" title={session.runtime.dockerImage}>{session.runtime.dockerImage}</span> : null}
                          </div>
                        </TableCell>
                        <TableCell>{session.runtime.dockerMode ? <Badge variant="outline" className="font-normal">{session.runtime.dockerMode}</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                        <TableCell className="tabular-nums text-muted-foreground">{format(new Date(session.createdAt), 'MM-dd HH:mm')}</TableCell>
                        <TableCell><ListStatusBadge tone={config.tone}>{config.label}</ListStatusBadge></TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            {session.status === 'active' ? (
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => void handleTerminate(session.sessionId)}
                                disabled={isTerminating}
                                aria-label={`终止会话 ${session.sessionId}`}
                                title="终止会话"
                                className="size-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                              >
                                {isTerminating ? <Loader2 className="size-4 animate-spin" /> : <Power className="size-4" />}
                              </Button>
                            ) : null}
                            <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" asChild>
                              <Link to={`/sessions/${session.sessionId}`} aria-label={`查看会话 ${session.sessionId}`} title="查看会话详情"><ArrowRight className="size-4" /></Link>
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </ListSurface>
        ) : null}
      </div>
    </DashboardLayout>
  )
}
