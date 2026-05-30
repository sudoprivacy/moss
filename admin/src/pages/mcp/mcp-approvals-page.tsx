'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Loader2, CheckCircle2, XCircle, Eye } from 'lucide-react'
import { toast } from 'sonner'

import { DashboardLayout } from '@/components/dashboard-layout'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { fetchMcpApprovals, approveMcpRequest, rejectMcpRequest, fetchMcpServers } from '@/lib/api/mcp'
import type { McpApprovalRequest, McpServer } from '@/lib/api/mcp'
import { ApiRequestError } from '@/lib/api/client'

function StatusBadge({ status }: { status: string }) {
  if (status === 'approved') return <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/25">已批准</Badge>
  if (status === 'rejected') return <Badge variant="destructive">已驳回</Badge>
  return <Badge className="bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border-yellow-500/25">待审批</Badge>
}

function TypeBadge({ mcpType }: { mcpType?: string }) {
  if (!mcpType) return <span className="text-muted-foreground text-sm">-</span>
  const labels: Record<string, string> = { http: 'HTTP', sse: 'SSE', stdio: 'STDIO' }
  return <Badge variant="outline">{labels[mcpType] || mcpType}</Badge>
}

function parseSnapshot(raw: string | null): { displayName: string; name: string; mcpType: string; description: string } | null {
  if (!raw) return null
  try {
    const s = JSON.parse(raw)
    return {
      displayName: s.display_name || s.name || '',
      name: s.name || '',
      mcpType: s.mcp_type || '',
      description: s.description || '',
    }
  } catch { return null }
}

