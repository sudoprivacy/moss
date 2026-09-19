'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Calendar, Clock, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { DashboardLayout } from '@/components/dashboard-layout'
import {
  ListEmptyState,
  ListError,
  ListSkeleton,
  ListStatusBadge,
  ListSurface,
  ListToolbar,
} from '@/components/list-page'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  getRotationAlerts,
  updateSecretMetadata,
  type ConfigItem,
  type SecretMetadata,
} from '@/lib/api/secrets'
import { hasAnyScope, hasScope } from '@/lib/api/client'
import {
  canExtendCredentialExpiry,
  canReadCredentialDestination,
  credentialRouteForScope,
  expiryAlertLevel,
} from '@/lib/credential-list'
import { useAuth } from '@/lib/hooks/use-auth'
import { toast } from 'sonner'

type AlertItem = SecretMetadata & { config_item: ConfigItem }

function formatCountdown(expiresAt: number | null) {
  if (!expiresAt) return '未设置'
  const diff = expiresAt - Date.now()
  if (diff <= 0) return '已过期'
  const hours = Math.floor(diff / 3_600_000)
  const minutes = Math.floor((diff % 3_600_000) / 60_000)
  if (hours < 1) return `${minutes} 分钟`
  if (hours < 24) return `${hours} 小时 ${minutes} 分钟`
  const days = Math.floor(hours / 24)
  return `${days} 天 ${hours % 24} 小时`
}

function riskLabel(expiresAt: number | null) {
  switch (expiryAlertLevel(expiresAt)) {
    case 'expired':
      return '已过期'
    case 'urgent':
      return '紧急（6 小时内）'
    case 'upcoming':
    default:
      return '即将过期'
  }
}

function scopeLabel(scope: ConfigItem['scope']) {
  switch (scope) {
    case 'department':
      return '部门'
    case 'user':
      return '个人'
    case 'system':
    default:
      return '企业'
  }
}

