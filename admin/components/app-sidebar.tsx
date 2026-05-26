'use client'

import { useState } from 'react'
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
} from 'lucide-react'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useAuth } from '@/lib/hooks/use-auth'
import { hasAnyScope, hasScope } from '@/lib/api/client'
import { cn } from '@/lib/utils'

type NavItem = {
  title: string
  url: string
  icon: ComponentType<{ className?: string }>
  requiredScope?: string
  requiredAnyScopes?: string[]
  children?: NavItem[]
}

const roleLabels: Record<string, string> = {
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
    title: '定时任务',
    url: '/cron',
    icon: Clock,
    requiredScope: 'admin:cron',
  },
  {
    title: 'IM管理',
    url: '/channels',
    icon: Bot,
  },
  {
    title: '智能体管理',
    url: '/settings/agents',
    icon: Bot,
    requiredScope: 'admin:settings',
  },
  {
    title: '技能商店',
    url: '/settings/skill',
    icon: Sparkles,
    requiredScope: 'admin:settings',
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
    requiredScope: 'admin:secrets',
    children: [
      { title: '配置项列表', url: '/secrets/config-items', icon: KeyRound },
      { title: '企业凭据', url: '/secrets/enterprise', icon: KeyRound },
      { title: '部门授权', url: '/secrets/department-policies', icon: KeyRound },
      { title: '用户凭据', url: '/secrets/user-credentials', icon: KeyRound },
      { title: '审计日志', url: '/secrets/audit-log', icon: KeyRound },
      { title: '轮换告警', url: '/secrets/rotation-alerts', icon: KeyRound },
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
  const { user, scopes, logout } = useAuth()
  const [expandedMenu, setExpandedMenu] = useState<string | null>('auto')

  const visibleMenuItems = menuItems.filter((item) => {
    if ('requiredScope' in item && item.requiredScope) {
      return hasScope(scopes, item.requiredScope)
    }
    if ('requiredAnyScopes' in item && item.requiredAnyScopes) {
      return hasAnyScope(scopes, item.requiredAnyScopes)
    }
    return true
  })

  const visibleSystemItems = systemItems.filter((item) => {
    if ('requiredScope' in item && item.requiredScope) {
      return hasScope(scopes, item.requiredScope)
    }
    if ('requiredAnyScopes' in item && item.requiredAnyScopes) {
      return hasAnyScope(scopes, item.requiredAnyScopes)
    }
    return true
  })

  const handleLogout = async () => {
    await logout()
    navigate('/login', { replace: true })
  }

  const isItemActive = (url: string) => {
    if (url === '/') return pathname === '/'
    return pathname === url || pathname.startsWith(`${url}/`)
  }

  const renderNavItem = (item: NavItem) => {
    // Parent menu with children
    if (item.children) {
      const visibleChildren = item.children.filter(() => {
        // Children inherit parent's scope requirement; if parent is visible, children are too
        return true
      })
      if (visibleChildren.length === 0) return null

      const isAnyChildActive = visibleChildren.some(child => isItemActive(child.url))
      const isExpanded = expandedMenu === item.title || (expandedMenu === 'auto' && isAnyChildActive)

      return (
        <li key={item.title}>
          <Collapsible
            open={isExpanded}
            onOpenChange={(open) => setExpandedMenu(open ? item.title : null)}
          >
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
                  const isActive = isItemActive(child.url)
                  return (
                    <li key={child.title}>
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
      <div className="h-14 border-b px-4 flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Shield className="size-5" />
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-semibold">moss 中控平台</span>
        </div>
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
