'use client'

import { useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  Users,
  MessageSquare,
  Settings,
  LogOut,
  Shield,
  Bot,
  Sparkles,
  Wallet,
  Building2,
  BookText,
  Check,
  ChevronDown,
  Plug,
  KeyRound,
  ChevronRight,
  ListChecks,
  Clock,
  Wrench,
  ScrollText,
  ShieldCheck,
  Plane,
  Webhook,
  ServerCog,
  ReceiptText,
  TicketCheck,
  Activity,
  ClipboardList,
  Database,
  Boxes,
} from 'lucide-react'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { useAuth } from '@/lib/hooks/use-auth'
import { useUnsavedChanges } from '@/lib/hooks/use-unsaved-changes'
import { hasAnyScope, hasScope, setPreferredOrgId } from '@/lib/api/client'
import { getOrganizations, ORGANIZATIONS_CHANGED_EVENT, switchOrg } from '@/lib/api/auth'
import { getEnterpriseConfig } from '@/lib/api/enterprise'
import type { AuthOrgWithCounts, EnterpriseConfig } from '@/lib/api/types'
import { cn } from '@/lib/utils'
import { OPERATION_ROUTES } from '@/src/operations-navigation'

type NavItem = {
  title: string
  url: string
  icon: ComponentType<{ className?: string }>
  requiredScope?: string
  requiredAnyScopes?: string[]
  requiredRole?: string
  feature?: 'cabin'
  exact?: boolean
  children?: NavItem[]
}

const roleLabels: Record<string, string> = {
  super_admin: '超级管理员',
  admin: '管理员',
  dept_admin: '部门管理员',
  user: '普通用户',
}

