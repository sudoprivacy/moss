import { useEffect, useMemo, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { getOrgDirectory, type OrgDirectory } from '@/lib/api/auth'
import type { VisibleTo } from '@/lib/api/agent-hub'

/**
 * Who may use a custom or tenant (专属) skill/agent. One of these four scopes;
 * the creator is always included. Any department or user of the org may be
 * chosen (the server re-validates the ids).
 */
export type CustomVisibilityMode = 'all' | 'departments' | 'users' | 'self'

export type CustomVisibilityValue = {
  mode: CustomVisibilityMode
  departmentIds: string[]
  userIds: string[]
}

/** Read a stored scope. Empty lists and the retired "admins only" read as only me. */
export function customVisibilityFrom(visibleTo: VisibleTo | null | undefined, ownerId: string | null | undefined): CustomVisibilityValue {
  if (!visibleTo || (visibleTo.department_ids == null && visibleTo.user_ids == null)) {
    return { mode: 'all', departmentIds: [], userIds: [] }
  }
  if (visibleTo.department_ids?.length) {
    return { mode: 'departments', departmentIds: visibleTo.department_ids, userIds: [] }
  }
  const userIds = (visibleTo.user_ids ?? []).filter(id => id !== 'admin')
  if (userIds.length && !(userIds.length === 1 && userIds[0] === ownerId)) {
    return { mode: 'users', departmentIds: [], userIds }
  }
  return { mode: 'self', departmentIds: [], userIds: [] }
}

/** Build the scope to save. An empty department/user choice saves as only me. */
export function customVisibleToFrom(value: CustomVisibilityValue, ownerId: string): VisibleTo | null {
  if (value.mode === 'all') return null
  if (value.mode === 'departments' && value.departmentIds.length) {
    return { department_ids: value.departmentIds, user_ids: null }
  }
  if (value.mode === 'users' && value.userIds.length) {
    return { department_ids: null, user_ids: value.userIds }
  }
  return { department_ids: null, user_ids: [ownerId] }
}

/** Hint for custom items: admins get no special use rights. */
export const CUSTOM_SCOPE_HINT = '创建者本人始终可用；管理员可在后台查看，但同样仅在上述范围内才能使用。'
/** Hint for tenant (专属) items: widening an approved scope needs re-approval. */
export const TENANT_SCOPE_HINT = '创建者本人与管理员始终可用。已审批的智能体/技能扩大可见范围需管理员重新审批，缩小范围立即生效。'

export function CustomVisibilityPicker({
  value,
  onChange,
  ownerId,
  hint = CUSTOM_SCOPE_HINT,
}: {
  value: CustomVisibilityValue
  onChange: (value: CustomVisibilityValue) => void
  ownerId: string | null | undefined
  hint?: string
}) {
  const [directory, setDirectory] = useState<OrgDirectory | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    getOrgDirectory()
      .then(result => { if (!cancelled) setDirectory(result) })
      .catch(() => { if (!cancelled) setLoadFailed(true) })
    return () => { cancelled = true }
  }, [])

  const departmentOptions = useMemo(() => {
    const departments = directory?.departments ?? []
    const build = (parentId: string | null, depth: number): Array<{ id: string; name: string; depth: number }> =>
      departments
        .filter(d => d.parentId === parentId)
        .flatMap(d => [{ id: d.id, name: d.name, depth }, ...build(d.id, depth + 1)])
    return build(null, 0)
  }, [directory])
  // The owner is always included, so they aren't offered as a pick.
  const userOptions = useMemo(
    () => (directory?.users ?? []).filter(u => u.id !== ownerId),
    [directory, ownerId],
  )

  const toggle = (list: string[], id: string, checked: boolean) =>
    checked ? [...list, id] : list.filter(item => item !== id)
  const emptyHint = loadFailed ? '加载组织架构失败' : directory ? null : '加载中…'

  return (
    <div className="space-y-3">
      <RadioGroup
        value={value.mode}
        onValueChange={mode => onChange({ ...value, mode: mode as CustomVisibilityMode })}
      >
        <div className="flex items-center gap-2">
          <RadioGroupItem value="all" />
          <label className="text-sm cursor-pointer">全员可用</label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="departments" />
          <label className="text-sm cursor-pointer">指定部门可用</label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="users" />
          <label className="text-sm cursor-pointer">指定人员可用</label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="self" />
          <label className="text-sm cursor-pointer">仅自己可用</label>
        </div>
      </RadioGroup>
      <p className="text-xs text-muted-foreground">{hint}</p>
      {value.mode === 'departments' ? (
        emptyHint || departmentOptions.length === 0 ? (
          <p className="text-xs text-muted-foreground">{emptyHint ?? '暂无部门数据'}</p>
        ) : (
          <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2 max-h-48 overflow-y-auto">
            {departmentOptions.map(dept => (
              <label
                key={dept.id}
                className="flex items-center gap-2 text-sm cursor-pointer hover:bg-accent/30 rounded px-2 py-1"
              >
                <Checkbox
                  checked={value.departmentIds.includes(dept.id)}
                  onCheckedChange={checked =>
                    onChange({ ...value, departmentIds: toggle(value.departmentIds, dept.id, checked === true) })
                  }
                />
                <span>{'— '.repeat(dept.depth)}{dept.name}</span>
              </label>
            ))}
          </div>
        )
      ) : value.mode === 'users' ? (
        emptyHint || userOptions.length === 0 ? (
          <p className="text-xs text-muted-foreground">{emptyHint ?? '暂无其他用户'}</p>
        ) : (
          <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2 max-h-48 overflow-y-auto">
            {userOptions.map(user => (
              <label
                key={user.id}
                className="flex items-center gap-2 text-sm cursor-pointer hover:bg-accent/30 rounded px-2 py-1"
              >
                <Checkbox
                  checked={value.userIds.includes(user.id)}
                  onCheckedChange={checked =>
                    onChange({ ...value, userIds: toggle(value.userIds, user.id, checked === true) })
                  }
                />
                <span>{user.displayName || user.name}</span>
              </label>
            ))}
          </div>
        )
      ) : null}
    </div>
  )
}
