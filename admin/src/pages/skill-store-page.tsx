'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getSystemSettings } from '@/lib/api/settings'
import {
  batchSyncSkills,
  getInstalledSkills,
  getSkillHubCategories,
  getSkillHubDetail,
  getSkillHubSkills,
  importSkillArchive,
  importSkillDirectory,
  installSkill,
  resolveSkillTenantId,
  setInstalledSkillEnabled,
  uninstallSkill,
  getSkillSyncStatus,
  getTenantSkills,
  uploadTenantSkillArchive,
  uploadTenantSkillDirectory,
  type TenantSkillInfo,
  type BatchSyncResult,
  type InstalledSkillInfo,
  type SkillHubDetail,
  type SkillHubSkill,
  type SkillHubVersion,
  type SkillStoreTab,
  type SkillSyncProgress,
} from '@/lib/api/skill-store'
import type { SystemSettings, AuthUser } from '@/lib/api/types'
import type { AuthDepartment } from '@/lib/api/types'
import { getDepartments, getUsers } from '@/lib/api/auth'
import { updateSkillVisibility, approveTenantSkill, deleteTenantSkill, updateTenantSkillMeta } from '@/lib/api/skill-store'
import { cn } from '@/lib/utils'
import {
  CheckCircle2,
  Cloud,
  Loader2,
  Package,
  RefreshCw,
  Search,
  Shield,
  Sparkles,
  Trash2,
  TriangleAlert,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'

type CoreFeature = {
  title: string
  desc: string
}

function normalizeSkillVersion(value: unknown): string {
  const normalized = String(value || '').trim()
  if (!normalized) return ''
  const lower = normalized.toLowerCase()
  if (lower === 'unknown' || lower === 'unkown') return ''
  return normalized
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string')
  }
  if (typeof value !== 'string' || !value.trim()) {
    return []
  }
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
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

function installedToHubSkill(skill: InstalledSkillInfo): SkillHubSkill {
  return {
    id: skill.meta?.id || skill.id || skill.name,
    name: skill.name,
    display_name: skill.displayName,
    description: skill.description,
    icon: skill.icon,
    emoji: skill.emoji || null,
    category: skill.category,
    categories: skill.categories,
    applicable_scenarios: skill.meta?.applicable_scenarios,
    core_features: skill.meta?.core_features,
    homepage: skill.meta?.homepage || null,
    author_id: skill.meta?.author_id || '',
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

async function fileToBase64(file: File): Promise<string> {
  return arrayBufferToBase64(await file.arrayBuffer())
}

function LoadingSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {Array.from({ length: 6 }).map((_, index) => (
        <div
          key={index}
          className="rounded-xl border bg-card p-4"
        >
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

type SkillCardProps = {
  skill: SkillHubSkill
  installed: boolean
  installedSkill?: InstalledSkillInfo | null
  hasUpdate: boolean
  latestVersion?: SkillHubVersion
  busy: boolean
  toggling?: boolean
  uninstalling?: boolean
  onInstall: (skillId: string) => void
  onUpdate: (skillId: string) => void
  onOpen: (skill: SkillHubSkill) => void
  onToggleEnabled?: (skill: InstalledSkillInfo, enabled: boolean) => void
  onEditVisibility?: (skill: InstalledSkillInfo) => void
  onRequestUninstall?: (skill: InstalledSkillInfo) => void
}

function SkillCard({
  skill,
  installed,
  installedSkill,
  hasUpdate,
  latestVersion,
  busy,
  toggling,
  uninstalling,
  onInstall,
  onUpdate,
  onOpen,
  onToggleEnabled,
  onEditVisibility,
  onRequestUninstall,
}: SkillCardProps) {
  const canManage = installedSkill && !installedSkill.isBuiltin

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(skill)}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen(skill)
        }
      }}
      className={cn(
        'group relative flex w-full items-start gap-4 overflow-hidden rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent/30',
        installedSkill && !installedSkill.enabled && 'opacity-65',
      )}
    >
      <div className="flex w-14 shrink-0 flex-col items-center gap-2">
        <div className="flex size-12 items-center justify-center overflow-hidden rounded-xl bg-muted text-xl">
          {skill.icon ? (
            <img
              src={skill.icon}
              alt={skill.display_name}
              className="size-full object-cover"
            />
          ) : (
            <span>{skill.emoji || '📦'}</span>
          )}
        </div>
        {installed ? (
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[11px] font-medium',
              hasUpdate
                ? 'bg-amber-500/15 text-amber-700'
                : 'bg-primary/10 text-primary',
            )}
          >
            {hasUpdate ? '可更新' : '已安装'}
          </span>
        ) : null}
      </div>

      <div className="min-w-0 flex-1 pr-28">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{skill.display_name}</span>
          {hasUpdate ? (
            <Badge variant="outline" className="text-[11px]">
              可更新
            </Badge>
          ) : null}
        </div>
        <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
          {skill.description || '暂无描述'}
        </p>
        {latestVersion ? (
          <p className="mt-2 text-xs text-muted-foreground">
            最新版本 {latestVersion.version}
          </p>
        ) : null}
      </div>

      <div
        className="absolute top-4 right-4 flex items-center gap-2"
        onClick={event => event.stopPropagation()}
      >
        {busy ? (
          <div className="w-20">
            <Progress value={85} />
          </div>
        ) : installed && canManage ? (
          <>
            {onEditVisibility && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onEditVisibility(installedSkill!)}
              >
                <Shield className="size-4" />
              </Button>
            )}
            {onToggleEnabled && (
              <Switch
                checked={installedSkill!.enabled}
                disabled={toggling}
                onCheckedChange={checked => onToggleEnabled(installedSkill!, checked)}
              />
            )}
            {hasUpdate && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onUpdate(skill.id)}
              >
                更新
              </Button>
            )}
            {onRequestUninstall && (
              <Button
                size="icon"
                variant="ghost"
                disabled={uninstalling}
                onClick={() => onRequestUninstall(installedSkill!)}
              >
                {uninstalling ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Trash2 className="size-4" />
                )}
              </Button>
            )}
          </>
        ) : installed && hasUpdate ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onUpdate(skill.id)}
          >
            更新
          </Button>
        ) : !installed ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onInstall(skill.id)}
          >
            安装
          </Button>
        ) : null}
      </div>
    </div>
  )
}

type InstalledSkillCardProps = {
  skill: InstalledSkillInfo
  hasUpdate: boolean
  latestVersion?: SkillHubVersion
  uninstalling: boolean
  toggling: boolean
  updating: boolean
  onOpen: (skill: InstalledSkillInfo) => void
  onToggleEnabled: (skill: InstalledSkillInfo, enabled: boolean) => void
  onRequestUninstall: (skill: InstalledSkillInfo) => void
  onUpdate: (skill: InstalledSkillInfo) => void
  onEditVisibility: (skill: InstalledSkillInfo) => void
  departmentNameMap: Map<string, string>
  users: AuthUser[]
}

