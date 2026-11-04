import { useMemo, useState } from 'react'
import { ChevronDown, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  DEFAULT_SHARE_LEVELS,
  SHARE_TYPES,
  type AccessList,
  type AgentifyConfig,
  type ShareLevel,
  type ShareType,
} from '@/lib/api/agentify'

export interface PickOption {
  value: string
  label: string
}

const TYPE_LABEL: Record<ShareType, { name: string; help: string }> = {
  conversation: { name: '对话正文', help: '会话的完整对话记录' },
  summary: { name: '工作摘要', help: '每次会话的摘要，以及与其他智能体的协作记录' },
  input: { name: '输入文件', help: '员工提供给会话的文件及其内容' },
  output: { name: '产出文件', help: '会话产出的文件、内容及文件清单' },
  intermediate: { name: '中间文件', help: '.drafts/ 下的过程文件' },
  sharedMemory: { name: '共享记忆', help: '智能体的共享记忆条目（个人记忆始终仅本人）' },
}

const LEVEL_LABEL: Record<ShareLevel, string> = {
  private: '仅本人',
  users: '本智能体员工',
  agents: '员工 + 其他智能体',
}

const EMPTY: AccessList = { allow: [], deny: [] }

/** A multi-select of names with search; `*` stands for everyone. */
function ListPicker(props: {
  options: PickOption[]
  value: string[]
  onChange: (next: string[]) => void
  placeholder: string
  disabled?: boolean
  label: string
}) {
  const [q, setQ] = useState('')
  const labelOf = (v: string) => (v === '*' ? '全部' : props.options.find(o => o.value === v)?.label ?? v)
  // Names typed into the JSON that are not in the list still show up.
  const all = useMemo(() => {
    const known = new Set(props.options.map(o => o.value))
    return [{ value: '*', label: '全部' }, ...props.options, ...props.value.filter(v => v !== '*' && !known.has(v)).map(v => ({ value: v, label: v }))]
  }, [props.options, props.value])
  const shown = q.trim() ? all.filter(o => `${o.label} ${o.value}`.toLowerCase().includes(q.trim().toLowerCase())) : all
  const text = props.value.length === 0 ? props.placeholder : props.value.map(labelOf).join('、')
  const toggle = (v: string, on: boolean) => props.onChange(on ? [...props.value, v] : props.value.filter(x => x !== v))
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={props.disabled}
          aria-label={props.label}
          className="w-full justify-between font-normal h-8 px-2"
        >
          <span className={`truncate text-left ${props.value.length === 0 ? 'text-muted-foreground' : ''}`}>{text}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start">
        <Input placeholder="搜索..." value={q} onChange={e => setQ(e.target.value)} className="h-8 mb-2" />
        <div className="max-h-56 overflow-y-auto space-y-0.5">
          {shown.map(o => (
            <label key={o.value} className="flex items-center gap-2 text-sm rounded px-2 py-1 cursor-pointer hover:bg-accent/40">
              <Checkbox checked={props.value.includes(o.value)} onCheckedChange={c => toggle(o.value, c === true)} />
              <span className="truncate">{o.label}</span>
            </label>
          ))}
          {shown.length === 0 ? <p className="text-xs text-muted-foreground px-2 py-1">没有匹配项</p> : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Allow + deny pickers for one list; `inherit` shows the list it falls back to when unset. */
function AccessPickers(props: {
  options: PickOption[]
  value: AccessList | undefined
  onChange: (next: AccessList | undefined) => void
  inheritText?: string
  disabled?: boolean
  label: string
}) {
  const v = props.value ?? EMPTY
  const inherited = props.value === undefined && props.inheritText !== undefined
  const set = (part: 'allow' | 'deny', names: string[]) => {
    const next = { ...v, [part]: names }
    props.onChange(next)
  }
  return (
    <div className="space-y-1 min-w-[180px]">
      <div className="flex items-center gap-1">
        <span className="text-xs text-muted-foreground w-8 shrink-0">允许</span>
        <ListPicker
          label={`${props.label} 允许`}
          options={props.options}
          value={v.allow}
          onChange={names => set('allow', names)}
          placeholder={inherited ? props.inheritText! : '无'}
          disabled={props.disabled}
        />
      </div>
      <div className="flex items-center gap-1">
        <span className="text-xs text-muted-foreground w-8 shrink-0">排除</span>
        <ListPicker
          label={`${props.label} 排除`}
          options={props.options}
          value={v.deny}
          onChange={names => set('deny', names)}
          placeholder={inherited ? '（同上）' : '无'}
          disabled={props.disabled}
        />
      </div>
      {props.value !== undefined && props.inheritText !== undefined && !props.disabled ? (
        <button type="button" className="text-xs text-muted-foreground hover:underline inline-flex items-center gap-1" onClick={() => props.onChange(undefined)}>
          <RotateCcw className="size-3" />
          恢复为{props.inheritText}
        </button>
      ) : null}
    </div>
  )
}

/**
 * Who sees which kind of data the agent keeps, and which agents may call it.
 * Edits the same config the JSON editor shows.
 */
export function SharingPanel(props: {
  config: AgentifyConfig | null
  onChange: (update: (config: AgentifyConfig) => AgentifyConfig) => void
  users: PickOption[]
  agents: PickOption[]
}) {
  const cfg = props.config
  if (!cfg) return <p className="text-xs text-destructive">配置 JSON 无效，修正后可使用下方的共享设置。</p>
  const sharing = cfg.sharing
  const callers = cfg.a2a?.callers ?? EMPTY
  const setSharing = (fn: (s: AgentifyConfig['sharing']) => AgentifyConfig['sharing']) => props.onChange(c => ({ ...c, sharing: fn(c.sharing) }))
  const setRule = (t: ShareType, patch: { level?: ShareLevel; users?: AccessList | undefined; agents?: AccessList | undefined }) =>
    setSharing(s => {
      const rule = { level: s[t]?.level ?? DEFAULT_SHARE_LEVELS[t], ...(s[t]?.users ? { users: s[t].users } : {}), ...(s[t]?.agents ? { agents: s[t].agents } : {}) }
      for (const [k, val] of Object.entries(patch) as Array<[keyof typeof rule, unknown]>) {
        if (val === undefined) delete rule[k]
        else (rule as Record<string, unknown>)[k] = val
      }
      return { ...s, [t]: rule }
    })

  return (
    <div className="space-y-3 text-sm">
      <div>
        <div className="font-medium">共享权限</div>
        <p className="text-xs text-muted-foreground">
          每类数据归本智能体所有。「仅本人」= 只有产生它的员工；「本智能体员工」= 还包括下方员工名单中的人；「员工 + 其他智能体」= 其他智能体提问时，本智能体可以查看并交给它（不能直接读取）。管理员始终可见全部。排除优先于允许。
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3 rounded-lg border p-3">
        <div className="space-y-1">
          <div className="text-xs font-medium">可调用本智能体的智能体</div>
          <AccessPickers
            label="可调用的智能体"
            options={props.agents}
            value={callers}
            onChange={next => props.onChange(c => ({ ...c, a2a: { ...c.a2a, callers: next ?? EMPTY } }))}
          />
          <p className="text-xs text-muted-foreground">单个能力可在 JSON 中用 callers 另设名单</p>
        </div>
        <div className="space-y-1">
          <div className="text-xs font-medium">默认员工名单</div>
          <AccessPickers label="默认员工名单" options={props.users} value={sharing.users} onChange={next => setSharing(s => ({ ...s, users: next ?? { allow: ['*'], deny: [] } }))} />
        </div>
        <div className="space-y-1">
          <div className="text-xs font-medium">默认智能体名单</div>
          <AccessPickers
            label="默认智能体名单"
            options={props.agents}
            value={sharing.agents}
            inheritText="同可调用的智能体"
            onChange={next =>
              setSharing(s => {
                const updated = { ...s }
                if (next) updated.agents = next
                else delete updated.agents
                return updated
              })
            }
          />
        </div>
      </div>
      <div className="border rounded-lg overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[150px]">数据</TableHead>
              <TableHead className="w-[170px]">共享范围</TableHead>
              <TableHead>员工</TableHead>
              <TableHead>其他智能体</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SHARE_TYPES.map(t => {
              const rule = sharing[t] ?? { level: DEFAULT_SHARE_LEVELS[t] }
              const levels: ShareLevel[] = t === 'sharedMemory' ? ['users', 'agents'] : ['private', 'users', 'agents']
              return (
                <TableRow key={t}>
                  <TableCell className="align-top">
                    <div className="font-medium">{TYPE_LABEL[t].name}</div>
                    <div className="text-xs text-muted-foreground whitespace-normal">{TYPE_LABEL[t].help}</div>
                  </TableCell>
                  <TableCell className="align-top">
                    <Select value={rule.level} onValueChange={v => setRule(t, { level: v as ShareLevel })}>
                      <SelectTrigger className="h-8" aria-label={`${TYPE_LABEL[t].name} 共享范围`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {levels.map(l => (
                          <SelectItem key={l} value={l}>{LEVEL_LABEL[l]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="align-top">
                    <AccessPickers
                      label={`${TYPE_LABEL[t].name} 员工`}
                      options={props.users}
                      value={rule.users}
                      inheritText="默认员工名单"
                      disabled={rule.level === 'private'}
                      onChange={next => setRule(t, { users: next })}
                    />
                  </TableCell>
                  <TableCell className="align-top">
                    <AccessPickers
                      label={`${TYPE_LABEL[t].name} 智能体`}
                      options={props.agents}
                      value={rule.agents}
                      inheritText="默认智能体名单"
                      disabled={rule.level !== 'agents'}
                      onChange={next => setRule(t, { agents: next })}
                    />
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
