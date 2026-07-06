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
  Plug,
  KeyRound,
  ChevronRight,
  ListChecks,
  Clock,
  Wrench,
  ScrollText,
  ShieldCheck,
  Plane,
} from 'lucide-react'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAuth } from '@/lib/hooks/use-auth'
import { hasAnyScope, hasScope, setPreferredOrgId } from '@/lib/api/client'
import { getOrganizations, switchOrg } from '@/lib/api/auth'
import { getEnterpriseConfig } from '@/lib/api/enterprise'
import type { AuthOrgWithCounts } from '@/lib/api/types'
import { cn } from '@/lib/utils'

type NavItem = {
  title: string
  url: string
  icon: ComponentType<{ className?: string }>
  requiredScope?: string
  requiredAnyScopes?: string[]
  requiredRole?: string
  feature?: 'cabin'
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
  },
]

export function AppSidebar() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { user, scopes, activeOrgId, logout } = useAuth()
  const [expandedMenus, setExpandedMenus] = useState<Set<string>>(new Set())
  const [cabinEnabled, setCabinEnabled] = useState(false)

  // Super-admin org switcher: lists all orgs and re-scopes the session to the
  // selected one. Only super admins may switch across organizations.
  const isSuperAdmin = user?.role === 'super_admin'
  const [organizations, setOrganizations] = useState<AuthOrgWithCounts[]>([])
  const [switchingOrg, setSwitchingOrg] = useState(false)

  useEffect(() => {
    if (!isSuperAdmin) return
    let cancelled = false
    getOrganizations()
      .then((res) => {
        if (!cancelled) setOrganizations(res.organizations)
      })
      .catch(() => {
        if (!cancelled) setOrganizations([])
      })
    return () => {
      cancelled = true
    }
  }, [isSuperAdmin])

  useEffect(() => {
    let cancelled = false
    getEnterpriseConfig()
      .then((response) => {
        if (!cancelled) setCabinEnabled(response.data.cabin_enabled === true)
      })
      .catch(() => {
        if (!cancelled) setCabinEnabled(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleSwitchOrg = async (orgId: string) => {
    if (!orgId || orgId === activeOrgId || switchingOrg) return
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
    await logout()
    navigate('/login', { replace: true })
  }

  const isItemActive = (url: string) => {
    if (url === '/') return pathname === '/'
    return pathname === url || pathname.startsWith(`${url}/`)
  }

  const hasActiveDescendant = (item: NavItem): boolean => {
    if (!item.children) return false
    return item.children.some(child => {
      if (child.children) return hasActiveDescendant(child)
      return child.url ? isItemActive(child.url) : false
    })
  }

  const isItemVisible = (item: NavItem): boolean => {
    if (item.requiredRole && user?.role !== item.requiredRole) return false
    return matchesScope(item)
  }

  const renderNavItem = (item: NavItem, level = 0) => {
    // Parent menu with children
    if (item.children) {
      const visibleChildren = item.children.filter(isItemVisible)
      if (visibleChildren.length === 0) return null

      const isAnyChildActive = hasActiveDescendant(item)
      const isExpanded = expandedMenus.has(item.title) || isAnyChildActive

      return (
        <li key={item.title}>
          <Collapsible open={isExpanded} onOpenChange={(open) => {
            const next = new Set(expandedMenus)
            if (open) { next.add(item.title) } else { next.delete(item.title) }
            setExpandedMenus(next)
          }}>
            <CollapsibleTrigger className={cn(
              'flex items-center gap-3 px-3 py-2 rounded-md text-sm w-full transition-colors text-left',
              isAnyChildActive
                ? 'bg-primary/10 text-primary font-medium'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            )}>
              <item.icon className="size-4" />
              <span className="flex-1">{item.title}</span>
              <ChevronRight className={cn('size-3.5 transition-transform', isExpanded && 'rotate-90')} />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="space-y-0.5 mt-1 ml-4">
                {visibleChildren.map(child => {
                  // Check if child has nested children (for 工具中心 -> MCP 服务)
                  const hasNestedChildren = child.children && child.children.length > 0
                  return (
                    <li key={child.title}>
                      {hasNestedChildren ? (
                        // Nested menu (level 1 with children, like MCP 服务)
                        (() => {
                          const nestedChildren = child.children!.filter(isItemVisible)
                          const isAnyNestedActive = nestedChildren.some((c: NavItem) => isItemActive(c.url))
                          const isNestedExpanded = expandedMenus.has(child.title) || isAnyNestedActive
                          return (
                            <Collapsible open={isNestedExpanded} onOpenChange={(open) => {
                              const next = new Set(expandedMenus)
                              if (open) { next.add(child.title) } else { next.delete(child.title) }
                              setExpandedMenus(next)
                            }}>
                              <CollapsibleTrigger className={cn(
                                'flex items-center gap-3 px-2 py-1.5 rounded-md text-sm w-full transition-colors text-left ml-2',
                                isAnyNestedActive
                                  ? 'bg-primary/10 text-primary font-medium'
                                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                              )}>
                                <span className="w-1 h-1 rounded-full bg-current opacity-40" />
                                <span className="flex-1">{child.title}</span>
                                <ChevronRight className={cn('size-3.5 transition-transform', isNestedExpanded && 'rotate-90')} />
                              </CollapsibleTrigger>
                              <CollapsibleContent>
                                <ul className="space-y-0.5 mt-0.5 ml-4">
                                  {nestedChildren.map((nested: NavItem) => {
                                    const isActive = isItemActive(nested.url)
                                    return (
                                      <li key={nested.title}>
                                        <Link
                                          to={nested.url}
                                          className={cn(
                                            'flex items-center gap-3 px-2 py-1.5 rounded-md text-sm transition-colors ml-2',
                                            isActive
                                              ? 'bg-primary/10 text-primary font-medium'
                                              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                                          )}
                                        >
                                          {nested.icon && <nested.icon className="size-3.5" />}
                                          <span>{nested.title}</span>
                                        </Link>
                                      </li>
                                    )
                                  })}
                                </ul>
                              </CollapsibleContent>
                            </Collapsible>
                          )
                        })()
                      ) : (
                        // Regular child (no nested children, like 知识树管理)
                        (() => {
                          const isActive = isItemActive(child.url)
                          return (
                            <Link
                              to={child.url}
                              className={cn(
                                'flex items-center gap-3 px-3 py-1.5 rounded-md text-sm transition-colors',
                                isActive
                                  ? 'bg-primary/10 text-primary font-medium'
                                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                              )}
                            >
                              <span className="w-1 h-1 rounded-full bg-current opacity-40" />
                              <span>{child.title}</span>
                            </Link>
                          )
                        })()
                      )}
                    </li>
                  )
                })}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        </li>
      )
    }

    // Regular menu item (no children)
    const isActive = isItemActive(item.url)
    return (
      <li key={item.title}>
        <Link
          to={item.url}
          className={cn(
            'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
            isActive
              ? 'bg-primary/10 text-primary font-medium'
              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
          )}
        >
          <item.icon className="size-4" />
          <span>{item.title}</span>
        </Link>
      </li>
    )
  }

  return (
    <aside className="w-64 border-r bg-card flex flex-col h-full">
      {/* Header */}
      <div className="border-b px-4 py-3 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Shield className="size-5" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold">moss 中控平台</span>
          </div>
        </div>
        {isSuperAdmin ? (
          <Select
            value={activeOrgId ?? ''}
            onValueChange={(value) => void handleSwitchOrg(value)}
            disabled={switchingOrg}
          >
            <SelectTrigger className="h-8 text-xs" aria-label="切换组织">
              <Building2 className="size-3.5 shrink-0 text-muted-foreground" />
              <SelectValue placeholder="选择组织" />
            </SelectTrigger>
            <SelectContent>
              {organizations.map((org) => (
                <SelectItem key={org.id} value={org.id}>
                  {org.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 overflow-y-auto">
        <div className="mb-6">
          <p className="text-xs font-medium text-muted-foreground mb-2 px-3">主菜单</p>
          <ul className="space-y-1">
            {visibleMenuItems.map(renderNavItem)}
          </ul>
        </div>

        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2 px-3">系统</p>
          <ul className="space-y-1">
            {visibleSystemItems.map(renderNavItem)}
          </ul>
        </div>
      </nav>

      {/* Footer */}
      <div className="border-t p-4">
        <div className="flex items-center gap-3">
          <Avatar className="size-8">
            <AvatarFallback className="bg-primary/10 text-primary text-xs">
              {user?.name?.slice(0, 1) || 'U'}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{user?.name || 'User'}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void handleLogout()}
            className="shrink-0"
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      </div>
    </aside>
  )
}