const menuItems: NavItem[] = [
  {
    title: '数据看板',
    url: '/',
    icon: LayoutDashboard,
  },
  {
    title: '预算管理',
    url: '/budget',
    icon: Wallet,
    requiredAnyScopes: ['sessions:list', 'sessions:list:any'],
  },
  {
    title: '用户与组织',
    url: '/users',
    icon: Users,
    requiredScope: 'admin:users',
  },
  {
    // 普通用户可见（页面对其展示"可用 Zone"列表是设计行为，后端 binding
    // 管理入口 403 兜底）——标题不带"管理"字样，避免误导。
    title: 'Zone',
    url: '/zones',
    icon: Boxes,
  },
  {
    title: '会话管理',
    url: '/sessions',
    icon: MessageSquare,
    requiredAnyScopes: ['sessions:list', 'sessions:list:any'],
  },
  {
    title: '客舱 AI',
    url: '/cabin/conversations',
    icon: Plane,
    requiredScope: 'admin:settings',
    feature: 'cabin',
  },
  {
    title: '定时任务',
    url: '/cron',
    icon: Clock,
    requiredAnyScopes: ['admin:cron', 'cron:self'],
  },
  {
    title: '事件触发器',
    url: '/event-triggers',
    icon: Webhook,
    requiredScope: 'admin:triggers',
  },
  {
    title: 'IM管理',
    url: '/channels',
    icon: Bot,
  },
  {
    title: '企业应用管理',
    url: '/corp-apps',
    icon: Building2,
    requiredScope: 'admin:settings',
  },
  {
    title: '智能体管理',
    url: '/settings/agents',
    icon: Bot,
    requiredAnyScopes: ['admin:settings', 'store:read'],
  },
  {
    title: '技能商店',
    url: '/settings/skill',
    icon: Sparkles,
    requiredAnyScopes: ['admin:settings', 'store:read'],
  },
  {
    title: '文档中心',
    url: '/document-center',
    icon: BookText,
    requiredAnyScopes: ['admin:documents', 'admin:settings'],
    children: [
      { title: '知识树管理', url: '/document-center/tree', icon: BookText },
      { title: '外部数据源', url: '/document-center/sources', icon: Plug },
      { title: '构建任务', url: '/document-center/build-jobs', icon: ListChecks },
      { title: 'Dify 数据集', url: '/document-center/dify-datasets', icon: Database },
    ],
  },
  {
    title: '凭据中心',
    url: '/secrets',
    icon: KeyRound,
    requiredAnyScopes: ['admin:secrets', 'secrets:department:read', 'secrets:user:write'],
    children: [
      { title: '配置项列表', url: '/secrets/config-items', icon: KeyRound, requiredScope: 'admin:secrets' },
      { title: '企业凭据', url: '/secrets/enterprise', icon: KeyRound, requiredScope: 'admin:secrets' },
      { title: '部门凭据', url: '/secrets/department', icon: KeyRound, requiredAnyScopes: ['admin:secrets', 'secrets:department:read'] },
      { title: '用户凭据', url: '/secrets/user-credentials', icon: KeyRound, requiredAnyScopes: ['admin:secrets', 'secrets:user:write'] },
      { title: '审计日志', url: '/secrets/audit-log', icon: KeyRound, requiredAnyScopes: ['admin:secrets', 'secrets:department:read', 'secrets:user:write'] },
      { title: '轮换告警', url: '/secrets/rotation-alerts', icon: KeyRound, requiredAnyScopes: ['admin:secrets', 'secrets:department:read', 'secrets:user:write'] },
    ],
  },
  {
    title: '运营中心',
    url: '/operations',
    icon: Activity,
    requiredScope: 'admin:settings',
    children: [
      { title: '邀请码管理', url: OPERATION_ROUTES.invitations, icon: TicketCheck },
      { title: '账务管理', url: OPERATION_ROUTES.billing, icon: ReceiptText },
      { title: '业务审计', url: OPERATION_ROUTES.audit, icon: ClipboardList },
      { title: '质量管理', url: OPERATION_ROUTES.quality, icon: Activity },
      { title: 'Sudowork 系统设置', url: OPERATION_ROUTES.sudoworkSettings, icon: Settings },
    ],
  },
  {
    title: '工具中心',
    url: '/mcp',
    icon: Wrench,
    requiredScope: 'admin:mcp',
    children: [
      {
        title: 'MCP 服务',
        url: '#',
        icon: Wrench,
        children: [
          { title: '企业服务', url: '/mcp/servers/enterprise', icon: Building2, requiredRole: 'admin' },
          { title: '部门服务', url: '/mcp/servers/department', icon: Users },
          { title: '策略配置', url: '/mcp/policy', icon: ShieldCheck },
          { title: '审计日志', url: '/mcp/audit-log', icon: ScrollText },
          { title: '审批管理', url: '/mcp/approvals', icon: Shield },
          { title: '模板市场', url: '/mcp/templates', icon: Sparkles },
        ],
      },
    ],
  },
]

const systemItems: NavItem[] = [
  {
    title: '企业信息配置',
    url: '/settings/enterprise',
    icon: Building2,
    requiredScope: 'admin:settings',
  },
  {
    title: '系统设置',
    url: '/settings',
    icon: Settings,
    requiredScope: 'admin:settings',
    exact: true,
  },
  {
    title: '平台配置',
    url: '/settings/platform-config',
    icon: ServerCog,
    requiredRole: 'super_admin',
  },
  {
    title: '账户安全',
    url: '/account/security',
    icon: KeyRound,
  },
  {
    title: '服务器凭据',
    requiredRole: 'super_admin',
    url: '/settings/server-credentials',
    icon: ServerCog,
    requiredScope: 'admin:settings',
  },
]

const primaryNavGroups = [
  {
    title: '工作空间',
    items: [
      menuItems[0],
      menuItems[1],
      menuItems[3],
      menuItems[4],
      menuItems[5],
      menuItems[9],
      menuItems[10],
      menuItems[11],
    ],
  },
  {
    title: '组织管理',
    items: [menuItems[2], menuItems[7], menuItems[8], menuItems[12]],
  },
  {
    title: '运营与集成',
    items: [menuItems[6], menuItems[13], menuItems[14]],
  },
] as const

