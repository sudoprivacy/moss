'use client'

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { format } from 'date-fns'
import { ChevronDown, ChevronRight, RefreshCw, Search } from 'lucide-react'
import { DashboardLayout } from '@/components/dashboard-layout'
import {
  ListEmptyState,
  ListError,
  ListPagination,
  ListSkeleton,
  ListStatusBadge,
  ListSurface,
  ListToolbar,
} from '@/components/list-page'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  getAuditLog,
  getConfigItems,
  type AuditLogEntry,
  type ConfigItem,
} from '@/lib/api/secrets'
import { useAuth } from '@/lib/hooks/use-auth'

const PAGE_SIZE = 20

const actionLabels: Record<string, string> = {
  created: '创建',
  updated: '更新',
  deleted: '删除',
  enabled: '启用',
  disabled: '禁用',
  auth_proxy_request: '代理请求',
}

function clampPage(page: number, total: number) {
  return Math.min(Math.max(1, page), Math.max(1, Math.ceil(total / PAGE_SIZE)))
}

export default function AuditLogPage() {
  const [searchParams] = useSearchParams()
  const { activeOrgId } = useAuth()
  const [entries, setEntries] = useState<AuditLogEntry[]>([])
  const [configItems, setConfigItems] = useState<ConfigItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [errorQueryKey, setErrorQueryKey] = useState<string | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [loadedQueryKey, setLoadedQueryKey] = useState<string | null>(null)
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  const requestSequence = useRef(0)

  // Preserve existing deep links for action/config_item_id. The backend remains
  // the source of truth for which audit rows this role can read.
  const [actionFilter, setActionFilter] = useState(searchParams.get('action') || 'all')
  const [configItemFilter, setConfigItemFilter] = useState(searchParams.get('config_item_id') || 'all')
  const queryKey = `${activeOrgId ?? 'unresolved'}|${actionFilter}|${configItemFilter}|${page}`

  useEffect(() => {
    let active = true
    setConfigItems([])

    // The limited config list is only a convenience for labels/filtering. A
    // 403 for this admin-only endpoint must never hide audit data for a scoped
    // reader, and a deep-linked id remains selectable as #id below.
    void getConfigItems({ page: 1, page_size: PAGE_SIZE })
      .then(result => {
        if (active) setConfigItems(result.items.slice(0, PAGE_SIZE))
      })
      .catch(() => {
        if (active) setConfigItems([])
      })

    return () => { active = false }
  }, [activeOrgId])

  useEffect(() => {
    let active = true
    const requestId = ++requestSequence.current
    setIsLoading(true)

    const configItemId = configItemFilter === 'all' ? undefined : Number(configItemFilter)
    void getAuditLog({
      page,
      page_size: PAGE_SIZE,
      action: actionFilter === 'all' ? undefined : actionFilter,
      config_item_id: typeof configItemId === 'number' && Number.isFinite(configItemId) ? configItemId : undefined,
    })
      .then(result => {
        if (!active || requestId !== requestSequence.current) return

        const validPage = clampPage(result.page || page, result.total)
        if (validPage !== page) {
          setPage(validPage)
          return
        }

        setEntries(result.items)
        setTotal(result.total)
        setLoadedQueryKey(queryKey)
        setError(null)
        setErrorQueryKey(null)
      })
      .catch(err => {
        if (!active || requestId !== requestSequence.current) return
        setError(err instanceof Error ? err.message : '请稍后重试。')
        setErrorQueryKey(queryKey)
      })
      .finally(() => {
        if (active && requestId === requestSequence.current) setIsLoading(false)
      })

    return () => { active = false }
  }, [actionFilter, configItemFilter, page, queryKey, refreshVersion])

  const resetFilters = useCallback(() => {
    setError(null)
    setErrorQueryKey(null)
    setActionFilter('all')
    setConfigItemFilter('all')
    setPage(1)
  }, [])

  const changeActionFilter = useCallback((value: string) => {
    setError(null)
    setErrorQueryKey(null)
    setActionFilter(value)
    setPage(1)
  }, [])

  const changeConfigItemFilter = useCallback((value: string) => {
    setError(null)
    setErrorQueryKey(null)
    setConfigItemFilter(value)
    setPage(1)
  }, [])

  const retry = useCallback(() => {
    setError(null)
    setErrorQueryKey(null)
    setRefreshVersion(version => version + 1)
  }, [])

  const toggleRow = useCallback((id: string) => {
    setExpandedRows(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const getConfigItemName = (id: number | null) => {
    if (id === null) return '-'
    return configItems.find(item => item.id === id)?.name ?? `#${id}`
  }

  const selectedItemMissing = configItemFilter !== 'all' && !configItems.some(item => String(item.id) === configItemFilter)
  const selectedActionMissing = actionFilter !== 'all' && !Object.prototype.hasOwnProperty.call(actionLabels, actionFilter)
  const isCurrentQueryLoaded = loadedQueryKey === queryKey
  const currentError = errorQueryKey === queryKey ? error : null
  const showSkeleton = !isCurrentQueryLoaded && !currentError
  const showInitialFailure = !isCurrentQueryLoaded && !!currentError

  return (
    <DashboardLayout title="审计日志" description="凭据操作历史记录">
      <div className="space-y-4">
        <ListToolbar
          aria-label="审计日志筛选"
          actions={
            <Button type="button" variant="outline" size="sm" onClick={retry} disabled={isLoading}>
              <RefreshCw className={`size-3.5 ${isLoading ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
              刷新
            </Button>
          }
        >
          <Select value={actionFilter} onValueChange={changeActionFilter}>
            <SelectTrigger className="w-[140px]" aria-label="按操作类型筛选"><SelectValue placeholder="操作类型" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部操作</SelectItem>
              {Object.entries(actionLabels).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}
              {selectedActionMissing && <SelectItem value={actionFilter}>未知操作：{actionFilter}</SelectItem>}
            </SelectContent>
          </Select>
          <Select value={configItemFilter} onValueChange={changeConfigItemFilter}>
            <SelectTrigger className="w-[180px]" aria-label="按配置项筛选"><SelectValue placeholder="配置项" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部配置项</SelectItem>
              {configItems.map(item => (
                <SelectItem key={item.id} value={String(item.id)}>{item.name}</SelectItem>
              ))}
              {selectedItemMissing && <SelectItem value={configItemFilter}>#{configItemFilter}</SelectItem>}
            </SelectContent>
          </Select>
          <Button type="button" variant="ghost" size="sm" onClick={resetFilters} disabled={isLoading || (actionFilter === 'all' && configItemFilter === 'all')}>
            重置
          </Button>
        </ListToolbar>

        {currentError && (
          <ListError
            title="无法加载审计日志"
            description={isCurrentQueryLoaded ? `刷新失败，仍显示上次成功结果。${currentError}` : currentError}
            onRetry={retry}
            retrying={isLoading}
          />
        )}

        {showSkeleton ? <ListSkeleton label="正在加载审计日志" rows={8} /> : showInitialFailure ? null : (
          <ListSurface
            aria-label="审计日志列表"
            aria-busy={isLoading}
            footer={
              <ListPagination
                page={page}
                pageSize={PAGE_SIZE}
                total={total}
                busy={isLoading}
                onPageChange={nextPage => {
                  setError(null)
                  setErrorQueryKey(null)
                  setPage(currentPage => clampPage(nextPage, total || (currentPage === 1 ? 1 : currentPage)))
                }}
              />
            }
          >
            <Table className="min-w-[880px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12"><span className="sr-only">详情</span></TableHead>
                  <TableHead>时间</TableHead>
                  <TableHead>操作人</TableHead>
                  <TableHead>操作类型</TableHead>
                  <TableHead>配置项</TableHead>
                  <TableHead>凭据路径</TableHead>
                  <TableHead>IP</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map(entry => {
                  const action = actionLabels[entry.action] ?? entry.action
                  const configItemName = getConfigItemName(entry.config_item_id)
                  const credentialPath = `${entry.namespace}/${entry.key}`
                  const isExpanded = expandedRows.has(entry.id)
                  const detailId = `audit-detail-${entry.id}`
                  return (
                    <Fragment key={entry.id}>
                      <TableRow>
                        <TableCell>
                          {entry.detail ? (
                            <button
                              type="button"
                              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-label={`${isExpanded ? '收起' : '展开'}审计详情`}
                              aria-expanded={isExpanded}
                              aria-controls={detailId}
                              onClick={() => toggleRow(entry.id)}
                            >
                              {isExpanded ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
                            </button>
                          ) : null}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm">{format(entry.created_at, 'MM-dd HH:mm:ss')}</TableCell>
                        <TableCell className="max-w-40 text-sm"><span className="block truncate" title={entry.actor_name}>{entry.actor_name}</span></TableCell>
                        <TableCell><ListStatusBadge>{action}</ListStatusBadge></TableCell>
                        <TableCell className="max-w-48 text-sm"><span className="block truncate" title={configItemName}>{configItemName}</span></TableCell>
                        <TableCell className="max-w-72 font-mono text-xs text-muted-foreground"><span className="block truncate" title={credentialPath}>{credentialPath}</span></TableCell>
                        <TableCell className="text-xs text-muted-foreground">{entry.ip_address ?? '-'}</TableCell>
                      </TableRow>
                      {isExpanded && entry.detail && (
                        <TableRow id={detailId}>
                          <TableCell colSpan={7} className="bg-muted/30">
                            <pre className="max-w-full overflow-x-auto p-2 font-mono text-xs">{JSON.stringify(entry.detail, null, 2)}</pre>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  )
                })}
                {entries.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="p-0">
                      <ListEmptyState
                        title={actionFilter === 'all' && configItemFilter === 'all' ? '暂无审计记录' : '没有匹配的审计记录'}
                        description={actionFilter === 'all' && configItemFilter === 'all' ? '当前可见范围内还没有凭据操作。' : '尝试调整筛选条件。'}
                        icon={<Search />}
                        action={actionFilter !== 'all' || configItemFilter !== 'all' ? <Button type="button" variant="outline" size="sm" onClick={resetFilters}>清除筛选</Button> : undefined}
                      />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </ListSurface>
        )}
      </div>
    </DashboardLayout>
  )
}
