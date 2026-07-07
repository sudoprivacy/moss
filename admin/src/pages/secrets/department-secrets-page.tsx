'use client'

import { useEffect, useState, useCallback } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { toast } from 'sonner'
import { Link } from 'react-router-dom'
import {
  Shield, Eye, EyeOff, Loader2, AlertTriangle, Clock, ExternalLink, Ban, CheckCircle,
  ChevronRight, ChevronDown, FolderTree, Minus,
} from 'lucide-react'
import {
  getDepartmentSecrets, getSecretMetadata, getConfigItems, putSecret,
  enableSecret, disableSecret, updateSecretMetadata,
  getConfigItemDepartments, updateConfigItemDepartments,
  type SecretEntry, type ConfigItem, type SecretMetadata,
} from '@/lib/api/secrets'
import {
  getDepartments as getAuthDepartments,
  getOrganizations,
} from '@/lib/api/auth'
import type { AuthDepartment, AuthOrgWithCounts } from '@/lib/api/types'
import { useAuth } from '@/lib/hooks/use-auth'
import { hasScope } from '@/lib/api/client'
import { DeptAdminDepartmentSecrets } from './dept-admin-department-secrets'

// ============================================================
// Department tree types (reused from old department-policies-page)
// ============================================================

type TreeNode = {
  id: string
  name: string
  parent_id: string | null
  kind: 'org' | 'dept'
  orgId?: string
  children?: TreeNode[]
}

function buildOrgFirstTree(depts: AuthDepartment[], orgs: AuthOrgWithCounts[]): TreeNode[] {
  const deptMap = new Map<string, TreeNode>()
  for (const d of depts) {
    deptMap.set(d.id, {
      id: d.id,
      name: d.name,
      parent_id: d.parentId,
      children: [],
      kind: 'dept',
      orgId: d.orgId,
    })
  }
  const orgRoots = new Map<string, TreeNode>()
  for (const org of orgs) {
    orgRoots.set(org.id, {
      id: `org:${org.id}`,
      name: org.name,
      parent_id: null,
      children: [],
      kind: 'org',
      orgId: org.id,
    })
  }
  for (const d of depts) {
    const node = deptMap.get(d.id)!
    if (d.parentId && deptMap.has(d.parentId)) {
      deptMap.get(d.parentId)!.children!.push(node)
    } else if (orgRoots.has(d.orgId)) {
      orgRoots.get(d.orgId)!.children!.push(node)
    }
  }
  return Array.from(orgRoots.values())
}

// ============================================================
// Skeleton
// ============================================================

