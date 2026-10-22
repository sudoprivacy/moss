import { Button } from '@/components/ui/button'
import type { EndpointRequest } from '@/lib/api/external-agents'
import { isEndpointAllowed } from '@/lib/external-endpoint'

export function ExternalEndpointRequests({ items, endpoints, canReview, busy, cursor, onNext, onFirst, onReview }: {
  items: EndpointRequest[]; endpoints: string[]; canReview: boolean; busy: boolean; cursor: string | null
  onNext: () => void; onFirst: () => void; onReview: (request: EndpointRequest, approved: boolean) => void
}) {
  return <details className="rounded-md border p-3">
    <summary className="cursor-pointer text-sm font-medium">服务地址申请（本页 {items.length} 条）</summary>
    <p className="my-3 text-xs text-muted-foreground">仅显示当前组织。批准服务地址后，仍需测试连接、配置授权并审核发布智能体。历史批准不代表地址仍在允许范围内。</p>
    {!items.length && <p className="text-sm text-muted-foreground">暂无申请。可在“接入外部智能体”中填写新地址。</p>}
    <div className="max-h-80 space-y-3 overflow-y-auto">
      {items.map(request => <div key={request.id} className="space-y-1 rounded-md bg-muted/40 p-3 text-sm">
        <p className="break-all font-medium">{request.endpoint}</p>
        <p>审批：{request.status === 'pending' ? '待审批' : request.status === 'approved' ? '已批准' : '已拒绝'} · 当前范围：{isEndpointAllowed(request.endpoint, endpoints) ? '已允许' : '未允许'}</p>
        <p className="break-words">申请说明：{request.reason}</p>
        <p className="break-all text-xs text-muted-foreground">申请人：{request.requested_by} · {new Date(request.requested_at).toLocaleString()}</p>
        {request.review_note && <p className="break-words">审核说明：{request.review_note}</p>}
        {request.reviewed_by && <p className="break-all text-xs text-muted-foreground">审核人：{request.reviewed_by} · {new Date(request.reviewed_at!).toLocaleString()}</p>}
        {canReview && request.status === 'pending' && <div className="flex gap-2 pt-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onReview(request, true)}>批准地址</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onReview(request, false)}>拒绝申请</Button>
        </div>}
      </div>)}
    </div>
    <div className="mt-3 flex gap-2">
      <Button size="sm" variant="ghost" disabled={busy} onClick={onFirst}>刷新申请 / 第一页</Button>
      <Button size="sm" variant="ghost" disabled={busy || !cursor} onClick={onNext}>下一页申请</Button>
    </div>
  </details>
}
