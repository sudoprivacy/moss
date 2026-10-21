import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { createInventoryApi, AssetSuspensionView } from '@/lib/api/agent-inventory'
import { inventoryError } from '@/lib/agent-inventory-labels'

const label = { pending: '待确认', confirmed: '已确认', not_configured: '未配置受控执行路径', closed_locally: '本地入口已关闭，等待权威确认' }
export function AgentAssetSuspension({ api, assetId }: { api: ReturnType<typeof createInventoryApi>; assetId: string }) {
  const [report, setReport] = useState<AssetSuspensionView | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const mounted = useRef(true), acting = useRef(false)
  useEffect(() => {
    mounted.current = true
    let active = true
    void api.suspension(assetId).then(value => { if (active) setReport(value) }, err => { if (active) setError(inventoryError(err)) })
    return () => { active = false; mounted.current = false }
  }, [api, assetId])
  async function refresh(retry: boolean) {
    if (acting.current) return
    acting.current = true; setBusy(true); setError('')
    try {
      const value = await api.suspension(assetId, retry)
      if (mounted.current) setReport(value)
    } catch (err) { if (mounted.current) setError(inventoryError(err)) }
    finally { acting.current = false; if (mounted.current) setBusy(false) }
  }
  if (!report && !error) return null
  return <section aria-label="停用执行情况" className="space-y-3 rounded border p-3 text-sm">
    <h3 className="font-medium">停用执行情况</h3>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {report && <>
      <p>{report.status === 'confirmed' ? '已确认受控路径回收。' : '回收尚未完成，入口保持关闭。'}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt>调用入口</dt><dd>{label[report.entry]}</dd>
        <dt>任务身份</dt><dd>{label[report.identity]} · {report.grants} 项凭证</dd>
        <dt>模型凭证</dt><dd>{label[report.model]} · {report.model_calls} 次调用</dd>
        <dt>托管运行资源</dt><dd>{label[report.hosted]} · {report.hosted_tasks} 个任务</dd>
        <dt>远端任务快照</dt><dd>{report.external_tasks ? `待派发 ${report.external_tasks.accepted} · 在途 ${report.external_tasks.in_flight} · 结果未知 ${report.external_tasks.unknown}` : '未取得适用的远端任务快照'}</dd>
      </dl>
      <p className="text-muted-foreground">原平台直连、原平台长期密钥及已受理的远端任务不在此回收确认范围内。此操作未确认取消远端任务，也不会把未知结果改成成功。模型请求若已受理，停用后仍可能产生用量。</p>
      <p className="text-muted-foreground">核对时间：{new Date(report.updated_at).toLocaleString()}</p>
      {report.error_code && <p className="break-all">状态代码：{report.error_code}</p>}
    </>}
    <div className="flex gap-2">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh(false)}>刷新状态</Button>
      {report?.status === 'pending' && <Button size="sm" disabled={busy} onClick={() => void refresh(true)}>继续核对回收</Button>}
    </div>
  </section>
}
