import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Brain, CheckCircle2, History, RefreshCw, Search, Settings2, XCircle } from 'lucide-react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { JsonEditor } from '@/components/ui/json-editor'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SharingPanel, type PickOption } from '@/components/agentify/sharing-panel'
import { CapabilitiesPanel, capabilityProblems } from '@/components/agentify/capabilities-panel'
import { getUsers } from '@/lib/api/auth'
import {
  DEFAULT_CONFIG,
  SHARE_TYPES,
  confirmCall,
  digestNow,
  disableAgentify,
  getAgentHistoryDoc,
  getAgentMemory,
  getNexusStatus,
  listA2ACalls,
  listAgentHistory,
  listAgentifyAgents,
  listConfirmations,
  saveAgentMemory,
  saveAgentifyConfig,
  type A2ACallView,
  type AgentifyAgent,
  type AgentifyConfig,
  type HistoryDoc,
  type HistoryPolicy,
  type NexusUpgradeReport,
} from '@/lib/api/agentify'

const STATUS_LABEL: Record<string, string> = {
  pending_confirmation: '待确认',
  queued: '排队中',
  running: '进行中',
  done: '完成',
  failed: '失败',
  rejected: '已拒绝',
  cancelled: '已取消',
  expired: '已过期',
}

const KIND_LABEL: Record<string, string> = {
  summary: '摘要',
  conversation: '对话',
  memory: '记忆',
  a2a: '协作',
  artifact: '产出',
  input: '输入',
}

const SHARE_TYPE_SHORT: Record<(typeof SHARE_TYPES)[number], string> = {
  conversation: '对话',
  summary: '摘要',
  input: '输入',
  output: '产出',
  intermediate: '中间文件',
  sharedMemory: '共享记忆',
}

const NEXUS_LABEL: Record<NexusUpgradeReport['status'], string> = {
  upgraded: '已升级',
  rolled_back: '升级失败，已回退',
  held: '暂缓升级',
  fresh: '新部署',
}

function fmt(ms: number | null | undefined): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'done') return 'default'
  if (status === 'failed' || status === 'rejected' || status === 'expired') return 'destructive'
  if (status === 'pending_confirmation') return 'outline'
  return 'secondary'
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

type HourKey = keyof HistoryPolicy

const HOUR_FIELDS: Array<{ key: HourKey; label: string; help: string }> = [
  { key: 'digestLookbackHours', label: '整理回溯（小时）', help: '最近活动在这段时间内的会话会被整理、可检索' },
  { key: 'decayHalfLifeHours', label: '检索衰减半衰期（小时）', help: '检索时越久远排名越靠后；0 = 不衰减' },
  { key: 'deleteAfterHours', label: '删除期限（小时）', help: '超过这段时间无活动的摘要、对话、产出和协作记录会被删除；0 = 永久保留；记忆条目不删除' },
]

function hoursText(h: number, key: HourKey): string {
  if (h === 0) return key === 'deleteAfterHours' ? '永久保留' : '不衰减'
  return h >= 24 && h % 24 === 0 ? `${h} 小时（${h / 24} 天）` : `${h} 小时`
}

/** Read a memory.* hours field from the JSON being edited; undefined when unset or the JSON is invalid. */
function readHours(configText: string, key: HourKey): { valid: boolean; value: number | undefined } {
  try {
    const v = (JSON.parse(configText) as { memory?: Record<string, unknown> }).memory?.[key]
    return { valid: true, value: typeof v === 'number' ? v : undefined }
  } catch {
    return { valid: false, value: undefined }
  }
}

const CONFIG_HELP = `所有设置都可以在前面几页填写；这里是同一份配置的 JSON。
a2a.capabilities: 本智能体对外提供的能力（kind=ask 只读问答；kind=task 委派任务，可设 requiresConfirmation / allowOutbound；callers 可为单个能力另设可调用的智能体）
a2a.callers: 可调用本智能体的其他智能体 { allow, deny }（名称 / ID，"*" 表示全部已开启协作的智能体；排除优先）
sharing: 每类数据的共享范围与名单，见下方「共享权限」。其他智能体不能直接读取本智能体的数据，只能提问，由本智能体交给它
a2a.confirmers: 可以确认委派任务的员工 ID（管理员始终可以）
memory.digestLookbackHours / decayHalfLifeHours / deleteAfterHours: 见上方，留空 = 服务器默认`

