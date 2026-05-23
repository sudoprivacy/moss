'use client'

import { useEffect, useState, useCallback } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'
import {
  Shield, Eye, EyeOff, Loader2, AlertTriangle, Clock, Ban, CheckCircle,
} from 'lucide-react'
import {
  getUserSecrets, getSecretMetadata, getConfigItems,
  putUserSecret, enableUserSecret, disableUserSecret, updateSecretMetadata,
  type SecretEntry, type ConfigItem, type SecretMetadata,
} from '@/lib/api/secrets'
import { useAuth } from '@/lib/hooks/use-auth'

function UserSecretsSkeleton() {
  return (
    <div className="space-y-3">
      {[...Array(3)].map((_, i) => (
        <div key={i} className="flex items-center gap-4 p-4 border rounded-lg">
          <Skeleton className="size-10 rounded-lg shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-48" />
          </div>
          <Skeleton className="h-8 w-20" />
        </div>
      ))}
    </div>
  )
}

export default function UserCredentialsPage() {
  const { user: currentUser } = useAuth()
  const [configItems, setConfigItems] = useState<ConfigItem[]>([])
  const [secrets, setSecrets] = useState<(SecretEntry & { config_item: ConfigItem })[]>([])
  const [metadata, setMetadata] = useState<(SecretMetadata & { config_item: ConfigItem })[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Edit dialog
  const [editItem, setEditItem] = useState<ConfigItem | null>(null)
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const [editExpires, setEditExpires] = useState<string>('')
  const [showValues, setShowValues] = useState<Record<string, boolean>>({})
  const [isSaving, setIsSaving] = useState(false)

  const fetchData = useCallback(async () => {
    try {
      const itemsRes = await getConfigItems({ scope: 'user', status: '1' })
      const userItems = itemsRes.items
      const [secretsRes, metaRes] = await Promise.all([
        getUserSecrets(userItems),
        getSecretMetadata(userItems),
      ])
      setConfigItems(userItems)
      setSecrets(secretsRes)
      setMetadata(metaRes)
    } catch {
      toast.error('获取用户凭据失败')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const getSecretsForItem = (itemId: number) => secrets.filter(s => s.config_item.id === itemId)
  const getMetadataForItem = (itemId: number) => metadata.find(m => m.config_item_id === itemId)

  const handleConfigure = (item: ConfigItem) => {
    setEditItem(item)
    const vals: Record<string, string> = {}
    item.entries.forEach(e => { vals[e.config_key] = '' })
    setEditValues(vals)
    const meta = getMetadataForItem(item.id)
    setEditExpires(meta?.expires_at ? new Date(meta.expires_at).toISOString().slice(0, 10) : '')
    setShowValues({})
  }

  const handleSave = async () => {
    if (!editItem || !currentUser) return
    setIsSaving(true)
    try {
      const namespace = `user:${currentUser.id}:${editItem.pinyin}`
      for (const entry of editItem.entries) {
        const val = editValues[entry.config_key]
        if (val && val.trim()) {
          await putUserSecret(namespace, entry.config_key, val)
        }
      }
      if (editExpires !== undefined) {
        const expiresAt = editExpires ? new Date(editExpires).getTime() : null
        await updateSecretMetadata(editItem.id, expiresAt)
      }
      toast.success('凭据已保存')
      setEditItem(null)
      fetchData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setIsSaving(false)
    }
  }

  const isItemDisabled = (item: ConfigItem) => {
    const itemSecrets = getSecretsForItem(item.id)
    return itemSecrets.length > 0 && itemSecrets.every(s => s.status === 'disabled')
  }

  const handleToggleSecretStatus = async (item: ConfigItem) => {
    if (!currentUser) return
    const disabled = isItemDisabled(item)
    try {
      const namespace = `user:${currentUser.id}:${item.pinyin}`
      for (const entry of item.entries) {
        if (disabled) {
          await enableUserSecret(namespace, entry.config_key)
        } else {
          await disableUserSecret(namespace, entry.config_key)
        }
      }
      toast.success(`已${disabled ? '启用' : '禁用'}「${item.name}」的凭据`)
      fetchData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    }
  }

  const formatExpiry = (expiresAt: number | null) => {
    if (!expiresAt) return null
    const diff = expiresAt - Date.now()
    if (diff <= 0) return { text: '已过期', urgent: true }
    const hours = Math.floor(diff / 3600000)
    const days = Math.floor(hours / 24)
    if (days > 0) return { text: `${days}天后过期`, urgent: false }
    return { text: `${hours}小时后过期`, urgent: true }
  }

  if (isLoading) {
    return <DashboardLayout title="用户凭据" description="管理用户级别的凭据"><UserSecretsSkeleton /></DashboardLayout>
  }

  return (
    <DashboardLayout title="用户凭据" description="管理用户级别的凭据">
      <div className="space-y-3">
        {configItems.map(item => {
          const itemSecrets = getSecretsForItem(item.id)
          const meta = getMetadataForItem(item.id)
          const isConfigured = itemSecrets.length > 0
          const expiry = formatExpiry(meta?.expires_at ?? null)

          return (
            <div key={item.id} className={`flex items-center gap-4 p-4 border rounded-lg ${expiry?.urgent ? 'border-destructive/50' : ''}`}>
              {/* Icon */}
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                {item.icon ? (
                  <img src={item.icon} alt={item.name} className="size-6 rounded" />
                ) : (
                  <Shield className="size-5 text-muted-foreground" />
                )}
              </div>

              {/* Name + description + fields */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{item.name}</span>
                  <Badge variant={isConfigured ? 'default' : 'secondary'} className="text-xs">
                    {isConfigured ? '已配置' : '未配置'}
                  </Badge>
                  {isConfigured && isItemDisabled(item) && (
                    <Badge variant="outline" className="text-xs text-muted-foreground">已禁用</Badge>
                  )}
                  {expiry && (
                    <span className={`text-xs flex items-center gap-1 ${expiry.urgent ? 'text-destructive' : 'text-muted-foreground'}`}>
                      {expiry.urgent ? <AlertTriangle className="size-3" /> : <Clock className="size-3" />}
                      {expiry.text}
                    </span>
                  )}
                </div>
                {isConfigured ? (
                  <div className="flex items-center gap-4 mt-1.5">
                    {item.entries.map(entry => {
                      const secret = itemSecrets.find(s => s.key === entry.config_key)
                      const key = `${item.id}:${entry.config_key}`
                      const visible = showValues[key]
                      return (
                        <span key={entry.id} className="text-xs text-muted-foreground flex items-center gap-1">
                          {entry.name}:
                          <span className="font-mono">
                            {visible ? (secret?.value ?? '-') : '••••••••'}
                          </span>
                          <button onClick={() => setShowValues(v => ({ ...v, [key]: !v[key] }))} className="hover:text-foreground transition-colors">
                            {visible ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                          </button>
                        </span>
                      )
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground mt-1">尚未配置凭据</p>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1.5 shrink-0">
                <Button size="sm" variant={isConfigured ? 'outline' : 'default'} onClick={() => handleConfigure(item)}>
                  {isConfigured ? '编辑' : '配置'}
                </Button>
                {isConfigured && (
                  <Button variant="ghost" size="sm" onClick={() => handleToggleSecretStatus(item)} title={isItemDisabled(item) ? '启用凭据' : '禁用凭据'}>
                    {isItemDisabled(item) ? (
                      <><CheckCircle className="size-3 mr-1" />启用</>
                    ) : (
                      <><Ban className="size-3 mr-1" />禁用</>
                    )}
                  </Button>
                )}
              </div>
            </div>
          )
        })}

        {configItems.length === 0 && (
          <div className="flex flex-col items-center py-16 text-muted-foreground">
            <Shield className="size-12 mb-3 opacity-30" />
            <p>暂无用户凭据配置项</p>
            <p className="text-xs mt-1">请先在「配置项列表」中创建 scope 为用户凭据的配置项</p>
          </div>
        )}
      </div>

      {/* Edit Dialog */}
      <Dialog open={!!editItem} onOpenChange={open => !open && setEditItem(null)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="size-5" />
              {editItem?.name ?? ''} — {editItem && getSecretsForItem(editItem.id).some(s => s.value !== null) ? '编辑凭据' : '配置凭据'}
            </DialogTitle>
          </DialogHeader>
          {editItem && (
            <div className="space-y-4 py-2">
              {editItem.entries.map(entry => (
                <div key={entry.id} className="space-y-1.5">
                  <Label>{entry.name} {entry.required ? <span className="text-destructive">*</span> : ''}</Label>
                  <Input
                    type="password"
                    value={editValues[entry.config_key] ?? ''}
                    onChange={e => setEditValues(v => ({ ...v, [entry.config_key]: e.target.value }))}
                    placeholder={entry.config_desc || `输入新的${entry.name}，留空则保持不变`}
                  />
                  {entry.config_desc && <p className="text-xs text-muted-foreground">{entry.config_desc}</p>}
                </div>
              ))}
              <div className="space-y-1.5 pt-2 border-t">
                <Label>过期时间</Label>
                <div className="flex gap-2">
                  <Input type="date" value={editExpires} onChange={e => setEditExpires(e.target.value)} className="flex-1" />
                  {editExpires && <Button variant="ghost" size="sm" onClick={() => setEditExpires('')}>清除</Button>}
                </div>
                <p className="text-xs text-muted-foreground">留空表示永久不过期</p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditItem(null)}>取消</Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving && <Loader2 className="size-4 mr-1 animate-spin" />}保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}
