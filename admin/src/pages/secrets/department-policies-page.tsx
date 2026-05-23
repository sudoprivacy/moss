'use client'

import { useEffect, useState, useCallback } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Checkbox } from '@/components/ui/checkbox'
import { toast } from 'sonner'
import { ChevronRight, ChevronDown, FolderTree, Save, Loader2, Search } from 'lucide-react'
import {
  getDepartmentPolicies, getConfigItems, updateDepartmentPolicies,
  type Department, type ConfigItem,
} from '@/lib/api/secrets'
import { getDepartments as getAuthDepartments } from '@/lib/api/auth'
import type { AuthDepartment } from '@/lib/api/types'

function TreeSkeleton() {
  return <div className="space-y-2 p-4">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
}

export default function DepartmentPoliciesPage() {
  const [departments, setDepartments] = useState<Department[]>([])
  const [configItems, setConfigItems] = useState<ConfigItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null)
  const [expandedDepts, setExpandedDepts] = useState<Set<string>>(new Set())
  const [selectedPolicyIds, setSelectedPolicyIds] = useState<number[]>([])
  const [isSaving, setIsSaving] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const buildDeptTree = (depts: AuthDepartment[]): Department[] => {
    const map = new Map<string, Department>()
    for (const d of depts) {
      map.set(d.id, { id: d.id, name: d.name, parent_id: d.parentId, children: [] })
    }
    const roots: Department[] = []
    for (const d of depts) {
      const node = map.get(d.id)!
      if (d.parentId && map.has(d.parentId)) {
        map.get(d.parentId)!.children!.push(node)
      } else {
        roots.push(node)
      }
    }
    return roots
  }

  const fetchData = useCallback(async () => {
    try {
      const [deptsRes, itemsRes] = await Promise.all([
        getAuthDepartments(),
        getConfigItems({ scope: 'system', status: '1' }),
      ])
      setDepartments(buildDeptTree(deptsRes.departments))
      setConfigItems(itemsRes.items)
    } catch {
      toast.error('获取数据失败')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const handleSelectDept = async (deptId: string) => {
    setSelectedDeptId(deptId)
    const policy = await getDepartmentPolicies(deptId)
    setSelectedPolicyIds(policy?.config_item_ids ?? [])
  }

  const toggleExpanded = (deptId: string) => {
    setExpandedDepts(prev => {
      const next = new Set(prev)
      if (next.has(deptId)) next.delete(deptId)
      else next.add(deptId)
      return next
    })
  }

  const handleSave = async () => {
    if (!selectedDeptId) return
    setIsSaving(true)
    try {
      await updateDepartmentPolicies(selectedDeptId, selectedPolicyIds)
      toast.success('部门授权已保存')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setIsSaving(false)
    }
  }

  const handleToggleItem = (itemId: number) => {
    setSelectedPolicyIds(prev =>
      prev.includes(itemId) ? prev.filter(id => id !== itemId) : [...prev, itemId]
    )
  }

  const getSelectedDept = () => {
    const find = (depts: Department[]): Department | null => {
      for (const d of depts) {
        if (d.id === selectedDeptId) return d
        if (d.children) { const found = find(d.children); if (found) return found }
      }
      return null
    }
    return find(departments)
  }

  const filterDepartments = (depts: Department[]): Department[] => {
    if (!searchQuery) return depts
    return depts.reduce<Department[]>((acc, d) => {
      const nameMatch = d.name.includes(searchQuery)
      const filteredChildren = d.children ? filterDepartments(d.children) : []
      if (nameMatch || filteredChildren.length > 0) {
        acc.push({ ...d, children: filteredChildren.length > 0 ? filteredChildren : d.children })
      }
      return acc
    }, [])
  }

  const renderDeptTree = (depts: Department[], level = 0) => (
    <ul className="space-y-0.5">
      {depts.map(dept => {
        const hasChildren = dept.children && dept.children.length > 0
        const isExpanded = expandedDepts.has(dept.id)
        const isSelected = selectedDeptId === dept.id
        return (
          <li key={dept.id}>
            <button
              onClick={() => { handleSelectDept(dept.id); if (hasChildren) toggleExpanded(dept.id) }}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left transition-colors ${
                isSelected ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-accent text-foreground'
              }`}
              style={{ paddingLeft: `${level * 16 + 8}px` }}
            >
              {hasChildren ? (
                isExpanded ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />
              ) : <span className="w-3.5 shrink-0" />}
              <FolderTree className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{dept.name}</span>
            </button>
            {hasChildren && isExpanded && renderDeptTree(dept.children!, level + 1)}
          </li>
        )
      })}
    </ul>
  )

  const selectedDept = getSelectedDept()
  const systemConfigItems = configItems.filter(c => c.scope === 'system')

  if (isLoading) {
    return (
      <DashboardLayout title="部门授权" description="配置部门对企业凭据的访问权限">
        <div className="grid grid-cols-[280px_1fr] gap-6 h-[calc(100vh-10rem)]">
          <Card className="overflow-hidden"><TreeSkeleton /></Card>
          <Skeleton className="h-full" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout title="部门授权" description="配置部门对企业凭据的访问权限">
      <div className="grid grid-cols-[280px_1fr] gap-6 h-[calc(100vh-10rem)]">
        {/* Department Tree */}
        <Card className="overflow-hidden flex flex-col">
          <div className="p-3 border-b">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input placeholder="搜索部门..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="h-8 pl-8 text-sm" />
            </div>
          </div>
          <ScrollArea className="flex-1 p-2">
            {renderDeptTree(filterDepartments(departments))}
          </ScrollArea>
        </Card>

        {/* Policy Config */}
        <div className="flex flex-col">
          {selectedDept ? (
            <>
              <Card className="flex-1 overflow-hidden flex flex-col">
                <div className="p-4 border-b">
                  <h3 className="font-medium">{selectedDept.name} — 授权配置</h3>
                  <p className="text-sm text-muted-foreground mt-0.5">选择该部门可访问的企业凭据配置项</p>
                </div>
                <ScrollArea className="flex-1 p-4">
                  <div className="space-y-3">
                    {systemConfigItems.map(item => (
                      <label key={item.id} className="flex items-start gap-3 p-3 border rounded-lg hover:bg-accent/50 transition-colors cursor-pointer">
                        <Checkbox
                          checked={selectedPolicyIds.includes(item.id)}
                          onCheckedChange={() => handleToggleItem(item.id)}
                          className="mt-0.5"
                        />
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm">{item.name}</span>
                            <Badge variant="secondary" className="text-xs">{item.scheme}</Badge>
                          </div>
                          {item.description && <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>}
                          {item.url_pattern && <p className="text-xs text-muted-foreground font-mono mt-0.5">{item.url_pattern}</p>}
                        </div>
                      </label>
                    ))}
                    {systemConfigItems.length === 0 && (
                      <div className="text-center py-8 text-muted-foreground">
                        <p className="text-sm">暂无可授权的企业配置项</p>
                        <p className="text-xs mt-1">请先在「配置项列表」中创建企业凭据配置项</p>
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </Card>
              <div className="flex justify-end pt-3">
                <Button onClick={handleSave} disabled={isSaving}>
                  {isSaving ? <Loader2 className="size-4 mr-1 animate-spin" /> : <Save className="size-4 mr-1" />}
                  保存授权
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground border rounded-lg border-dashed">
              <FolderTree className="size-10 mb-2 opacity-30" />
              <p className="text-sm">请在左侧选择一个部门</p>
              <p className="text-xs mt-1">选择后将展示该部门的授权配置</p>
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  )
}
