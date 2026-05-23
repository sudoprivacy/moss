'use client'

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
} from 'lucide-react'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/hooks/use-auth'
import { hasAnyScope, hasScope } from '@/lib/api/client'

type NavItem = {
  title: string
  url: string
  icon: ComponentType<{ className?: string }>
  requiredScope?: string
  requiredAnyScopes?: string[]
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
    title: 'IM 接入',
    url: '/settings/adapters',
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
]

const systemItems: NavItem[] = [
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
      <nav className="flex-1 p-4">
        <div className="mb-6">
          <p className="text-xs font-medium text-muted-foreground mb-2 px-3">主菜单</p>
          <ul className="space-y-1">
            {visibleMenuItems.map((item) => {
              const isActive =
                item.url === '/'
                  ? pathname === '/'
                  : pathname === item.url || pathname.startsWith(`${item.url}/`)
              return (
                <li key={item.title}>
                  <Link
                    to={item.url}
                    className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                      isActive
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                    }`}
                  >
                    <item.icon className="size-4" />
                    <span>{item.title}</span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>

        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2 px-3">系统</p>
          <ul className="space-y-1">
            {visibleSystemItems.map((item) => {
              const isActive =
                item.url === '/settings'
                  ? pathname === item.url
                  : pathname === item.url || pathname.startsWith(`${item.url}/`)
              return (
                <li key={item.title}>
                  <Link
                    to={item.url}
                    className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                      isActive
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                    }`}
                  >
                    <item.icon className="size-4" />
                    <span>{item.title}</span>
                  </Link>
                </li>
              )
            })}
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