export default function RotationAlertsPage() {
  const { scopes } = useAuth()
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadedSuccessfully = useRef(false)
  const requestSequence = useRef(0)
  const mounted = useRef(false)

  const [extendTarget, setExtendTarget] = useState<AlertItem | null>(null)
  const [newExpiry, setNewExpiry] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const saveInFlight = useRef(false)

  const loadAlerts = useCallback(async () => {
    if (!mounted.current) return
    const requestId = ++requestSequence.current
    const initialLoad = !loadedSuccessfully.current
    if (initialLoad) setIsLoading(true)
    else setIsRefreshing(true)
    setError(null)

    try {
      const result = await getRotationAlerts()
      if (!mounted.current || requestId !== requestSequence.current) return
      setAlerts(result)
      loadedSuccessfully.current = true
    } catch (err) {
      if (!mounted.current || requestId !== requestSequence.current) return
      setError(err instanceof Error ? err.message : '请稍后重试。')
    } finally {
      if (mounted.current && requestId === requestSequence.current) {
        setIsLoading(false)
        setIsRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void loadAlerts()
    return () => {
      mounted.current = false
      requestSequence.current += 1
    }
  }, [loadAlerts])

  const canReadAdminSecrets = hasScope(scopes, 'admin:secrets')
  const canReadDepartmentSecrets = hasAnyScope(scopes, ['admin:secrets', 'secrets:department:read'])
  const canWriteUserSecrets = hasScope(scopes, 'secrets:user:write')
  const canWriteAdminSecrets = hasScope(scopes, 'admin:secrets:write')
  const destinationPermissions = {
    canReadAdminSecrets,
    canReadDepartmentSecrets,
    canWriteUserSecrets,
    canWriteAdminSecrets,
  }

  const handleExtend = (item: AlertItem) => {
    setExtendTarget(item)
    const current = item.expires_at ? new Date(item.expires_at) : new Date()
    current.setDate(current.getDate() + 30)
    setNewExpiry(current.toISOString().slice(0, 10))
  }

  const handleSaveExpiry = async () => {
    if (!extendTarget || !newExpiry || isSaving || saveInFlight.current) return
    if (!canExtendCredentialExpiry(extendTarget.config_item.scope, destinationPermissions)) {
      toast.error('您没有延长该凭据有效期的权限')
      return
    }
    const expiresAt = new Date(newExpiry).getTime()
    if (Number.isNaN(expiresAt)) {
      toast.error('请输入有效的过期时间')
      return
    }

    saveInFlight.current = true
    setIsSaving(true)
    try {
      // This endpoint updates expiration metadata only; it does not rotate or
      // expose the credential value.
      await updateSecretMetadata(extendTarget.config_item_id, expiresAt)
      if (!mounted.current) return
      toast.success('过期时间已更新')
      setExtendTarget(null)
      void loadAlerts()
    } catch (err) {
      if (!mounted.current) return
      // Keep the dialog and input intact so a failed update can be corrected
      // and retried without silently claiming the credential was rotated.
      toast.error(err instanceof Error ? err.message : '更新失败')
    } finally {
      saveInFlight.current = false
      if (mounted.current) setIsSaving(false)
    }
  }

  return (
    <DashboardLayout title="轮换告警" description="即将过期或已过期的凭据">
      <div className="space-y-4">
        <ListToolbar
          aria-label="轮换告警操作"
          actions={
            <Button type="button" variant="outline" size="sm" onClick={() => void loadAlerts()} disabled={isLoading || isRefreshing}>
              <RefreshCw className={`size-3.5 ${(isLoading || isRefreshing) ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
              刷新
            </Button>
          }
        />

        {isLoading ? <ListSkeleton label="正在加载轮换告警" rows={4} /> : (
          <>
            {error && (
              <ListError
                title="无法加载轮换告警"
                description={alerts.length > 0 ? `刷新失败，仍显示上次成功结果。${error}` : error}
                onRetry={() => void loadAlerts()}
                retrying={isRefreshing}
              />
            )}

            {alerts.length > 0 ? (
              <ListSurface aria-label="轮换告警列表" aria-busy={isRefreshing}>
                <div className="divide-y">
                  {alerts.map(alert => {
                    const level = expiryAlertLevel(alert.expires_at)
                    const canNavigate = canReadCredentialDestination(alert.config_item.scope, destinationPermissions)
                    const canExtend = canExtendCredentialExpiry(alert.config_item.scope, destinationPermissions)
                    const destination = credentialRouteForScope(alert.config_item.scope)
                    const countdown = formatCountdown(alert.expires_at)

                    return (
                      <div key={alert.config_item_id} className="flex min-w-0 flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 items-start gap-3">
                          <div className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md ${level === 'expired' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}`}>
                            <AlertTriangle className="size-4" aria-hidden="true" />
                          </div>
                          <div className="min-w-0">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              <p className="truncate text-sm font-medium">{alert.config_item.name}</p>
                              <ListStatusBadge>{scopeLabel(alert.config_item.scope)}</ListStatusBadge>
                              <ListStatusBadge tone={level === 'expired' ? 'danger' : 'neutral'}>{riskLabel(alert.expires_at)}</ListStatusBadge>
                            </div>
                            {alert.config_item.description && <p className="mt-1 break-words text-[13px] text-muted-foreground">{alert.config_item.description}</p>}
                            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
                              <span className="inline-flex items-center gap-1"><Clock className="size-3.5" aria-hidden="true" />过期时间：{alert.expires_at ? new Date(alert.expires_at).toLocaleString('zh-CN') : '-'}</span>
                              <span className="inline-flex items-center gap-1"><Calendar className="size-3.5" aria-hidden="true" />剩余：{countdown}</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                          {canExtend && (
                            <Button type="button" variant="outline" size="sm" onClick={() => handleExtend(alert)}>
                              <Calendar className="size-3.5" aria-hidden="true" />延长有效期
                            </Button>
                          )}
                          {canNavigate && (
                            <Button variant="outline" size="sm" asChild>
                              <Link to={destination}><ExternalLink className="size-3.5" aria-hidden="true" />查看凭据</Link>
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" asChild>
                            <Link to={`/secrets/audit-log?config_item_id=${alert.config_item_id}`}>审计</Link>
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </ListSurface>
            ) : !error ? (
              <ListEmptyState
                title="当前可见范围内没有轮换告警"
                description="没有即将过期或已过期的凭据。"
                icon={<AlertTriangle />}
              />
            ) : null}
          </>
        )}
      </div>

      <Dialog open={!!extendTarget} onOpenChange={open => { if (!open && !isSaving) setExtendTarget(null) }}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="break-words pr-6">延长有效期 — {extendTarget?.config_item.name}</DialogTitle>
            <DialogDescription>此操作只更新过期元数据，不会轮换、读取或显示凭据值。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>当前过期时间</Label>
              <p className="text-sm text-muted-foreground">{extendTarget?.expires_at ? new Date(extendTarget.expires_at).toLocaleString('zh-CN') : '未设置'}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rotation-new-expiry">新的过期时间</Label>
              <Input id="rotation-new-expiry" type="date" value={newExpiry} onChange={event => setNewExpiry(event.target.value)} disabled={isSaving} />
              <p className="text-xs text-muted-foreground">此操作只更新有效期，不会轮换或显示凭据值。</p>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setExtendTarget(null)} disabled={isSaving}>取消</Button>
            <Button type="button" onClick={() => void handleSaveExpiry()} disabled={isSaving || !newExpiry}>
              {isSaving && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}
