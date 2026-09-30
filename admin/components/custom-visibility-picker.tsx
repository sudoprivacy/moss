import { useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { getOrgDirectory, type OrgDirectory } from '@/lib/api/auth'
import type { VisibleTo } from '@/lib/api/agent-hub'

/**
 * Who may use a custom or tenant (专属) skill/agent. One of these four scopes;
 * the creator is always included. Any department or user of the org may be
 * chosen (the server re-validates the ids).
 */
export type CustomVisibilityMode = 'all' | 'departments' | 'users' | 'self' | 'admins'

export type CustomVisibilityValue = {
  mode: CustomVisibilityMode
  departmentIds: string[]
  userIds: string[]
}

/**
 * Read a stored scope. Empty lists, the retired "admins only" value, and
 * `{ null, null }` (an old empty pick — shown as 全员 but visible to nobody)
 * read as only me.
 */
export function customVisibilityFrom(
  visibleTo: VisibleTo | null | undefined,
  ownerId: string | null | undefined,
  opts?: { allowAdminOnly?: boolean },
): CustomVisibilityValue {
  if (!visibleTo) {
    return { mode: 'all', departmentIds: [], userIds: [] }
  }
  // Tenant wikis keep 仅管理员可用 ({ [], [] }) as a real scope.
  if (
    opts?.allowAdminOnly
    && Array.isArray(visibleTo.department_ids) && visibleTo.department_ids.length === 0
    && Array.isArray(visibleTo.user_ids) && visibleTo.user_ids.length === 0
  ) {
    return { mode: 'admins', departmentIds: [], userIds: [] }
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
  if (value.mode === 'admins') return { department_ids: [], user_ids: [] }
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
/** Hint for tenant knowledge-base wikis: agents bound to them still deliver them. */
export const WIKI_SCOPE_HINT = '控制谁可在会话中直接使用此知识库。创建者本人与管理员始终可用；绑定了该知识库的智能体，其所有可用用户均可通过智能体使用它。'
/** Hint for tenant (专属) items: widening an approved scope needs re-approval. */
export const TENANT_SCOPE_HINT = '创建者本人与管理员始终可用。已审批的智能体/技能扩大可用范围需管理员重新审批，缩小范围立即生效。'

// One directory fetch per page load, shared by every picker and badge.
let directoryRequest: Promise<OrgDirectory> | null = null

/**
 * The org directory (departments + active users, names only), readable by any
 * member — so every role sees names, not ids, wherever a scope is shown.
 */
export function useOrgDirectory() {
  const [directory, setDirectory] = useState<OrgDirectory | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    directoryRequest ??= getOrgDirectory()
    directoryRequest
      .then(result => { if (!cancelled) setDirectory(result) })
      .catch(() => {
        directoryRequest = null
        if (!cancelled) setFailed(true)
      })
    return () => { cancelled = true }
  }, [])
  const names = useMemo(() => ({
    departments: new Map((directory?.departments ?? []).map(d => [d.id, d.name])),
    users: new Map((directory?.users ?? []).map(u => [u.id, u.displayName || u.name])),
  }), [directory])
  return { directory, failed, departmentName: (id: string) => names.departments.get(id), userName: (id: string) => names.users.get(id) }
}

/**
 * A stored scope as readable badges — names, never ids. Works for any item:
 * everyone / admins only / only the creator / departments / users.
 */
export function ScopeBadges({
  visibleTo,
  ownerId,
  badgeClassName = 'text-[10px]',
}: {
  visibleTo: VisibleTo | null | undefined
  ownerId?: string | null
  badgeClassName?: string
}) {
  const { directory, departmentName, userName } = useOrgDirectory()
  const note = (text: string) => <span className="text-[11px] text-muted-foreground">{text}</span>
  if (!visibleTo) return note('全员可用')
  const departmentIds = visibleTo.department_ids ?? []
  const userIds = (visibleTo.user_ids ?? []).filter(id => id !== 'admin')
  if (!departmentIds.length && !userIds.length) return note('仅管理员可用')
  if (!departmentIds.length && userIds.length === 1 && userIds[0] === ownerId) return note('仅创建者可用')
  const fallback = directory ? '（已删除）' : '…'
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {departmentIds.map(id => (
        <Badge key={id} variant="outline" className={badgeClassName}>{departmentName(id) ?? `部门${fallback}`}</Badge>
      ))}
      {userIds.map(id => (
        <Badge key={id} variant="outline" className={badgeClassName}>{userName(id) ?? `用户${fallback}`}</Badge>
      ))}
    </div>
  )
}

export function CustomVisibilityPicker({
  value,
  onChange,
  ownerId,
  hint = CUSTOM_SCOPE_HINT,
  allowAdminOnly = false,
}: {
  value: CustomVisibilityValue
  onChange: (value: CustomVisibilityValue) => void
  ownerId: string | null | undefined
  hint?: string
  /** Offer 仅管理员可用 (tenant wikis; custom/专属 agents and skills don't have it). */
  allowAdminOnly?: boolean
}) {
  const { directory, failed: loadFailed } = useOrgDirectory()

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
        {allowAdminOnly && (
          <div className="flex items-center gap-2">
            <RadioGroupItem value="admins" />
            <label className="text-sm cursor-pointer">仅管理员可用</label>
          </div>
        )}
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
