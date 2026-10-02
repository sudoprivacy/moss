import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ConfigScope } from '@/lib/api/types'

export function ConfigScopeSelect({ scope, allowPlatform, disabled, onChange }: {
  scope: ConfigScope
  allowPlatform: boolean
  disabled?: boolean
  onChange(scope: ConfigScope): void
}) {
  return <div className="flex flex-wrap items-center gap-3">
    <Label htmlFor="config-scope">配置范围</Label>
    <Select value={scope} disabled={disabled || !allowPlatform} onValueChange={value => {
      if (value === 'organization' || (value === 'platform' && allowPlatform)) onChange(value)
    }}>
      <SelectTrigger id="config-scope" className="w-40"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="organization">当前组织</SelectItem>
        {allowPlatform ? <SelectItem value="platform">平台</SelectItem> : null}
      </SelectContent>
    </Select>
  </div>
}
