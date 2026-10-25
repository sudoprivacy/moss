import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { DashboardLayout } from '@/components/dashboard-layout'
import { getMyMossAgent } from '@/lib/api/moss-im'
import { useAuth } from '@/lib/hooks/use-auth'

export default function MyMossPage() {
  const { activeOrgId } = useAuth()
  const [target, setTarget] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setTarget(null)
    setError(null)
    void getMyMossAgent(controller.signal).then(agent => {
      if (controller.signal.aborted) return
      if (agent.orgId !== activeOrgId) throw new Error('当前企业已变化，请重新打开。')
      setTarget(`/agents/${encodeURIComponent(agent.ownerId)}/${encodeURIComponent(agent.agentName)}`)
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '无法打开 Moss Agent。') })
    return () => controller.abort()
  }, [activeOrgId])
  if (target) return <Navigate to={target} replace />
  return <DashboardLayout title="我的 Moss Agent" description="每位获授权成员在当前企业有一个专属 Moss Agent。">
    {error ? <div role="alert"><p className="text-destructive">{error}</p><p>需要企业管理员在用户管理中授予 Moss 使用权。</p></div> : <p role="status">正在打开…</p>}
  </DashboardLayout>
}