export default function AgentifyPage() {
  const [loading, setLoading] = useState(true)
  const [agents, setAgents] = useState<AgentifyAgent[]>([])
  const [home, setHome] = useState<'nexus' | 'local' | null>(null)
  const [nexus, setNexus] = useState<NexusUpgradeReport | null>(null)
  const [historyDefaults, setHistoryDefaults] = useState<HistoryPolicy | null>(null)
  const [filter, setFilter] = useState('')

  const [configAgent, setConfigAgent] = useState<AgentifyAgent | null>(null)
  const [configText, setConfigText] = useState('')
  const [saving, setSaving] = useState(false)
  const [userOptions, setUserOptions] = useState<PickOption[] | null>(null)
  const [configTab, setConfigTab] = useState('general')

  const [memoryAgent, setMemoryAgent] = useState<AgentifyAgent | null>(null)
  const [memoryText, setMemoryText] = useState('')

  const [historyAgent, setHistoryAgent] = useState<AgentifyAgent | null>(null)
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyItems, setHistoryItems] = useState<HistoryDoc[]>([])
  const [historyDoc, setHistoryDoc] = useState<HistoryDoc | null>(null)

  const [calls, setCalls] = useState<A2ACallView[]>([])
  const [callStatus, setCallStatus] = useState('all')
  const [callDetail, setCallDetail] = useState<A2ACallView | null>(null)
  const [pending, setPending] = useState<A2ACallView[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [a, n, c, p] = await Promise.all([
        listAgentifyAgents(),
        getNexusStatus().catch(() => null),
        listA2ACalls(callStatus === 'all' ? {} : { status: callStatus }),
        listConfirmations().catch(() => ({ calls: [] })),
      ])
      setAgents(a.agents)
      setHome(a.home)
      setHistoryDefaults(a.historyDefaults ?? null)
      setNexus(n?.nexus ?? null)
      setCalls(c.calls)
      setPending(p.calls)
    } catch (err) {
      toast.error(errorText(err, '加载失败'))
    } finally {
      setLoading(false)
    }
  }, [callStatus])

  useEffect(() => {
    void load()
  }, [load])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = q ? agents.filter(a => `${a.displayName} ${a.name} ${a.description}`.toLowerCase().includes(q)) : agents
    return [...list].sort((a, b) => Number(b.agentified) - Number(a.agentified) || a.displayName.localeCompare(b.displayName))
  }, [agents, filter])

  const openConfig = (agent: AgentifyAgent) => {
    setConfigAgent(agent)
    setConfigTab('general')
    setConfigText(JSON.stringify(agent.config ?? DEFAULT_CONFIG, null, 2))
    if (userOptions === null) {
      getUsers()
        .then(r => setUserOptions(r.users.filter(u => u.status === 'active').map(u => ({ value: u.id, label: u.displayName || u.name }))))
        .catch(() => setUserOptions([]))
    }
  }

  const parsedConfig = useMemo((): AgentifyConfig | null => {
    try {
      const c = JSON.parse(configText) as AgentifyConfig
      return c && typeof c === 'object' && c.sharing && c.a2a ? c : null
    } catch {
      return null
    }
  }, [configText])

  const updateConfig = (fn: (c: AgentifyConfig) => AgentifyConfig) => {
    if (!parsedConfig) return
    setConfigText(JSON.stringify(fn(parsedConfig), null, 2))
  }

  const agentOptions = useMemo(
    (): PickOption[] => agents.filter(a => a.id !== configAgent?.id).map(a => ({ value: a.name, label: a.displayName })),
    [agents, configAgent],
  )

  const setHours = (key: HourKey, raw: string) => {
    try {
      const cfg = JSON.parse(configText) as { memory?: Record<string, unknown> }
      const memory = { ...(cfg.memory ?? {}) }
      if (raw.trim() === '') delete memory[key]
      else memory[key] = Number(raw)
      setConfigText(JSON.stringify({ ...cfg, memory }, null, 2))
    } catch {
      // The inputs are disabled while the JSON is invalid.
    }
  }

  const saveConfig = async () => {
    if (!configAgent) return
    let parsed
    try {
      parsed = JSON.parse(configText)
    } catch {
      toast.error('配置不是合法的 JSON')
      setConfigTab('json')
      return
    }
    const problems = capabilityProblems(parsed?.a2a?.capabilities ?? [])
    if (problems.length > 0) {
      toast.error(problems[0]!)
      setConfigTab('capabilities')
      return
    }
    setSaving(true)
    try {
      await saveAgentifyConfig(configAgent.id, parsed)
      toast.success(`已保存 ${configAgent.displayName} 的协作配置`)
      setConfigAgent(null)
      await load()
    } catch (err) {
      toast.error(errorText(err, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const turnOff = async () => {
    if (!configAgent) return
    try {
      await disableAgentify(configAgent.id)
      toast.success(`已关闭 ${configAgent.displayName} 的协作（已有记录保留）`)
      setConfigAgent(null)
      await load()
    } catch (err) {
      toast.error(errorText(err, '操作失败'))
    }
  }

  const openMemory = async (agent: AgentifyAgent) => {
    setMemoryAgent(agent)
    setMemoryText('')
    try {
      setMemoryText((await getAgentMemory(agent.id)).text)
    } catch (err) {
      toast.error(errorText(err, '读取记忆失败'))
    }
  }

  const saveMemory = async () => {
    if (!memoryAgent) return
    try {
      await saveAgentMemory(memoryAgent.id, memoryText)
      toast.success('记忆已保存')
      setMemoryAgent(null)
    } catch (err) {
      toast.error(errorText(err, '保存失败'))
    }
  }

  const searchHistory = async (agent: AgentifyAgent, q: string) => {
    try {
      const r = await listAgentHistory(agent.id, q.trim() ? { q } : { limit: 50 })
      setHistoryItems(r.hits ?? r.items ?? [])
    } catch (err) {
      toast.error(errorText(err, '读取历史失败'))
    }
  }

  const openHistory = async (agent: AgentifyAgent) => {
    setHistoryAgent(agent)
    setHistoryQuery('')
    setHistoryDoc(null)
    await searchHistory(agent, '')
  }

  const showDoc = async (doc: HistoryDoc) => {
    if (!historyAgent) return
    try {
      setHistoryDoc(await getAgentHistoryDoc(historyAgent.id, doc.docId ?? doc.id))
    } catch (err) {
      toast.error(errorText(err, '读取失败'))
    }
  }

  const runDigest = async () => {
    if (!historyAgent) return
    try {
      const r = await digestNow(historyAgent.id)
      toast.success(`已整理 ${r.digested} 个会话`)
      await searchHistory(historyAgent, historyQuery)
    } catch (err) {
      toast.error(errorText(err, '整理失败'))
    }
  }

  const decide = async (call: A2ACallView, approve: boolean) => {
    try {
      await confirmCall(call.id, approve)
      toast.success(approve ? '已确认，任务开始执行' : '已拒绝')
      await load()
    } catch (err) {
      toast.error(errorText(err, '操作失败'))
    }
  }

  return (
    <DashboardLayout title="协作智能体" description="让智能体拥有跨会话、跨员工的记忆，并与其他岗位的智能体互相查询、委派任务">
      <div className="p-6 space-y-4">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Badge variant="outline">记忆存储：{home === 'nexus' ? 'Nexus VFS' : home === 'local' ? '本地目录' : '—'}</Badge>
          {nexus ? (
            <Badge variant={nexus.status === 'rolled_back' ? 'destructive' : 'outline'}>
              Nexus {nexus.running}（{NEXUS_LABEL[nexus.status]}
              {nexus.status === 'upgraded' && nexus.secrets !== null ? `，${nexus.secrets} 条密钥${nexus.verified ? '已逐条校验' : '可读取'}` : ''}）
            </Badge>
          ) : null}
          {nexus?.error ? <span className="text-destructive">{nexus.error}</span> : null}
          <div className="ml-auto">
            <Button variant="outline" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={`size-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
              刷新
            </Button>
          </div>
        </div>

        <Tabs defaultValue="agents">
          <TabsList>
            <TabsTrigger value="agents">智能体</TabsTrigger>
            <TabsTrigger value="calls">协作记录</TabsTrigger>
            <TabsTrigger value="pending">待确认{pending.length > 0 ? `（${pending.length}）` : ''}</TabsTrigger>
          </TabsList>

          <TabsContent value="agents" className="space-y-3">
            <div className="relative max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input className="pl-9" placeholder="搜索智能体..." value={filter} onChange={e => setFilter(e.target.value)} />
            </div>
            <div className="border rounded-lg overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>智能体</TableHead>
                    <TableHead>协作</TableHead>
                    <TableHead>对外能力</TableHead>
                    <TableHead title="共享范围为「员工 + 其他智能体」的数据">交给其他智能体</TableHead>
                    <TableHead>历史记录</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading && agents.length === 0
                    ? Array.from({ length: 4 }).map((_, i) => (
                        <TableRow key={i}>
                          <TableCell colSpan={6}><Skeleton className="h-6" /></TableCell>
                        </TableRow>
                      ))
                    : shown.map(agent => (
                        <TableRow key={agent.id}>
                          <TableCell className="max-w-[300px]">
                            <div className="font-medium truncate">{agent.displayName}</div>
                            <div className="text-xs text-muted-foreground truncate" title={agent.description}>
                              {agent.name}{agent.description ? ` · ${agent.description}` : ''}
                            </div>
                          </TableCell>
                          <TableCell>
                            {agent.agentified ? <Badge>已开启</Badge> : <Badge variant="secondary">未开启</Badge>}
                          </TableCell>
                          <TableCell className="text-sm max-w-[180px] truncate" title={agent.config?.a2a.capabilities.map(c => c.id).join("、")}>
                            {agent.config?.a2a.capabilities.length
                              ? agent.config.a2a.capabilities.map(c => c.id).join('、')
                              : '—'}
                          </TableCell>
                          <TableCell className="text-sm max-w-[140px] truncate" title="共享范围为「员工 + 其他智能体」的数据">
                            {agent.agentified && agent.config
                              ? SHARE_TYPES.filter(t => agent.config!.sharing?.[t]?.level === 'agents').map(t => SHARE_TYPE_SHORT[t]).join('、') || '—'
                              : '—'}
                          </TableCell>
                          <TableCell>{agent.documents}</TableCell>
                          <TableCell className="text-right space-x-1">
                            <Button size="sm" variant="outline" onClick={() => openConfig(agent)}>
                              <Settings2 className="size-4 mr-1" />配置
                            </Button>
                            <Button size="sm" variant="outline" disabled={!agent.agentified} onClick={() => void openMemory(agent)}>
                              <Brain className="size-4 mr-1" />记忆
                            </Button>
                            <Button size="sm" variant="outline" disabled={!agent.agentified} onClick={() => void openHistory(agent)}>
                              <History className="size-4 mr-1" />历史
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          <TabsContent value="calls" className="space-y-3">
            <div className="w-48">
              <Select value={callStatus} onValueChange={setCallStatus}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  {Object.entries(STATUS_LABEL).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="border rounded-lg overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>时间</TableHead>
                    <TableHead>发起方 → 对方</TableHead>
                    <TableHead>类型 / 能力</TableHead>
                    <TableHead>员工</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>结果</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {calls.length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">暂无协作记录</TableCell></TableRow>
                  ) : calls.map(call => (
                    <TableRow key={call.id} className="cursor-pointer" onClick={() => setCallDetail(call)}>
                      <TableCell className="whitespace-nowrap">{fmt(call.createdAt)}</TableCell>
                      <TableCell>{call.caller.name} → {call.target.name}</TableCell>
                      <TableCell>{call.kind === 'ask' ? '查询' : '委派'} · {call.capability}</TableCell>
                      <TableCell>{call.actor?.name ?? '—'}</TableCell>
                      <TableCell><Badge variant={statusVariant(call.status)}>{STATUS_LABEL[call.status] ?? call.status}</Badge></TableCell>
                      <TableCell className="max-w-[360px] truncate text-sm" title={call.result ?? call.error ?? undefined}>{call.result ?? call.error ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          <TabsContent value="pending" className="space-y-3">
            {pending.length === 0 ? (
              <p className="text-sm text-muted-foreground">没有需要你确认的任务。</p>
            ) : pending.map(call => (
              <div key={call.id} className="border rounded-lg p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{call.caller.name} → {call.target.name}</span>
                  <Badge variant="outline">{call.capability}</Badge>
                  <span className="text-xs text-muted-foreground">发起员工：{call.actor?.name ?? '—'} · {fmt(call.createdAt)}</span>
                </div>
                <pre className="whitespace-pre-wrap text-sm bg-muted rounded p-3">{call.input}</pre>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void decide(call, true)}><CheckCircle2 className="size-4 mr-1" />确认执行</Button>
                  <Button size="sm" variant="outline" onClick={() => void decide(call, false)}><XCircle className="size-4 mr-1" />拒绝</Button>
                </div>
              </div>
            ))}
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={configAgent !== null} onOpenChange={open => !open && setConfigAgent(null)}>
        <DialogContent className="sm:max-w-6xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>协作配置：{configAgent?.displayName}</DialogTitle>
            <DialogDescription className="text-xs">
              开启后，此智能体的会话会整理为可检索的历史与记忆；其他智能体只能通过下方开放的能力向它提问或委派任务，数据按「共享权限」交接。
            </DialogDescription>
          </DialogHeader>
          <Tabs value={configTab} onValueChange={setConfigTab}>
            <TabsList>
              <TabsTrigger value="general">常规</TabsTrigger>
              <TabsTrigger value="capabilities">对外能力{parsedConfig?.a2a?.capabilities?.length ? `（${parsedConfig.a2a.capabilities.length}）` : ''}</TabsTrigger>
              <TabsTrigger value="sharing">共享权限</TabsTrigger>
              <TabsTrigger value="json">JSON</TabsTrigger>
            </TabsList>
            <TabsContent value="general" className="space-y-3 pt-2">
              <div className="grid gap-3 sm:grid-cols-3">
                {HOUR_FIELDS.map(f => {
                  const { valid, value } = readHours(configText, f.key)
                  const def = historyDefaults?.[f.key]
                  return (
                    <label key={f.key} className="space-y-1 text-sm">
                      <span className="font-medium whitespace-nowrap">{f.label}</span>
                      <Input
                        type="number"
                        min={0}
                        step={1}
                        aria-label={f.label}
                        disabled={!valid}
                        value={value ?? ''}
                        placeholder={def !== undefined ? `默认 ${def}` : '服务器默认'}
                        onChange={e => setHours(f.key, e.target.value)}
                      />
                      <span className="block text-xs text-muted-foreground">{f.help}{def !== undefined ? `（默认 ${hoursText(def, f.key)}）` : ''}</span>
                    </label>
                  )
                })}
              </div>
              {configAgent?.agentified ? (
                <p className="text-xs text-muted-foreground" data-testid="history-policy">
                  当前生效：回溯 {hoursText(configAgent.historyPolicy.digestLookbackHours, 'digestLookbackHours')} · 衰减半衰期 {hoursText(configAgent.historyPolicy.decayHalfLifeHours, 'decayHalfLifeHours')} · 删除期限 {hoursText(configAgent.historyPolicy.deleteAfterHours, 'deleteAfterHours')}（回溯不会超过删除期限）
                </p>
              ) : null}
              <label className="block space-y-1 text-sm max-w-xs">
                <span className="font-medium">记忆注入字数</span>
                <Input
                  type="number"
                  min={1}
                  aria-label="记忆注入字数"
                  disabled={!parsedConfig}
                  value={parsedConfig?.memory?.injectChars ?? ''}
                  onChange={e => updateConfig(c => ({ ...c, memory: { ...c.memory, injectChars: e.target.value === '' ? (undefined as unknown as number) : Number(e.target.value) } }))}
                />
                <span className="block text-xs text-muted-foreground">新会话开头带入的记忆与最近工作的字数上限（默认 4000）</span>
              </label>
            </TabsContent>
            <TabsContent value="capabilities" className="pt-2">
              <CapabilitiesPanel config={parsedConfig} onChange={updateConfig} users={userOptions ?? []} agents={agentOptions} />
            </TabsContent>
            <TabsContent value="sharing" className="pt-2">
              <SharingPanel config={parsedConfig} onChange={updateConfig} users={userOptions ?? []} agents={agentOptions} />
            </TabsContent>
            <TabsContent value="json" className="space-y-2 pt-2">
              <p className="whitespace-pre-line text-xs text-muted-foreground">{CONFIG_HELP}</p>
              <JsonEditor value={configText} onChange={setConfigText} height="420px" />
            </TabsContent>
          </Tabs>
          <DialogFooter className="gap-2">
            {configAgent?.agentified ? <Button variant="outline" onClick={() => void turnOff()}>关闭协作</Button> : null}
            <Button onClick={() => void saveConfig()} disabled={saving}>{configAgent?.agentified ? '保存' : '开启协作'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={memoryAgent !== null} onOpenChange={open => !open && setMemoryAgent(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>共享记忆：{memoryAgent?.displayName}</DialogTitle>
            <DialogDescription>按「共享权限」中共享记忆的设置提供给员工（及其他智能体提问时的回答）。每行一条，格式「- [时间 记录人] 内容」。</DialogDescription>
          </DialogHeader>
          <Textarea rows={16} value={memoryText} onChange={e => setMemoryText(e.target.value)} className="font-mono text-sm" />
          <DialogFooter>
            <Button onClick={() => void saveMemory()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={historyAgent !== null} onOpenChange={open => !open && setHistoryAgent(null)}>
        <DialogContent className="sm:max-w-6xl">
          <DialogHeader>
            <DialogTitle>历史与产出：{historyAgent?.displayName}</DialogTitle>
            <DialogDescription>会话结束后自动整理为摘要、对话与产出清单；关键词与语义混合检索。</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input
              placeholder="用中文提问或输入关键词，例如：上周返厂最多的品类"
              value={historyQuery}
              onChange={e => setHistoryQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && historyAgent && void searchHistory(historyAgent, historyQuery)}
            />
            <Button variant="outline" onClick={() => historyAgent && void searchHistory(historyAgent, historyQuery)}>
              <Search className="size-4 mr-1" />检索
            </Button>
            <Button variant="outline" onClick={() => void runDigest()}>立即整理</Button>
          </div>
          <div className="grid grid-cols-5 gap-3 h-[460px]">
            <div className="col-span-2 overflow-auto border rounded">
              {historyItems.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">没有记录</p>
              ) : historyItems.map(doc => (
                <button
                  key={doc.docId ?? doc.id}
                  className="w-full text-left p-3 border-b hover:bg-muted"
                  onClick={() => void showDoc(doc)}
                >
                  <div className="text-xs text-muted-foreground">{KIND_LABEL[doc.kind] ?? doc.kind} · {fmt(doc.activeAt ?? doc.createdAt)}</div>
                  <div className="text-sm font-medium truncate">{doc.title}</div>
                  {(doc.origin ?? doc.meta?.origin) ? (
                    <div className="text-xs text-muted-foreground truncate" title={String(doc.origin ?? doc.meta?.origin)}>来自：{String(doc.origin ?? doc.meta?.origin)}</div>
                  ) : null}
                  {doc.snippet ? <div className="text-xs text-muted-foreground line-clamp-2">{doc.snippet}</div> : null}
                </button>
              ))}
            </div>
            <div className="col-span-3 overflow-auto border rounded p-3">
              {historyDoc ? (
                <>
                  <div className="text-xs text-muted-foreground mb-2">{historyDoc.path}</div>
                  <pre className="whitespace-pre-wrap text-sm">{historyDoc.text}</pre>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">选择左侧记录查看全文</p>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={callDetail !== null} onOpenChange={open => !open && setCallDetail(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{callDetail?.caller.name} → {callDetail?.target.name}（{callDetail?.capability}）</DialogTitle>
            <DialogDescription>
              {callDetail ? `${STATUS_LABEL[callDetail.status] ?? callDetail.status} · 层级 ${callDetail.depth} · 员工 ${callDetail.actor?.name ?? '—'} · ${fmt(callDetail.createdAt)}` : ''}
            </DialogDescription>
          </DialogHeader>
          {callDetail ? (
            <div className="space-y-3 text-sm max-h-[60vh] overflow-auto">
              <div>
                <div className="font-medium mb-1">请求</div>
                <pre className="whitespace-pre-wrap bg-muted rounded p-3">{callDetail.input}</pre>
              </div>
              <div>
                <div className="font-medium mb-1">{callDetail.error ? '错误' : '结果'}</div>
                <pre className="whitespace-pre-wrap bg-muted rounded p-3">{callDetail.result ?? callDetail.error ?? '—'}</pre>
              </div>
              {callDetail.files.length > 0 ? (
                <div>
                  <div className="font-medium mb-1">文件</div>
                  <ul className="list-disc pl-5">{callDetail.files.map(f => <li key={f} className="font-mono text-xs">{f}</li>)}</ul>
                </div>
              ) : null}
              <div className="text-xs text-muted-foreground">
                发起会话 {callDetail.callerSessionId ?? '—'} · 执行会话 {callDetail.targetSessionId ?? '—'}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}