function DepartmentSkeleton() {
  return (
    <div className="space-y-3">
      {[...Array(6)].map((_, i) => (
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

// ============================================================
// Main component
// ============================================================

export default function DepartmentSecretsPage() {
  const { scopes } = useAuth()
  // An admin sets the org-wide department value + department-authorization
  // policy (existing flow). A dept_admin (secrets:department:read, no
  // admin:secrets) instead sets a value specific to a department in their
  // subtree — a different, narrower surface.
  const isSecretsAdmin = hasScope(scopes, 'admin:secrets')
  if (!isSecretsAdmin) {
    return (
      <DashboardLayout title="部门凭据" description="为您管理的部门设置专属凭据值">
        <DeptAdminDepartmentSecrets />
      </DashboardLayout>
    )
  }
  return <DepartmentSecretsAdminPage />
}

function DepartmentSecretsAdminPage() {
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

  // Department tree
  const [tree, setTree] = useState<TreeNode[]>([])
  const [expandedDepts, setExpandedDepts] = useState<Set<string>>(new Set())
  const [selectedDeptIds, setSelectedDeptIds] = useState<string[]>([])

  const fetchData = useCallback(async () => {
    try {
      const itemsRes = await getConfigItems({ scope: 'department', status: '1' })
      const deptItems = itemsRes.items
      const [secretsRes, metaRes] = await Promise.all([
        getDepartmentSecrets(deptItems),
        getSecretMetadata(deptItems),
      ])
      setConfigItems(deptItems)
      setSecrets(secretsRes)
      setMetadata(metaRes)
    } catch {
      toast.error('获取部门凭据失败')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const getSecretsForItem = (itemId: number) => secrets.filter(s => s.config_item.id === itemId)
  const getMetadataForItem = (itemId: number) => metadata.find(m => m.config_item_id === itemId)

  const handleConfigure = async (item: ConfigItem) => {
    setEditItem(item)
    const vals: Record<string, string> = {}
    item.entries.forEach(e => { vals[e.config_key] = '' })
    setEditValues(vals)
    const meta = getMetadataForItem(item.id)
    setEditExpires(meta?.expires_at ? new Date(meta.expires_at).toISOString().slice(0, 10) : '')
    setShowValues({})

    // Load department tree and current associations
    try {
      const [deptsRes, orgsRes, currentDepts] = await Promise.all([
        getAuthDepartments(),
        getOrganizations(),
        getConfigItemDepartments(item.id),
      ])
      setTree(buildOrgFirstTree(deptsRes.departments, orgsRes.organizations))
      setSelectedDeptIds(currentDepts)
    } catch {
      setTree([])
      setSelectedDeptIds([])
    }
  }

  const handleSave = async () => {
    if (!editItem) return
    for (const entry of editItem.entries) {
      if (entry.required && !(editValues[entry.config_key]?.trim())) {
        toast.error(`请填写必填项：${entry.name}`)
        return
      }
    }
    if (selectedDeptIds.length === 0) {
      toast.error('请至少选择一个授权部门')
      return
    }
    setIsSaving(true)
    try {
      const namespace = `role:${editItem.pinyin}`
      for (const entry of editItem.entries) {
        const val = editValues[entry.config_key]
        if (val && val.trim()) {
          await putSecret(namespace, entry.config_key, val)
        }
      }
      if (editExpires !== undefined) {
        const expiresAt = editExpires ? new Date(editExpires).getTime() : null
        await updateSecretMetadata(editItem.id, expiresAt)
      }
      await updateConfigItemDepartments(editItem.id, selectedDeptIds)
      toast.success('部门凭据已保存')
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
    const disabled = isItemDisabled(item)
    try {
      const namespace = `role:${item.pinyin}`
      for (const entry of item.entries) {
        if (disabled) {
          await enableSecret(namespace, entry.config_key)
        } else {
          await disableSecret(namespace, entry.config_key)
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

  const toggleExpanded = (deptId: string) => {
    setExpandedDepts(prev => {
      const next = new Set(prev)
      if (next.has(deptId)) next.delete(deptId)
      else next.add(deptId)
      return next
    })
  }

  // All department ids in a node's subtree (the node itself + every descendant
  // department; org wrappers are skipped since they aren't selectable).
  const collectDeptSubtreeIds = (node: TreeNode): string[] => {
    const ids: string[] = []
    const walk = (n: TreeNode) => {
      if (n.kind === 'dept') ids.push(n.id)
      n.children?.forEach(walk)
    }
    walk(node)
    return ids
  }

  // Toggling a department cascades to its whole subtree: selecting adds the
  // department and all sub-departments; deselecting removes them all. The user
  // can still expand and toggle individual sub-departments afterward to
  // fine-tune the selection.
  const toggleDeptSelection = (node: TreeNode) => {
    const subtreeIds = collectDeptSubtreeIds(node)
    setSelectedDeptIds(prev => {
      const isSelected = prev.includes(node.id)
      if (isSelected) {
        const remove = new Set(subtreeIds)
        return prev.filter(id => !remove.has(id))
      }
      const next = new Set(prev)
      subtreeIds.forEach(id => next.add(id))
      return [...next]
    })
  }

  const renderTree = (nodes: TreeNode[], level = 0) => (
    <ul className="space-y-0.5">
      {nodes.map(node => {
        const hasChildren = node.children && node.children.length > 0
        const isExpanded = expandedDepts.has(node.id)
        const isSelected = selectedDeptIds.includes(node.id)
        const isOrg = node.kind === 'org'
        // A department is "partially" selected when it isn't itself selected but
        // some of its descendants are — surfaced as an indeterminate checkbox so
        // the cascade state is legible when the user has drilled in.
        const subtreeIds = !isOrg ? collectDeptSubtreeIds(node) : []
        const someDescendantSelected = subtreeIds.some(id => selectedDeptIds.includes(id))
        const isPartial = !isSelected && someDescendantSelected
        return (
          <li key={node.id}>
            <div
              className={`flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors ${
                isSelected && !isOrg
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'hover:bg-accent text-foreground'
              } ${isOrg ? 'font-semibold' : ''}`}
              style={{ paddingLeft: `${level * 16 + 8}px` }}
            >
              {!isOrg && (
                isPartial ? (
                  <button
                    type="button"
                    aria-label="部分选中，点击全选"
                    onClick={() => toggleDeptSelection(node)}
                    className="shrink-0 flex size-4 items-center justify-center rounded-[4px] border border-primary bg-primary/20 text-primary"
                  >
                    <Minus className="size-3" />
                  </button>
                ) : (
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => toggleDeptSelection(node)}
                    className="shrink-0"
                  />
                )
              )}
              <button
                onClick={() => {
                  if (hasChildren) toggleExpanded(node.id)
                }}
                className="flex items-center gap-2 flex-1 text-left"
              >
                {hasChildren ? (
                  isExpanded ? (
                    <ChevronDown className="size-3.5 shrink-0" />
                  ) : (
                    <ChevronRight className="size-3.5 shrink-0" />
                  )
                ) : (
                  <span className="w-3.5 shrink-0" />
                )}
                <FolderTree className={`size-3.5 shrink-0 ${isOrg ? 'text-primary' : 'text-muted-foreground'}`} />
                <span className="truncate">{node.name}</span>
              </button>
            </div>
            {hasChildren && isExpanded && renderTree(node.children!, level + 1)}
          </li>
        )
      })}
    </ul>
  )

  if (isLoading) {
    return <DashboardLayout title="部门凭据" description="管理按部门授权的共享凭据"><DepartmentSkeleton /></DashboardLayout>
  }

  return (
    <DashboardLayout title="部门凭据" description="管理按部门授权的共享凭据">
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
                  <>
                    <Button variant="ghost" size="sm" onClick={() => handleToggleSecretStatus(item)} title={isItemDisabled(item) ? '启用凭据' : '禁用凭据'}>
                      {isItemDisabled(item) ? (
                        <><CheckCircle className="size-3 mr-1" />启用</>
                      ) : (
                        <><Ban className="size-3 mr-1" />禁用</>
                      )}
                    </Button>
                    <Button variant="ghost" size="sm" asChild>
                      <Link to={`/secrets/audit-log?config_item_id=${item.id}`}>
                        <ExternalLink className="size-3 mr-1" />审计
                      </Link>
                    </Button>
                  </>
                )}
              </div>
            </div>
          )
        })}

        {configItems.length === 0 && (
          <div className="flex flex-col items-center py-16 text-muted-foreground">
            <Shield className="size-12 mb-3 opacity-30" />
            <p>暂无部门凭据配置项</p>
            <p className="text-xs mt-1">请先在「配置项列表」中创建 scope 为部门凭据的配置项</p>
          </div>
        )}
      </div>

      {/* Edit Dialog */}
      <Dialog open={!!editItem} onOpenChange={open => !open && setEditItem(null)}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="size-5" />
              {editItem?.name ?? ''} — {getSecretsForItem(editItem?.id ?? 0).some(s => s.value !== null) ? '编辑凭据' : '配置凭据'}
            </DialogTitle>
          </DialogHeader>
          {editItem && (
            <div className="space-y-4 py-2">
              {/* Credential values */}
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

              {/* Expiry */}
              <div className="space-y-1.5 pt-2 border-t">
                <Label>过期时间</Label>
                <div className="flex gap-2">
                  <Input type="date" value={editExpires} onChange={e => setEditExpires(e.target.value)} className="flex-1" />
                  {editExpires && <Button variant="ghost" size="sm" onClick={() => setEditExpires('')}>清除</Button>}
                </div>
                <p className="text-xs text-muted-foreground">留空表示永久不过期</p>
              </div>

              {/* Associated departments */}
              <div className="space-y-1.5 pt-2 border-t">
                <Label>关联部门</Label>
                <p className="text-xs text-muted-foreground">选择可访问此凭据的部门</p>
                <div className="border rounded-md max-h-[240px] overflow-auto">
                  <ScrollArea className="h-[240px]">
                    <div className="p-2">
                      {renderTree(tree)}
                      {tree.length === 0 && (
                        <p className="text-sm text-muted-foreground text-center py-4">暂无部门数据</p>
                      )}
                    </div>
                  </ScrollArea>
                </div>
                {selectedDeptIds.length > 0 && (
                  <p className="text-xs text-muted-foreground">已选择 {selectedDeptIds.length} 个部门</p>
                )}
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
