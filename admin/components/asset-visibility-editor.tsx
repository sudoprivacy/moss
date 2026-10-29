import { useState } from 'react'
import type { VisibleTo } from '../lib/api/agent-hub'
import { Checkbox } from './ui/checkbox'
import { RadioGroup, RadioGroupItem } from './ui/radio-group'

export function AssetVisibilityEditor({ value, onChange, departments, users, canChooseDepartments, isScoped }: {
  value: VisibleTo | null
  onChange: (value: VisibleTo | null) => void
  departments: Array<{ id: string; name: string; depth: number }>
  users: Array<{ id: string; name?: string | null; email?: string | null }>
  canChooseDepartments: boolean
  isScoped: boolean
}) {
  const [mode, setMode] = useState(() => value?.department_ids?.length ? 'departments' : value?.user_ids?.length ? 'users'
    : value && (Array.isArray(value.department_ids) || Array.isArray(value.user_ids)) ? 'admin' : 'all')
  return <div className="space-y-3">
    <div className="text-sm font-medium">可见范围</div>
    <p className="text-xs text-muted-foreground">新版本审核发布后生效；本人仍可使用自己的未发布版本。{isScoped ? '可选范围受当前账户权限限制，管理员可在审核时调整。' : ''}</p>
    <RadioGroup value={mode} onValueChange={next => { setMode(next); onChange(next === 'all' ? null : next === 'departments' ? { department_ids: [], user_ids: null } : next === 'users' ? { department_ids: null, user_ids: [] } : { department_ids: [], user_ids: [] }) }}>
      {([['all', '全员可见'], ['departments', '指定部门可见'], ['users', '指定人员可见'], ['admin', '仅管理员可见']] as const).map(([key, label]) => <label key={key} className="flex items-center gap-2 text-sm cursor-pointer">
        <RadioGroupItem value={key} disabled={key === 'departments' && !canChooseDepartments} />{label}
      </label>)}
    </RadioGroup>
    {(mode === 'departments' || mode === 'users') && <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2 max-h-48 overflow-y-auto">
      {(mode === 'departments' ? departments : users).map(item => {
        const field = mode === 'departments' ? 'department_ids' : 'user_ids'
        const ids = value?.[field] ?? []
        return <label key={item.id} className="flex items-center gap-2 text-sm cursor-pointer">
          <Checkbox checked={ids.includes(item.id)} onCheckedChange={checked => onChange({ department_ids: value?.department_ids ?? null, user_ids: value?.user_ids ?? null, [field]: checked === true ? [...ids, item.id] : ids.filter(id => id !== item.id) })} />
          <span>{'depth' in item ? '— '.repeat(item.depth) : ''}{item.name || ('email' in item ? item.email : '') || item.id}</span>
        </label>
      })}
    </div>}
  </div>
}
