'use client'

import { useEffect, useState, useCallback } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'
import { Eye, EyeOff, Loader2, KeyRound, Info } from 'lucide-react'
import {
  getPublicConfigItems,
  getDepartmentSecretValue, putDepartmentSecretValue,
  type ConfigItem,
} from '@/lib/api/secrets'
import { getDepartments as getAuthDepartments } from '@/lib/api/auth'
import type { AuthDepartment } from '@/lib/api/types'

/**
 * Per-department credential editor for a dept_admin. Unlike the admin page
 * (which sets the org-wide value + department-authorization policy), this sets a
 * value SPECIFIC to a department in the dept_admin's subtree. The department
 * list is already narrowed to the caller's subtree by the server
 * (getDepartments), and writes are gated to that subtree server-side.
 */
export function DeptAdminDepartmentSecrets() {
  const [departments, setDepartments] = useState<AuthDepartment[]>([])
  const [configItems, setConfigItems] = useState<ConfigItem[]>([])
  const [selectedDeptId, setSelectedDeptId] = useState<string>('')
  const [isLoading, setIsLoading] = useState(true)

  const [editItem, setEditItem] = useState<ConfigItem | null>(null)
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const [showValues, setShowValues] = useState<Record<string, boolean>>({})
  const [usingOrgDefault, setUsingOrgDefault] = useState<Record<string, boolean>>({})
  const [isSaving, setIsSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const [deptsRes, items] = await Promise.all([
        getAuthDepartments(),
        // Public endpoint: department-scope config items the caller may use.
        getPublicConfigItems('department'),
      ])
      setDepartments(deptsRes.departments)
      setConfigItems(items)
      if (deptsRes.departments.length > 0) {
        setSelectedDeptId(prev => prev || deptsRes.departments[0].id)
      }
    } catch {
      toast.error('获取部门凭据信息失败')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const selectedDept = departments.find(d => d.id === selectedDeptId)

  const handleConfigure = async (item: ConfigItem) => {
    setEditItem(item)
    const vals: Record<string, string> = {}
    const orgDefault: Record<string, boolean> = {}
    item.entries.forEach(e => { vals[e.config_key] = '' })
    setEditValues(vals)
    setShowValues({})
    // Surface whether each key currently resolves to a per-dept value or the
    // inherited org default, so the dept_admin knows what they're overriding.
    await Promise.all(item.entries.map(async e => {
      try {
        const cur = await getDepartmentSecretValue(selectedDeptId, item.pinyin, e.config_key)
        orgDefault[e.config_key] = !!cur?.is_org_default || !cur
      } catch {
        orgDefault[e.config_key] = true
      }
    }))
    setUsingOrgDefault(orgDefault)
  }

  const handleSave = async () => {
    if (!editItem || !selectedDeptId) return
    for (const entry of editItem.entries) {
      if (entry.required && !(editValues[entry.config_key]?.trim())) {
        toast.error(`请填写必填项：${entry.name}`)
        return
      }
    }
    setIsSaving(true)
    try {
      for (const entry of editItem.entries) {
        const val = editValues[entry.config_key]
        if (val && val.trim()) {
          await putDepartmentSecretValue(selectedDeptId, editItem.pinyin, entry.config_key, val)
        }
      }
      toast.success(`已为「${selectedDept?.name ?? '部门'}」保存凭据`)
      setEditItem(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setIsSaving(false)
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="flex items-center gap-4 p-4 border rounded-lg">
            <Skeleton className="size-10 rounded-lg shrink-0" />
            <div className="flex-1 space-y-2"><Skeleton className="h-4 w-32" /><Skeleton className="h-3 w-48" /></div>
            <Skeleton className="h-8 w-20" />
          </div>
        ))}
      </div>
    )
  }

  if (departments.length === 0) {
    return (
      <div className="rounded-xl border border-dashed bg-muted/30 px-6 py-12 text-center text-muted-foreground">
        <KeyRound className="mx-auto mb-3 size-8 opacity-50" />
        您没有可管理的部门。
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Label className="text-sm text-muted-foreground">部门</Label>
        <Select value={selectedDeptId} onValueChange={setSelectedDeptId}>
          <SelectTrigger className="w-64"><SelectValue placeholder="选择部门" /></SelectTrigger>
          <SelectContent>
            {departments.map(d => (
              <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Info className="size-3.5" />
          为所选部门设置专属凭据值；未设置时该部门沿用企业默认值。
        </span>
      </div>

      {configItems.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-muted/30 px-6 py-12 text-center text-muted-foreground">
          暂无部门级凭据配置项。
        </div>
      ) : (
        <div className="space-y-3">
          {configItems.map(item => (
            <div key={item.id} className="flex items-center gap-4 rounded-lg border p-4">
              <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
                {item.icon ? <img src={item.icon} alt={item.name} className="size-full object-cover" /> : <KeyRound className="size-5" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{item.name}</span>
                  <Badge variant="outline" className="text-[10px]">{item.pinyin}</Badge>
                </div>
                {item.description ? <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">{item.description}</p> : null}
              </div>
              <Button size="sm" variant="outline" onClick={() => void handleConfigure(item)}>设置本部门值</Button>
            </div>
          ))}
        </div>
      )}

      <Dialog open={editItem !== null} onOpenChange={open => { if (!open) setEditItem(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editItem?.name} · {selectedDept?.name}</DialogTitle>
            <DialogDescription>
              为「{selectedDept?.name}」设置该凭据的专属值。仅影响此部门，其它部门不受影响。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {editItem?.entries.map(entry => (
              <div key={entry.config_key} className="space-y-1.5">
                <Label className="flex items-center gap-2">
                  {entry.name}
                  {entry.required ? <span className="text-destructive">*</span> : null}
                  {usingOrgDefault[entry.config_key] ? (
                    <Badge variant="secondary" className="text-[10px]">当前沿用企业默认</Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px]">已有本部门值</Badge>
                  )}
                </Label>
                <div className="relative">
                  <Input
                    type={showValues[entry.config_key] ? 'text' : 'password'}
                    value={editValues[entry.config_key] ?? ''}
                    placeholder={usingOrgDefault[entry.config_key] ? '留空则继续沿用企业默认值' : '留空则保持现有本部门值'}
                    onChange={e => setEditValues(v => ({ ...v, [entry.config_key]: e.target.value }))}
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                    onClick={() => setShowValues(s => ({ ...s, [entry.config_key]: !s[entry.config_key] }))}
                  >
                    {showValues[entry.config_key] ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditItem(null)}>取消</Button>
            <Button onClick={() => void handleSave()} disabled={isSaving}>
              {isSaving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
