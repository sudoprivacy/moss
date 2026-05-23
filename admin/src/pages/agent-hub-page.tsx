'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import {
  fetchAgentHubSkillDetailsByIds,
  getAgentHubCategories,
  getAgentHubDetail,
  getAgentHubAssistants,
  getInstalledAgents,
  installAgent,
  uninstallAgent,
  updateInstalledAgentMeta,
  type AgentHubAssistant,
  type AgentHubDetail,
  type InstalledAgentInfo,
} from '@/lib/api/agent-hub'
import { getSystemSettings } from '@/lib/api/settings'
import {
  getInstalledSkills,
  type InstalledSkillInfo,
  type SkillHubSkill,
} from '@/lib/api/skill-store'
import type { SystemSettings } from '@/lib/api/types'
import { cn } from '@/lib/utils'
import {
  Bot,
  CheckCircle2,
  Loader2,
  Package,
  RefreshCw,
  Search,
  Shield,
  Sparkles,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { toast } from 'sonner'

type AgentHubTab = 'store' | 'installed'

type CoreFeature = {
  title: string
  desc?: string
}

type AgentSkillSummary = SkillHubSkill & {
  isInstalled: boolean
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(item => String(item || '').trim())
      .filter(Boolean)
  }
  if (typeof value !== 'string' || !value.trim()) {
    return []
  }
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed
          .map(item => String(item || '').trim())
          .filter(Boolean)
      : []
  } catch {
    return [value.trim()]
  }
}

function parseCoreFeatures(value: unknown): CoreFeature[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is CoreFeature =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as CoreFeature).title === 'string',
    )
  }
  if (typeof value !== 'string' || !value.trim()) {
    return []
  }
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is CoreFeature =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as CoreFeature).title === 'string',
        )
      : []
  } catch {
    return []
  }
}

function normalizeVersion(value: unknown): string {
  const normalized = String(value || '').trim()
  if (!normalized) return ''
  const lower = normalized.toLowerCase()
  if (lower === 'unknown' || lower === 'unkown') return ''
  return normalized
}

function installedToHubAssistant(agent: InstalledAgentInfo): AgentHubAssistant {
  return {
    id: agent.meta?.id || agent.id || agent.name,
    name: agent.name,
    display_name: agent.displayName,
    description: agent.description,
    avatar: agent.avatar,
    emoji: agent.emoji || null,
    category: agent.category,
    categories: agent.categories,
    skills: agent.skills,
    sourceUrl: '',
  }
}

function LoadingSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="rounded-xl border bg-card p-4">
          <div className="flex gap-4">
            <Skeleton className="size-12 rounded-xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

type StoreAgentCardProps = {
  agent: AgentHubAssistant
  installed: boolean
  busy: boolean
  onOpen: (agent: AgentHubAssistant) => void
  onInstall: (agent: AgentHubAssistant, skillIds: string[]) => void
}

