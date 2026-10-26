import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { getManagedAgent, getManagedAgents, startManagedAgent, upgradeUserRuntime, type ManagedAgentDetail, type ManagedAgentList } from '@/lib/api/agent-manager'
import { useAuth } from '@/lib/hooks/use-auth'
import { MossImBindingPanel } from '../components/moss-im-binding'

const PAGE_SIZE = 50
const stateLabels: Record<string, string> = {
  stopped: '已停止', ready: '就绪', busy: '执行中', awaiting_input: '等待回复',
  registered: '已注册', warming_up: '启动中', terminated: '已终止',
}

export default function AgentManagerPage() {
  const [result, setResult] = useState<ManagedAgentList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const onRefresh = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try { setResult(await getManagedAgents()) }
    catch (failure) { setError(failure instanceof Error ? failure.message : '无法加载 Agent') }
    finally { setIsLoading(false) }
  }, [])
  useEffect(() => { void onRefresh() }, [onRefresh])
  const onLoadMore = async () => {
    if (!result?.nextCursor) return
    setIsLoadingMore(true)
    try {
      const more = await getManagedAgents(result.nextCursor)
      setResult(current => current ? { ...more,
        agents: [...current.agents, ...more.agents],
        runtimeStates: [...current.runtimeStates, ...more.runtimeStates],
        unavailableOwners: [...new Set([...current.unavailableOwners, ...more.unavailableOwners])] } : more)
    } catch (failure) { setError(failure instanceof Error ? failure.message : '无法加载更多 Agent') }
    finally { setIsLoadingMore(false) }
  }
  const filtered = (result?.agents ?? []).filter(agent =>
    `${agent.displayName} ${agent.name} ${agent.ownerName} ${agent.ownerId}`.toLowerCase().includes(search.toLowerCase()))
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  return (
    <DashboardLayout title="Agent" description="当前企业内可访问的 Agent、运行状态和对话。"
      headerActions={<><Button asChild variant="outline"><Link to="/moss">我的 Moss Agent</Link></Button><Button variant="outline" disabled={isLoading} onClick={() => void onRefresh()}>刷新</Button></>}>
      <div className="space-y-4">
        <Input aria-label="搜索当前列表中的 Agent 或所有者" placeholder="搜索当前列表中的 Agent 或所有者" value={search}
          onChange={event => { setSearch(event.target.value); setPage(0) }} />
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {Boolean(result?.unavailableOwners.length) && <p role="alert">部分用户的运行环境暂时无法读取；恢复后可刷新查看。</p>}
        {isLoading ? <p role="status">正在加载 Agent…</p> : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader><TableRow><TableHead>Agent</TableHead><TableHead>所有者</TableHead><TableHead>状态</TableHead><TableHead>详情</TableHead></TableRow></TableHeader>
              <TableBody>
                {filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(agent => (
                  <TableRow key={`${agent.ownerId}:${agent.name}`}>
                    <TableCell><div>{agent.displayName}</div><div className="text-xs text-muted-foreground break-all">{agent.path}</div></TableCell>
                    <TableCell>{agent.ownerName}</TableCell>
                    <TableCell>{stateLabels[agent.state] || agent.state}
                      {result?.runtimeStates.some(state => state.ownerId === agent.ownerId && state.isDrifted) && <div className="text-xs text-amber-600">运行环境待升级</div>}
                    </TableCell>
                    <TableCell><Button asChild variant="outline" size="sm"><Link to={`/agents/${encodeURIComponent(agent.ownerId)}/${encodeURIComponent(agent.name)}`}>查看</Link></Button></TableCell>
                  </TableRow>
                ))}
                {!filtered.length && !error && <TableRow><TableCell colSpan={4}>没有符合条件的 Agent。</TableCell></TableRow>}
              </TableBody>
            </Table>
          </div>
        )}
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">已载入 {filtered.length} 个 · {currentPage + 1}/{pageCount} 页</span>
          <Button variant="outline" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button>
          <Button variant="outline" size="sm" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</Button>
          {result?.nextCursor && <Button variant="outline" size="sm" disabled={isLoading || isLoadingMore} onClick={() => void onLoadMore()}>{isLoadingMore ? '加载中…' : '载入更多 Agent'}</Button>}
        </div>
      </div>
    </DashboardLayout>
  )
}

