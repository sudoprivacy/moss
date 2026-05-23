'use client'

import { useEffect, useState, useCallback } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'
import { Link } from 'react-router-dom'
import { AlertTriangle, Clock, ExternalLink, Calendar, Loader2 } from 'lucide-react'
import { getRotationAlerts, updateSecretMetadata, type SecretMetadata, type ConfigItem } from '@/lib/api/secrets'

type AlertItem = SecretMetadata & { config_item: ConfigItem }

function AlertsSkeleton() {
  return (
    <div className="space-y-4">
      {[...Array(3)].map((_, i) => (
        <Card key={i}><CardContent className="p-4"><Skeleton className="h-20 w-full" /></CardContent></Card>
      ))}
    </div>
  )
}

export default function RotationAlertsPage() {
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Extend dialog
  const [extendTarget, setExtendTarget] = useState<AlertItem | null>(null)
  const [newExpiry, setNewExpiry] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  const fetchData = useCallback(async () => {
    try {
      const res = await getRotationAlerts()
      setAlerts(res)
    } catch {
      toast.error('获取告警信息失败')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const handleExtend = (item: AlertItem) => {
    setExtendTarget(item)
    const current = item.expires_at ? new Date(item.expires_at) : new Date()
    current.setDate(current.getDate() + 30)
    setNewExpiry(current.toISOString().slice(0, 10))
  }

  const handleSaveExpiry = async () => {
    if (!extendTarget || !newExpiry) return
    setIsSaving(true)
    try {
      await updateSecretMetadata(extendTarget.config_item_id, new Date(newExpiry).getTime())
      toast.success('过期时间已更新')
      setExtendTarget(null)
      fetchData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失败')
    } finally {
      setIsSaving(false)
    }
  }

  const formatCountdown = (expiresAt: number) => {
    const diff = expiresAt - Date.now()
    if (diff <= 0) return { text: '已过期', expired: true }
    const hours = Math.floor(diff / 3600000)
    const minutes = Math.floor((diff % 3600000) / 60000)
    if (hours < 1) return { text: `${minutes} 分钟`, expired: false }
    if (hours < 24) return { text: `${hours} 小时 ${minutes} 分钟`, expired: false }
    const days = Math.floor(hours / 24)
    return { text: `${days} 天 ${hours % 24} 小时`, expired: false }
  }

  if (isLoading) {
    return <DashboardLayout title="轮换告警" description="即将过期或已过期的凭据"><AlertsSkeleton /></DashboardLayout>
  }

  return (
    <DashboardLayout title="轮换告警" description="即将过期或已过期的凭据">
      {alerts.length > 0 ? (
        <div className="space-y-4">
          {alerts.map(alert => {
            const countdown = formatCountdown(alert.expires_at ?? 0)
            const isExpired = countdown.expired
            const isUrgent = !isExpired && (alert.expires_at ?? 0) - Date.now() < 3600000 * 6

            return (
              <Card key={alert.config_item_id} className={`border-2 ${isExpired ? 'border-destructive' : isUrgent ? 'border-orange-400' : 'border-yellow-400'}`}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`flex size-10 items-center justify-center rounded-lg ${
                        isExpired ? 'bg-destructive/10' : isUrgent ? 'bg-orange-100 dark:bg-orange-900/30' : 'bg-yellow-100 dark:bg-yellow-900/30'
                      }`}>
                        <AlertTriangle className={`size-5 ${isExpired ? 'text-destructive' : isUrgent ? 'text-orange-600' : 'text-yellow-600'}`} />
                      </div>
                      <div>
                        <CardTitle className="text-base">{alert.config_item.name}</CardTitle>
                        {alert.config_item.description && <p className="text-xs text-muted-foreground mt-0.5">{alert.config_item.description}</p>}
                      </div>
                    </div>
                    <Badge variant={isExpired ? 'destructive' : 'outline'} className={isUrgent ? 'border-orange-400 text-orange-600' : 'border-yellow-400 text-yellow-600'}>
                      {countdown.text}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1"><Clock className="size-3.5" />过期时间: {alert.expires_at ? new Date(alert.expires_at).toLocaleString('zh-CN') : '-'}</span>
                      <span className="flex items-center gap-1"><Calendar className="size-3.5" />剩余: {countdown.text}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => handleExtend(alert)}>
                        <Calendar className="size-3 mr-1" />延长有效期
                      </Button>
                      <Button variant="outline" size="sm" asChild>
                        <Link to={`/secrets/enterprise`}>
                          <ExternalLink className="size-3 mr-1" />更新凭据
                        </Link>
                      </Button>
                      <Button variant="ghost" size="sm" asChild>
                        <Link to={`/secrets/audit-log?config_item_id=${alert.config_item_id}`}>
                          审计
                        </Link>
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      ) : (
        <div className="flex flex-col items-center py-16 text-muted-foreground">
          <AlertTriangle className="size-12 mb-3 opacity-20" />
          <p>暂无即将过期的凭据</p>
          <p className="text-xs mt-1">所有凭据状态正常</p>
        </div>
      )}

      {/* Extend Expiry Dialog */}
      <Dialog open={!!extendTarget} onOpenChange={open => !open && setExtendTarget(null)}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>延长有效期 — {extendTarget?.config_item.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>当前过期时间</Label>
              <p className="text-sm text-muted-foreground">{extendTarget?.expires_at ? new Date(extendTarget.expires_at).toLocaleString('zh-CN') : '未设置'}</p>
            </div>
            <div className="space-y-1.5">
              <Label>新的过期时间</Label>
              <Input type="date" value={newExpiry} onChange={e => setNewExpiry(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExtendTarget(null)}>取消</Button>
            <Button onClick={handleSaveExpiry} disabled={isSaving}>
              {isSaving && <Loader2 className="size-4 mr-1 animate-spin" />}保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}
