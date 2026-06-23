'use client'

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Eye, Loader2, MessageSquareText, RefreshCw, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import {
  getCabinConversation,
  getCabinConversations,
  type CabinConversation,
  type CabinMessage,
} from '@/lib/api/cabin'
import { getEnterpriseConfig } from '@/lib/api/enterprise'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 50

const statusLabels: Record<CabinConversation['status'], string> = {
  active: '活跃',
  reset: '已重置',
}

const roleLabels: Record<CabinMessage['role'], string> = {
  user: '乘客',
  assistant: 'AI',
  system: '系统',
}

const sourceLabels: Record<CabinMessage['source'], string> = {
  text: '文本',
  voice: '语音',
  agent: '智能体',
  tool: '工具',
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function CabinSkeleton() {
  return (
    <div className="space-y-3">
      {[...Array(8)].map((_, index) => (
        <div key={index} className="flex items-center gap-4 rounded-lg border p-4">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-20" />
        </div>
      ))}
    </div>
  )
}

export default function CabinConversationsPage() {
  const [conversations, setConversations] = useState<CabinConversation[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [flightId, setFlightId] = useState('')
  const [flightDate, setFlightDate] = useState('')
  const [seatId, setSeatId] = useState('')
  const [passenger, setPassenger] = useState('')
  const [status, setStatus] = useState<'all' | 'active' | 'reset'>('all')
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [selectedConversation, setSelectedConversation] = useState<CabinConversation | null>(null)
  const [selectedMessages, setSelectedMessages] = useState<CabinMessage[]>([])
  const [isDetailLoading, setIsDetailLoading] = useState(false)
  const [isCheckingConfig, setIsCheckingConfig] = useState(true)
  const [cabinEnabled, setCabinEnabled] = useState(false)

  const fetchData = useCallback(async (
    nextOffset = offset,
    overrides: Partial<{
      flightId: string
      flightDate: string
      seatId: string
      passenger: string
      status: 'all' | 'active' | 'reset'
    }> = {},
  ) => {
    const filters = {
      flightId,
      flightDate,
      seatId,
      passenger,
      status,
      ...overrides,
    }
    try {
      const response = await getCabinConversations({
        flightId: filters.flightId.trim() || undefined,
        flightDate: filters.flightDate.trim() || undefined,
        seatId: filters.seatId.trim() || undefined,
        passenger: filters.passenger.trim() || undefined,
        status: filters.status,
        limit: PAGE_SIZE,
        offset: nextOffset,
      })
      setConversations(response.conversations)
      setTotal(response.total)
      setOffset(response.offset)
    } catch (error) {
      console.error('Failed to fetch cabin conversations:', error)
      toast.error(error instanceof Error ? error.message : '获取客舱会话失败')
    } finally {
      setIsLoading(false)
      setIsRefreshing(false)
    }
  }, [flightDate, flightId, offset, passenger, seatId, status])

  useEffect(() => {
    let cancelled = false
    getEnterpriseConfig()
      .then((response) => {
        if (cancelled) return
        const enabled = response.data.cabin_enabled === true
        setCabinEnabled(enabled)
        if (enabled) {
          void fetchData(0)
        } else {
          setIsLoading(false)
        }
      })
      .catch((error) => {
        if (cancelled) return
        console.error('Failed to fetch enterprise config:', error)
        toast.error(error instanceof Error ? error.message : '获取系统配置失败')
        setIsLoading(false)
      })
      .finally(() => {
        if (!cancelled) setIsCheckingConfig(false)
      })
    return () => {
      cancelled = true
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = () => {
    setIsRefreshing(true)
    void fetchData(0)
  }

  const handleResetFilters = () => {
    setFlightId('')
    setFlightDate('')
    setSeatId('')
    setPassenger('')
    setStatus('all')
    setIsRefreshing(true)
    void fetchData(0, {
      flightId: '',
      flightDate: '',
      seatId: '',
      passenger: '',
      status: 'all',
    })
  }

  const openDetail = async (conversation: CabinConversation) => {
    setSelectedConversation(conversation)
    setSelectedMessages([])
    setIsDetailLoading(true)
    try {
      const response = await getCabinConversation(conversation.id)
      setSelectedConversation(response.conversation)
      setSelectedMessages(response.messages)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '获取会话详情失败')
    } finally {
      setIsDetailLoading(false)
    }
  }

  const canPrev = offset > 0
  const canNext = offset + PAGE_SIZE < total

  if (isCheckingConfig) {
    return (
      <DashboardLayout title="客舱 AI 会话">
        <CabinSkeleton />
      </DashboardLayout>
    )
  }

  if (!cabinEnabled) {
    return (
      <DashboardLayout title="客舱 AI 会话">
        <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
          客舱 AI 功能未启用。
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout title="客舱 AI 会话" description="按航班、座位或乘客检索平板侧语音与文本对话，并跳转原始 moss transcript。">
      <div className="space-y-5">
        <div className="rounded-lg border bg-card p-4">
          <div className="grid gap-3 md:grid-cols-5">
            <div className="space-y-1.5">
              <Label htmlFor="flight-id">航班号</Label>
              <Input id="flight-id" value={flightId} onChange={event => setFlightId(event.target.value)} placeholder="MU1234" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="flight-date">航班日期</Label>
              <Input id="flight-date" type="date" value={flightDate} onChange={event => setFlightDate(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="seat-id">座位号</Label>
              <Input id="seat-id" value={seatId} onChange={event => setSeatId(event.target.value)} placeholder="12A" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="passenger">乘客</Label>
              <Input id="passenger" value={passenger} onChange={event => setPassenger(event.target.value)} placeholder="姓名 / ID" />
            </div>
            <div className="space-y-1.5">
              <Label>状态</Label>
              <Select value={status} onValueChange={value => setStatus(value as typeof status)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="active">活跃</SelectItem>
                  <SelectItem value="reset">已重置</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button onClick={handleSearch} disabled={isRefreshing}>
              {isRefreshing ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Search className="mr-2 size-4" />}
              查询
            </Button>
            <Button variant="outline" onClick={handleResetFilters}>
              <X className="mr-2 size-4" />
              清空
            </Button>
            <Button variant="ghost" onClick={() => {
              setIsRefreshing(true)
              void fetchData(offset)
            }}>
              <RefreshCw className={cn('mr-2 size-4', isRefreshing && 'animate-spin')} />
              刷新
            </Button>
          </div>
        </div>

        {isLoading ? (
          <CabinSkeleton />
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>航班</TableHead>
                  <TableHead>座位</TableHead>
                  <TableHead>乘客</TableHead>
                  <TableHead>平板</TableHead>
                  <TableHead>更新时间</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {conversations.map(conversation => (
                  <TableRow key={conversation.id}>
                    <TableCell>
                      <div className="font-medium">{conversation.flight_id}</div>
                      <div className="text-xs text-muted-foreground">{conversation.flight_date}</div>
                    </TableCell>
                    <TableCell>{conversation.seat_id || '-'}</TableCell>
                    <TableCell>
                      <div>{conversation.passenger_name || conversation.passenger_ref || conversation.passenger_id || '-'}</div>
                      {conversation.passenger_name && (conversation.passenger_ref || conversation.passenger_id) ? (
                        <div className="text-xs text-muted-foreground">{conversation.passenger_ref || conversation.passenger_id}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{conversation.tablet_id}</TableCell>
                    <TableCell>{formatTime(conversation.updated_at)}</TableCell>
                    <TableCell>
                      <Badge variant={conversation.status === 'active' ? 'default' : 'secondary'}>
                        {statusLabels[conversation.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="icon" title="查看 Cabin 消息" onClick={() => void openDetail(conversation)}>
                          <Eye className="size-4" />
                        </Button>
                        <Button variant="ghost" size="icon" asChild title="打开原始 moss 会话">
                          <Link to={`/sessions/${conversation.moss_session_id}`}>
                            <ArrowRight className="size-4" />
                          </Link>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {conversations.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-12 text-center">
                      <div className="flex flex-col items-center text-muted-foreground">
                        <MessageSquareText className="mb-2 size-8 opacity-50" />
                        <p>暂无匹配的客舱会话</p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>共 {total} 条，当前显示 {conversations.length} 条</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={!canPrev} onClick={() => void fetchData(Math.max(0, offset - PAGE_SIZE))}>
              上一页
            </Button>
            <Button variant="outline" size="sm" disabled={!canNext} onClick={() => void fetchData(offset + PAGE_SIZE)}>
              下一页
            </Button>
          </div>
        </div>
      </div>

      <Dialog open={!!selectedConversation} onOpenChange={(open) => {
        if (!open) {
          setSelectedConversation(null)
          setSelectedMessages([])
        }
      }}>
        <DialogContent className="max-h-[82vh] max-w-3xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>
              {selectedConversation?.flight_id} {selectedConversation?.seat_id || ''} 对话记录
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[62vh] space-y-3 overflow-y-auto pr-1">
            {isDetailLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : selectedMessages.length > 0 ? (
              selectedMessages.map(message => (
                <div key={message.id} className="rounded-lg border p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge variant={message.role === 'user' ? 'outline' : 'secondary'}>
                        {roleLabels[message.role]}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{sourceLabels[message.source]}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">{formatTime(message.created_at)}</span>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm leading-6">{message.content}</p>
                </div>
              ))
            ) : (
              <div className="py-10 text-center text-sm text-muted-foreground">暂无消息</div>
            )}
          </div>
          {selectedConversation ? (
            <div className="flex justify-end border-t pt-3">
              <Button asChild>
                <Link to={`/sessions/${selectedConversation.moss_session_id}`}>
                  打开原始 moss 会话
                  <ArrowRight className="ml-2 size-4" />
                </Link>
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}