export function AppSidebar() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { setOpenMobile } = useSidebar()
  useEffect(() => { setOpenMobile(false) }, [pathname, setOpenMobile])
  const { user, scopes, activeOrgId, logout } = useAuth()
  const { confirmDiscard } = useUnsavedChanges()
  const [expandedMenus, setExpandedMenus] = useState<Record<string, boolean>>({})
  useEffect(() => { setExpandedMenus({}) }, [pathname])
  const [cabinEnabled, setCabinEnabled] = useState(false)
  const [enterpriseConfig, setEnterpriseConfig] = useState<EnterpriseConfig | null>(null)

  // Super-admin org switcher: lists all orgs and re-scopes the session to the
  // selected one. Only super admins may switch across organizations.
  const isSuperAdmin = user?.role === 'super_admin'
  const [organizations, setOrganizations] = useState<AuthOrgWithCounts[]>([])
  const [switchingOrg, setSwitchingOrg] = useState(false)
  const [orgPickerOpen, setOrgPickerOpen] = useState(false)
  const [orgSearch, setOrgSearch] = useState('')

  useEffect(() => {
    if (!isSuperAdmin) return
    let cancelled = false
    let latestRequest = 0
    const refreshOrganizations = () => {
      const request = ++latestRequest
      void getOrganizations()
        .then((res) => {
          if (!cancelled && request === latestRequest) setOrganizations(res.organizations)
        })
        .catch(() => {
          // Keep the last usable list if a refresh fails.
        })
    }
    refreshOrganizations()
    window.addEventListener(ORGANIZATIONS_CHANGED_EVENT, refreshOrganizations)
    return () => {
      cancelled = true
      window.removeEventListener(ORGANIZATIONS_CHANGED_EVENT, refreshOrganizations)
    }
  }, [isSuperAdmin])

  useEffect(() => {
    let cancelled = false
    getEnterpriseConfig()
      .then((response) => {
        if (!cancelled) {
          setCabinEnabled(response.data.cabin_enabled === true)
          setEnterpriseConfig(response.data)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCabinEnabled(false)
          setEnterpriseConfig(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleSwitchOrg = async (orgId: string) => {
    if (!orgId || orgId === activeOrgId || switchingOrg) return
    if (!(await confirmDiscard())) return
    setSwitchingOrg(true)
    try {
      await switchOrg(orgId)
      // Remember the selection so it persists across logins.
      setPreferredOrgId(orgId)
      // Reload so every page re-fetches against the newly selected org.
      window.location.reload()
    } catch {
      setSwitchingOrg(false)
    }
  }

  // Single source of truth for scope-gating a nav item (top-level or child):
  // an explicit requiredScope / requiredAnyScopes must be satisfied; items with
  // neither are ungated. Shared by the top-level filters and the child-level
  // isItemVisible so children honor scope gating identically to their parents.
  const matchesScope = (item: NavItem): boolean => {
    if (item.requiredRole && item.requiredRole !== user?.role) return false
    if ('requiredScope' in item && item.requiredScope) {
      return hasScope(scopes, item.requiredScope)
    }
    if ('requiredAnyScopes' in item && item.requiredAnyScopes) {
      return hasAnyScope(scopes, item.requiredAnyScopes)
    }
    return true
  }

  const visibleMenuItems = menuItems.filter((item) => {
    if (item.feature === 'cabin' && !cabinEnabled) {
      return false
    }
    return matchesScope(item)
  })

  const visibleSystemItems = systemItems.filter(matchesScope)

  const handleLogout = async () => {
    if (!(await confirmDiscard())) return
    await logout()
    navigate('/login', { replace: true })
  }

  const isItemActive = (item: NavItem) => {
    if (item.url === '/') return pathname === '/'
    if (item.exact) return pathname === item.url
    return pathname === item.url || pathname.startsWith(`${item.url}/`)
  }

  const hasActiveDescendant = (item: NavItem): boolean => {
    if (!item.children) return false
    return item.children.some(child => {
      if (child.children) return hasActiveDescendant(child)
      return child.url ? isItemActive(child) : false
    })
  }

  const isItemVisible = (item: NavItem): boolean => {
    if (item.requiredRole && user?.role !== item.requiredRole) return false
    return matchesScope(item)
  }

  const visiblePrimaryNavGroups = primaryNavGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => visibleMenuItems.includes(item)),
    }))
    .filter((group) => group.items.length > 0)

  const setMenuExpanded = (title: string, open: boolean) => {
    setExpandedMenus(current => ({ ...current, [title]: open }))
  }

  const renderNavItem = (item: NavItem, level = 0) => {
    if (item.children) {
      const visibleChildren = item.children.filter(isItemVisible)
      if (visibleChildren.length === 0) return null

      const isAnyChildActive = isItemActive(item) || hasActiveDescendant(item)
      const isExpanded = expandedMenus[item.title] ?? isAnyChildActive

      if (level === 0) {
        return (
          <SidebarMenuItem key={item.title}>
            <Collapsible open={isExpanded} onOpenChange={(open) => setMenuExpanded(item.title, open)}>
              <SidebarMenuButton asChild isActive={isAnyChildActive} tooltip={item.title}>
                <Link to={item.url}>
                  <item.icon />
                  <span>{item.title}</span>
                </Link>
              </SidebarMenuButton>
              <CollapsibleTrigger asChild>
                <SidebarMenuAction aria-label={`${item.title} 展开/收起`} showOnHover>
                  <ChevronRight className={cn('transition-transform', isExpanded && 'rotate-90')} />
                </SidebarMenuAction>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <SidebarMenuSub>
                  {visibleChildren.map((child) => renderNavItem(child, level + 1))}
                </SidebarMenuSub>
              </CollapsibleContent>
            </Collapsible>
          </SidebarMenuItem>
        )
      }

      return (
        <SidebarMenuSubItem key={item.title}>
          <Collapsible open={isExpanded} onOpenChange={(open) => setMenuExpanded(item.title, open)}>
            <CollapsibleTrigger asChild>
              <SidebarMenuSubButton asChild isActive={isAnyChildActive}>
                <button type="button" aria-label={`${item.title} 展开/收起`}>
                  <item.icon />
                  <span>{item.title}</span>
                  <ChevronRight className={cn('ml-auto transition-transform', isExpanded && 'rotate-90')} />
                </button>
              </SidebarMenuSubButton>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarMenuSub className="ml-2">
                {visibleChildren.map((child) => renderNavItem(child, level + 1))}
              </SidebarMenuSub>
            </CollapsibleContent>
          </Collapsible>
        </SidebarMenuSubItem>
      )
    }

    const isActive = isItemActive(item)
    if (level === 0) {
      return (
        <SidebarMenuItem key={item.title}>
          <SidebarMenuButton asChild isActive={isActive} tooltip={item.title}>
            <Link to={item.url}>
              <item.icon />
              <span>{item.title}</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      )
    }

    return (
      <SidebarMenuSubItem key={item.title}>
        <SidebarMenuSubButton asChild isActive={isActive}>
          <Link to={item.url}>
            <item.icon />
            <span>{item.title}</span>
          </Link>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    )
  }

  const activeOrganization = organizations.find((organization) => organization.id === activeOrgId)
  const normalizedOrgSearch = orgSearch.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
  const filteredOrganizations = normalizedOrgSearch
    ? organizations.filter((organization) => {
        const name = organization.name.toLocaleLowerCase()
        const id = organization.id.toLocaleLowerCase()
        return name.includes(normalizedOrgSearch) || id.includes(normalizedOrgSearch)
      })
    : organizations
  const brandName = enterpriseConfig?.top_name || enterpriseConfig?.app_name || activeOrganization?.name || '管理平台'
  const accountName = user?.displayName || user?.name || '当前用户'

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-sidebar-border gap-3 border-b px-3 py-4">
        <div className="flex min-w-0 items-center gap-2 px-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          {enterpriseConfig?.logo ? (
            <img
              src={enterpriseConfig.logo}
              alt={`${brandName} 标志`}
              className="size-8 shrink-0 rounded-md object-contain"
            />
          ) : (
            <span className="bg-sidebar-primary text-sidebar-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
              <Shield className="size-4" aria-hidden="true" />
            </span>
          )}
          <span className="min-w-0 truncate text-sm font-semibold tracking-[-0.01em] group-data-[collapsible=icon]:hidden">
            {brandName}
          </span>
        </div>

        {isSuperAdmin ? (
          <SidebarMenu>
            <SidebarMenuItem>
              <Popover
                open={orgPickerOpen}
                onOpenChange={(open) => {
                  setOrgPickerOpen(open)
                  if (!open) setOrgSearch('')
                }}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    role="combobox"
                    aria-label="切换组织"
                    aria-expanded={orgPickerOpen}
                    disabled={switchingOrg}
                    className="border-sidebar-border bg-background/60 flex h-auto w-full items-center justify-start gap-2 rounded-md border px-2 py-2 text-left text-sm shadow-none outline-none hover:bg-sidebar-accent focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-transparent group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-2! group-data-[collapsible=icon]:[&>svg]:hidden"
                  >
                    <span className="shrink-0"><Building2 className="text-sidebar-foreground/70 size-4" /></span>
                    <span className="grid min-w-0 flex-1 gap-0.5 group-data-[collapsible=icon]:hidden">
                      <span className="truncate">{activeOrganization?.name || '选择组织'}</span>
                      <span className="text-muted-foreground text-xs">企业工作空间</span>
                    </span>
                    <ChevronDown className="text-sidebar-foreground/60 size-4 shrink-0" aria-hidden="true" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 max-w-[calc(100vw-1rem)] p-0">
                  <Command shouldFilter={false}>
                    <CommandInput
                      placeholder="搜索组织名称或 ID"
                      aria-label="搜索组织"
                      value={orgSearch}
                      onValueChange={setOrgSearch}
                    />
                    <CommandList className="max-h-72">
                      <CommandEmpty>未找到匹配的组织</CommandEmpty>
                      {filteredOrganizations.map((organization) => (
                        <CommandItem
                          key={organization.id}
                          value={organization.id}
                          onSelect={() => {
                            setOrgPickerOpen(false)
                            setOrgSearch('')
                            void handleSwitchOrg(organization.id)
                          }}
                        >
                          <span className="min-w-0 truncate">{organization.name}</span>
                          <Check
                            className={cn(
                              'ml-auto size-4 shrink-0',
                              organization.id === activeOrgId ? 'opacity-100' : 'opacity-0',
                            )}
                            aria-hidden="true"
                          />
                        </CommandItem>
                      ))}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </SidebarMenuItem>
          </SidebarMenu>
        ) : null}
      </SidebarHeader>

      <SidebarContent className="gap-0 px-2 py-3">
        <nav aria-label="主导航">
          {visiblePrimaryNavGroups.map((group) => (
            <SidebarGroup key={group.title} className="px-1 py-2">
              <SidebarGroupLabel className="text-sidebar-foreground/60 h-7 px-2 text-xs font-medium">
                {group.title}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="gap-0.5">
                  {group.items.map((item) => renderNavItem(item))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}

          {visibleSystemItems.length > 0 ? (
            <SidebarGroup className="px-1 py-2">
              <SidebarGroupLabel className="text-sidebar-foreground/60 h-7 px-2 text-xs font-medium">
                系统
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="gap-0.5">
                  {visibleSystemItems.map((item) => renderNavItem(item))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ) : null}
        </nav>
      </SidebarContent>

      <SidebarFooter className="border-sidebar-border border-t p-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton tooltip={accountName} className="h-auto py-1.5">
              <Avatar className="size-6 shrink-0">
                <AvatarFallback className="bg-sidebar-accent text-sidebar-accent-foreground text-xs">
                  {accountName.slice(0, 1)}
                </AvatarFallback>
              </Avatar>
              <span className="flex min-w-0 flex-1 flex-col text-left">
                <span className="truncate text-sm font-medium">{accountName}</span>
                <span className="text-sidebar-foreground/60 truncate text-xs">
                  {roleLabels[user?.role ?? ''] || '用户'}
                </span>
              </span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end" className="w-56">
            <DropdownMenuLabel className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate">{accountName}</span>
              {user?.email ? (
                <span className="text-muted-foreground truncate text-xs font-normal">{user.email}</span>
              ) : null}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void handleLogout()}>
              <LogOut />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
