import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { AgentifyCapability, AgentifyConfig } from '@/lib/api/agentify'
import { AccessPickers, EMPTY, ListPicker, type PickOption } from './sharing-panel'

const CAPABILITY_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Problems the server would reject, shown next to the field. */
export function capabilityProblems(caps: AgentifyCapability[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  caps.forEach((c, i) => {
    const n = `能力 ${i + 1}`
    if (!CAPABILITY_ID.test(c.id ?? '')) out.push(`${n}：ID 只能用小写字母、数字、- 或 _`)
    else if (seen.has(c.id)) out.push(`${n}：ID「${c.id}」重复`)
    seen.add(c.id)
    if (!c.description?.trim()) out.push(`${n}：请填写说明`)
  })
  return out
}

function CheckboxField(props: { label: string; help: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={`flex items-start gap-2 text-sm ${props.disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <Checkbox className="mt-0.5" checked={props.checked} disabled={props.disabled} onCheckedChange={v => props.onChange(v === true)} aria-label={props.label} />
      <span>
        <span className="font-medium">{props.label}</span>
        <span className="block text-xs text-muted-foreground">{props.help}</span>
      </span>
    </label>
  )
}

/**
 * What this agent offers other agents, who may call it, and who confirms
 * outward tasks. Edits the same config the JSON tab shows.
 */
export function CapabilitiesPanel(props: {
  config: AgentifyConfig | null
  onChange: (update: (config: AgentifyConfig) => AgentifyConfig) => void
  users: PickOption[]
  agents: PickOption[]
}) {
  const cfg = props.config
  if (!cfg) return <p className="text-xs text-destructive">配置 JSON 无效，请在「JSON」页修正后再使用此页。</p>
  const caps = cfg.a2a.capabilities ?? []
  const setA2a = (patch: Partial<AgentifyConfig['a2a']>) => props.onChange(c => ({ ...c, a2a: { ...c.a2a, ...patch } }))
  const setCap = (i: number, patch: Partial<AgentifyCapability>) =>
    props.onChange(c => {
      const next = [...c.a2a.capabilities]
      const cap: AgentifyCapability = { ...next[i]!, ...patch }
      // Read-only questions cannot confirm or act outward; acting outward needs confirmation.
      if (cap.kind === 'ask') {
        delete cap.requiresConfirmation
        delete cap.allowOutbound
      }
      if (cap.allowOutbound) cap.requiresConfirmation = true
      for (const k of Object.keys(cap) as Array<keyof AgentifyCapability>) if (cap[k] === undefined) delete cap[k]
      next[i] = cap
      return { ...c, a2a: { ...c.a2a, capabilities: next } }
    })
  const remove = (i: number) => props.onChange(c => ({ ...c, a2a: { ...c.a2a, capabilities: c.a2a.capabilities.filter((_, k) => k !== i) } }))
  const add = () =>
    props.onChange(c => {
      let n = c.a2a.capabilities.length + 1
      while (c.a2a.capabilities.some(x => x.id === `capability-${n}`)) n += 1
      return { ...c, a2a: { ...c.a2a, capabilities: [...c.a2a.capabilities, { id: `capability-${n}`, kind: 'ask', description: '' }] } }
    })
  const problems = capabilityProblems(caps)
  const hasOutbound = caps.some(c => c.allowOutbound)

  return (
    <div className="space-y-4 text-sm">
      <div className="grid gap-4 sm:grid-cols-2 rounded-lg border p-3">
        <div className="space-y-1">
          <div className="text-xs font-medium">可调用本智能体的智能体</div>
          <AccessPickers label="可调用的智能体" options={props.agents} value={cfg.a2a.callers ?? EMPTY} onChange={next => setA2a({ callers: next ?? EMPTY })} />
          <p className="text-xs text-muted-foreground">「全部」= 所有已开启协作的智能体。单个能力可另设名单。</p>
        </div>
        <div className="space-y-3">
          <div className="space-y-1">
            <div className="text-xs font-medium">任务确认人</div>
            <ListPicker
              label="任务确认人"
              allowAll={false}
              options={props.users}
              value={cfg.a2a.confirmers ?? []}
              onChange={names => setA2a({ confirmers: names })}
              placeholder="仅管理员"
            />
            <p className={`text-xs ${hasOutbound && (cfg.a2a.confirmers ?? []).length === 0 ? 'text-amber-600' : 'text-muted-foreground'}`}>
              需要确认的任务由这些员工在管理端左侧「待确认任务」中批准（不需要管理员权限）；管理员始终可以。
              {hasOutbound && (cfg.a2a.confirmers ?? []).length === 0 ? ' 有对外动作的能力，建议指定确认人。' : ''}
            </p>
          </div>
          <label className="block space-y-1">
            <span className="block text-xs font-medium">每日调用上限</span>
            <Input
              type="number"
              min={1}
              className="h-8 w-32"
              aria-label="每日调用上限"
              value={cfg.a2a.dailyCallLimit ?? ''}
              onChange={e => setA2a({ dailyCallLimit: e.target.value === '' ? (undefined as unknown as number) : Number(e.target.value) })}
            />
          </label>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium">对外能力</div>
          <p className="text-xs text-muted-foreground">其他智能体只能使用这里列出的能力。查询只读；任务可以产出文件，需对外动作时必须先经人工确认。</p>
        </div>
        <Button size="sm" variant="outline" onClick={add}>
          <Plus className="size-4 mr-1" />添加能力
        </Button>
      </div>

      {caps.length === 0 ? (
        <p className="text-sm text-muted-foreground border rounded-lg p-4 text-center">还没有对外能力：其他智能体无法向本智能体提问或委派任务。</p>
      ) : (
        caps.map((cap, i) => (
          <div key={i} className="rounded-lg border p-3 space-y-3" data-testid={`capability-${i}`}>
            <div className="grid gap-2 sm:grid-cols-[180px_150px_1fr_auto] items-start">
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">ID</span>
                <Input
                  className="h-8 font-mono"
                  aria-label={`能力 ${i + 1} ID`}
                  value={cap.id}
                  onChange={e => setCap(i, { id: e.target.value.trim() })}
                  aria-invalid={!CAPABILITY_ID.test(cap.id)}
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">类型</span>
                <Select value={cap.kind} onValueChange={v => setCap(i, { kind: v as AgentifyCapability['kind'] })}>
                  <SelectTrigger className="h-8" aria-label={`能力 ${i + 1} 类型`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ask">查询（只读）</SelectItem>
                    <SelectItem value="task">委派任务</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">说明（其他智能体据此判断何时使用）</span>
                <Input
                  className="h-8"
                  aria-label={`能力 ${i + 1} 说明`}
                  placeholder="例如：查询返厂统计、原因和结论"
                  value={cap.description}
                  onChange={e => setCap(i, { description: e.target.value })}
                />
              </label>
              <Button size="icon" variant="ghost" className="mt-5" aria-label={`删除能力 ${i + 1}`} onClick={() => remove(i)}>
                <Trash2 className="size-4" />
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
              <div className="space-y-2">
                <label className="block space-y-1">
                  <span className="text-xs text-muted-foreground">输入提示（可选）</span>
                  <Input
                    className="h-8"
                    aria-label={`能力 ${i + 1} 输入提示`}
                    placeholder="例如：周次或日期范围"
                    value={cap.input ?? ''}
                    onChange={e => setCap(i, { input: e.target.value || undefined })}
                  />
                </label>
                <CheckboxField
                  label="需要人工确认"
                  help="任务在「待确认任务」中等待确认人批准后才执行"
                  checked={cap.requiresConfirmation === true}
                  disabled={cap.kind === 'ask'}
                  onChange={v => setCap(i, { requiresConfirmation: v || undefined, ...(v ? {} : { allowOutbound: undefined }) })}
                />
                <CheckboxField
                  label="允许对外动作"
                  help="确认后可发送消息、发起审批等；会自动要求人工确认"
                  checked={cap.allowOutbound === true}
                  disabled={cap.kind === 'ask'}
                  onChange={v => setCap(i, { allowOutbound: v || undefined })}
                />
                <CheckboxField
                  label="限本智能体的使用者"
                  help="发起调用的员工也必须能直接使用本智能体"
                  checked={cap.requireCallerVisibility === true}
                  onChange={v => setCap(i, { requireCallerVisibility: v || undefined })}
                />
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">可使用此能力的智能体</span>
                <AccessPickers
                  label={`能力 ${i + 1} 调用方`}
                  options={props.agents}
                  value={cap.callers}
                  inheritText="可调用本智能体的智能体"
                  inherited={cfg.a2a.callers ?? EMPTY}
                  onChange={next => setCap(i, { callers: next })}
                />
              </div>
            </div>
          </div>
        ))
      )}
      {problems.length > 0 ? (
        <ul className="text-xs text-destructive list-disc pl-5" data-testid="capability-problems">
          {problems.map(p => <li key={p}>{p}</li>)}
        </ul>
      ) : null}
    </div>
  )
}
