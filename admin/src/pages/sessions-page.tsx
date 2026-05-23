'use client'

import { useEffect, useState, useCallback } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { Search, ArrowRight, Loader2, Power, RefreshCw, Calendar } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { format, subDays, startOfDay, endOfDay, isWithinInterval } from 'date-fns'

const statusConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  active: { label: '进行中', variant: 'default' },
  creating: { label: '创建中', variant: 'secondary' },
  detached: { label: '已断开', variant: 'outline' },
  ended: { label: '已结束', variant: 'secondary' },
  terminated: { label: '已终止', variant: 'destructive' },
  failed: { label: '失败', variant: 'destructive' },
  lost: { label: '丢失', variant: 'destructive' },
}

const DATE_RANGES = [
  { label: '今天', days: 0 },
  { label: '近7天', days: 7 },
  { label: '近30天', days: 30 },
  { label: '全部', days: -1 },
]

function SessionsSkeleton() {
  return (
    <div className="space-y-4">
      {[...Array(10)].map((_, i) => (
        <div key={i} className="flex items-center gap-4 p-4 border rounded-lg">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-8 w-20" />
        </div>
      ))}
    </div>
  )
}

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
  const [terminatingId, setTerminatingId] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const [sessionsRes, usersRes, agentsRes] = await Promise.all([getSessions(), getUsers(), getInstalledAgents()])
      setSessions(sessionsRes.sessions)
      setUsers(usersRes.users)
      setInstalledAgents(agentsRes)
    } catch (error) {
      console.error('Failed to fetch data:', error)
      toast.error('获取会话列表失败')
    } finally {
      setIsLoading(false)
      setIsRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleRefresh = () => {
    setIsRefreshing(true)
    fetchData()
  }

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

  const handleTerminate = async (sessionId: string) => {
    if (!confirm('确定要终止这个会话吗？')) return
    setTerminatingId(sessionId)
    try {
      await terminateSession(sessionId)
      toast.success('会话已终止')
      setSessions(
        sessions.map((s) =>
          s.sessionId === sessionId
            ? { ...s, status: 'terminated', desiredState: 'terminated' as const }
            : s
        )
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '终止会话失败')
    } finally {
      setTerminatingId(null)
    }
  }

  const getUserName = (userId: string) => {
    const user = users.find((u) => u.id === userId)
    return user?.name || userId.slice(0, 8)
  }

  if (isLoading) {
    return (
      <DashboardLayout title="会话管理">
        <SessionsSkeleton />
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout title="会话管理">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-1 flex-wrap gap-2">
            <div className="relative w-full max-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                placeholder="搜索..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={userFilter} onValueChange={setUserFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="筛选用户" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部用户</SelectItem>
                {users.map((user) => (
                  <SelectItem key={user.id} value={user.id}>
                    {user.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[120px]">
                <SelectValue placeholder="筛选状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                {Object.entries(statusConfig).map(([key, config]) => (
                  <SelectItem key={key} value={key}>
                    {config.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="筛选智能体" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部智能体</SelectItem>
                {agentNames.map((name) => {
                  const agent = installedAgents.find((a) => a.name === name)
                  return (
                    <SelectItem key={name} value={name}>
                      {agent?.displayName || name}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            <div className="flex rounded-md border">
              {DATE_RANGES.map((range) => (
                <Button
                  key={range.days}
                  variant={dateRange === range.days ? 'default' : 'ghost'}
                  size="sm"
                  className="rounded-none first:rounded-l-md last:rounded-r-md"
                  onClick={() => setDateRange(range.days)}
                >
                  {range.label}
                </Button>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing}>
              <RefreshCw className={`size-3 mr-1 ${isRefreshing ? 'animate-spin' : ''}`} />
              刷新
            </Button>
          </div>
        </div>

        {/* Sessions Table */}
        <div className="border rounded-lg">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Session ID</TableHead>
                <TableHead>用户</TableHead>
                <TableHead>运行时</TableHead>
                <TableHead>模式</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredSessions.map((session) => {
                const config = statusConfig[session.status] || { label: session.status, variant: 'outline' as const }
                const isTerminating = terminatingId === session.sessionId
                return (
                  <TableRow key={session.sessionId}>
                    <TableCell className="font-mono text-sm">{session.sessionId.slice(0, 12)}...</TableCell>
                    <TableCell>{getUserName(session.userId)}</TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <Badge variant="secondary">{session.runtime.type}</Badge>
                        {session.runtime.dockerImage && (
                          <span className="text-xs text-muted-foreground truncate max-w-[120px]" title={session.runtime.dockerImage}>
                            {session.runtime.dockerImage}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {session.runtime.dockerMode && (
                        <Badge variant="outline" className="text-xs">
                          {session.runtime.dockerMode}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{format(new Date(session.createdAt), 'MM-dd HH:mm')}</TableCell>
                    <TableCell>
                      <Badge variant={config.variant}>{config.label}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        {session.status === 'active' && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleTerminate(session.sessionId)}
                            disabled={isTerminating}
                            title="终止会话"
                          >
                            {isTerminating ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <Power className="size-4" />
                            )}
                          </Button>
                        )}
                        <Button variant="ghost" size="icon" asChild>
                          <Link to={`/sessions/${session.sessionId}`}>
                            <ArrowRight className="size-4" />
                          </Link>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
              {filteredSessions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-12">
                    <div className="flex flex-col items-center text-muted-foreground">
                      <Search className="size-8 mb-2 opacity-50" />
                      <p>没有找到匹配的会话</p>
                      <p className="text-xs mt-1">尝试调整筛选条件</p>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {/* Summary */}
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            共 {filteredSessions.length} 个会话
            {filteredSessions.length !== sessions.length && (
              <span className="ml-1">（共 {sessions.length} 个）</span>
            )}
          </span>
          <span>
            活跃: {filteredSessions.filter((s) => s.status === 'active').length}
          </span>
        </div>
      </div>
    </DashboardLayout>
  )
}