function StoreAgentCard({
  agent,
  installed,
  busy,
  onOpen,
  onInstall,
}: StoreAgentCardProps) {
  const skillIds = agent.skills || []

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(agent)}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen(agent)
        }
      }}
      className="group relative flex w-full items-start gap-4 overflow-hidden rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent/30"
    >
      <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted text-xl">
        {agent.avatar ? (
          <img
            src={agent.avatar}
            alt={agent.display_name}
            className="size-full object-cover"
          />
        ) : agent.emoji ? (
          <span>{agent.emoji}</span>
        ) : (
          <Bot className="size-5 text-muted-foreground" />
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">{agent.display_name}</h3>
          {installed ? <Badge variant="secondary">已安装</Badge> : null}
          {skillIds.length > 0 ? (
            <Badge variant="outline">{skillIds.length} 个关联技能</Badge>
          ) : null}
        </div>

        <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">
          {agent.description || '暂无描述'}
        </p>

        {agent.categories?.length ? (
          <div className="flex flex-wrap gap-2">
            {agent.categories.slice(0, 3).map(category => (
              <Badge key={`${agent.id}:${category}`} variant="outline">
                {category}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>

      <div className="shrink-0">
        {busy ? (
          <Button size="sm" disabled>
            <Loader2 className="mr-2 size-4 animate-spin" />
            安装中
          </Button>
        ) : installed ? (
          <Button size="sm" variant="outline" disabled>
            已安装
          </Button>
        ) : agent.sourceUrl ? (
          <Button
            size="sm"
            onClick={event => {
              event.stopPropagation()
              onInstall(agent, skillIds)
            }}
          >
            安装
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled>
            不可安装
          </Button>
        )}
      </div>
    </div>
  )
}

type InstalledAgentCardProps = {
  agent: InstalledAgentInfo
  uninstalling: boolean
  onOpenEdit: (agent: InstalledAgentInfo) => void
  onRequestUninstall: (agent: InstalledAgentInfo) => void
}

function InstalledAgentCard({
  agent,
  uninstalling,
  onOpenEdit,
  onRequestUninstall,
}: InstalledAgentCardProps) {
  const badges = [
    agent.isBuiltin ? '系统内置' : agent.isHubInstalled ? 'Hub' : '本地',
    agent.version ? `v${agent.version}` : '',
    agent.skills.length > 0 ? `${agent.skills.length} 个关联技能` : '',
  ].filter(Boolean)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpenEdit(agent)}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpenEdit(agent)
        }
      }}
      className="flex items-start gap-4 rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent/30"
    >
      <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted text-xl">
        {agent.avatar ? (
          <img
            src={agent.avatar}
            alt={agent.displayName}
            className="size-full object-cover"
          />
        ) : agent.emoji ? (
          <span>{agent.emoji}</span>
        ) : (
          <Bot className="size-5 text-muted-foreground" />
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">{agent.displayName}</h3>
          {agent.enabled ? (
            <Badge variant="secondary">已启用</Badge>
          ) : (
            <Badge variant="outline">已禁用</Badge>
          )}
        </div>
        <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">
          {agent.description || '暂无描述'}
        </p>
        <div className="flex flex-wrap gap-2">
          {badges.map(badge => (
            <Badge key={`${agent.source}:${badge}`} variant="outline">
              {badge}
            </Badge>
          ))}
          {agent.categories.map(category => (
            <Badge key={`${agent.source}:${category}`} variant="outline">
              {category}
            </Badge>
          ))}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={event => {
            event.stopPropagation()
            onOpenEdit(agent)
          }}
        >
          编辑
        </Button>
        {!agent.isBuiltin ? (
          <Button
            size="icon"
            variant="ghost"
            disabled={uninstalling}
            onClick={event => {
              event.stopPropagation()
              onRequestUninstall(agent)
            }}
          >
            {uninstalling ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4 text-destructive" />
            )}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export default function AgentHubPage() {
  const [settings, setSettings] = useState<SystemSettings | null>(null)
  const [pageLoading, setPageLoading] = useState(true)
  const [pageError, setPageError] = useState('')

  const [activeTab, setActiveTab] = useState<AgentHubTab>('store')
  const [assistants, setAssistants] = useState<AgentHubAssistant[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('')

  const [installedAgents, setInstalledAgents] = useState<InstalledAgentInfo[]>([])
  const [installedSkills, setInstalledSkills] = useState<InstalledSkillInfo[]>([])

  const [storeLoading, setStoreLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [installedLoading, setInstalledLoading] = useState(false)
  const [storeError, setStoreError] = useState('')
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)

  const [installingAssistantId, setInstallingAssistantId] = useState<string | null>(null)

  const [detailOpen, setDetailOpen] = useState(false)
  const [detailAgent, setDetailAgent] = useState<AgentHubAssistant | null>(null)
  const [detailData, setDetailData] = useState<AgentHubDetail | null>(null)
  const [detailSkills, setDetailSkills] = useState<AgentSkillSummary[]>([])
  const [detailLoading, setDetailLoading] = useState(false)

  const [editOpen, setEditOpen] = useState(false)
  const [editingAgent, setEditingAgent] = useState<InstalledAgentInfo | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editAvatar, setEditAvatar] = useState('')
  const [editSkills, setEditSkills] = useState<SkillHubSkill[]>([])
  const [editSkillsLoading, setEditSkillsLoading] = useState(false)
  const [savingEdit, setSavingEdit] = useState(false)

  const [pendingUninstallAgent, setPendingUninstallAgent] =
    useState<InstalledAgentInfo | null>(null)

  const requestIdRef = useRef(0)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim())
    }, 300)

    return () => window.clearTimeout(timer)
  }, [searchQuery])

  const installedAgentLookup = useMemo(() => {
    const lookup = new Map<string, InstalledAgentInfo>()
    for (const agent of installedAgents) {
      lookup.set(agent.name, agent)
      if (agent.id) {
        lookup.set(agent.id, agent)
      }
      if (agent.meta?.id) {
        lookup.set(agent.meta.id, agent)
      }
    }
    return lookup
  }, [installedAgents])

  const installedSkillLookup = useMemo(() => {
    const lookup = new Set<string>()
    for (const skill of installedSkills) {
      if (skill.id) {
        lookup.add(skill.id)
      }
      lookup.add(skill.name)
    }
    return lookup
  }, [installedSkills])

  const tenantId = settings?.skillStore.tenantId.trim() || ''

  const detailResolvedInstalledAgent = useMemo(() => {
    if (!detailAgent) return null
    return (
      installedAgentLookup.get(detailAgent.id) ||
      installedAgentLookup.get(detailAgent.name) ||
      null
    )
  }, [detailAgent, installedAgentLookup])

  const detailSkillIds = useMemo(
    () => parseStringArray(detailData?.skills ?? detailAgent?.skills),
    [detailAgent?.skills, detailData?.skills],
  )

  const detailDisplayName =
    detailData?.display_name ||
    detailAgent?.display_name ||
    detailResolvedInstalledAgent?.displayName ||
    ''
  const detailDescription =
    detailData?.description ||
    detailAgent?.description ||
    detailResolvedInstalledAgent?.description ||
    ''
  const detailCategories =
    detailData?.categories ||
    detailAgent?.categories ||
    detailResolvedInstalledAgent?.categories ||
    []
  const detailScenarios = parseStringArray(detailData?.applicable_scenarios)
  const detailCoreFeatures = parseCoreFeatures(detailData?.core_features)

  const fetchInstalledState = useCallback(async (showLoader = true) => {
    if (showLoader) {
      setInstalledLoading(true)
    }

    try {
      const [agents, skills] = await Promise.all([
        getInstalledAgents(),
        getInstalledSkills(),
      ])
      setInstalledAgents(agents)
      setInstalledSkills(skills)
      return { agents, skills }
    } finally {
      if (showLoader) {
        setInstalledLoading(false)
      }
    }
  }, [])

  const loadBootstrapData = useCallback(async () => {
    setPageLoading(true)
    setPageError('')

    const [settingsResult, categoriesResult, installedResult] =
      await Promise.allSettled([
        getSystemSettings(),
        getAgentHubCategories(),
        fetchInstalledState(false),
      ])

    if (settingsResult.status === 'fulfilled') {
      setSettings(settingsResult.value)
    } else {
      toast.error(
        settingsResult.reason instanceof Error
          ? settingsResult.reason.message
          : '读取系统设置失败',
      )
    }

    if (categoriesResult.status === 'fulfilled') {
      setCategories(categoriesResult.value)
    } else {
      const message =
        categoriesResult.reason instanceof Error
          ? categoriesResult.reason.message
          : '读取智能体分类失败'
      setPageError(message)
    }

    if (installedResult.status === 'rejected') {
      const message =
        installedResult.reason instanceof Error
          ? installedResult.reason.message
          : '读取已安装智能体失败'
      setPageError(current => current || message)
    }

    setPageLoading(false)
  }, [fetchInstalledState])

  useEffect(() => {
    void loadBootstrapData()
  }, [loadBootstrapData])

  const loadAssistantsPage = useCallback(
    async (params: {
      cursor?: string
      append: boolean
      requestId: number
      query: string
      category: string
    }) => {
      try {
        if (params.append) {
          setLoadingMore(true)
        } else {
          setStoreLoading(true)
          setStoreError('')
        }

        const response = await getAgentHubAssistants({
          cursor: params.cursor,
          limit: 40,
          query: params.query,
          category: params.category,
        })

        if (params.requestId !== requestIdRef.current) {
          return
        }

        setAssistants(current => {
          if (!params.append) {
            return response.assistants
          }

          const existingIds = new Set(current.map(agent => agent.id))
          return [
            ...current,
            ...response.assistants.filter(agent => !existingIds.has(agent.id)),
          ]
        })
        setNextCursor(response.next_cursor)
        setHasMore(response.has_more)
      } catch (error) {
        if (params.requestId !== requestIdRef.current) {
          return
        }
        setStoreError(error instanceof Error ? error.message : '获取智能体列表失败')
      } finally {
        if (params.requestId === requestIdRef.current) {
          setStoreLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [],
  )

  useEffect(() => {
    if (activeTab !== 'store') {
      return
    }

    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setAssistants([])
    setNextCursor(null)
    setHasMore(false)

    void loadAssistantsPage({
      append: false,
      requestId,
      query: debouncedSearchQuery,
      category: selectedCategory === 'all' ? '' : selectedCategory,
    })
  }, [activeTab, debouncedSearchQuery, loadAssistantsPage, selectedCategory])

  const handleLoadMore = useCallback(() => {
    if (
      activeTab !== 'store' ||
      storeLoading ||
      loadingMore ||
      !hasMore ||
      !nextCursor
    ) {
      return
    }

    void loadAssistantsPage({
      cursor: nextCursor,
      append: true,
      requestId: requestIdRef.current,
      query: debouncedSearchQuery,
      category: selectedCategory === 'all' ? '' : selectedCategory,
    })
  }, [
    activeTab,
    debouncedSearchQuery,
    hasMore,
    loadAssistantsPage,
    loadingMore,
    nextCursor,
    selectedCategory,
    storeLoading,
  ])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !hasMore || activeTab !== 'store') {
      return
    }

    const observer = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) {
        handleLoadMore()
      }
    })

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [activeTab, handleLoadMore, hasMore])

  const buildSkillSummaries = useCallback(
    (skills: SkillHubSkill[]): AgentSkillSummary[] =>
      skills.map(skill => ({
        ...skill,
        isInstalled:
          installedSkillLookup.has(skill.id) || installedSkillLookup.has(skill.name),
      })),
    [installedSkillLookup],
  )

  const openDetail = useCallback(
    async (agent: AgentHubAssistant) => {
      setDetailOpen(true)
      setDetailAgent(agent)
      setDetailData(null)
      setDetailSkills([])
      setDetailLoading(true)

      try {
        const detail = await getAgentHubDetail(agent.id)
        setDetailData(detail)

        const skillIds = parseStringArray(detail?.skills ?? agent.skills)
        if (skillIds.length > 0) {
          const skills = await fetchAgentHubSkillDetailsByIds(skillIds)
          setDetailSkills(buildSkillSummaries(skills))
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '读取智能体详情失败')
      } finally {
        setDetailLoading(false)
      }
    },
    [buildSkillSummaries],
  )

  const openEdit = useCallback(async (agent: InstalledAgentInfo) => {
    setEditingAgent(agent)
    setEditName(agent.displayName || agent.name)
    setEditDescription(agent.description || '')
    setEditAvatar(agent.avatar || '')
    setEditSkills([])
    setEditOpen(true)

    if (agent.skills.length === 0) {
      setEditSkillsLoading(false)
      return
    }

    setEditSkillsLoading(true)
    try {
      const skills = await fetchAgentHubSkillDetailsByIds(agent.skills)
      setEditSkills(skills)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取关联技能失败')
    } finally {
      setEditSkillsLoading(false)
    }
  }, [])

  const handleInstall = useCallback(
    async (agent: AgentHubAssistant, skillIds: string[]) => {
      if (installingAssistantId) {
        return
      }

      const sourceUrl = agent.sourceUrl?.trim() || ''
      if (!sourceUrl) {
        toast.error('该智能体暂不支持安装')
        return
      }

      setInstallingAssistantId(agent.id)
      try {
        const result = await installAgent({
          assistantName: agent.name,
          sourceUrl,
          version: normalizeVersion((detailData?.id === agent.id && detailData?.versions?.[0]?.version) || ''),
          checksum:
            detailData?.id === agent.id &&
            typeof detailData.versions?.[0]?.checksum === 'string'
              ? detailData.versions?.[0]?.checksum
              : undefined,
          assistantMeta: agent,
          selectedSkillIds: skillIds,
        })

        let message = `已安装 ${agent.display_name}`
        if (result.installedSkills.length > 0) {
          message += `，并安装 ${result.installedSkills.length} 个关联技能`
        }
        if (result.failedSkills.length > 0) {
          message += `，${result.failedSkills.length} 个关联技能安装失败`
        }
        toast.success(message)
        await fetchInstalledState(false)
        setDetailOpen(false)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '安装智能体失败')
      } finally {
        setInstallingAssistantId(null)
      }
    },
    [detailData, fetchInstalledState, installingAssistantId],
  )

  const handleSaveEdit = useCallback(async () => {
    if (!editingAgent) {
      return
    }

    setSavingEdit(true)
    try {
      await updateInstalledAgentMeta({
        assistantName: editingAgent.name,
        updates: {
          display_name: editName.trim(),
          description: editDescription.trim(),
          avatar: editAvatar.trim(),
        },
      })
      toast.success(`已更新 ${editingAgent.displayName}`)
      await fetchInstalledState(false)
      setEditOpen(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存智能体信息失败')
    } finally {
      setSavingEdit(false)
    }
  }, [editAvatar, editDescription, editName, editingAgent, fetchInstalledState])

  const handleConfirmUninstall = useCallback(async () => {
    if (!pendingUninstallAgent) {
      return
    }

    try {
      await uninstallAgent({
        assistantName: pendingUninstallAgent.name,
        sourcePath: pendingUninstallAgent.source,
      })
      toast.success(`已卸载 ${pendingUninstallAgent.displayName}`)
      await fetchInstalledState(false)
      if (detailResolvedInstalledAgent?.name === pendingUninstallAgent.name) {
        setDetailOpen(false)
      }
      if (editingAgent?.name === pendingUninstallAgent.name) {
        setEditOpen(false)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '卸载智能体失败')
    } finally {
      setPendingUninstallAgent(null)
    }
  }, [
    detailResolvedInstalledAgent?.name,
    editingAgent?.name,
    fetchInstalledState,
    pendingUninstallAgent,
  ])

  const handleRefresh = useCallback(async () => {
    await loadBootstrapData()
    if (activeTab === 'store') {
      const requestId = requestIdRef.current + 1
      requestIdRef.current = requestId
      setAssistants([])
      setNextCursor(null)
      setHasMore(false)

      await loadAssistantsPage({
        append: false,
        requestId,
        query: debouncedSearchQuery,
        category: selectedCategory === 'all' ? '' : selectedCategory,
      })
    }
  }, [
    activeTab,
    debouncedSearchQuery,
    loadAssistantsPage,
    loadBootstrapData,
    selectedCategory,
  ])

  if (pageLoading) {
    return (
      <DashboardLayout
        title="智能体管理"
        description="浏览、安装和管理 Hub 智能体，安装动作在 server 侧执行。"
      >
        <div className="space-y-6">
          <Skeleton className="h-10 w-64" />
          <LoadingSkeleton />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout
      title="智能体管理"
      description="浏览、安装和管理 Hub 智能体，安装动作在 server 侧执行。"
    >
      <div className="space-y-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={tenantId ? 'secondary' : 'outline'}>
              {tenantId ? `专属技能租户: ${tenantId}` : '未配置专属技能租户 ID'}
            </Badge>
            <Badge variant="secondary">已安装 {installedAgents.length} 个智能体</Badge>
          </div>

          <Button variant="outline" onClick={() => void handleRefresh()}>
            <RefreshCw className="mr-2 size-4" />
            刷新
          </Button>
        </div>

        {pageError ? (
          <Alert variant="destructive">
            <TriangleAlert className="size-4" />
            <AlertTitle>初始化失败</AlertTitle>
            <AlertDescription>{pageError}</AlertDescription>
          </Alert>
        ) : null}

        <Card>
          <CardHeader className="space-y-4 border-b">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
              <Tabs
                value={activeTab}
                onValueChange={value => setActiveTab(value as AgentHubTab)}
                className="gap-0"
              >
                <TabsList>
                  <TabsTrigger value="store">智能体库</TabsTrigger>
                  <TabsTrigger value="installed">
                    已安装
                    {installedAgents.length > 0 ? (
                      <span className="rounded-full bg-primary px-1.5 py-0 text-[10px] leading-4 text-primary-foreground">
                        {installedAgents.length}
                      </span>
                    ) : null}
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              <div
                className={cn(
                  'min-w-0 flex-1 transition-opacity',
                  activeTab === 'installed' && 'pointer-events-none opacity-0',
                )}
              >
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={searchQuery}
                    onChange={event => setSearchQuery(event.target.value)}
                    placeholder="搜索智能体..."
                    className="pl-9"
                  />
                </div>
              </div>
            </div>

            {activeTab === 'store' ? (
              <div className="flex flex-wrap gap-2">
                {[{ key: 'all', label: '精选' }, ...categories.map(item => ({ key: item, label: item }))].map(item => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setSelectedCategory(item.key)}
                    className={cn(
                      'rounded-full px-3 py-1 text-sm transition-colors',
                      selectedCategory === item.key
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
          </CardHeader>

          <CardContent className="pt-6">
            <Tabs value={activeTab} className="gap-0">
              <TabsContent value="store" className="space-y-4">
                {storeError ? (
                  <Alert variant="destructive">
                    <TriangleAlert className="size-4" />
                    <AlertTitle>读取智能体失败</AlertTitle>
                    <AlertDescription>{storeError}</AlertDescription>
                  </Alert>
                ) : null}

                {storeLoading ? (
                  <LoadingSkeleton />
                ) : assistants.length === 0 ? (
                  <Empty className="rounded-xl border bg-muted/20">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Sparkles className="size-5" />
                      </EmptyMedia>
                      <EmptyTitle>暂无可用智能体</EmptyTitle>
                      <EmptyDescription>
                        当前筛选条件下没有结果，试试切换分类或调整搜索词。
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <div className="grid gap-4 md:grid-cols-2">
                    {assistants.map(agent => {
                      const installed =
                        installedAgentLookup.has(agent.id) ||
                        installedAgentLookup.has(agent.name)

                      return (
                        <StoreAgentCard
                          key={agent.id}
                          agent={agent}
                          installed={installed}
                          busy={installingAssistantId === agent.id}
                          onOpen={item => void openDetail(item)}
                          onInstall={(item, skillIds) =>
                            void handleInstall(item, skillIds)
                          }
                        />
                      )
                    })}
                  </div>
                )}

                {loadingMore ? <LoadingSkeleton /> : null}
                {hasMore ? <div ref={sentinelRef} className="h-1" /> : null}
              </TabsContent>

              <TabsContent value="installed" className="space-y-4">
                {installedLoading ? (
                  <LoadingSkeleton />
                ) : installedAgents.length === 0 ? (
                  <Empty className="rounded-xl border bg-muted/20">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Package className="size-5" />
                      </EmptyMedia>
                      <EmptyTitle>暂无已安装智能体</EmptyTitle>
                      <EmptyDescription>
                        从智能体库安装后，这里会展示 server 上当前已部署的智能体。
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <div className="grid gap-4 md:grid-cols-2">
                    {installedAgents.map(agent => (
                      <InstalledAgentCard
                        key={`${agent.source}:${agent.name}`}
                        agent={agent}
                        uninstalling={pendingUninstallAgent?.source === agent.source}
                        onOpenEdit={item => void openEdit(item)}
                        onRequestUninstall={setPendingUninstallAgent}
                      />
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{detailDisplayName || '智能体详情'}</DialogTitle>
            <DialogDescription>
              查看智能体说明、关联技能和当前安装状态。
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="max-h-[65vh] pr-4">
            <div className="space-y-6">
              {detailLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-32 w-full" />
                </div>
              ) : (
                <>
                  <div className="flex items-start gap-4">
                    <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-muted text-2xl">
                      {detailData?.avatar || detailAgent?.avatar ? (
                        <img
                          src={detailData?.avatar || detailAgent?.avatar}
                          alt={detailDisplayName}
                          className="size-full object-cover"
                        />
                      ) : detailData?.emoji || detailAgent?.emoji ? (
                        <span>{detailData?.emoji || detailAgent?.emoji}</span>
                      ) : (
                        <Bot className="size-6 text-muted-foreground" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1 space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        {detailResolvedInstalledAgent ? (
                          <Badge variant="secondary">已安装</Badge>
                        ) : (
                          <Badge variant="outline">未安装</Badge>
                        )}
                        {detailCategories.map(category => (
                          <Badge key={`detail:${category}`} variant="outline">
                            {category}
                          </Badge>
                        ))}
                      </div>
                      <p className="text-sm leading-6 text-muted-foreground">
                        {detailDescription || '暂无描述'}
                      </p>
                    </div>
                  </div>

                  {detailCoreFeatures.length > 0 ? (
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-base">核心能力</CardTitle>
                        <CardDescription>智能体在 Hub 中声明的能力说明。</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {detailCoreFeatures.map(feature => (
                          <div key={feature.title} className="rounded-lg border bg-muted/20 p-3">
                            <div className="font-medium">{feature.title}</div>
                            {feature.desc ? (
                              <p className="mt-1 text-sm text-muted-foreground">
                                {feature.desc}
                              </p>
                            ) : null}
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  ) : null}

                  {detailScenarios.length > 0 ? (
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-base">适用场景</CardTitle>
                        <CardDescription>适合部署该智能体的业务场景。</CardDescription>
                      </CardHeader>
                      <CardContent className="flex flex-wrap gap-2">
                        {detailScenarios.map(scenario => (
                          <Badge key={scenario} variant="outline">
                            {scenario}
                          </Badge>
                        ))}
                      </CardContent>
                    </Card>
                  ) : null}

                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">关联技能</CardTitle>
                      <CardDescription>
                        安装智能体时会尝试自动安装这些技能到 server。
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {detailSkillIds.length === 0 ? (
                        <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-6 text-sm text-muted-foreground">
                          该智能体没有声明关联技能。
                        </div>
                      ) : detailSkills.length === 0 ? (
                        <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-6 text-sm text-muted-foreground">
                          关联技能信息暂未加载完成。
                        </div>
                      ) : (
                        detailSkills.map(skill => (
                          <div
                            key={skill.id}
                            className="flex items-center gap-3 rounded-lg border bg-muted/20 p-3"
                          >
                            <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-background text-lg">
                              {skill.icon ? (
                                <img
                                  src={skill.icon}
                                  alt={skill.display_name}
                                  className="size-full object-cover"
                                />
                              ) : skill.emoji ? (
                                <span>{skill.emoji}</span>
                              ) : (
                                <Package className="size-4 text-muted-foreground" />
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium">
                                {skill.display_name || skill.name}
                              </div>
                              {skill.description ? (
                                <div className="line-clamp-2 text-sm text-muted-foreground">
                                  {skill.description}
                                </div>
                              ) : null}
                            </div>
                            <Badge variant={skill.isInstalled ? 'secondary' : 'outline'}>
                              {skill.isInstalled ? '已安装' : '未安装'}
                            </Badge>
                          </div>
                        ))
                      )}
                    </CardContent>
                  </Card>
                </>
              )}
            </div>
          </ScrollArea>

          <DialogFooter className="items-center sm:justify-between">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Shield className="size-4" />
              <span>安装与卸载动作都在 server 侧执行。</span>
            </div>

            <div className="flex items-center gap-2">
              {detailResolvedInstalledAgent ? (
                <>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setDetailOpen(false)
                      void openEdit(detailResolvedInstalledAgent)
                    }}
                  >
                    编辑已安装项
                  </Button>
                  {!detailResolvedInstalledAgent.isBuiltin ? (
                    <Button
                      variant="destructive"
                      onClick={() => setPendingUninstallAgent(detailResolvedInstalledAgent)}
                    >
                      <Trash2 className="mr-2 size-4" />
                      卸载
                    </Button>
                  ) : null}
                </>
              ) : (
                <Button
                  disabled={
                    detailLoading ||
                    installingAssistantId === detailAgent?.id ||
                    !(detailData?.sourceUrl || detailAgent?.sourceUrl)
                  }
                  onClick={() => {
                    if (!detailAgent) return
                    void handleInstall(detailData || detailAgent, detailSkillIds)
                  }}
                >
                  {installingAssistantId === detailAgent?.id ? (
                    <>
                      <Loader2 className="mr-2 size-4 animate-spin" />
                      安装中
                    </>
                  ) : (
                    '安装到 Server'
                  )}
                </Button>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editOpen}
        onOpenChange={open => {
          setEditOpen(open)
          if (!open) {
            setEditingAgent(null)
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>编辑智能体</DialogTitle>
            <DialogDescription>
              修改 server 上已安装智能体的展示信息，不影响 Hub 原始数据。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="space-y-2">
              <label className="text-sm font-medium">显示名称</label>
              <Input
                value={editName}
                onChange={event => setEditName(event.target.value)}
                placeholder="输入智能体显示名称"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">头像地址</label>
              <Input
                value={editAvatar}
                onChange={event => setEditAvatar(event.target.value)}
                placeholder="https://..."
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">描述</label>
              <Textarea
                value={editDescription}
                onChange={event => setEditDescription(event.target.value)}
                rows={4}
                placeholder="输入智能体描述"
              />
            </div>

            <div className="space-y-3">
              <div>
                <div className="text-sm font-medium">关联技能</div>
                <p className="text-sm text-muted-foreground">
                  这里展示当前已安装智能体声明的技能列表，暂不在 admin 中编辑。
                </p>
              </div>

              {editSkillsLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : editSkills.length === 0 ? (
                <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-6 text-sm text-muted-foreground">
                  该智能体没有关联技能。
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {editSkills.map(skill => (
                    <Badge key={`edit-skill:${skill.id}`} variant="outline">
                      {skill.display_name || skill.name}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {editingAgent?.isHubInstalled ? (
              <Alert>
                <CheckCircle2 className="size-4" />
                <AlertTitle>当前安装源</AlertTitle>
                <AlertDescription>
                  该智能体来自 Hub，当前修改只会写入 server 本地的
                  `_moss_meta.json`。
                </AlertDescription>
              </Alert>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              取消
            </Button>
            <Button disabled={savingEdit || !editingAgent} onClick={() => void handleSaveEdit()}>
              {savingEdit ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  保存中
                </>
              ) : (
                '保存'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingUninstallAgent !== null}
        onOpenChange={open => {
          if (!open) {
            setPendingUninstallAgent(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认卸载智能体</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingUninstallAgent
                ? `将从 server 上移除 ${pendingUninstallAgent.displayName}，该操作不会删除 Hub 中的原始数据。`
                : '确认后将从 server 上卸载该智能体。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleConfirmUninstall()}>
              卸载
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  )
}
