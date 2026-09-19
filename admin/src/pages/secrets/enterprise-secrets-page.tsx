'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { ListEmptyState, ListError, ListPagination, ListSkeleton, ListStatusBadge, ListSurface, ListToolbar } from '@/components/list-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { Link } from 'react-router-dom'
import { Shield, Loader2, RefreshCw, ExternalLink, Ban, CheckCircle } from 'lucide-react'
import { useAuth } from '@/lib/hooks/use-auth'
import { hasScope } from '@/lib/api/client'
import { hasSavedCredentialField } from '@/lib/credential-list'
import {
  getEnterpriseSecrets, getSecretMetadata, getConfigItems,
  putSecret, enableSecret, disableSecret, updateSecretMetadata,
  type SecretListEntry, type ConfigItem, type SecretMetadata,
} from '@/lib/api/secrets'

const PAGE_SIZE = 20

type EnterpriseSecret = SecretListEntry & { config_item: ConfigItem }
type EnterpriseResult = {
  query: string
  items: ConfigItem[]
  total: number
  secrets: EnterpriseSecret[]
  metadata: SecretMetadata[]
}

export default function EnterpriseSecretsPage() {
  const { scopes, activeOrgId } = useAuth()
  const canWrite = hasScope(scopes, 'admin:secrets:write')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<EnterpriseResult | null>(null)
  const [load, setLoad] = useState({ query: '', busy: true, error: false })
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [pendingId, setPendingId] = useState<number | null>(null)
  const query = JSON.stringify([activeOrgId, page])
  const hasData = result?.query === query
  const isLoading = load.query !== query || load.busy
  const loadError = load.query === query && load.error
  const fetchData = useCallback(() => setRefreshVersion(value => value + 1), [])

  // Edit inputs are always blank; no individual secret is fetched for editing.
  const [editItem, setEditItem] = useState<ConfigItem | null>(null)
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const [editExpires, setEditExpires] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoad({ query, busy: true, error: false })
    const loadData = async () => {
      try {
        const itemsRes = await getConfigItems({ scope: 'system', status: '1', page, page_size: PAGE_SIZE })
        if (!active) return
        const lastPage = Math.max(1, Math.ceil(itemsRes.total / PAGE_SIZE))
        if (page > lastPage) { setPage(lastPage); return }
        const [secrets, metadata] = await Promise.all([
          getEnterpriseSecrets(itemsRes.items),
          getSecretMetadata(itemsRes.items),
        ])
        if (active) setResult({ query, items: itemsRes.items, total: itemsRes.total, secrets, metadata })
      } catch {
        if (active) setLoad({ query, busy: true, error: true })
      } finally {
        if (active) setLoad(state => ({ ...state, busy: false }))
      }
    }
    void loadData()
    return () => { active = false }
  }, [query, page, refreshVersion])

  const secretsByItem = useMemo(() => {
    const grouped = new Map<number, EnterpriseSecret[]>()
    for (const secret of result?.secrets ?? []) {
      const group = grouped.get(secret.config_item.id) ?? []
      group.push(secret)
      grouped.set(secret.config_item.id, group)
    }
    return grouped
  }, [result])
  const metadataByItem = useMemo(() => new Map(result?.metadata.map(item => [item.config_item_id, item]) ?? []), [result])
  const getSecretsForItem = (id: number) => secretsByItem.get(id) ?? []
  const editEntryHasValue = (configKey: string) => editItem !== null
    && hasSavedCredentialField(getSecretsForItem(editItem.id), configKey)
  const isItemDisabled = (item: ConfigItem) => {
    const secrets = getSecretsForItem(item.id)
    return secrets.length > 0 && secrets.every(secret => secret.status === 'disabled')
  }

  const closeEditor = () => {
    setEditItem(null)
    setEditValues({})
    setEditExpires('')
    setSaveError(null)
  }
  const handleConfigure = (item: ConfigItem) => {
    if (!canWrite) return
    setEditItem(item)
    setEditValues(Object.fromEntries(item.entries.map(entry => [entry.config_key, ''])))
    const expiry = metadataByItem.get(item.id)?.expires_at
    setEditExpires(expiry ? new Date(expiry).toISOString().slice(0, 10) : '')
  }

  const handleSave = async () => {
    if (!editItem || !canWrite || isSaving) return
    for (const entry of editItem.entries) {
      if (entry.required && !editEntryHasValue(entry.config_key) && !(editValues[entry.config_key]?.trim())) {
        toast.error(`请填写必填项：${entry.name}`)
        return
      }
    }
    setIsSaving(true)
    setSaveError(null)
    try {
      const namespace = `system:${editItem.pinyin}`
      for (const entry of editItem.entries) {
        const val = editValues[entry.config_key]
        if (val && val.trim()) {
          await putSecret(namespace, entry.config_key, val)
        }
      }
      const expiresAt = editExpires ? new Date(editExpires).getTime() : null
      await updateSecretMetadata(editItem.id, expiresAt)
      toast.success('凭据已保存')
      closeEditor()
      fetchData()
    } catch (err) {
      const message = err instanceof Error ? err.message : '保存失败'
      setSaveError(`保存未完成，部分更新可能已生效且不会自动回滚。请核对后重试。${message}`)
      toast.error('凭据保存未完成，请查看提示')
      fetchData()
    } finally {
      setIsSaving(false)
    }
  }

  const handleToggleSecretStatus = async (item: ConfigItem) => {
    if (!canWrite || pendingId !== null) return
    const disabled = isItemDisabled(item)
    setPendingId(item.id)
    try {
      const namespace = `system:${item.pinyin}`
      for (const entry of item.entries) {
        if (disabled) await enableSecret(namespace, entry.config_key)
        else await disableSecret(namespace, entry.config_key)
      }
      toast.success(`已${disabled ? '启用' : '禁用'}「${item.name}」的凭据`)
      fetchData()
    } catch (err) {
      toast.error(`操作未完成，部分字段状态可能已更新。${err instanceof Error ? err.message : '请重试'}`)
      fetchData()
    } finally {
      setPendingId(null)
    }
  }

  return (
    <DashboardLayout title="企业凭据" description="管理企业共享凭据，只展示保存状态，不展示明文">
      <div className="space-y-4">
        <ListToolbar actions={<Button variant="outline" size="sm" onClick={fetchData} disabled={isLoading}>
          <RefreshCw className={`size-3.5 ${isLoading ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />刷新
        </Button>}>
          <span className="text-[13px] text-muted-foreground">仅显示已启用的企业配置项</span>
        </ListToolbar>
        {loadError && <ListError title={hasData ? '刷新企业凭据失败' : '无法加载企业凭据'} description={hasData ? '当前显示上次加载的结果，请重新加载。' : '请检查连接及访问权限后重试。'} onRetry={fetchData} retrying={isLoading} />}
        {!hasData && isLoading ? <ListSkeleton label="正在加载企业凭据" /> : hasData && (
          <ListSurface aria-label="企业凭据列表" aria-busy={isLoading} footer={<ListPagination page={page} pageSize={PAGE_SIZE} total={result.total} busy={isLoading || pendingId !== null} onPageChange={setPage} />}>
            {result.items.length > 0 ? <Table className="min-w-[840px]">
              <TableHeader><TableRow>
                <TableHead>凭据</TableHead><TableHead>字段保存状态</TableHead><TableHead>状态</TableHead><TableHead>有效期</TableHead><TableHead className="text-right">操作</TableHead>
              </TableRow></TableHeader>
              <TableBody>{result.items.map(item => {
                const secrets = getSecretsForItem(item.id)
                const configured = secrets.length > 0
                const disabled = isItemDisabled(item)
                const expiry = metadataByItem.get(item.id)?.expires_at
                const expired = expiry != null && expiry <= Date.now()
                return <TableRow key={item.id}>
                  <TableCell><div className="flex items-center gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                      {item.icon ? <img src={item.icon} alt="" className="size-5 rounded" /> : <Shield className="size-4 text-muted-foreground" aria-hidden="true" />}
                    </div>
                    <div className="max-w-60"><p className="truncate font-medium" title={item.name}>{item.name}</p><p className="truncate text-xs text-muted-foreground" title={item.description || item.pinyin}>{item.description || item.pinyin}</p></div>
                  </div></TableCell>
                  <TableCell><ul className="space-y-1">{item.entries.map(entry => <li key={entry.id} className="flex max-w-64 items-center gap-2 text-xs">
                    <span className="truncate text-muted-foreground" title={entry.name}>{entry.name}</span>
                    <span className="shrink-0">{hasSavedCredentialField(secrets, entry.config_key) ? '已保存' : '未配置'}</span>
                  </li>)}</ul></TableCell>
                  <TableCell><ListStatusBadge tone={configured && !disabled ? 'positive' : 'neutral'}>{configured ? disabled ? '已禁用' : '已启用' : '未配置'}</ListStatusBadge></TableCell>
                  <TableCell><div className="space-y-1 text-xs">
                    <p className={expired ? 'text-destructive' : 'text-muted-foreground'}>{expiry != null ? new Date(expiry).toLocaleDateString('zh-CN') : '未设有效期'}</p>
                    {expired && <span className="text-destructive">已过期</span>}
                    {!expired && expiry != null && expiry - Date.now() < 86400000 && <span className="text-destructive">24 小时内到期</span>}
                  </div></TableCell>
                  <TableCell><div className="flex justify-end gap-1">
                    {canWrite && <Button size="sm" variant="outline" onClick={() => handleConfigure(item)} disabled={isLoading || pendingId !== null}>{configured ? '编辑' : '配置'}</Button>}
                    {canWrite && configured && <Button variant="ghost" size="sm" onClick={() => handleToggleSecretStatus(item)} disabled={isLoading || pendingId !== null}>
                      {pendingId === item.id ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : disabled ? <CheckCircle className="size-3.5" /> : <Ban className="size-3.5" />}{disabled ? '启用' : '禁用'}
                    </Button>}
                    {configured && <Button variant="ghost" size="sm" asChild><Link to={`/secrets/audit-log?config_item_id=${item.id}`}><ExternalLink className="size-3.5" aria-hidden="true" />审计</Link></Button>}
                  </div></TableCell>
                </TableRow>
              })}</TableBody>
            </Table> : <ListEmptyState icon={<Shield />} title="暂无企业凭据配置项" description={canWrite ? '先创建企业分类的配置项并启用，再在这里保存凭据。' : '管理员启用企业配置项后，将显示在这里。'} action={canWrite ? <Button variant="outline" size="sm" asChild><Link to="/secrets/config-items">管理配置项</Link></Button> : undefined} />}
          </ListSurface>
        )}
      </div>

      <Dialog open={!!editItem} onOpenChange={open => { if (!open && !isSaving) closeEditor() }}>
        <DialogContent className="min-w-0 max-h-[85vh] overflow-y-auto sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="break-words">{getSecretsForItem(editItem?.id ?? 0).length > 0 ? '编辑凭据' : '配置凭据'}</DialogTitle>
            <DialogDescription className="break-words">{editItem?.name}。已保存的字段留空保留原值；尚未配置的必填项需要填写。</DialogDescription>
          </DialogHeader>
          {saveError && <p role="alert" className="break-words rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{saveError}</p>}
          {editItem && <fieldset disabled={isSaving} className="min-w-0 space-y-4 py-2">
            {editItem.entries.map(entry => <div key={entry.id} className="space-y-1.5">
              <Label htmlFor={`credential-${entry.id}`} className="flex flex-wrap items-center gap-2">
                <span>{entry.name} {entry.required ? <span className="text-destructive">*</span> : null}</span>
                <Badge variant="outline" className="text-xs font-normal text-muted-foreground">{hasSavedCredentialField(getSecretsForItem(editItem.id), entry.config_key) ? '已保存' : '未配置'}</Badge>
              </Label>
              <Input id={`credential-${entry.id}`} type="password" autoComplete="new-password" value={editValues[entry.config_key] ?? ''} onChange={e => setEditValues(values => ({ ...values, [entry.config_key]: e.target.value }))} placeholder={editEntryHasValue(entry.config_key) ? '留空保留原值' : `请输入${entry.name}`} />
              {entry.config_desc && <p className="break-words text-xs text-muted-foreground">{entry.config_desc}</p>}
            </div>)}
            <div className="space-y-1.5 border-t pt-3">
              <Label htmlFor="credential-expiry">过期时间</Label>
              <div className="flex gap-2"><Input id="credential-expiry" type="date" value={editExpires} onChange={e => setEditExpires(e.target.value)} className="min-w-0 flex-1" />{editExpires && <Button variant="ghost" size="sm" onClick={() => setEditExpires('')}>清除</Button>}</div>
              <p className="text-xs text-muted-foreground">留空表示永久不过期</p>
            </div>
          </fieldset>}
          <DialogFooter>
            <Button variant="outline" onClick={closeEditor} disabled={isSaving}>取消</Button>
            <Button onClick={handleSave} disabled={isSaving || !canWrite}>{isSaving && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />}保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}