export function AgentManagerDetailPage() {
  const { user: currentUser, activeOrgId } = useAuth()
  const { ownerId = '', name = '' } = useParams<{ ownerId: string; name: string }>()
  const [detail, setDetail] = useState<ManagedAgentDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isStarting, setIsStarting] = useState(false)
  const [isUpgrading, setIsUpgrading] = useState(false)
  useEffect(() => {
    let isActive = true
    setDetail(null)
    setError(null)
    void getManagedAgent(ownerId, name).then(value => { if (isActive) setDetail(value) })
      .catch(failure => { if (isActive) setError(failure instanceof Error ? failure.message : '无法加载 Agent') })
    return () => { isActive = false }
  }, [ownerId, name])
  const onStart = async () => {
    setIsStarting(true)
    try {
      const created = await startManagedAgent(ownerId, name)
      window.location.assign(created.workspaceUrl)
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : '无法启动对话')
      setIsStarting(false)
    }
  }
  const onUpgrade = async () => {
    setIsUpgrading(true)
    try {
      const upgraded = await upgradeUserRuntime(ownerId)
      setDetail(current => current ? { ...current, runtime: upgraded.runtime } : current)
      toast.success('运行环境已升级，会话正在恢复。')
    } catch (failure) { toast.error(failure instanceof Error ? failure.message : '无法升级运行环境') }
    finally { setIsUpgrading(false) }
  }
  return (
    <DashboardLayout title={detail?.agent.displayName || 'Agent 详情'} description={detail?.agent.path}
      headerActions={<Button asChild variant="outline"><Link to="/agents">返回 Agent 列表</Link></Button>}>
      {error ? <p role="alert" className="text-destructive">{error}</p> : !detail ? <p role="status">正在加载…</p> : (
        <div className="space-y-6">
          <div className="space-y-2">
            <p>所有者：{detail.agent.ownerName}</p>
            <p>状态：{stateLabels[detail.agent.state] || detail.agent.state}</p>
            {detail.runtime.isDrifted && <div className="space-y-2">
              <p>该用户的运行环境与当前发布版本不同。执行中的回合结束后，可升级并恢复已有会话。</p>
            </div>}
            {detail.canUpgrade && detail.runtime.isPresent && <Button variant="outline" disabled={isUpgrading} onClick={() => void onUpgrade()}>{isUpgrading ? '更新中…' : detail.runtime.isDrifted ? '升级用户运行环境' : '重载模型凭据并恢复会话'}</Button>}
            <p className="text-sm text-muted-foreground">对话使用该 Agent 所有者的模型账户和额度。</p>
            {detail.agent.isOwnerActive === false ? <p>该 Agent 的所有者已停用，启用后可继续对话。</p> : !detail.agent.canStart && <p>当前权限或该 Agent 的运行类型不支持启动对话。</p>}
            {!detail.isWorkspaceAvailable && <p>对话工作台尚未配置，请联系管理员。</p>}
            <Button disabled={!detail.agent.canStart || !detail.isWorkspaceAvailable || isStarting} onClick={() => void onStart()}>{isStarting ? '启动中…' : '开始对话'}</Button>
          </div>
          <div className="rounded-lg border">
            <Table>
              <TableHeader><TableRow><TableHead>对话</TableHead><TableHead>状态</TableHead><TableHead>打开</TableHead></TableRow></TableHeader>
              <TableBody>
                {detail.sessions.map(session => <TableRow key={session.sessionId}>
                  <TableCell>{session.title || new Date(session.createdAt).toLocaleString()}</TableCell>
                  <TableCell>{session.status}</TableCell>
                  <TableCell>{session.workspaceUrl ? <Button asChild variant="outline" size="sm"><a href={session.workspaceUrl}>打开对话</a></Button> : <Button asChild variant="outline" size="sm"><Link to={`/sessions/${session.sessionId}`}>查看记录</Link></Button>}</TableCell>
                </TableRow>)}
                {!detail.sessions.length && <TableRow><TableCell colSpan={3}>还没有对话。</TableCell></TableRow>}
              </TableBody>
            </Table>
          </div>
          {currentUser?.id === ownerId && detail.agent.reference?.startsWith('moss-agent:operator:') && <MossImBindingPanel key={`${activeOrgId}:${ownerId}`} />}
        </div>
      )}
    </DashboardLayout>
  )
}