function InstalledSkillCard({
  skill,
  hasUpdate,
  latestVersion,
  uninstalling,
  toggling,
  updating,
  onOpen,
  onToggleEnabled,
  onRequestUninstall,
  onUpdate,
  onEditVisibility,
  departmentNameMap,
  users,
}: InstalledSkillCardProps) {
  const canManage = !skill.isBuiltin

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(skill)}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen(skill)
        }
      }}
      className={cn(
        'group relative flex w-full items-start gap-4 overflow-hidden rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent/30',
        !skill.enabled && 'opacity-65',
      )}
    >
      <div className="flex w-14 shrink-0 flex-col items-center gap-2">
        <div className="flex size-12 items-center justify-center overflow-hidden rounded-xl bg-muted text-xl">
          {skill.icon ? (
            <img
              src={skill.icon}
              alt={skill.displayName}
              className="size-full object-cover"
            />
          ) : (
            <span>{skill.emoji || '📦'}</span>
          )}
        </div>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] font-medium',
            skill.isBuiltin
              ? 'bg-muted text-muted-foreground'
              : skill.isUploaded
                ? 'bg-sky-500/15 text-sky-700'
                : skill.isHubInstalled
                  ? 'bg-primary/10 text-primary'
                  : 'bg-emerald-500/15 text-emerald-700',
          )}
        >
          {skill.isBuiltin
            ? '内置'
            : skill.isUploaded
              ? '上传'
              : skill.isHubInstalled
                ? 'Hub'
                : '本地'}
        </span>
      </div>

      <div className="min-w-0 flex-1 pr-28">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{skill.displayName}</span>
          {hasUpdate ? (
            <Badge variant="outline" className="text-[11px]">
              可更新
            </Badge>
          ) : null}
        </div>
        <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
          {skill.description || '暂无描述'}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>当前版本 {normalizeSkillVersion(skill.version) || '未知'}</span>
          {latestVersion && hasUpdate ? <span>最新 {latestVersion.version}</span> : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {(skill.visibleTo?.user_ids ?? skill.meta?.visible_to?.user_ids)?.length ? (
            (skill.visibleTo?.user_ids ?? skill.meta?.visible_to?.user_ids ?? []).map(userId => {
              const user = users.find(u => u.id === userId)
              return user ? (
                <Badge key={userId} variant="outline" className="text-[10px]">{user.name}</Badge>
              ) : null
            })
          ) : (skill.visibleTo?.department_ids ?? skill.meta?.visible_to?.department_ids)?.length ? (
            (skill.visibleTo?.department_ids ?? skill.meta?.visible_to?.department_ids ?? []).map(deptId => {
              const name = departmentNameMap.get(deptId)
              return name ? (
                <Badge key={deptId} variant="outline" className="text-[10px]">{name}</Badge>
              ) : null
            })
          ) : (
            <span className="text-[11px] text-muted-foreground">所有部门可见</span>
          )}
        </div>
      </div>

      <div
        className="absolute top-4 right-4 flex items-center gap-2"
        onClick={event => event.stopPropagation()}
      >
        {canManage ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onEditVisibility(skill)}
          >
            <Shield className="size-4" />
          </Button>
        ) : null}
        {canManage ? (
          <Switch
            checked={skill.enabled}
            disabled={toggling}
            onCheckedChange={checked => onToggleEnabled(skill, checked)}
          />
        ) : null}
        {hasUpdate ? (
          <Button
            size="sm"
            variant="outline"
            disabled={updating}
            onClick={() => onUpdate(skill)}
          >
            {updating ? <Loader2 className="size-4 animate-spin" /> : '更新'}
          </Button>
        ) : null}
        {canManage ? (
          <Button
            size="icon"
            variant="ghost"
            disabled={uninstalling}
            onClick={() => onRequestUninstall(skill)}
          >
            {uninstalling ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

type InstalledSkillSectionProps = {
  title: string
  skills: InstalledSkillInfo[]
  renderCard: (skill: InstalledSkillInfo) => React.ReactNode
}

function InstalledSkillSection({
  title,
  skills,
  renderCard,
}: InstalledSkillSectionProps) {
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">
            共 {skills.length} 个
          </p>
        </div>
      </div>
      {skills.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
          暂无{title}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {skills.map(renderCard)}
        </div>
      )}
    </section>
  )
}

export default function SkillStorePage() {
  const [settings, setSettings] = useState<SystemSettings | null>(null)
  const [pageLoading, setPageLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [activeTab, setActiveTab] = useState<SkillStoreTab>('store')
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('')
  const [categories, setCategories] = useState<string[]>([])
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [skills, setSkills] = useState<SkillHubSkill[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [storeError, setStoreError] = useState('')
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [installedList, setInstalledList] = useState<InstalledSkillInfo[]>([])
  const [installedLoading, setInstalledLoading] = useState(false)
  const [latestVersions, setLatestVersions] = useState<Map<string, SkillHubVersion>>(
    new Map(),
  )
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailSkill, setDetailSkill] = useState<SkillHubSkill | null>(null)
  const [detailInstalledSkill, setDetailInstalledSkill] = useState<InstalledSkillInfo | null>(null)
  const [detailData, setDetailData] = useState<SkillHubDetail | null>(null)
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null)
  const [updatingSkillId, setUpdatingSkillId] = useState<string | null>(null)
  const [togglingSkillName, setTogglingSkillName] = useState<string | null>(null)
  const [pendingUninstallSkill, setPendingUninstallSkill] = useState<InstalledSkillInfo | null>(null)
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [importingMode, setImportingMode] = useState<'zip' | 'directory' | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [skillSyncProgressOpen, setSkillSyncProgressOpen] = useState(false)
  const [skillSyncProgress, setSkillSyncProgress] = useState<SkillSyncProgress | null>(null)
  const [departments, setDepartments] = useState<AuthDepartment[]>([])
  const [users, setUsers] = useState<AuthUser[]>([])
  const [editVisibilityOpen, setEditVisibilityOpen] = useState(false)
  const [editingSkillName, setEditingSkillName] = useState('')
  const [skillVisibilityMode, setSkillVisibilityMode] = useState<'all' | 'departments' | 'users' | 'admin'>('all')
  const [editSkillVisibleTo, setEditSkillVisibleTo] = useState<string[]>([])
  const [editSkillVisibleUserIds, setEditSkillVisibleUserIds] = useState<string[]>([])
  const [savingVisibility, setSavingVisibility] = useState(false)
  const [tenantSkills, setTenantSkills] = useState<TenantSkillInfo[]>([])
  const [tenantSkillsLoading, setTenantSkillsLoading] = useState(false)
  const [approvalDialogOpen, setApprovalDialogOpen] = useState(false)
  const [approvingSkill, setApprovingSkill] = useState<TenantSkillInfo | null>(null)
  const [approvalNote, setApprovalNote] = useState('')
  const [approving, setApproving] = useState(false)
  const [togglingTenantSkillId, setTogglingTenantSkillId] = useState<string | null>(null)
  const [deletingTenantSkillId, setDeletingTenantSkillId] = useState<string | null>(null)
  const [tenantVisibilityOpen, setTenantVisibilityOpen] = useState(false)
  const [editingTenantSkill, setEditingTenantSkill] = useState<TenantSkillInfo | null>(null)
  const [tenantVisibilityMode, setTenantVisibilityMode] = useState<'all' | 'departments' | 'users' | 'admin'>('all')
  const [editTenantVisibleTo, setEditTenantVisibleTo] = useState<string[]>([])
  const [editTenantVisibleUserIds, setEditTenantVisibleUserIds] = useState<string[]>([])
  const [savingTenantVisibility, setSavingTenantVisibility] = useState(false)
  const [tenantSkillDetail, setTenantSkillDetail] = useState<TenantSkillInfo | null>(null)

  const latestVersionsRef = useRef(latestVersions)
  const requestIdRef = useRef(0)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const zipInputRef = useRef<HTMLInputElement | null>(null)
  const directoryInputRef = useRef<HTMLInputElement | null>(null)

  type DepartmentOption = AuthDepartment & { depth: number }

  const departmentOptions = useMemo((): DepartmentOption[] => {
    const build = (depts: AuthDepartment[], parentId: string | null, depth: number): DepartmentOption[] =>
      depts.filter(d => d.parentId === parentId).flatMap(d => [{ ...d, depth }, ...build(depts, d.id, depth + 1)])
    return build(departments, null, 0)
  }, [departments])

  useEffect(() => {
    latestVersionsRef.current = latestVersions
  }, [latestVersions])

  useEffect(() => {
    const directoryInput = directoryInputRef.current
    if (!directoryInput) return
    directoryInput.setAttribute('webkitdirectory', '')
    directoryInput.setAttribute('directory', '')
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim())
    }, 300)
    return () => window.clearTimeout(timer)
  }, [searchQuery])

  const tenantId = settings?.skillStore.tenantId.trim() || ''
  const exclusiveTenantId = useMemo(
    () => resolveSkillTenantId(activeTab, tenantId),
    [activeTab, tenantId],
  )

  const installedVersionLookup = useMemo(() => {
    const lookup = new Map<string, string>()
    for (const skill of installedList) {
      if (skill.isHubInstalled || skill.meta?.source_type === 'hub') {
        lookup.set(skill.name, normalizeSkillVersion(skill.version))
        if (skill.meta?.id) {
          lookup.set(skill.meta.id, normalizeSkillVersion(skill.version))
        }
      }
    }
    return lookup
  }, [installedList])

  const detailResolvedInstalledSkill = useMemo(() => {
    if (detailInstalledSkill) return detailInstalledSkill
    if (!detailSkill) return null
    return (
      installedList.find(
        skill =>
          (skill.isHubInstalled || skill.meta?.source_type === 'hub') &&
          (skill.name === detailSkill.name ||
            (skill.meta?.id && skill.meta.id === detailSkill.id)),
      ) || null
    )
  }, [detailInstalledSkill, detailSkill, installedList])

  const detailLatestVersion = detailSkill
    ? latestVersions.get(detailSkill.id)
    : detailResolvedInstalledSkill?.meta?.id
      ? latestVersions.get(detailResolvedInstalledSkill.meta.id)
      : undefined

  const groupedInstalledSkills = useMemo(() => {
    const custom = installedList.filter(skill => !skill.isBuiltin && skill.isUploaded)
    const hub = installedList.filter(
      skill => !skill.isBuiltin && !skill.isUploaded && skill.isHubInstalled,
    )
    const builtin = installedList.filter(skill => skill.isBuiltin)
    const local = installedList.filter(
      skill => !skill.isBuiltin && !skill.isUploaded && !skill.isHubInstalled,
    )

    return {
      custom,
      hub,
      builtin,
      local,
    }
  }, [installedList])

  // Filter tenant skills by search query
  const filteredTenantSkills = useMemo(() => {
    if (!searchQuery.trim()) return tenantSkills
    const query = searchQuery.toLowerCase()
    return tenantSkills.filter(skill =>
      (skill.display_name || skill.name).toLowerCase().includes(query) ||
      (skill.description || '').toLowerCase().includes(query)
    )
  }, [tenantSkills, searchQuery])

  // Filter custom skills by search query
  const filteredCustomSkills = useMemo(() => {
    if (!searchQuery.trim()) return groupedInstalledSkills.custom
    const query = searchQuery.toLowerCase()
    return groupedInstalledSkills.custom.filter(skill =>
      (skill.displayName || skill.name).toLowerCase().includes(query) ||
      (skill.description || '').toLowerCase().includes(query)
    )
  }, [groupedInstalledSkills.custom, searchQuery])

  const fetchInstalledList = useCallback(async () => {
    setInstalledLoading(true)
    try {
      const response = await getInstalledSkills()
      setInstalledList(response)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : '读取已安装技能失败',
      )
    } finally {
      setInstalledLoading(false)
    }
  }, [])

  const fetchTenantSkills = useCallback(async () => {
    setTenantSkillsLoading(true)
    try {
      const response = await getTenantSkills()
      setTenantSkills(response)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : '读取专属技能失败',
      )
    } finally {
      setTenantSkillsLoading(false)
    }
  }, [])

  const fetchLatestVersions = useCallback(
    async (
      skillList: SkillHubSkill[],
      existingMap?: Map<string, SkillHubVersion>,
      requestId?: number,
    ) => {
      const versionMap = existingMap
        ? new Map(existingMap)
        : new Map<string, SkillHubVersion>()
      const toFetch = skillList.filter(skill => !versionMap.has(skill.id))
      if (toFetch.length === 0) {
        if (requestId === undefined || requestId === requestIdRef.current) {
          setLatestVersions(versionMap)
        }
        return versionMap
      }

      const batchSize = 5
      for (let index = 0; index < toFetch.length; index += batchSize) {
        const batch = toFetch.slice(index, index + batchSize)
        const results = await Promise.all(
          batch.map(async skill => {
            try {
              const detail = await getSkillHubDetail(skill.id)
              const latest = detail?.versions?.[0]
              if (!latest) return null
              return {
                skillId: skill.id,
                version: latest,
              }
            } catch {
              return null
            }
          }),
        )

        for (const result of results) {
          if (result) {
            versionMap.set(result.skillId, result.version)
          }
        }
      }

      if (requestId === undefined || requestId === requestIdRef.current) {
        setLatestVersions(versionMap)
      }
      return versionMap
    },
    [],
  )

  const loadBootstrapData = useCallback(async () => {
    setPageLoading(true)
    setLoadError('')

    const [settingsResult, categoriesResult, installedResult, tenantSkillsResult] =
      await Promise.allSettled([
        getSystemSettings(),
        getSkillHubCategories(),
        getInstalledSkills(),
        getTenantSkills(),
      ])

    if (settingsResult.status === 'fulfilled') {
      setSettings(settingsResult.value)
    } else {
      const message =
        settingsResult.reason instanceof Error
          ? settingsResult.reason.message
          : '读取系统设置失败'
      setLoadError(message)
    }

    if (categoriesResult.status === 'fulfilled') {
      setCategories(categoriesResult.value)
    } else if (settingsResult.status === 'fulfilled') {
      toast.error(
        categoriesResult.reason instanceof Error
          ? categoriesResult.reason.message
          : '读取技能分类失败',
      )
    }

    if (installedResult.status === 'fulfilled') {
      setInstalledList(installedResult.value)
    } else if (settingsResult.status === 'fulfilled') {
      toast.error(
        installedResult.reason instanceof Error
          ? installedResult.reason.message
          : '读取已安装技能失败',
      )
    }

    if (tenantSkillsResult.status === 'fulfilled') {
      setTenantSkills(tenantSkillsResult.value)
    } else if (settingsResult.status === 'fulfilled') {
      toast.error(
        tenantSkillsResult.reason instanceof Error
          ? tenantSkillsResult.reason.message
          : '读取专属技能失败',
      )
    }

    setPageLoading(false)

    try {
      const [deptResult, userResult] = await Promise.all([
        getDepartments(),
        getUsers(),
      ])
      setDepartments(deptResult.departments)
      setUsers(userResult.users)
    } catch { /* non-critical */ }
  }, [])

  useEffect(() => {
    void loadBootstrapData()
  }, [loadBootstrapData])

  const loadSkillsPage = useCallback(
    async (params: {
      cursor?: string
      append: boolean
      requestId: number
      query: string
      category: string
      tenantId?: string
    }) => {
      try {
        if (params.append) {
          setLoadingMore(true)
        } else {
          setLoading(true)
          setStoreError('')
        }

        const response = await getSkillHubSkills({
          cursor: params.cursor,
          limit: 40,
          query: params.query,
          category: params.category,
          tenantId: params.tenantId,
        })

        if (params.requestId !== requestIdRef.current) {
          return
        }

        setSkills(current => {
          if (!params.append) {
            return response.skills
          }
          const existingIds = new Set(current.map(skill => skill.id))
          return [
            ...current,
            ...response.skills.filter(skill => !existingIds.has(skill.id)),
          ]
        })
        setNextCursor(response.next_cursor)
        setHasMore(response.has_more)

        void fetchLatestVersions(
          response.skills,
          params.append ? latestVersionsRef.current : undefined,
          params.requestId,
        )
      } catch (error) {
        if (params.requestId !== requestIdRef.current) {
          return
        }
        const message =
          error instanceof Error ? error.message : '获取技能列表失败'
        setStoreError(message)
      } finally {
        if (params.requestId === requestIdRef.current) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [fetchLatestVersions],
  )

  useEffect(() => {
    if (!settings || activeTab === 'custom') {
      return
    }

    const currentRequestId = requestIdRef.current + 1
    requestIdRef.current = currentRequestId
    setSkills([])
    setLatestVersions(new Map())
    setNextCursor(null)
    setHasMore(false)

    // 专属技能页签不再从 Hub 获取数据，改为从后端获取
    if (activeTab === 'exclusive') {
      setLoading(false)
      setLoadingMore(false)
      setStoreError('')
      return
    }

    void loadSkillsPage({
      append: false,
      requestId: currentRequestId,
      query: debouncedSearchQuery,
      category: selectedCategory === 'all' ? '' : selectedCategory,
      tenantId: exclusiveTenantId,
    })
  }, [
    activeTab,
    debouncedSearchQuery,
    exclusiveTenantId,
    loadSkillsPage,
    selectedCategory,
    settings,
  ])

  useEffect(() => {
    if (installedList.length === 0) return

    const hubSkills = installedList
      .filter(skill => skill.isHubInstalled && skill.meta?.id)
      .map(installedToHubSkill)

    if (hubSkills.length === 0) return
    void fetchLatestVersions(hubSkills, latestVersionsRef.current)
  }, [fetchLatestVersions, installedList])

  const handleLoadMore = useCallback(() => {
    if (
      loading ||
      loadingMore ||
      !hasMore ||
      !nextCursor ||
      activeTab === 'custom'
    ) {
      return
    }

    const currentRequestId = requestIdRef.current
    void loadSkillsPage({
      cursor: nextCursor,
      append: true,
      requestId: currentRequestId,
      query: debouncedSearchQuery,
      category: selectedCategory === 'all' ? '' : selectedCategory,
      tenantId: exclusiveTenantId,
    })
  }, [
    activeTab,
    debouncedSearchQuery,
    exclusiveTenantId,
    hasMore,
    loadSkillsPage,
    loading,
    loadingMore,
    nextCursor,
    selectedCategory,
  ])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !hasMore || activeTab === 'custom') {
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

  const handleRefresh = async () => {
    await loadBootstrapData()
  }

  const handleSync = useCallback(async () => {
    setSyncing(true)
    try {
      await batchSyncSkills(tenantId || undefined)
      setSkillSyncProgressOpen(true)
      setSkillSyncProgress(null)
      const poll = setInterval(async () => {
        try {
          const status = await getSkillSyncStatus()
          setSkillSyncProgress(status)
          if (status.status === 'done' || status.status === 'error') {
            clearInterval(poll)
            setSyncing(false)
            if (status.status === 'done') {
              const parts: string[] = []
              if (status.installed > 0) parts.push(`新安装 ${status.installed} 个`)
              if (status.updated > 0) parts.push(`更新 ${status.updated} 个`)
              if (status.failed > 0) parts.push(`${status.failed} 个失败`)
              if (parts.length === 0) {
                toast.info('所有技能已是最新版本')
              } else {
                toast.success(`同步完成：${parts.join('，')}`)
              }
            } else {
              toast.error(status.error || '同步失败')
            }
            await fetchInstalledList()
          }
        } catch {
          clearInterval(poll)
          setSyncing(false)
        }
      }, 1000)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '同步技能失败')
      setSyncing(false)
    }
  }, [fetchInstalledList, tenantId])

  const openSkillDetail = useCallback(
    async (skill: SkillHubSkill, installedSkill?: InstalledSkillInfo | null) => {
      setDetailOpen(true)
      setDetailSkill(skill)
      setDetailInstalledSkill(installedSkill || null)
      setDetailData(null)
      setDetailLoading(true)
      try {
        const detail = await getSkillHubDetail(skill.id)
        setDetailData(detail)
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : '读取技能详情失败',
        )
      } finally {
        setDetailLoading(false)
      }
    },
    [],
  )

  const openInstalledSkillDetail = useCallback(
    (skill: InstalledSkillInfo) => {
      const hubSkill = installedToHubSkill(skill)
      // For custom/uploaded/tenant skills, don't fetch from hub - show local info directly
      const sourceType = skill.meta?.source_type
      if (!skill.meta?.id || sourceType === 'upload' || sourceType === 'custom' || sourceType === 'tenant') {
        setDetailOpen(true)
        setDetailSkill(hubSkill)
        setDetailInstalledSkill(skill)
        setDetailData(null)
        setDetailLoading(false)
        return
      }

      void openSkillDetail(
        {
          ...hubSkill,
          id: skill.meta.id,
        },
        skill,
      )
    },
    [openSkillDetail],
  )

  const handleInstall = useCallback(
    async (skillId: string) => {
      const skill = skills.find(item => item.id === skillId)
      const latestVersion = latestVersions.get(skillId)
      if (!skill || !latestVersion) {
        toast.error('未获取到技能安装包信息')
        return
      }

      setInstallingSkillId(skillId)
      try {
        await installSkill({
          skillName: skill.name,
          sourceUrl: latestVersion.source_url,
          version: latestVersion.version,
          checksum: latestVersion.checksum,
          skillMeta: skill,
        })
        toast.success(`已安装 ${skill.display_name}`)
        await fetchInstalledList()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '安装技能失败')
      } finally {
        setInstallingSkillId(null)
      }
    },
    [fetchInstalledList, latestVersions, skills],
  )

  const handleUpdate = useCallback(
    async (skillId: string, installedSkill?: InstalledSkillInfo | null) => {
      const latestVersion = latestVersions.get(skillId)
      const storeSkill = skills.find(item => item.id === skillId)
      const resolvedInstalledSkill =
        installedSkill ||
        installedList.find(
          item => item.meta?.id === skillId || item.name === storeSkill?.name,
        ) ||
        null
      const resolvedSkill = storeSkill || (resolvedInstalledSkill ? installedToHubSkill(resolvedInstalledSkill) : null)

      if (!latestVersion || !resolvedSkill) {
        toast.error('未获取到技能更新包信息')
        return
      }

      setUpdatingSkillId(skillId)
      try {
        await installSkill({
          skillName: resolvedSkill.name,
          sourceUrl: latestVersion.source_url,
          version: latestVersion.version,
          checksum: latestVersion.checksum,
          skillMeta: resolvedSkill,
        })
        toast.success(`已更新 ${resolvedSkill.display_name}`)
        await fetchInstalledList()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '更新技能失败')
      } finally {
        setUpdatingSkillId(null)
      }
    },
    [fetchInstalledList, installedList, latestVersions, skills],
  )

  const handleConfirmUninstall = useCallback(async () => {
    if (!pendingUninstallSkill) return

    const skill = pendingUninstallSkill
    try {
      await uninstallSkill({
        skillName: skill.name,
        sourcePath: skill.source,
      })
      toast.success(`已卸载 ${skill.displayName}`)
      await fetchInstalledList()
      if (detailResolvedInstalledSkill?.name === skill.name) {
        setDetailOpen(false)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '卸载技能失败')
    } finally {
      setPendingUninstallSkill(null)
    }
  }, [detailResolvedInstalledSkill, fetchInstalledList, pendingUninstallSkill])

  const handleToggleEnabled = useCallback(
    async (skill: InstalledSkillInfo, enabled: boolean) => {
      setTogglingSkillName(skill.name)
      try {
        await setInstalledSkillEnabled({
          skillName: skill.name,
          enabled,
          sourcePath: skill.source,
        })
        toast.success(enabled ? `已启用 ${skill.displayName}` : `已禁用 ${skill.displayName}`)
        await fetchInstalledList()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '更新技能状态失败')
      } finally {
        setTogglingSkillName(null)
      }
    },
    [fetchInstalledList],
  )

  const handleImportArchiveFiles = useCallback(
    async (files: FileList | null) => {
      const file = files?.[0]
      if (!file) return

      setImportingMode('zip')
      try {
        const archiveBase64 = await fileToBase64(file)

        if (activeTab === 'exclusive') {
          // Upload to tenant skills (auto-approved)
          const result = await uploadTenantSkillArchive({
            fileName: file.name,
            archiveBase64,
          })
          toast.success(`已上传专属技能 ${result.skillName}`)
          await fetchTenantSkills()
        } else {
          // Upload to custom skills
          const result = await importSkillArchive({
            fileName: file.name,
            archiveBase64,
          })
          toast.success(`已导入技能 ${result.skillName}`)
          await fetchInstalledList()
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '上传技能失败')
      } finally {
        setImportingMode(null)
      }
    },
    [activeTab, fetchInstalledList, fetchTenantSkills],
  )

  const handleImportDirectoryFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return

      setImportingMode('directory')
      try {
        const entries = await Promise.all(
          Array.from(files).map(async file => {
            const fileWithRelativePath = file as File & {
              webkitRelativePath?: string
            }
            return {
              path: fileWithRelativePath.webkitRelativePath || file.name,
              contentBase64: await fileToBase64(file),
            }
          }),
        )

        if (activeTab === 'exclusive') {
          // Upload to tenant skills (auto-approved)
          const result = await uploadTenantSkillDirectory({ entries })
          toast.success(`已上传专属技能 ${result.skillName}`)
          await fetchTenantSkills()
        } else {
          // Upload to custom skills
          const result = await importSkillDirectory({ entries })
          toast.success(`已导入技能 ${result.skillName}`)
          await fetchInstalledList()
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '上传技能失败')
      } finally {
        setImportingMode(null)
      }
    },
    [activeTab, fetchInstalledList, fetchTenantSkills],
  )

  const handleOpenVisibilityEdit = useCallback((skill: InstalledSkillInfo) => {
    setEditingSkillName(skill.name)
    const visibleTo = skill.visibleTo ?? skill.meta?.visible_to
    const deptIds = visibleTo?.department_ids
    const userIds = visibleTo?.user_ids

    // Determine mode based on visible_to
    let mode: 'all' | 'departments' | 'users' | 'admin' = 'all'
    if (visibleTo === null || visibleTo === undefined) {
      mode = 'all'
    } else if (deptIds !== null && deptIds !== undefined && deptIds.length === 0 && (userIds === null || userIds === undefined || userIds.length === 0)) {
      mode = 'admin'
    } else if (userIds !== null && userIds !== undefined && userIds.length > 0) {
      mode = 'users'
    } else if (deptIds !== null && deptIds !== undefined && deptIds.length > 0) {
      mode = 'departments'
    }

    setSkillVisibilityMode(mode)
    setEditSkillVisibleTo(deptIds ?? [])
    setEditSkillVisibleUserIds(userIds ?? [])
    setEditVisibilityOpen(true)
  }, [])

  const handleSaveVisibility = useCallback(async () => {
    setSavingVisibility(true)
    try {
      await updateSkillVisibility(
        editingSkillName,
        skillVisibilityMode === 'admin'
          ? { department_ids: [], user_ids: [] }
          : skillVisibilityMode === 'departments'
            ? { department_ids: editSkillVisibleTo.length > 0 ? editSkillVisibleTo : null, user_ids: null }
            : skillVisibilityMode === 'users'
              ? { department_ids: null, user_ids: editSkillVisibleUserIds.length > 0 ? editSkillVisibleUserIds : null }
              : null,
      )
      toast.success('可见性已更新')
      setEditVisibilityOpen(false)
      await fetchInstalledList()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新可见性失败')
    } finally {
      setSavingVisibility(false)
    }
  }, [editingSkillName, skillVisibilityMode, editSkillVisibleTo, editSkillVisibleUserIds, fetchInstalledList])

  const handleApproveTenantSkill = useCallback(async (approved: boolean) => {
    if (!approvingSkill) return
    setApproving(true)
    try {
      await approveTenantSkill(approvingSkill.id, approved, approvalNote || undefined)
      toast.success(approved ? '已通过审批' : '已拒绝审批')
      setApprovalDialogOpen(false)
      setApprovingSkill(null)
      setApprovalNote('')
      await fetchTenantSkills()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '审批失败')
    } finally {
      setApproving(false)
    }
  }, [approvingSkill, approvalNote, fetchTenantSkills])

  const handleDeleteTenantSkill = useCallback(async (skill: TenantSkillInfo) => {
    try {
      await deleteTenantSkill(skill.id)
      toast.success('已删除')
      await fetchTenantSkills()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除失败')
    }
  }, [fetchTenantSkills])

  const handleToggleTenantSkillEnabled = useCallback(async (skill: TenantSkillInfo, enabled: boolean) => {
    setTogglingTenantSkillId(skill.id)
    try {
      await updateTenantSkillMeta({ id: skill.id, enabled })
      toast.success(enabled ? '已启用' : '已禁用')
      await fetchTenantSkills()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败')
    } finally {
      setTogglingTenantSkillId(null)
    }
  }, [fetchTenantSkills])

  const handleOpenTenantVisibilityEdit = useCallback((skill: TenantSkillInfo) => {
    setEditingTenantSkill(skill)
    const visibleTo = skill.visible_to
    if (!visibleTo || (!visibleTo.department_ids && !visibleTo.user_ids)) {
      setTenantVisibilityMode('all')
      setEditTenantVisibleTo([])
      setEditTenantVisibleUserIds([])
    } else if (visibleTo.user_ids?.length === 1 && visibleTo.user_ids[0] === 'admin') {
      setTenantVisibilityMode('admin')
      setEditTenantVisibleTo([])
      setEditTenantVisibleUserIds([])
    } else if (visibleTo.department_ids?.length) {
      setTenantVisibilityMode('departments')
      setEditTenantVisibleTo(visibleTo.department_ids)
      setEditTenantVisibleUserIds([])
    } else if (visibleTo.user_ids?.length) {
      setTenantVisibilityMode('users')
      setEditTenantVisibleTo([])
      setEditTenantVisibleUserIds(visibleTo.user_ids)
    } else {
      setTenantVisibilityMode('all')
      setEditTenantVisibleTo([])
      setEditTenantVisibleUserIds([])
    }
    setTenantVisibilityOpen(true)
  }, [])

  const handleSaveTenantVisibility = useCallback(async () => {
    if (!editingTenantSkill) return
    setSavingTenantVisibility(true)
    try {
      let visible_to: { department_ids: string[] | null; user_ids: string[] | null } | null = null
      if (tenantVisibilityMode === 'admin') {
        visible_to = { department_ids: null, user_ids: ['admin'] }
      } else if (tenantVisibilityMode === 'departments') {
        visible_to = { department_ids: editTenantVisibleTo.length > 0 ? editTenantVisibleTo : null, user_ids: null }
      } else if (tenantVisibilityMode === 'users') {
        visible_to = { department_ids: null, user_ids: editTenantVisibleUserIds.length > 0 ? editTenantVisibleUserIds : null }
      }
      await updateTenantSkillMeta({ id: editingTenantSkill.id, visible_to })
      toast.success('可见性已更新')
      setTenantVisibilityOpen(false)
      setEditingTenantSkill(null)
      await fetchTenantSkills()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSavingTenantVisibility(false)
    }
  }, [editingTenantSkill, tenantVisibilityMode, editTenantVisibleTo, editTenantVisibleUserIds, fetchTenantSkills])

  const handleConfirmDeleteTenantSkill = useCallback(async () => {
    if (!editingTenantSkill) return
    setDeletingTenantSkillId(editingTenantSkill.id)
    try {
      await deleteTenantSkill(editingTenantSkill.id)
      toast.success('已删除')
      setTenantVisibilityOpen(false)
      setEditingTenantSkill(null)
      await fetchTenantSkills()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除失败')
    } finally {
      setDeletingTenantSkillId(null)
    }
  }, [editingTenantSkill, fetchTenantSkills])

  const departmentNameMap = useMemo(
    () => new Map(departments.map(dept => [dept.id, dept.name])),
    [departments],
  )

  const renderInstalledCard = useCallback(
    (skill: InstalledSkillInfo) => {
      const latestVersion = skill.meta?.id
        ? latestVersions.get(skill.meta.id)
        : undefined
      const installedVersion = normalizeSkillVersion(skill.version)
      const hasUpdate =
        skill.isHubInstalled &&
        !!latestVersion &&
        (!installedVersion || latestVersion.version !== installedVersion)

      return (
        <InstalledSkillCard
          key={`${skill.source}:${skill.name}`}
          skill={skill}
          hasUpdate={hasUpdate}
          latestVersion={latestVersion}
          uninstalling={pendingUninstallSkill?.source === skill.source}
          toggling={togglingSkillName === skill.name}
          updating={updatingSkillId === skill.meta?.id}
          onOpen={openInstalledSkillDetail}
          onToggleEnabled={handleToggleEnabled}
          onRequestUninstall={setPendingUninstallSkill}
          onUpdate={item => {
            if (item.meta?.id) {
              void handleUpdate(item.meta.id, item)
            }
          }}
          onEditVisibility={handleOpenVisibilityEdit}
          departmentNameMap={departmentNameMap}
          users={users}
        />
      )
    },
    [
      departmentNameMap,
      handleOpenVisibilityEdit,
      handleToggleEnabled,
      handleUpdate,
      latestVersions,
      openInstalledSkillDetail,
      openSkillDetail,
      pendingUninstallSkill,
      togglingSkillName,
      updatingSkillId,
      users,
    ],
  )

  if (pageLoading) {
    return (
      <DashboardLayout
        title="技能商店"
        description="浏览、安装和管理 Hub 技能，专属技能租户 ID 来自系统设置。"
      >
        <div className="space-y-6">
          <Skeleton className="h-10 w-64" />
          <LoadingSkeleton />
        </div>
      </DashboardLayout>
    )
  }

  if (!settings) {
    return (
      <DashboardLayout
        title="技能商店"
        description="浏览、安装和管理 Hub 技能，专属技能租户 ID 来自系统设置。"
      >
        <Alert variant="destructive" className="max-w-3xl">
          <TriangleAlert className="size-4" />
          <AlertTitle>读取技能商店配置失败</AlertTitle>
          <AlertDescription>{loadError || '未获取到系统设置。'}</AlertDescription>
        </Alert>
      </DashboardLayout>
    )
  }

  const applicableScenarios = parseStringArray(
    detailData?.applicable_scenarios ??
      detailResolvedInstalledSkill?.meta?.applicable_scenarios,
  )
  const coreFeatures = parseCoreFeatures(
    detailData?.core_features ??
      detailResolvedInstalledSkill?.meta?.core_features,
  )
  const detailSkillName = detailSkill?.display_name || detailResolvedInstalledSkill?.displayName || ''
  const detailInstalledVersion = detailResolvedInstalledSkill
    ? normalizeSkillVersion(detailResolvedInstalledSkill.version)
    : ''
  const detailHasUpdate =
    !!detailResolvedInstalledSkill?.isHubInstalled &&
    !!detailLatestVersion &&
    (!detailInstalledVersion || detailLatestVersion.version !== detailInstalledVersion)

  return (
    <DashboardLayout
      title="技能商店"
      description="浏览、安装和管理 Hub 技能，专属技能租户 ID 来自系统设置。"
    >
      <div className="space-y-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            {/* <Badge variant={tenantId ? 'secondary' : 'outline'}>
              {tenantId ? `专属租户: ${tenantId}` : '未配置专属租户 ID'}
            </Badge> */}
            <Badge variant="secondary">
              已安装 {installedList.length} 个技能
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => void handleSync()} disabled={syncing}>
              {syncing ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCw className="mr-2 size-4" />}
              批量同步
            </Button>
            <Button variant="outline" onClick={() => void handleRefresh()}>
              <RefreshCw className="mr-2 size-4" />
              刷新
            </Button>
          </div>
        </div>

        {loadError ? (
          <Alert variant="destructive">
            <TriangleAlert className="size-4" />
            <AlertTitle>初始化失败</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        ) : null}

        <Card>
          <CardHeader className="border-b space-y-4">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
              <Tabs
                value={activeTab}
                onValueChange={value => setActiveTab(value as SkillStoreTab)}
                className="gap-0"
              >
                <TabsList>
                  <TabsTrigger value="store">
                    技能库
                    {groupedInstalledSkills.hub.length > 0 ? (
                      <span className="rounded-full bg-primary px-1.5 py-0 text-[10px] leading-4 text-primary-foreground">
                        {groupedInstalledSkills.hub.length}
                      </span>
                    ) : null}
                  </TabsTrigger>
                  <TabsTrigger value="exclusive">
                    专属技能
                    {tenantSkills.filter(t => t.status === 'approved').length > 0 ? (
                      <span className="rounded-full bg-primary px-1.5 py-0 text-[10px] leading-4 text-primary-foreground">
                        {tenantSkills.filter(t => t.status === 'approved').length}
                      </span>
                    ) : null}
                  </TabsTrigger>
                  <TabsTrigger value="custom">
                    自定义技能
                    {groupedInstalledSkills.custom.length > 0 ? (
                      <span className="rounded-full bg-primary px-1.5 py-0 text-[10px] leading-4 text-primary-foreground">
                        {groupedInstalledSkills.custom.length}
                      </span>
                    ) : null}
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              <div className="min-w-0 flex-1">
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={searchQuery}
                    onChange={event => setSearchQuery(event.target.value)}
                    placeholder="搜索技能..."
                    className="pl-9"
                  />
                </div>
              </div>

              {activeTab === 'exclusive' ? (
                <Button onClick={() => setImportDialogOpen(true)}>
                  <Upload className="mr-2 size-4" />
                  上传技能
                </Button>
              ) : null}
            </div>

            {activeTab !== 'custom' && activeTab !== 'exclusive' ? (
              <div className="flex flex-wrap gap-2">
                {[{ key: 'all', label: '全部' }, ...categories.map(item => ({ key: item, label: item }))].map(item => (
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
                    <AlertTitle>读取技能失败</AlertTitle>
                    <AlertDescription>{storeError}</AlertDescription>
                  </Alert>
                ) : null}
                {loading ? (
                  <LoadingSkeleton />
                ) : skills.length === 0 ? (
                  <div className="rounded-xl border border-dashed bg-muted/30 px-6 py-12 text-center text-muted-foreground">
                    <Sparkles className="mx-auto mb-3 size-8 opacity-50" />
                    暂无技能
                  </div>
                ) : (
                  <div className="grid gap-4 md:grid-cols-2">
                    {skills.map(skill => {
                      const installedVersion =
                        installedVersionLookup.get(skill.id) ||
                        installedVersionLookup.get(skill.name) ||
                        ''
                      const latestVersion = latestVersions.get(skill.id)
                      const installed = Boolean(installedVersion)
                      const hasUpdate =
                        installed &&
                        !!latestVersion &&
                        (!installedVersion || latestVersion.version !== installedVersion)

                      // Find the installed skill info for this skill
                      const installedSkillInfo = installed
                        ? installedList.find(
                            s =>
                              (s.isHubInstalled || s.meta?.source_type === 'hub') &&
                              (s.name === skill.name || s.meta?.id === skill.id)
                          ) || null
                        : null

                      return (
                        <SkillCard
                          key={skill.id}
                          skill={skill}
                          installed={installed}
                          installedSkill={installedSkillInfo}
                          hasUpdate={hasUpdate}
                          latestVersion={latestVersion}
                          busy={
                            installingSkillId === skill.id ||
                            updatingSkillId === skill.id
                          }
                          toggling={installedSkillInfo ? togglingSkillName === installedSkillInfo.name : false}
                          uninstalling={installedSkillInfo ? pendingUninstallSkill?.name === installedSkillInfo.name : false}
                          onInstall={handleInstall}
                          onUpdate={skillId => void handleUpdate(skillId)}
                          onOpen={item => void openSkillDetail(item)}
                          onToggleEnabled={handleToggleEnabled}
                          onEditVisibility={handleOpenVisibilityEdit}
                          onRequestUninstall={setPendingUninstallSkill}
                        />
                      )
                    })}
                  </div>
                )}
                {loadingMore ? <LoadingSkeleton /> : null}
                {hasMore ? <div ref={sentinelRef} className="h-1" /> : null}
              </TabsContent>

              <TabsContent value="exclusive" className="space-y-4">
                {tenantSkillsLoading ? (
                  <LoadingSkeleton />
                ) : filteredTenantSkills.length === 0 ? (
                  <div className="rounded-xl border border-dashed bg-muted/30 px-6 py-12 text-center text-muted-foreground">
                    <Shield className="mx-auto mb-3 size-8 opacity-50" />
                    {searchQuery.trim() ? '未找到匹配的专属技能' : '暂无专属技能'}
                  </div>
                ) : (
                  <div className="grid gap-4 md:grid-cols-2">
                    {filteredTenantSkills.map(skill => (
                      <div
                        key={skill.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setTenantSkillDetail(skill)}
                        onKeyDown={event => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            setTenantSkillDetail(skill)
                          }
                        }}
                        className="rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent/30"
                      >
                        <div className="flex items-start gap-4">
                          <div className="flex size-12 items-center justify-center rounded-xl bg-muted text-xl">
                            <span>📦</span>
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium">
                                {skill.display_name || skill.name}
                              </span>
                              <Badge
                                variant={
                                  skill.status === 'approved'
                                    ? 'default'
                                    : skill.status === 'pending'
                                      ? 'secondary'
                                      : 'destructive'
                                }
                                className="text-[10px]"
                              >
                                {skill.status === 'approved'
                                  ? '已通过'
                                  : skill.status === 'pending'
                                    ? '待审批'
                                    : '已拒绝'}
                              </Badge>
                              {skill.status === 'approved' && skill.enabled ? (
                                <Badge variant="outline" className="text-[10px]">已启用</Badge>
                              ) : skill.status === 'approved' ? (
                                <Badge variant="outline" className="text-[10px]">已禁用</Badge>
                              ) : null}
                            </div>
                            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                              {skill.description || '暂无描述'}
                            </p>
                            <div className="mt-2 text-xs text-muted-foreground">
                              {skill.author_name || skill.author_id}
                              {' · '}
                              {new Date(skill.created_at).toLocaleDateString()}
                            </div>
                            {skill.status === 'approved' && skill.visible_to ? (
                              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                {skill.visible_to.user_ids?.length ? (
                                  skill.visible_to.user_ids.map(userId => {
                                    const user = users.find(u => u.id === userId)
                                    return user ? (
                                      <Badge key={userId} variant="outline" className="text-[10px]">{user.name}</Badge>
                                    ) : null
                                  })
                                ) : skill.visible_to.department_ids?.length ? (
                                  skill.visible_to.department_ids.map(deptId => {
                                    const name = departmentNameMap.get(deptId)
                                    return name ? (
                                      <Badge key={deptId} variant="outline" className="text-[10px]">{name}</Badge>
                                    ) : null
                                  })
                                ) : (
                                  <span className="text-[11px] text-muted-foreground">全员可见</span>
                                )}
                              </div>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-2" onClick={e => e.stopPropagation()}>
                            {skill.status === 'pending' ? (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setApprovingSkill(skill)
                                    setApprovalDialogOpen(true)
                                  }}
                                >
                                  审批
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={deletingTenantSkillId === skill.id}
                                  onClick={() => void handleDeleteTenantSkill(skill)}
                                >
                                  {deletingTenantSkillId === skill.id ? (
                                    <Loader2 className="size-4 animate-spin" />
                                  ) : (
                                    <Trash2 className="size-4" />
                                  )}
                                </Button>
                              </>
                            ) : skill.status === 'approved' ? (
                              <>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => handleOpenTenantVisibilityEdit(skill)}
                                >
                                  <Shield className="size-4" />
                                </Button>
                                <Switch
                                  checked={skill.enabled === 1}
                                  disabled={togglingTenantSkillId === skill.id}
                                  onCheckedChange={checked => void handleToggleTenantSkillEnabled(skill, checked)}
                                />
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  disabled={deletingTenantSkillId === skill.id}
                                  onClick={() => void handleDeleteTenantSkill(skill)}
                                >
                                  {deletingTenantSkillId === skill.id ? (
                                    <Loader2 className="size-4 animate-spin" />
                                  ) : (
                                    <Trash2 className="size-4" />
                                  )}
                                </Button>
                              </>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={deletingTenantSkillId === skill.id}
                                onClick={() => void handleDeleteTenantSkill(skill)}
                              >
                                {deletingTenantSkillId === skill.id ? (
                                  <Loader2 className="size-4 animate-spin" />
                                ) : (
                                  <Trash2 className="size-4" />
                                )}
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="custom" className="space-y-6">
                {installedLoading ? (
                  <LoadingSkeleton />
                ) : filteredCustomSkills.length === 0 ? (
                  <div className="rounded-xl border border-dashed bg-muted/30 px-6 py-12 text-center text-muted-foreground">
                    <Package className="mx-auto mb-3 size-8 opacity-50" />
                    {searchQuery.trim() ? '未找到匹配的自定义技能' : '暂无自定义技能'}
                  </div>
                ) : (
                  <div className="grid gap-4 md:grid-cols-2">
                    {filteredCustomSkills.map(renderInstalledCard)}
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
            <DialogTitle>{detailSkillName || '技能详情'}</DialogTitle>
            <DialogDescription>
              查看技能说明、版本信息和安装状态。
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="max-h-[65vh] pr-4">
            <div className="space-y-6">
              {detailLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-5 w-48" />
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-32 w-full" />
                </div>
              ) : (
                <>
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {detailResolvedInstalledSkill ? (
                        <Badge variant="secondary">
                          {detailHasUpdate ? '已安装，可更新' : '已安装'}
                        </Badge>
                      ) : (
                        <Badge variant="outline">未安装</Badge>
                      )}
                      {detailResolvedInstalledSkill?.enabled ? (
                        <Badge variant="outline">已启用</Badge>
                      ) : detailResolvedInstalledSkill ? (
                        <Badge variant="outline">已禁用</Badge>
                      ) : null}
                    </div>
                    <p className="text-sm leading-6 text-muted-foreground">
                      {detailData?.description ||
                        detailResolvedInstalledSkill?.description ||
                        detailSkill?.description ||
                        '暂无描述'}
                    </p>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-base">版本信息</CardTitle>
                        <CardDescription>当前安装版本与 Hub 最新版本。</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3 text-sm">
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">当前安装</span>
                          <span>{detailInstalledVersion || '未安装'}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">最新版本</span>
                          <span>{detailLatestVersion?.version || '未知'}</span>
                        </div>
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <CardTitle className="text-base">分类与场景</CardTitle>
                        <CardDescription>Hub 中记录的分类信息。</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div className="flex flex-wrap gap-2">
                          {(
                            detailData?.categories ||
                            detailResolvedInstalledSkill?.categories ||
                            []
                          ).map(category => (
                            <Badge key={category} variant="outline">
                              {category}
                            </Badge>
                          ))}
                          {(
                            detailData?.categories ||
                            detailResolvedInstalledSkill?.categories ||
                            []
                          ).length === 0 ? (
                            <span className="text-sm text-muted-foreground">暂无分类</span>
                          ) : null}
                        </div>
                        <div className="space-y-2">
                          {applicableScenarios.length > 0 ? (
                            applicableScenarios.map(item => (
                              <div key={item} className="text-sm text-muted-foreground">
                                {item}
                              </div>
                            ))
                          ) : (
                            <span className="text-sm text-muted-foreground">暂无场景说明</span>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  </div>

                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">核心能力</CardTitle>
                      <CardDescription>技能提供的主要能力点。</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {coreFeatures.length > 0 ? (
                        coreFeatures.map(feature => (
                          <div
                            key={`${feature.title}:${feature.desc}`}
                            className="rounded-lg border bg-muted/30 p-3"
                          >
                            <div className="text-sm font-medium">{feature.title}</div>
                            {feature.desc ? (
                              <div className="mt-1 text-sm text-muted-foreground">
                                {feature.desc}
                              </div>
                            ) : null}
                          </div>
                        ))
                      ) : (
                        <div className="text-sm text-muted-foreground">
                          暂无核心能力说明
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </>
              )}
            </div>
          </ScrollArea>

          <DialogFooter className="gap-2 sm:justify-between">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {detailResolvedInstalledSkill?.isHubInstalled ? (
                <CheckCircle2 className="size-4 text-primary" />
              ) : null}
              {detailResolvedInstalledSkill
                ? `安装路径：${detailResolvedInstalledSkill.source}`
                : '该技能尚未安装'}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {detailResolvedInstalledSkill && !detailResolvedInstalledSkill.isBuiltin ? (
                <>
                  <Button
                    variant="outline"
                    onClick={() => handleOpenVisibilityEdit(detailResolvedInstalledSkill)}
                  >
                    <Shield className="mr-2 size-4" />
                    编辑可见性
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setPendingUninstallSkill(detailResolvedInstalledSkill)}
                  >
                    卸载
                  </Button>
                </>
              ) : null}
              {detailHasUpdate && detailSkill ? (
                <Button
                  onClick={() =>
                    void handleUpdate(detailSkill.id, detailResolvedInstalledSkill)
                  }
                  disabled={updatingSkillId === detailSkill.id}
                >
                  {updatingSkillId === detailSkill.id ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : null}
                  更新
                </Button>
              ) : !detailResolvedInstalledSkill && detailSkill ? (
                <Button
                  onClick={() => void handleInstall(detailSkill.id)}
                  disabled={installingSkillId === detailSkill.id}
                >
                  {installingSkillId === detailSkill.id ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : null}
                  安装
                </Button>
              ) : null}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>上传技能</DialogTitle>
            <DialogDescription>
              {activeTab === 'exclusive'
                ? '上传技能到专属技能，自动审批通过后全员可见。支持 ZIP 压缩包或本地技能目录。'
                : '支持导入 ZIP 压缩包，或直接上传本地技能目录。'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Button
              variant="outline"
              disabled={importingMode !== null}
              onClick={() => {
                setImportDialogOpen(false)
                zipInputRef.current?.click()
              }}
            >
              {importingMode === 'zip' ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Upload className="mr-2 size-4" />
              )}
              选择 ZIP 压缩包
            </Button>
            <Button
              variant="outline"
              disabled={importingMode !== null}
              onClick={() => {
                setImportDialogOpen(false)
                directoryInputRef.current?.click()
              }}
            >
              {importingMode === 'directory' ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Package className="mr-2 size-4" />
              )}
              选择技能目录
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingUninstallSkill !== null}
        onOpenChange={open => {
          if (!open) {
            setPendingUninstallSkill(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认卸载技能</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingUninstallSkill
                ? `将从本机删除技能'${pendingUninstallSkill.displayName}'。`
                : '将从本机删除该技能。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleConfirmUninstall()}>
              确认卸载
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={editVisibilityOpen} onOpenChange={setEditVisibilityOpen}>
        <DialogContent className='max-w-lg'>
          <DialogHeader>
            <DialogTitle>编辑技能可见性</DialogTitle>
            <DialogDescription>
              设置哪些用户或部门可以看到此技能。
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-3'>
            <RadioGroup
              value={skillVisibilityMode}
              onValueChange={value => setSkillVisibilityMode(value as 'all' | 'departments' | 'users' | 'admin')}
            >
              <div className='flex items-center gap-2'>
                <RadioGroupItem value="all" />
                <label className='text-sm cursor-pointer'>全员可见</label>
              </div>
              <div className='flex items-center gap-2'>
                <RadioGroupItem value="departments" />
                <label className='text-sm cursor-pointer'>指定部门可见</label>
              </div>
              <div className='flex items-center gap-2'>
                <RadioGroupItem value="users" />
                <label className='text-sm cursor-pointer'>指定人员可见</label>
              </div>
              <div className='flex items-center gap-2'>
                <RadioGroupItem value="admin" />
                <label className='text-sm cursor-pointer'>仅管理员可见</label>
              </div>
            </RadioGroup>
            {skillVisibilityMode === 'departments' ? (
              departmentOptions.length === 0 ? (
                <p className='text-sm text-muted-foreground'>暂无部门数据</p>
              ) : (
                <div className='grid gap-2 rounded-lg border p-3 sm:grid-cols-2 max-h-64 overflow-y-auto'>
                  {departmentOptions.map(dept => (
                    <label
                      key={dept.id}
                      className='flex items-center gap-2 text-sm cursor-pointer hover:bg-accent/30 rounded px-2 py-1'
                    >
                      <Checkbox
                        checked={editSkillVisibleTo.includes(dept.id)}
                        onCheckedChange={checked => {
                          setEditSkillVisibleTo(
                            checked === true
                              ? [...editSkillVisibleTo, dept.id]
                              : editSkillVisibleTo.filter(id => id !== dept.id),
                          )
                        }}
                      />
                      <span>{'— '.repeat(dept.depth)}{dept.name}</span>
                    </label>
                  ))}
                </div>
              )
            ) : null}
            {skillVisibilityMode === 'users' ? (
              users.length === 0 ? (
                <p className='text-sm text-muted-foreground'>暂无用户数据</p>
              ) : (
                <div className='grid gap-2 rounded-lg border p-3 sm:grid-cols-2 max-h-64 overflow-y-auto'>
                  {users.map(user => (
                    <label
                      key={user.id}
                      className='flex items-center gap-2 text-sm cursor-pointer hover:bg-accent/30 rounded px-2 py-1'
                    >
                      <Checkbox
                        checked={editSkillVisibleUserIds.includes(user.id)}
                        onCheckedChange={checked => {
                          setEditSkillVisibleUserIds(
                            checked === true
                              ? [...editSkillVisibleUserIds, user.id]
                              : editSkillVisibleUserIds.filter(id => id !== user.id),
                          )
                        }}
                      />
                      <span>{user.name}</span>
                    </label>
                  ))}
                </div>
              )
            ) : null}
          </div>
          <DialogFooter>
            <Button variant='outline' onClick={() => setEditVisibilityOpen(false)}>
              取消
            </Button>
            <Button disabled={savingVisibility} onClick={() => void handleSaveVisibility()}>
              {savingVisibility ? (
                <>
                  <Loader2 className='mr-2 size-4 animate-spin' />
                  保存中
                </>
              ) : (
                '保存'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <input
        ref={zipInputRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={event => {
          const files = event.target.files
          void handleImportArchiveFiles(files)
          event.target.value = ''
        }}
      />
      <input
        ref={directoryInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={event => {
          const files = event.target.files
          void handleImportDirectoryFiles(files)
          event.target.value = ''
        }}
      />

      <Dialog open={skillSyncProgressOpen} onOpenChange={open => { if (!open) setSkillSyncProgressOpen(false) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>技能同步进度</DialogTitle>
            <DialogDescription>
              {skillSyncProgress?.status === 'running'
                ? '正在从 Hub 同步技能...'
                : skillSyncProgress?.status === 'done'
                  ? '同步完成'
                  : skillSyncProgress?.status === 'error'
                    ? '同步失败'
                    : '等待同步...'}
            </DialogDescription>
          </DialogHeader>
          {skillSyncProgress ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span>进度</span>
                <span className="text-muted-foreground">
                  {skillSyncProgress.processed}/{skillSyncProgress.total}
                </span>
              </div>
              <div className="h-2 w-full rounded-full bg-muted">
                <div
                  className="h-2 rounded-full bg-primary transition-all"
                  style={{
                    width: skillSyncProgress.total > 0
                      ? `${(skillSyncProgress.processed / skillSyncProgress.total) * 100}%`
                      : '0%',
                  }}
                />
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>新安装: <span className="font-medium">{skillSyncProgress.installed}</span></div>
                <div>更新: <span className="font-medium">{skillSyncProgress.updated}</span></div>
                <div>跳过: <span className="font-medium">{skillSyncProgress.skipped}</span></div>
                <div>失败: <span className="font-medium text-destructive">{skillSyncProgress.failed}</span></div>
              </div>
              {skillSyncProgress.status === 'error' && skillSyncProgress.error ? (
                <p className="text-sm text-destructive">{skillSyncProgress.error}</p>
              ) : null}
            </div>
          ) : (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSkillSyncProgressOpen(false)}
              disabled={skillSyncProgress?.status === 'running'}
            >
              {skillSyncProgress?.status === 'running' ? '同步中...' : '关闭'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={approvalDialogOpen} onOpenChange={open => { if (!open) setApprovalDialogOpen(false) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>审批专属技能</DialogTitle>
            <DialogDescription>
              {approvingSkill ? `审批技能: ${approvingSkill.display_name || approvingSkill.name}` : '审批专属技能发布申请'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-sm">
              <p className="font-medium">发布说明</p>
              <p className="mt-1 text-muted-foreground">{approvingSkill?.publish_note || '无发布说明'}</p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">审批备注</label>
              <Input
                value={approvalNote}
                onChange={e => setApprovalNote(e.target.value)}
                placeholder="可选，填写审批说明"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApprovalDialogOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={approving}
              onClick={() => void handleApproveTenantSkill(false)}
            >
              {approving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              拒绝
            </Button>
            <Button
              disabled={approving}
              onClick={() => void handleApproveTenantSkill(true)}
            >
              {approving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              通过
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={tenantVisibilityOpen} onOpenChange={open => { if (!open) setTenantVisibilityOpen(false) }}>
        <DialogContent className='max-w-lg'>
          <DialogHeader>
            <DialogTitle>编辑专属技能可见性</DialogTitle>
            <DialogDescription>
              {editingTenantSkill ? `设置 ${editingTenantSkill.display_name || editingTenantSkill.name} 的可见范围` : '设置专属技能的可见范围'}
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-3'>
            <RadioGroup
              value={tenantVisibilityMode}
              onValueChange={value => setTenantVisibilityMode(value as 'all' | 'departments' | 'users' | 'admin')}
            >
              <div className='flex items-center gap-2'>
                <RadioGroupItem value="all" />
                <label className='text-sm cursor-pointer'>全员可见</label>
              </div>
              <div className='flex items-center gap-2'>
                <RadioGroupItem value="departments" />
                <label className='text-sm cursor-pointer'>指定部门可见</label>
              </div>
              <div className='flex items-center gap-2'>
                <RadioGroupItem value="users" />
                <label className='text-sm cursor-pointer'>指定人员可见</label>
              </div>
              <div className='flex items-center gap-2'>
                <RadioGroupItem value="admin" />
                <label className='text-sm cursor-pointer'>仅管理员可见</label>
              </div>
            </RadioGroup>
            {tenantVisibilityMode === 'departments' ? (
              departmentOptions.length === 0 ? (
                <p className='text-sm text-muted-foreground'>暂无部门数据</p>
              ) : (
                <div className='grid gap-2 rounded-lg border p-3 sm:grid-cols-2 max-h-64 overflow-y-auto'>
                  {departmentOptions.map(dept => (
                    <label
                      key={dept.id}
                      className='flex items-center gap-2 text-sm cursor-pointer hover:bg-accent/30 rounded px-2 py-1'
                    >
                      <Checkbox
                        checked={editTenantVisibleTo.includes(dept.id)}
                        onCheckedChange={checked => {
                          setEditTenantVisibleTo(
                            checked === true
                              ? [...editTenantVisibleTo, dept.id]
                              : editTenantVisibleTo.filter(id => id !== dept.id),
                          )
                        }}
                      />
                      <span>{'— '.repeat(dept.depth)}{dept.name}</span>
                    </label>
                  ))}
                </div>
              )
            ) : null}
            {tenantVisibilityMode === 'users' ? (
              users.length === 0 ? (
                <p className='text-sm text-muted-foreground'>暂无用户数据</p>
              ) : (
                <div className='grid gap-2 rounded-lg border p-3 sm:grid-cols-2 max-h-64 overflow-y-auto'>
                  {users.map(user => (
                    <label
                      key={user.id}
                      className='flex items-center gap-2 text-sm cursor-pointer hover:bg-accent/30 rounded px-2 py-1'
                    >
                      <Checkbox
                        checked={editTenantVisibleUserIds.includes(user.id)}
                        onCheckedChange={checked => {
                          setEditTenantVisibleUserIds(
                            checked === true
                              ? [...editTenantVisibleUserIds, user.id]
                              : editTenantVisibleUserIds.filter(id => id !== user.id),
                          )
                        }}
                      />
                      <span>{user.name}</span>
                    </label>
                  ))}
                </div>
              )
            ) : null}
          </div>
          <DialogFooter>
            <Button variant='outline' onClick={() => setTenantVisibilityOpen(false)}>
              取消
            </Button>
            <Button
              variant='destructive'
              disabled={deletingTenantSkillId !== null}
              onClick={() => void handleConfirmDeleteTenantSkill()}
            >
              {deletingTenantSkillId !== null ? <Loader2 className='mr-2 size-4 animate-spin' /> : null}
              删除
            </Button>
            <Button disabled={savingTenantVisibility} onClick={() => void handleSaveTenantVisibility()}>
              {savingTenantVisibility ? (
                <>
                  <Loader2 className='mr-2 size-4 animate-spin' />
                  保存中
                </>
              ) : (
                '保存'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 专属技能详情对话框 */}
      <Dialog open={tenantSkillDetail !== null} onOpenChange={open => { if (!open) setTenantSkillDetail(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{tenantSkillDetail?.display_name || tenantSkillDetail?.name || '专属技能详情'}</DialogTitle>
            <DialogDescription>
              查看专属技能详细信息。
            </DialogDescription>
          </DialogHeader>
          {tenantSkillDetail && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    tenantSkillDetail.status === 'approved'
                      ? 'default'
                      : tenantSkillDetail.status === 'pending'
                        ? 'secondary'
                        : 'destructive'
                  }
                >
                  {tenantSkillDetail.status === 'approved'
                    ? '已通过'
                    : tenantSkillDetail.status === 'pending'
                      ? '待审批'
                      : '已拒绝'}
                </Badge>
                {tenantSkillDetail.status === 'approved' && (
                  <Badge variant="outline">
                    {tenantSkillDetail.enabled ? '已启用' : '已禁用'}
                  </Badge>
                )}
              </div>

              <div>
                <h4 className="text-sm font-medium text-muted-foreground mb-1">描述</h4>
                <p className="text-sm">{tenantSkillDetail.description || '暂无描述'}</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h4 className="text-sm font-medium text-muted-foreground mb-1">版本</h4>
                  <p className="text-sm">{tenantSkillDetail.version || '未知'}</p>
                </div>
                <div>
                  <h4 className="text-sm font-medium text-muted-foreground mb-1">作者</h4>
                  <p className="text-sm">{tenantSkillDetail.author_name || tenantSkillDetail.author_id}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h4 className="text-sm font-medium text-muted-foreground mb-1">创建时间</h4>
                  <p className="text-sm">{new Date(tenantSkillDetail.created_at).toLocaleString()}</p>
                </div>
                <div>
                  <h4 className="text-sm font-medium text-muted-foreground mb-1">更新时间</h4>
                  <p className="text-sm">{new Date(tenantSkillDetail.updated_at).toLocaleString()}</p>
                </div>
              </div>

              {tenantSkillDetail.publish_note && (
                <div>
                  <h4 className="text-sm font-medium text-muted-foreground mb-1">发布说明</h4>
                  <p className="text-sm">{tenantSkillDetail.publish_note}</p>
                </div>
              )}

              {tenantSkillDetail.review_note && (
                <div>
                  <h4 className="text-sm font-medium text-muted-foreground mb-1">审批备注</h4>
                  <p className="text-sm">{tenantSkillDetail.review_note}</p>
                </div>
              )}

              {tenantSkillDetail.status === 'approved' && tenantSkillDetail.visible_to && (
                <div>
                  <h4 className="text-sm font-medium text-muted-foreground mb-2">可见范围</h4>
                  <div className="flex flex-wrap gap-2">
                    {tenantSkillDetail.visible_to.user_ids?.length ? (
                      tenantSkillDetail.visible_to.user_ids.map(userId => {
                        const user = users.find(u => u.id === userId)
                        return user ? (
                          <Badge key={userId} variant="outline">{user.name}</Badge>
                        ) : null
                      })
                    ) : tenantSkillDetail.visible_to.department_ids?.length ? (
                      tenantSkillDetail.visible_to.department_ids.map(deptId => {
                        const name = departmentNameMap.get(deptId)
                        return name ? (
                          <Badge key={deptId} variant="outline">{name}</Badge>
                        ) : null
                      })
                    ) : (
                      <span className="text-sm text-muted-foreground">全员可见</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTenantSkillDetail(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}