function formatDateTime(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function McpApprovalsPage() {
  const [isLoading, setIsLoading] = useState(true)
  const [approvals, setApprovals] = useState<McpApprovalRequest[]>([])
  const [serverLookup, setServerLookup] = useState<Map<string, McpServer>>(new Map())
  const [statusFilter, setStatusFilter] = useState('all')
  const [applicantFilter, setApplicantFilter] = useState('all')
  const [detailDialog, setDetailDialog] = useState<McpApprovalRequest | null>(null)
  const [approveDialog, setApproveDialog] = useState<McpApprovalRequest | null>(null)
  const [rejectDialog, setRejectDialog] = useState<McpApprovalRequest | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const loadApprovals = useCallback(async () => {
    try {
      setIsLoading(true)
      // Load approval list and the full server catalog in parallel so we can show MCP name+type.
      const [data, servers] = await Promise.all([
        fetchMcpApprovals(statusFilter !== 'all' ? statusFilter : undefined),
        fetchMcpServers().catch(() => ({ items: [] as McpServer[] })),
      ])
      setApprovals(data)
      const map = new Map<string, McpServer>()
      for (const s of servers.items || []) map.set(s.id, s)
      setServerLookup(map)
    } catch (err) {
      if (err instanceof ApiRequestError) {
        toast.error(`加载审批列表失败: ${err.message}`)
      }
    } finally {
      setIsLoading(false)
    }
  }, [statusFilter])

  useEffect(() => {
    loadApprovals()
  }, [loadApprovals])

  const pendingCount = approvals.filter((a) => a.status === 'pending').length

  // Distinct applicants in current result for the filter dropdown.
  const applicantOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const a of approvals) {
      if (a.user_id) seen.set(a.user_id, a.user_name || a.user_id)
    }
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }))
  }, [approvals])

  const filteredApprovals = useMemo(() => {
    if (applicantFilter === 'all') return approvals
    return approvals.filter((a) => a.user_id === applicantFilter)
  }, [approvals, applicantFilter])

  async function handleApprove(request: McpApprovalRequest) {
    setApproveDialog(null)
    setIsSubmitting(true)
    try {
      await approveMcpRequest(request.id)
      toast.success('已批准')
      await loadApprovals()
    } catch (err) {
      if (err instanceof ApiRequestError) {
        toast.error(`批准失败: ${err.message}`)
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleReject() {
    if (!rejectDialog) return
    const target = rejectDialog
    setRejectDialog(null)
    setRejectReason('')
    setIsSubmitting(true)
    try {
      await rejectMcpRequest(target.id, rejectReason)
      toast.success('已驳回')
      await loadApprovals()
    } catch (err) {
      if (err instanceof ApiRequestError) {
        toast.error(`驳回失败: ${err.message}`)
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  if (isLoading && approvals.length === 0) {
    return (
      <DashboardLayout title="MCP 审批管理" description="审核员工提交的个人 MCP 配置申请">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout title="MCP 审批管理" description="审核员工提交的个人 MCP 配置申请">
      {/* Stats */}
      <div className="flex items-center gap-4 mb-4">
        <div className="rounded-lg border bg-card px-4 py-2">
          <span className="text-sm text-muted-foreground">待审批</span>
          <span className="ml-2 text-lg font-bold text-yellow-600">{pendingCount}</span>
        </div>
        <Button variant="outline" size="sm" onClick={loadApprovals} disabled={isLoading}>
          {isLoading ? <Loader2 className="size-3.5 mr-1 animate-spin" /> : null}刷新
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 mb-4">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[130px]"><SelectValue placeholder="状态" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="pending">待审批</SelectItem>
            <SelectItem value="approved">已批准</SelectItem>
            <SelectItem value="rejected">已驳回</SelectItem>
          </SelectContent>
        </Select>
        <Select value={applicantFilter} onValueChange={setApplicantFilter}>
          <SelectTrigger className="w-[150px]"><SelectValue placeholder="申请人" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部申请人</SelectItem>
            {applicantOptions.map((u) => (
              <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>申请人</TableHead>
              <TableHead>MCP 名称</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>提交时间</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredApprovals.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  没有找到匹配的审批请求
                </TableCell>
              </TableRow>
            ) : (
              filteredApprovals.map((request) => {
                const server = serverLookup.get(request.mcp_server_id)
                const snapshot = parseSnapshot(request.mcp_server_snapshot)
                const info = snapshot || (server ? { displayName: server.display_name || server.name, name: server.name } : null)
                return (
                  <TableRow key={request.id}>
                    <TableCell className="font-medium">{request.user_name || request.user_id}</TableCell>
                    <TableCell className="text-sm">
                      {info ? (
                        <div className="font-medium">{info.displayName}</div>
                      ) : (
                        <span className="font-mono text-xs text-muted-foreground" title={request.mcp_server_id}>
                          {request.mcp_server_id.substring(0, 8)}…
                        </span>
                      )}
                    </TableCell>
                    <TableCell><TypeBadge mcpType={snapshot?.mcpType || server?.mcp_type} /></TableCell>
                    <TableCell className="text-sm">{formatDateTime(request.created_at)}</TableCell>
                    <TableCell><StatusBadge status={request.status} /></TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setDetailDialog(request)}>
                          <Eye className="size-3.5 mr-1" />详情
                        </Button>
                        {request.status === 'pending' && (
                          <>
                            <Button variant="ghost" size="sm" className="text-emerald-600 hover:text-emerald-700" onClick={() => setApproveDialog(request)} disabled={isSubmitting}>
                              <CheckCircle2 className="size-3.5 mr-1" />批准
                            </Button>
                            <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700" onClick={() => { setRejectDialog(request); setRejectReason('') }} disabled={isSubmitting}>
                              <XCircle className="size-3.5 mr-1" />驳回
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Detail Dialog */}
      <Dialog open={!!detailDialog} onOpenChange={(open) => { if (!open) setDetailDialog(null) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>审批请求详情</DialogTitle>
            <DialogDescription>{detailDialog?.user_name} 提交的申请</DialogDescription>
          </DialogHeader>
          {detailDialog && (() => {
            const server = serverLookup.get(detailDialog.mcp_server_id)
            const snapshot = parseSnapshot(detailDialog.mcp_server_snapshot)
            const info = snapshot || (server ? { displayName: server.display_name || server.name, name: server.name, mcpType: server.mcp_type, description: server.description } : null)
            return (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div><span className="text-muted-foreground">申请人：</span>{detailDialog.user_name || detailDialog.user_id}</div>
                <div><span className="text-muted-foreground">状态：</span><StatusBadge status={detailDialog.status} /></div>
              </div>
              {info ? (
                <>
                  <div><span className="text-muted-foreground">MCP 名称：</span>{info.displayName} <span className="text-xs text-muted-foreground">({info.name})</span></div>
                  <div className="flex items-center gap-2"><span className="text-muted-foreground">类型：</span><TypeBadge mcpType={info.mcpType} /></div>
                  {info.description && (
                    <div><span className="text-muted-foreground">描述：</span>{info.description}</div>
                  )}
                </>
              ) : (
                <div><span className="text-muted-foreground">MCP 名称：</span><span className="text-muted-foreground">（服务已删除）</span></div>
              )}
              <div><span className="text-muted-foreground">MCP 服务 ID：</span><code className="rounded bg-muted px-1.5 py-0.5 text-xs">{detailDialog.mcp_server_id}</code></div>
              <div><span className="text-muted-foreground">提交时间：</span>{formatDateTime(detailDialog.created_at)}</div>
              {detailDialog.reviewed_at && (
                <div><span className="text-muted-foreground">审核时间：</span>{formatDateTime(detailDialog.reviewed_at)}</div>
              )}
              {detailDialog.reviewer_name && (
                <div><span className="text-muted-foreground">审核人：</span>{detailDialog.reviewer_name}</div>
              )}
              {detailDialog.review_note && (
                <div>
                  <span className="text-muted-foreground">审核备注：</span>
                  <p className="mt-1 rounded bg-muted p-2">{detailDialog.review_note}</p>
                </div>
              )}
            </div>
            )
          })()}
        </DialogContent>
      </Dialog>

      {/* Approve Confirm Dialog */}
      <AlertDialog open={!!approveDialog} onOpenChange={(open) => { if (!open) setApproveDialog(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认批准</AlertDialogTitle>
            <AlertDialogDescription>
              确定要批准 <strong>{approveDialog?.user_name}</strong> 的 MCP 申请吗？批准后该 MCP 将可立即使用。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => approveDialog && handleApprove(approveDialog)} disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="size-3.5 mr-1 animate-spin" />}确认批准
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reject Dialog */}
      <Dialog open={!!rejectDialog} onOpenChange={(open) => { if (!open) setRejectDialog(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>驳回申请</DialogTitle>
            <DialogDescription>驳回 {rejectDialog?.user_name} 的 MCP 申请</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>驳回原因</Label>
            <Textarea
              placeholder="请输入驳回原因..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDialog(null)}>取消</Button>
            <Button variant="destructive" onClick={handleReject} disabled={!rejectReason.trim() || isSubmitting}>
              {isSubmitting && <Loader2 className="size-3.5 mr-1 animate-spin" />}确认驳回
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}
