'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Link } from 'react-router-dom'
import {
  Building2,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  LockKeyhole,
  MonitorSmartphone,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Coins,
  Trash2,
  UserCheck,
  UserCog,
  UserRoundPlus,
  UserX,
  Users,
} from 'lucide-react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Checkbox } from '@/components/ui/checkbox'
import { toast } from 'sonner'
import {
  createApiKey,
  createDepartment,
  createOrganization,
  createUser,
  deleteDepartment,
  deleteOrganization,
  getApiKeys,
  getDepartments,
  getOrganizations,
  getRoles,
  getUsers,
  resetPassword,
  revokeApiKey,
  setDepartmentTokenLimit,
  setUserLocalAuth,
  setUserTokenLimit,
  updateDepartment,
  updateOrganization,
  updateUser,
} from '@/lib/api/auth'
import { hasScope } from '@/lib/api/client'
import { getUserSessions } from '@/lib/api/sessions'
import { useAuth } from '@/lib/hooks/use-auth'
import type {
  ApiKey,
  AuthDepartment,
  AuthOrgWithCounts,
  AuthUser,
  RoleDefinition,
  Session,
  UserRole,
} from '@/lib/api/types'
import { cn } from '@/lib/utils'

type DepartmentTreeNode = AuthDepartment & {
  children: DepartmentTreeNode[]
}

type DepartmentOption = AuthDepartment & {
  depth: number
}

const NONE_VALUE = '__none__'
const ROOT_VALUE = '__root__'

const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: '超级管理员',
  admin: '管理员',
  dept_admin: '部门管理员',
  user: '普通用户',
}

const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  super_admin: '可跨组织查看与管理资源，并指定其他超级管理员。',
  admin: '负责整个组织的部门、用户、角色和系统设置。',
  dept_admin: '负责部门内成员日常管理和 API Key 代发。',
  user: '基础使用角色，可创建并接入自己的会话。',
}

const DEFAULT_SCOPES_BY_ROLE: Record<UserRole, string[]> = {
  super_admin: ['*'],
  admin: ['*'],
  dept_admin: [
    'sessions:create',
    'sessions:attach',
    'sessions:list',
    'admin:users',
    'admin:api_keys',
  ],
  user: ['sessions:create', 'sessions:attach', 'sessions:list'],
}

const FALLBACK_ROLES: RoleDefinition[] = [
  {
    id: 'super_admin',
    name: '超级管理员',
    description: ROLE_DESCRIPTIONS.super_admin,
    scopes: DEFAULT_SCOPES_BY_ROLE.super_admin,
  },
  {
    id: 'admin',
    name: '系统管理员',
    description: ROLE_DESCRIPTIONS.admin,
    scopes: DEFAULT_SCOPES_BY_ROLE.admin,
  },
  {
    id: 'dept_admin',
    name: '部门管理员',
    description: ROLE_DESCRIPTIONS.dept_admin,
    scopes: DEFAULT_SCOPES_BY_ROLE.dept_admin,
  },
  {
    id: 'user',
    name: '普通用户',
    description: ROLE_DESCRIPTIONS.user,
    scopes: DEFAULT_SCOPES_BY_ROLE.user,
  },
]

const SCOPE_LABELS: Record<string, string> = {
  '*': '全部权限',
  'sessions:create': '创建会话',
  'sessions:attach': '接入会话',
  'sessions:list': '查看自己的会话',
  'sessions:list:any': '查看所有会话',
  'sessions:attach:any': '接入任意会话',
  'admin:users': '管理用户与部门',
  'admin:api_keys': '管理 API Keys',
  'admin:settings': '管理系统设置',
}

const API_SCOPE_OPTIONS = [
  { value: '*', label: '全部权限' },
  { value: 'sessions:create', label: '创建会话' },
  { value: 'sessions:attach', label: '接入会话' },
  { value: 'sessions:list', label: '查看自己的会话' },
  { value: 'sessions:list:any', label: '查看所有会话' },
  { value: 'sessions:attach:any', label: '接入任意会话' },
  { value: 'admin:users', label: '管理用户与部门' },
  { value: 'admin:api_keys', label: '管理 API Keys' },
  { value: 'admin:settings', label: '管理系统设置' },
]

const userFormSchema = z.object({
  name: z.string().trim().min(2, '用户名至少 2 个字符'),
  email: z.union([z.literal(''), z.string().trim().email('请输入有效的邮箱地址')]),
  password: z.union([z.literal(''), z.string().min(6, '密码至少 6 位')]),
  role: z.enum(['super_admin', 'admin', 'dept_admin', 'user']),
  orgId: z.string().optional(),
  departmentId: z.string().nullable().optional(),
  extUserId: z.string().optional(),
})

const departmentFormSchema = z.object({
  name: z.string().trim().min(1, '请输入部门名称'),
  orgId: z.string().optional(),
  parentId: z.string().nullable().optional(),
  extDeptId: z.string().optional(),
})

const organizationFormSchema = z.object({
  name: z.string().trim().min(1, '请输入组织名称'),
  extOrgId: z.string().optional(),
})

const apiKeyFormSchema = z.object({
  name: z.string().trim().min(2, '名称至少 2 个字符'),
  scopes: z.array(z.string()).min(1, '至少选择一个权限'),
})

const passwordFormSchema = z.object({
  password: z.string().min(6, '密码至少 6 位'),
})

const tokenLimitFormSchema = z.object({
  tokenLimit: z.string().refine(
    (v) => v === '' || (Number.isInteger(Number(v)) && Number(v) > 0),
    '请输入正整数，留空表示不限制',
  ),
})

type UserFormData = z.infer<typeof userFormSchema>
type DepartmentFormData = z.infer<typeof departmentFormSchema>
type OrganizationFormData = z.infer<typeof organizationFormSchema>
type ApiKeyFormData = z.infer<typeof apiKeyFormSchema>
type PasswordFormData = z.infer<typeof passwordFormSchema>
type TokenLimitFormData = z.infer<typeof tokenLimitFormSchema>

function formatTimestamp(value: number | null): string {
  if (!value) {
    return '从未登录'
  }
  return new Date(value).toLocaleString('zh-CN')
}

function getRoleBadgeVariant(role: UserRole): 'default' | 'secondary' | 'outline' {
  switch (role) {
    case 'admin':
      return 'default'
    case 'dept_admin':
      return 'secondary'
    default:
      return 'outline'
  }
}

function buildDepartmentTree(departments: AuthDepartment[]): DepartmentTreeNode[] {
  const sortedDepartments = [...departments].sort((left, right) => {
    if (left.parentId === right.parentId) {
      return left.name.localeCompare(right.name, 'zh-CN')
    }
    return left.createdAt - right.createdAt
  })

  const byId = new Map(
    sortedDepartments.map(department => [
      department.id,
      {
        ...department,
        children: [] as DepartmentTreeNode[],
      },
    ]),
  )

  const roots: DepartmentTreeNode[] = []
  for (const department of sortedDepartments) {
    const node = byId.get(department.id)
    if (!node) {
      continue
    }
    if (department.parentId) {
      const parent = byId.get(department.parentId)
      if (parent) {
        parent.children.push(node)
        continue
      }
    }
    roots.push(node)
  }

  return roots
}

function flattenDepartmentTree(
  nodes: DepartmentTreeNode[],
  depth = 0,
): DepartmentOption[] {
  return nodes.flatMap(node => [
    {
      ...node,
      depth,
    },
    ...flattenDepartmentTree(node.children, depth + 1),
  ])
}

function collectDescendantDepartmentIds(
  departments: AuthDepartment[],
  departmentId: string,
): Set<string> {
  const childrenByParent = new Map<string | null, AuthDepartment[]>()
  for (const department of departments) {
    const bucket = childrenByParent.get(department.parentId) ?? []
    bucket.push(department)
    childrenByParent.set(department.parentId, bucket)
  }

  const collected = new Set<string>()
  const stack = [departmentId]
  while (stack.length > 0) {
    const currentId = stack.pop()
    if (!currentId || collected.has(currentId)) {
      continue
    }
    collected.add(currentId)
    const children = childrenByParent.get(currentId) ?? []
    for (const child of children) {
      stack.push(child.id)
    }
  }

  return collected
}

function SummaryCard({
  title,
  value,
  description,
  icon: Icon,
}: {
  title: string
  value: string
  description: string
  icon: typeof Users
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {title}
          </CardTitle>
          <div className="text-2xl font-semibold tracking-tight">{value}</div>
        </div>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  )
}

function DepartmentTree({
  nodes,
  onEdit,
  onCreateChild,
  onDelete,
  onSetTokenLimit,
}: {
  nodes: DepartmentTreeNode[]
  onEdit: (department: AuthDepartment) => void
  onCreateChild: (department: AuthDepartment) => void
  onDelete: (department: AuthDepartment) => void
  onSetTokenLimit: (department: AuthDepartment) => void
}) {
  if (nodes.length === 0) {
    return (
      <div className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
        还没有部门，先创建一级部门。
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {nodes.map(node => (
        <DepartmentTreeRow
          key={node.id}
          node={node}
          depth={0}
          onEdit={onEdit}
          onCreateChild={onCreateChild}
          onDelete={onDelete}
          onSetTokenLimit={onSetTokenLimit}
        />
      ))}
    </div>
  )
}

function DepartmentTreeRow({
  node,
  depth,
  onEdit,
  onCreateChild,
  onDelete,
  onSetTokenLimit,
}: {
  node: DepartmentTreeNode
  depth: number
  onEdit: (department: AuthDepartment) => void
  onCreateChild: (department: AuthDepartment) => void
  onDelete: (department: AuthDepartment) => void
  onSetTokenLimit: (department: AuthDepartment) => void
}) {
  return (
    <div className="space-y-3">
      <div
        className={cn(
          'flex flex-col gap-3 rounded-xl border bg-card/60 p-4 md:flex-row md:items-center md:justify-between',
          depth > 0 && 'border-dashed',
        )}
        style={{ marginLeft: `${depth * 20}px` }}
      >
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{node.name}</span>
            <Badge variant="secondary">{node.userCount} 人</Badge>
            {node.children.length > 0 ? (
              <Badge variant="outline">{node.children.length} 个子部门</Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            创建于 {new Date(node.createdAt).toLocaleDateString('zh-CN')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => onCreateChild(node)}>
            <Plus className="mr-2 size-4" />
            新建子部门
          </Button>
          <Button variant="outline" size="sm" onClick={() => onSetTokenLimit(node)}>
            <Coins className="mr-2 size-4" />
            Token 限额{node.tokenLimit != null ? `：${node.tokenLimit.toLocaleString()}` : ''}
          </Button>
          <Button variant="outline" size="sm" onClick={() => onEdit(node)}>
            <Pencil className="mr-2 size-4" />
            编辑
          </Button>
          <Button variant="outline" size="sm" onClick={() => onDelete(node)}>
            <Trash2 className="mr-2 size-4" />
            删除
          </Button>
        </div>
      </div>
      {node.children.map(child => (
        <DepartmentTreeRow
          key={child.id}
          node={child}
          depth={depth + 1}
          onEdit={onEdit}
          onCreateChild={onCreateChild}
          onDelete={onDelete}
          onSetTokenLimit={onSetTokenLimit}
        />
      ))}
    </div>
  )
}

export default function UsersPage() {
  const { user: currentUser, scopes } = useAuth()
  const canManageUsers = hasScope(scopes, 'admin:users')
  const isSuperAdmin = currentUser?.role === 'super_admin'
  // super_admin is a superset of admin — it gets every org-admin capability.
  const isOrgAdmin = currentUser?.role === 'admin' || isSuperAdmin

  const [users, setUsers] = useState<AuthUser[]>([])
  const [departments, setDepartments] = useState<AuthDepartment[]>([])
  const [organizations, setOrganizations] = useState<AuthOrgWithCounts[]>([])
  const [roles, setRoles] = useState<RoleDefinition[]>([])
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [userSessions, setUserSessions] = useState<Session[]>([])
  const [selectedUser, setSelectedUser] = useState<AuthUser | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [activeTab, setActiveTab] = useState('users')
  const [organizationDialog, setOrganizationDialog] = useState<{
    open: boolean
    mode: 'create' | 'edit'
    organization: AuthOrgWithCounts | null
  }>({ open: false, mode: 'create', organization: null })
  const [isSubmittingOrganization, setIsSubmittingOrganization] = useState(false)
  const [pendingOrganizationActionId, setPendingOrganizationActionId] = useState<string | null>(null)
  const [organizationToDelete, setOrganizationToDelete] = useState<AuthOrgWithCounts | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isLoadingSessions, setIsLoadingSessions] = useState(false)
  const [userDialog, setUserDialog] = useState<{
    open: boolean
    mode: 'create' | 'edit'
    user: AuthUser | null
  }>({
    open: false,
    mode: 'create',
    user: null,
  })
  const [departmentDialog, setDepartmentDialog] = useState<{
    open: boolean
    mode: 'create' | 'edit'
    parent: AuthDepartment | null
    department: AuthDepartment | null
  }>({
    open: false,
    mode: 'create',
    parent: null,
    department: null,
  })
  const [resetPasswordUser, setResetPasswordUser] = useState<AuthUser | null>(null)
  const [apiKeyUser, setApiKeyUser] = useState<AuthUser | null>(null)
  const [departmentToDelete, setDepartmentToDelete] = useState<AuthDepartment | null>(null)
  const [revealedApiKey, setRevealedApiKey] = useState<{
    userName: string
    value: string
  } | null>(null)
  const [tokenLimitTarget, setTokenLimitTarget] = useState<
    { type: 'user'; data: AuthUser } | { type: 'department'; data: AuthDepartment } | null
  >(null)
  const [isSubmittingTokenLimit, setIsSubmittingTokenLimit] = useState(false)
  const [localAuthTarget, setLocalAuthTarget] = useState<{ userId: string; userName: string; currentAuth: boolean } | null>(null)
  const [isSubmittingLocalAuth, setIsSubmittingLocalAuth] = useState(false)
  const [isSubmittingUser, setIsSubmittingUser] = useState(false)
  const [isSubmittingDepartment, setIsSubmittingDepartment] = useState(false)
  const [isSubmittingPassword, setIsSubmittingPassword] = useState(false)
  const [isSubmittingApiKey, setIsSubmittingApiKey] = useState(false)
  const [pendingUserActionId, setPendingUserActionId] = useState<string | null>(null)
  const [pendingDepartmentActionId, setPendingDepartmentActionId] = useState<string | null>(null)
  const [pendingApiKeyActionId, setPendingApiKeyActionId] = useState<string | null>(null)

  const userForm = useForm<UserFormData>({
    resolver: zodResolver(userFormSchema),
    defaultValues: {
      name: '',
      email: '',
      password: '',
      role: 'user',
      departmentId: null,
    },
  })

  const departmentForm = useForm<DepartmentFormData>({
    resolver: zodResolver(departmentFormSchema),
    defaultValues: {
      name: '',
      parentId: null,
    },
  })

  const organizationForm = useForm<OrganizationFormData>({
    resolver: zodResolver(organizationFormSchema),
    defaultValues: {
      name: '',
      extOrgId: '',
    },
  })

  const apiKeyForm = useForm<ApiKeyFormData>({
    resolver: zodResolver(apiKeyFormSchema),
    defaultValues: {
      name: '',
      scopes: DEFAULT_SCOPES_BY_ROLE.user,
    },
  })

  const passwordForm = useForm<PasswordFormData>({
    resolver: zodResolver(passwordFormSchema),
    defaultValues: {
      password: '',
    },
  })

  const tokenLimitForm = useForm<TokenLimitFormData>({
    resolver: zodResolver(tokenLimitFormSchema),
    defaultValues: { tokenLimit: '' },
  })

  const roleCatalog = roles.length > 0 ? roles : FALLBACK_ROLES

  const departmentTree = useMemo(
    () => buildDepartmentTree(departments),
    [departments],
  )

  const departmentOptions = useMemo(
    () => flattenDepartmentTree(departmentTree),
    [departmentTree],
  )

  const departmentNameMap = useMemo(
    () => new Map(departments.map(department => [department.id, department.name])),
    [departments],
  )

  const fetchData = useCallback(async () => {
    if (!canManageUsers) {
      setIsLoading(false)
      return
    }

    try {
      const [usersRes, departmentsRes, apiKeysRes, rolesRes, organizationsRes] = await Promise.all([
        getUsers(),
        getDepartments(),
        getApiKeys(),
        getRoles().catch(() => ({ roles: FALLBACK_ROLES })),
        getOrganizations().catch(() => ({ organizations: [] as AuthOrgWithCounts[] })),
      ])

      setUsers(usersRes.users)
      setDepartments(departmentsRes.departments)
      setApiKeys(apiKeysRes.api_keys)
      setRoles(rolesRes.roles)
      setOrganizations(organizationsRes.organizations)
      setSelectedUser(previousSelectedUser => {
        if (!previousSelectedUser) {
          return null
        }
        return usersRes.users.find(user => user.id === previousSelectedUser.id) ?? null
      })
    } catch (error) {
      console.error('Failed to fetch auth management data:', error)
      toast.error('获取用户与组织数据失败')
    } finally {
      setIsLoading(false)
      setIsRefreshing(false)
    }
  }, [canManageUsers])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  useEffect(() => {
    if (!isOrgAdmin && activeTab !== 'users') {
      setActiveTab('users')
    }
  }, [activeTab, isOrgAdmin])

  useEffect(() => {
    if (!userDialog.open) {
      userForm.reset({
        name: '',
        email: '',
        password: '',
        role: 'user',
        // Normal admins don't get the org list (super_admin-only) → default to
        // their own org so user/dept creation stays scoped correctly.
        orgId: organizations[0]?.id ?? currentUser?.orgId ?? '',
        departmentId: null,
        extUserId: '',
      })
      return
    }

    userForm.reset({
      name: userDialog.user?.name ?? '',
      email: userDialog.user?.email ?? '',
      password: '',
      role: userDialog.user?.role ?? 'user',
      orgId: userDialog.user?.orgId ?? organizations[0]?.id ?? currentUser?.orgId ?? '',
      departmentId: userDialog.user?.departmentId ?? null,
      extUserId: userDialog.user?.extUserId ?? '',
    })
  }, [userDialog, userForm, organizations, currentUser])

  useEffect(() => {
    if (!departmentDialog.open) {
      departmentForm.reset({
        name: '',
        orgId: organizations[0]?.id ?? currentUser?.orgId ?? '',
        parentId: null,
        extDeptId: '',
      })
      return
    }

    departmentForm.reset({
      name: departmentDialog.department?.name ?? '',
      orgId:
        departmentDialog.department?.orgId ??
        departmentDialog.parent?.orgId ??
        organizations[0]?.id ?? currentUser?.orgId ?? '',
      parentId:
        departmentDialog.department?.parentId ??
        departmentDialog.parent?.id ??
        null,
      extDeptId: departmentDialog.department?.extDeptId ?? '',
    })
  }, [departmentDialog, departmentForm, organizations, currentUser])

  useEffect(() => {
    if (!organizationDialog.open) {
      organizationForm.reset({ name: '', extOrgId: '' })
      return
    }
    organizationForm.reset({
      name: organizationDialog.organization?.name ?? '',
      extOrgId: organizationDialog.organization?.extOrgId ?? '',
    })
  }, [organizationDialog, organizationForm])

  useEffect(() => {
    if (!apiKeyUser) {
      apiKeyForm.reset({
        name: '',
        scopes: DEFAULT_SCOPES_BY_ROLE.user,
      })
      return
    }

    apiKeyForm.reset({
      name: `${apiKeyUser.name}-key`,
      scopes: DEFAULT_SCOPES_BY_ROLE[apiKeyUser.role],
    })
  }, [apiKeyForm, apiKeyUser])

  useEffect(() => {
    if (!resetPasswordUser) {
      passwordForm.reset({ password: '' })
    }
  }, [passwordForm, resetPasswordUser])

  useEffect(() => {
    if (!tokenLimitTarget) {
      tokenLimitForm.reset({ tokenLimit: '' })
      return
    }
    const current = tokenLimitTarget.data.tokenLimit
    tokenLimitForm.reset({ tokenLimit: current != null ? String(current) : '' })
  }, [tokenLimitForm, tokenLimitTarget])

  const filteredUsers = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase()
    return users.filter(user => {
      const departmentName = user.departmentId
        ? departmentNameMap.get(user.departmentId) ?? ''
        : ''
      const matchesKeyword =
        !keyword ||
        user.name.toLowerCase().includes(keyword) ||
        user.email?.toLowerCase().includes(keyword) ||
        departmentName.toLowerCase().includes(keyword)

      const matchesRole = roleFilter === 'all' || user.role === roleFilter
      const matchesStatus = statusFilter === 'all' || user.status === statusFilter
      return matchesKeyword && matchesRole && matchesStatus
    })
  }, [departmentNameMap, roleFilter, searchQuery, statusFilter, users])

  const totalUsers = users.length
  const activeUsers = users.filter(user => user.status === 'active').length
  const deptAdminCount = users.filter(user => user.role === 'dept_admin').length
  const unassignedUsers = users.filter(user => !user.departmentId).length

  const getUserApiKeys = (userId: string) =>
    apiKeys.filter(apiKey => apiKey.userId === userId)

  const getDepartmentName = (departmentId: string | null) => {
    if (!departmentId) {
      return '未分配'
    }
    return departmentNameMap.get(departmentId) ?? '未知部门'
  }

  const handleRefresh = () => {
    setIsRefreshing(true)
    void fetchData()
  }

  const handleViewUser = async (user: AuthUser) => {
    setSelectedUser(user)
    setIsLoadingSessions(true)
    try {
      const response = await getUserSessions(user.id)
      setUserSessions(response.sessions)
    } catch (error) {
      console.error('Failed to fetch user sessions:', error)
      toast.error('获取用户会话失败')
    } finally {
      setIsLoadingSessions(false)
    }
  }

  const handleSubmitUser = async (values: UserFormData) => {
    if (userDialog.mode === 'create' && !values.password) {
      userForm.setError('password', {
        message: '新建用户必须设置初始密码',
      })
      return
    }

    setIsSubmittingUser(true)
    try {
      const extUserId = values.extUserId?.trim() || null
      if (userDialog.mode === 'create') {
        await createUser({
          name: values.name,
          email: values.email || undefined,
          org_id: values.orgId || undefined,
          department_id: values.departmentId ?? null,
          role: values.role,
          password: values.password || '',
          ext_user_id: extUserId,
        })
        toast.success('用户创建成功')
      } else if (userDialog.user) {
        // Organization is immutable (req 3) — never send target_org_id on edit.
        await updateUser(userDialog.user.id, {
          name: values.name,
          department_id: values.departmentId ?? null,
          role: values.role,
          ext_user_id: extUserId,
        })
        toast.success('用户信息已更新')
      }

      setUserDialog({
        open: false,
        mode: 'create',
        user: null,
      })
      await fetchData()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存用户失败')
    } finally {
      setIsSubmittingUser(false)
    }
  }

  const handleSubmitDepartment = async (values: DepartmentFormData) => {
    setIsSubmittingDepartment(true)
    try {
      const extDeptId = values.extDeptId?.trim() || null
      if (departmentDialog.mode === 'create') {
        await createDepartment({
          name: values.name,
          org_id: values.orgId || undefined,
          parent_id: values.parentId ?? null,
          ext_dept_id: extDeptId,
        })
        toast.success('部门创建成功')
      } else if (departmentDialog.department) {
        await updateDepartment(departmentDialog.department.id, {
          name: values.name,
          parent_id: values.parentId ?? null,
          ext_dept_id: extDeptId,
        })
        toast.success('部门已更新')
      }

      setDepartmentDialog({
        open: false,
        mode: 'create',
        parent: null,
        department: null,
      })
      await fetchData()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存部门失败')
    } finally {
      setIsSubmittingDepartment(false)
    }
  }

  const handleSubmitOrganization = async (values: OrganizationFormData) => {
    setIsSubmittingOrganization(true)
    try {
      const extOrgId = values.extOrgId?.trim() || null
      if (organizationDialog.mode === 'create') {
        await createOrganization({ name: values.name, ext_org_id: extOrgId })
        toast.success('组织创建成功')
      } else if (organizationDialog.organization) {
        await updateOrganization(organizationDialog.organization.id, {
          name: values.name,
          ext_org_id: extOrgId,
        })
        toast.success('组织已更新')
      }
      setOrganizationDialog({ open: false, mode: 'create', organization: null })
      await fetchData()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存组织失败')
    } finally {
      setIsSubmittingOrganization(false)
    }
  }

  const handleConfirmDeleteOrganization = async () => {
    if (!organizationToDelete) return
    setPendingOrganizationActionId(organizationToDelete.id)
    try {
      await deleteOrganization(organizationToDelete.id)
      toast.success(`已删除组织 ${organizationToDelete.name}`)
      setOrganizationToDelete(null)
      await fetchData()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除组织失败')
    } finally {
      setPendingOrganizationActionId(null)
    }
  }

  const handleSubmitPassword = async (values: PasswordFormData) => {
    if (!resetPasswordUser) {
      return
    }

    setIsSubmittingPassword(true)
    try {
      await resetPassword(resetPasswordUser.id, values.password)
      toast.success(`已重置 ${resetPasswordUser.name} 的密码`)
      setResetPasswordUser(null)
      passwordForm.reset({
        password: '',
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '重置密码失败')
    } finally {
      setIsSubmittingPassword(false)
    }
  }

  const handleSubmitApiKey = async (values: ApiKeyFormData) => {
    if (!apiKeyUser) {
      return
    }

    setIsSubmittingApiKey(true)
    try {
      const response = await createApiKey({
        user_id: apiKeyUser.id,
        name: values.name,
        scopes: values.scopes,
      })
      setApiKeyUser(null)
      setRevealedApiKey({
        userName: apiKeyUser.name,
        value: response.plain_text_key,
      })
      toast.success('API Key 已生成')
      await fetchData()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '生成 API Key 失败')
    } finally {
      setIsSubmittingApiKey(false)
    }
  }

  const handleToggleUserStatus = async (user: AuthUser) => {
    setPendingUserActionId(user.id)
    try {
      await updateUser(user.id, {
        status: user.status === 'active' ? 'disabled' : 'active',
      })
      toast.success(user.status === 'active' ? '用户已禁用' : '用户已启用')
      await fetchData()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新用户状态失败')
    } finally {
      setPendingUserActionId(null)
    }
  }

  const handleDeleteDepartment = async () => {
    if (!departmentToDelete) {
      return
    }

    setPendingDepartmentActionId(departmentToDelete.id)
    try {
      await deleteDepartment(departmentToDelete.id)
      toast.success('部门已删除')
      setDepartmentToDelete(null)
      await fetchData()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除部门失败')
    } finally {
      setPendingDepartmentActionId(null)
    }
  }

  const handleRevokeApiKey = async (apiKey: ApiKey) => {
    setPendingApiKeyActionId(apiKey.id)
    try {
      await revokeApiKey(apiKey.id)
      toast.success('API Key 已撤销')
      await fetchData()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '撤销 API Key 失败')
    } finally {
      setPendingApiKeyActionId(null)
    }
  }

  const handleSubmitTokenLimit = async (values: TokenLimitFormData) => {
    if (!tokenLimitTarget) return
    const tokenLimit = values.tokenLimit === '' ? null : Number(values.tokenLimit)
    setIsSubmittingTokenLimit(true)
    try {
      if (tokenLimitTarget.type === 'user') {
        await setUserTokenLimit(tokenLimitTarget.data.id, tokenLimit)
      } else {
        await setDepartmentTokenLimit(tokenLimitTarget.data.id, tokenLimit)
      }
      toast.success(tokenLimit == null ? '已清除 Token 限额' : `Token 限额已设为 ${tokenLimit.toLocaleString()}`)
      setTokenLimitTarget(null)
      await fetchData()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '设置失败')
    } finally {
      setIsSubmittingTokenLimit(false)
    }
  }

  const copyApiKey = async (value: string) => {
    // Fallback for non-HTTPS environments (navigator.clipboard requires secure context)
    // For Radix Dialog, we need to append textarea inside the dialog to avoid focus trap issues
    const fallbackCopy = (text: string): boolean => {
      // Try to find the dialog content element
      const dialogContent = document.querySelector('[role="dialog"]')
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;opacity:0;z-index:9999;'
      textarea.setAttribute('readonly', '')

      // Append to dialog if inside one, otherwise to body
      const container = dialogContent || document.body
      container.appendChild(textarea)

      // Create a range and select the text
      textarea.focus()
      textarea.select()

      let success = false
      try {
        success = document.execCommand('copy')
      } catch {
        success = false
      }

      container.removeChild(textarea)
      return success
    }

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value)
        toast.success('API Key 已复制')
      } else {
        const success = fallbackCopy(value)
        if (success) {
          toast.success('API Key 已复制')
        } else {
          toast.error('复制失败')
        }
      }
    } catch {
      const success = fallbackCopy(value)
      if (success) {
        toast.success('API Key 已复制')
      } else {
        toast.error('复制失败')
      }
    }
  }

  const availableParentDepartments = useMemo(() => {
    if (!departmentDialog.department) {
      return departmentOptions
    }

    const blockedIds = collectDescendantDepartmentIds(
      departments,
      departmentDialog.department.id,
    )
    return departmentOptions.filter(option => !blockedIds.has(option.id))
  }, [departmentDialog.department, departmentOptions, departments])

  if (!canManageUsers) {
    return (
      <DashboardLayout
        title="用户与组织管理"
        description="当前账号缺少用户管理权限。"
      >
        <div className="rounded-xl border border-dashed px-6 py-16 text-center text-sm text-muted-foreground">
          当前账号没有 `admin:users` 权限，无法访问此页面。
        </div>
      </DashboardLayout>
    )
  }

  if (isLoading) {
    return (
      <DashboardLayout
        title="用户与组织管理"
        description="管理部门、用户、角色及 API Key。"
      >
        <div className="flex min-h-[320px] items-center justify-center">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout
      title="用户与组织管理"
      description="统一维护部门树、用户账号、角色分配与 API Key。"
    >
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <SummaryCard
            title="组织用户数"
            value={String(totalUsers)}
            description={`未分配部门 ${unassignedUsers} 人`}
            icon={Users}
          />
          <SummaryCard
            title="启用中用户"
            value={String(activeUsers)}
            description={`禁用 ${totalUsers - activeUsers} 人`}
            icon={UserCheck}
          />
          <SummaryCard
            title="部门数量"
            value={String(departments.length)}
            description="支持树形层级管理"
            icon={Building2}
          />
          <SummaryCard
            title="部门管理员"
            value={String(deptAdminCount)}
            description="已分配 dept_admin 角色人数"
            icon={Shield}
          />
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <TabsList>
              <TabsTrigger value="users">用户管理</TabsTrigger>
              {isOrgAdmin ? <TabsTrigger value="departments">部门管理</TabsTrigger> : null}
              {/* Org management is cross-org → super_admin only (backend enforces too). */}
              {isSuperAdmin ? <TabsTrigger value="organizations">组织管理</TabsTrigger> : null}
              {isOrgAdmin ? <TabsTrigger value="roles">角色管理</TabsTrigger> : null}
            </TabsList>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={handleRefresh} disabled={isRefreshing}>
                <RefreshCw className={cn('mr-2 size-4', isRefreshing && 'animate-spin')} />
                刷新
              </Button>
              {activeTab === 'users' ? (
                <Button
                  onClick={() =>
                    setUserDialog({
                      open: true,
                      mode: 'create',
                      user: null,
                    })
                  }
                >
                  <UserRoundPlus className="mr-2 size-4" />
                  新建用户
                </Button>
              ) : null}
              {activeTab === 'departments' && isOrgAdmin ? (
                <Button
                  onClick={() =>
                    setDepartmentDialog({
                      open: true,
                      mode: 'create',
                      parent: null,
                      department: null,
                    })
                  }
                >
                  <Plus className="mr-2 size-4" />
                  新建部门
                </Button>
              ) : null}
              {activeTab === 'organizations' && isSuperAdmin ? (
                <Button
                  onClick={() =>
                    setOrganizationDialog({ open: true, mode: 'create', organization: null })
                  }
                >
                  <Plus className="mr-2 size-4" />
                  新建组织
                </Button>
              ) : null}
            </div>
          </div>

          <TabsContent value="users" className="space-y-6">
            <Card>
              <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="space-y-1">
                  <CardTitle>用户列表</CardTitle>
                  <CardDescription>
                    新增、禁用、重置密码、分配部门与角色，并为用户生成 API Key。
                  </CardDescription>
                </div>
                <div className="flex flex-col gap-3 md:flex-row md:items-center">
                  <div className="relative min-w-[240px]">
                    <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder="搜索用户名、部门或邮箱"
                      className="pl-9"
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                    />
                  </div>
                  <Select value={roleFilter} onValueChange={setRoleFilter}>
                    <SelectTrigger className="w-[160px]">
                      <SelectValue placeholder="角色筛选" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部角色</SelectItem>
                      {roleCatalog.map(role => (
                        <SelectItem key={role.id} value={role.id}>
                          {ROLE_LABELS[role.id]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="w-[140px]">
                      <SelectValue placeholder="状态筛选" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部状态</SelectItem>
                      <SelectItem value="active">启用</SelectItem>
                      <SelectItem value="disabled">禁用</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardHeader>
              <CardContent>
                <div className="overflow-hidden rounded-xl border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>用户名</TableHead>
                        <TableHead>所属组织</TableHead>
                        <TableHead>所属部门</TableHead>
                        <TableHead>角色</TableHead>
                        <TableHead>API Keys</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead>最后登录</TableHead>
                        <TableHead className="text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredUsers.map(user => {
                        const userKeys = getUserApiKeys(user.id)
                        const isPending = pendingUserActionId === user.id
                        return (
                          <TableRow key={user.id}>
                            <TableCell className="font-medium">
                              <button
                                type="button"
                                className="text-left hover:text-primary"
                                onClick={() => void handleViewUser(user)}
                              >
                                {user.name}
                              </button>
                              {user.extUserId ? (
                                <div className="text-xs text-muted-foreground font-mono">{user.extUserId}</div>
                              ) : null}
                            </TableCell>
                            <TableCell>
                              {organizations.find(o => o.id === user.orgId)?.name ?? '—'}
                            </TableCell>
                            <TableCell>{getDepartmentName(user.departmentId)}</TableCell>
                            <TableCell>
                              <Badge variant={getRoleBadgeVariant(user.role)}>
                                {ROLE_LABELS[user.role]}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              {userKeys.length > 0 ? (
                                <div className="flex flex-wrap gap-1">
                                  {userKeys.slice(0, 2).map(apiKey => (
                                    <Badge key={apiKey.id} variant="secondary" className="text-xs">
                                      {apiKey.name}
                                    </Badge>
                                  ))}
                                  {userKeys.length > 2 ? (
                                    <Badge variant="outline" className="text-xs">
                                      +{userKeys.length - 2}
                                    </Badge>
                                  ) : null}
                                </div>
                              ) : (
                                <span className="text-xs text-muted-foreground">暂无</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant={user.status === 'active' ? 'default' : 'secondary'}
                              >
                                {user.status === 'active' ? '启用' : '禁用'}
                              </Badge>
                            </TableCell>
                            <TableCell>{formatTimestamp(user.lastLoginAt)}</TableCell>
                            <TableCell className="text-right">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" disabled={isPending}>
                                    {isPending ? (
                                      <Loader2 className="size-4 animate-spin" />
                                    ) : (
                                      <MoreHorizontal className="size-4" />
                                    )}
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem onClick={() => void handleViewUser(user)}>
                                    <UserCog className="mr-2 size-4" />
                                    查看详情
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() =>
                                      setUserDialog({
                                        open: true,
                                        mode: 'edit',
                                        user,
                                      })
                                    }
                                  >
                                    <Pencil className="mr-2 size-4" />
                                    编辑用户
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => setApiKeyUser(user)}>
                                    <KeyRound className="mr-2 size-4" />
                                    生成 API Key
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => setResetPasswordUser(user)}>
                                    <LockKeyhole className="mr-2 size-4" />
                                    重置密码
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => setTokenLimitTarget({ type: 'user', data: user })}>
                                    <Coins className="mr-2 size-4" />
                                    设置 Token 限额
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => setLocalAuthTarget({ userId: user.id, userName: user.name, currentAuth: user.localAuth ?? false })}>
                                    {user.localAuth ? (
                                      <>
                                        <MonitorSmartphone className="mr-2 size-4" />
                                        取消Local授权
                                      </>
                                    ) : (
                                      <>
                                        <MonitorSmartphone className="mr-2 size-4" />
                                        Local授权
                                      </>
                                    )}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => void handleToggleUserStatus(user)}>
                                    {user.status === 'active' ? (
                                      <>
                                        <UserX className="mr-2 size-4" />
                                        禁用用户
                                      </>
                                    ) : (
                                      <>
                                        <UserCheck className="mr-2 size-4" />
                                        启用用户
                                      </>
                                    )}
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </TableCell>
                          </TableRow>
                        )
                      })}
                      {filteredUsers.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                            没有匹配的用户。
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {isOrgAdmin ? (
            <TabsContent value="departments" className="space-y-6">
              <Card>
                <CardHeader className="space-y-1">
                  <CardTitle>部门树</CardTitle>
                  <CardDescription>
                    支持新增、编辑、删除部门，并通过树形结构维护层级关系。
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <DepartmentTree
                    nodes={departmentTree}
                    onEdit={(department) =>
                      setDepartmentDialog({
                        open: true,
                        mode: 'edit',
                        parent: null,
                        department,
                      })
                    }
                    onCreateChild={(department) =>
                      setDepartmentDialog({
                        open: true,
                        mode: 'create',
                        parent: department,
                        department: null,
                      })
                    }
                    onDelete={setDepartmentToDelete}
                    onSetTokenLimit={(department) => setTokenLimitTarget({ type: 'department', data: department })}
                  />
                </CardContent>
              </Card>
            </TabsContent>
          ) : null}

          {isSuperAdmin ? (
            <TabsContent value="organizations" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>组织管理</CardTitle>
                  <CardDescription>
                    管理 moss 内的组织（租户）。OAuth2 登录会按外部组织 ID 自动创建新的组织。
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>名称</TableHead>
                        <TableHead>外部组织 ID</TableHead>
                        <TableHead className="text-right">用户数</TableHead>
                        <TableHead className="text-right">部门数</TableHead>
                        <TableHead>创建时间</TableHead>
                        <TableHead className="w-12 text-right"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {organizations.map(org => (
                        <TableRow key={org.id}>
                          <TableCell className="font-medium">{org.name}</TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {org.extOrgId ?? '—'}
                          </TableCell>
                          <TableCell className="text-right">{org.userCount}</TableCell>
                          <TableCell className="text-right">{org.departmentCount}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {formatTimestamp(org.createdAt)}
                          </TableCell>
                          <TableCell className="text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon">
                                  <MoreHorizontal className="size-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onClick={() =>
                                    setOrganizationDialog({
                                      open: true,
                                      mode: 'edit',
                                      organization: org,
                                    })
                                  }
                                >
                                  编辑
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => setOrganizationToDelete(org)}
                                  className="text-destructive"
                                >
                                  删除
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      ))}
                      {organizations.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center text-muted-foreground">
                            暂无组织
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>
          ) : null}

          {isOrgAdmin ? (
            <TabsContent value="roles" className="space-y-6">
              <div className="grid gap-4 xl:grid-cols-3">
                {roleCatalog.map(role => {
                  const assignedCount = users.filter(user => user.role === role.id).length
                  return (
                    <Card key={role.id} className="border-l-4 border-l-primary/60">
                      <CardHeader className="space-y-2">
                        <div className="flex items-center justify-between gap-3">
                          <CardTitle className="text-base">{role.name}</CardTitle>
                          <Badge variant={getRoleBadgeVariant(role.id)}>
                            {assignedCount} 人
                          </Badge>
                        </div>
                        <CardDescription>{role.description}</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className="rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
                          {ROLE_DESCRIPTIONS[role.id]}
                        </div>
                        <div className="space-y-2">
                          <p className="text-xs font-medium text-muted-foreground">默认权限</p>
                          <div className="flex flex-wrap gap-2">
                            {role.scopes.map(scope => (
                              <Badge key={scope} variant="secondary" className="text-xs">
                                {SCOPE_LABELS[scope] ?? scope}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            </TabsContent>
          ) : null}
        </Tabs>
      </div>

      <Dialog
        open={userDialog.open}
        onOpenChange={(open) => {
          if (!open) {
            setUserDialog({
              open: false,
              mode: 'create',
              user: null,
            })
            return
          }
          setUserDialog(previous => ({
            ...previous,
            open: true,
          }))
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{userDialog.mode === 'create' ? '新建用户' : '编辑用户'}</DialogTitle>
            <DialogDescription>
              {userDialog.mode === 'create'
                ? '创建新账号，支持直接分配部门和角色。'
                : '调整用户的部门归属、角色和展示信息。'}
            </DialogDescription>
          </DialogHeader>
          <Form {...userForm}>
            <form onSubmit={userForm.handleSubmit(handleSubmitUser)} className="space-y-4">
              <FormField
                control={userForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>用户名</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="请输入用户名" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={userForm.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {userDialog.mode === 'create' ? '初始密码' : '密码'}
                    </FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        type="password"
                        placeholder={
                          userDialog.mode === 'create'
                            ? '至少 6 位'
                            : '编辑用户时不在这里修改密码'
                        }
                        disabled={userDialog.mode === 'edit'}
                      />
                    </FormControl>
                    {userDialog.mode === 'edit' ? (
                      <FormDescription>密码修改请使用“重置密码”。</FormDescription>
                    ) : null}
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid gap-4 md:grid-cols-2">
                <FormField
                  control={userForm.control}
                  name="role"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>角色</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="选择角色" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {roleCatalog
                            // Only a super_admin may see/assign the super_admin
                            // role (req 5). Keep it visible when editing a user
                            // who already is one so the current value renders,
                            // but a non-super actor can't pick it.
                            .filter(role =>
                              role.id !== 'super_admin' ||
                              isSuperAdmin ||
                              userDialog.user?.role === 'super_admin',
                            )
                            .map(role => (
                              <SelectItem
                                key={role.id}
                                value={role.id}
                                disabled={
                                  (!isOrgAdmin && role.id !== 'user') ||
                                  (role.id === 'super_admin' && !isSuperAdmin)
                                }
                              >
                                {ROLE_LABELS[role.id]}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={userForm.control}
                  name="departmentId"
                  render={({ field }) => {
                    const selectedOrgId = userForm.watch('orgId') || userDialog.user?.orgId
                    const filteredOptions = departmentOptions.filter(option => {
                      const dept = departments.find(d => d.id === option.id)
                      return !selectedOrgId || !dept || dept.orgId === selectedOrgId
                    })
                    return (
                      <FormItem>
                        <FormLabel>所属部门</FormLabel>
                        <Select
                          onValueChange={(value) =>
                            field.onChange(value === NONE_VALUE ? null : value)
                          }
                          value={field.value ?? NONE_VALUE}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="选择部门" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value={NONE_VALUE}>未分配部门</SelectItem>
                            {filteredOptions.map(option => (
                              <SelectItem key={option.id} value={option.id}>
                                {`${'— '.repeat(option.depth)}${option.name}`}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )
                  }}
                />
              </div>
              <FormField
                control={userForm.control}
                name="orgId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>所属组织</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value || ''}
                      // Organization is immutable for an existing user (req 3):
                      // read-only in edit mode. In create mode, only a
                      // super_admin (who has the org list) may choose the org;
                      // a normal admin is fixed to their own org.
                      disabled={userDialog.mode === 'edit' || !isSuperAdmin}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="选择组织" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(organizations.length > 0
                          ? organizations
                          : currentUser?.orgId
                            ? [{ id: currentUser.orgId, name: '本组织', extOrgId: null as string | null }]
                            : []
                        ).map(org => (
                          <SelectItem key={org.id} value={org.id}>
                            {org.name}
                            {org.extOrgId ? ` (${org.extOrgId})` : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      {userDialog.mode === 'edit'
                        ? '用户的所属组织不可修改。'
                        : isSuperAdmin
                          ? '切换组织后，请重新选择该组织下的部门。'
                          : '新用户将创建在您所属的组织。'}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={userForm.control}
                name="extUserId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>外部用户 ID（OAuth2）</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="留空表示无外部 ID" />
                    </FormControl>
                    <FormDescription>
                      由 OAuth2 登录脚本自动填充，通常无需手动修改。
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setUserDialog({
                      open: false,
                      mode: 'create',
                      user: null,
                    })
                  }
                >
                  取消
                </Button>
                <Button type="submit" disabled={isSubmittingUser}>
                  {isSubmittingUser ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : null}
                  {userDialog.mode === 'create' ? '创建用户' : '保存修改'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={departmentDialog.open}
        onOpenChange={(open) => {
          if (!open) {
            setDepartmentDialog({
              open: false,
              mode: 'create',
              parent: null,
              department: null,
            })
            return
          }
          setDepartmentDialog(previous => ({
            ...previous,
            open: true,
          }))
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {departmentDialog.mode === 'create' ? '新建部门' : '编辑部门'}
            </DialogTitle>
            <DialogDescription>
              {departmentDialog.mode === 'create'
                ? '可以创建一级部门，也可以挂到指定父部门下面。'
                : '修改部门名称或调整在树中的层级位置。'}
            </DialogDescription>
          </DialogHeader>
          <Form {...departmentForm}>
            <form onSubmit={departmentForm.handleSubmit(handleSubmitDepartment)} className="space-y-4">
              <FormField
                control={departmentForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>部门名称</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="请输入部门名称" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={departmentForm.control}
                name="orgId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>所属组织</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value || ''}
                      disabled={departmentDialog.mode === 'edit'}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="选择组织" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {organizations.map(org => (
                          <SelectItem key={org.id} value={org.id}>
                            {org.name}
                            {org.extOrgId ? ` (${org.extOrgId})` : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {departmentDialog.mode === 'edit' ? (
                      <FormDescription>
                        部门所属组织不可修改。如需迁移，请删除后在目标组织重新创建。
                      </FormDescription>
                    ) : null}
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={departmentForm.control}
                name="parentId"
                render={({ field }) => {
                  const selectedOrgId = departmentForm.watch('orgId')
                  const filtered = availableParentDepartments.filter(option => {
                    const dept = departments.find(d => d.id === option.id)
                    return !selectedOrgId || !dept || dept.orgId === selectedOrgId
                  })
                  return (
                    <FormItem>
                      <FormLabel>上级部门</FormLabel>
                      <Select
                        onValueChange={(value) =>
                          field.onChange(value === ROOT_VALUE ? null : value)
                        }
                        value={field.value ?? ROOT_VALUE}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="选择上级部门" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value={ROOT_VALUE}>作为一级部门</SelectItem>
                          {filtered.map(option => (
                            <SelectItem key={option.id} value={option.id}>
                              {`${'— '.repeat(option.depth)}${option.name}`}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )
                }}
              />
              <FormField
                control={departmentForm.control}
                name="extDeptId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>外部部门 ID（OAuth2）</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="留空表示无外部 ID" />
                    </FormControl>
                    <FormDescription>
                      由 OAuth2 登录脚本自动填充，通常无需手动修改。
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setDepartmentDialog({
                      open: false,
                      mode: 'create',
                      parent: null,
                      department: null,
                    })
                  }
                >
                  取消
                </Button>
                <Button type="submit" disabled={isSubmittingDepartment}>
                  {isSubmittingDepartment ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : null}
                  {departmentDialog.mode === 'create' ? '创建部门' : '保存修改'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={organizationDialog.open}
        onOpenChange={(open) => {
          if (!open) {
            setOrganizationDialog({ open: false, mode: 'create', organization: null })
            return
          }
          setOrganizationDialog(prev => ({ ...prev, open: true }))
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {organizationDialog.mode === 'create' ? '新建组织' : '编辑组织'}
            </DialogTitle>
            <DialogDescription>
              组织（租户）是 moss 内独立的用户与部门空间。OAuth2 登录会按外部组织 ID 自动创建组织。
            </DialogDescription>
          </DialogHeader>
          <Form {...organizationForm}>
            <form onSubmit={organizationForm.handleSubmit(handleSubmitOrganization)} className="space-y-4">
              <FormField
                control={organizationForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>名称</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="请输入组织名称" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={organizationForm.control}
                name="extOrgId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>外部组织 ID（OAuth2）</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="留空表示无外部 ID" />
                    </FormControl>
                    <FormDescription>
                      由 OAuth2 登录脚本自动填充，可留空。
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setOrganizationDialog({ open: false, mode: 'create', organization: null })
                  }
                >
                  取消
                </Button>
                <Button type="submit" disabled={isSubmittingOrganization}>
                  {isSubmittingOrganization ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : null}
                  {organizationDialog.mode === 'create' ? '创建组织' : '保存修改'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!organizationToDelete}
        onOpenChange={(open) => !open && setOrganizationToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除组织</AlertDialogTitle>
            <AlertDialogDescription>
              确认删除「{organizationToDelete?.name ?? ''}」？组织下若仍有用户或部门，删除将被拒绝。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDeleteOrganization}
              disabled={pendingOrganizationActionId === organizationToDelete?.id}
            >
              {pendingOrganizationActionId === organizationToDelete?.id ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!tokenLimitTarget} onOpenChange={(open) => !open && setTokenLimitTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>设置 Token 限额</DialogTitle>
            <DialogDescription>
              为「{tokenLimitTarget?.data.name ?? ''}」设置每日 Token 用量上限，留空表示不限制。
            </DialogDescription>
          </DialogHeader>
          <Form {...tokenLimitForm}>
            <form onSubmit={tokenLimitForm.handleSubmit(handleSubmitTokenLimit)} className="space-y-4">
              <FormField
                control={tokenLimitForm.control}
                name="tokenLimit"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Token 上限</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="留空表示不限制，例如：100000" />
                    </FormControl>
                    <FormDescription>单位：tokens，整数，留空清除限制。</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setTokenLimitTarget(null)}>
                  取消
                </Button>
                <Button type="submit" disabled={isSubmittingTokenLimit}>
                  {isSubmittingTokenLimit ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                  保存
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!resetPasswordUser} onOpenChange={(open) => !open && setResetPasswordUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重置密码</DialogTitle>
            <DialogDescription>
              为 {resetPasswordUser?.name ?? '当前用户'} 设置新的登录密码。
            </DialogDescription>
          </DialogHeader>
          <Form {...passwordForm}>
            <form onSubmit={passwordForm.handleSubmit(handleSubmitPassword)} className="space-y-4">
              <FormField
                control={passwordForm.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>新密码</FormLabel>
                    <FormControl>
                      <Input {...field} type="password" placeholder="至少 6 位" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setResetPasswordUser(null)}>
                  取消
                </Button>
                <Button type="submit" disabled={isSubmittingPassword}>
                  {isSubmittingPassword ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : null}
                  确认重置
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!apiKeyUser} onOpenChange={(open) => !open && setApiKeyUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>生成 API Key</DialogTitle>
            <DialogDescription>
              为 {apiKeyUser?.name ?? '当前用户'} 生成新的访问密钥。
            </DialogDescription>
          </DialogHeader>
          <Form {...apiKeyForm}>
            <form onSubmit={apiKeyForm.handleSubmit(handleSubmitApiKey)} className="space-y-4">
              <FormField
                control={apiKeyForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Key 名称</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="例如：service-key" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={apiKeyForm.control}
                name="scopes"
                render={() => (
                  <FormItem>
                    <FormLabel>权限范围</FormLabel>
                    <div className="grid gap-2 rounded-xl border p-4 sm:grid-cols-2">
                      {API_SCOPE_OPTIONS.map(option => (
                        <FormField
                          key={option.value}
                          control={apiKeyForm.control}
                          name="scopes"
                          render={({ field }) => (
                            <FormItem className="flex flex-row items-start gap-3 space-y-0 rounded-lg border p-3">
                              <FormControl>
                                <Checkbox
                                  checked={field.value.includes(option.value)}
                                  onCheckedChange={(checked) => {
                                    const nextValues = checked === true
                                      ? [...field.value, option.value]
                                      : field.value.filter(value => value !== option.value)
                                    field.onChange(nextValues)
                                  }}
                                />
                              </FormControl>
                              <div className="space-y-1 leading-none">
                                <FormLabel className="font-normal">{option.label}</FormLabel>
                              </div>
                            </FormItem>
                          )}
                        />
                      ))}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setApiKeyUser(null)}>
                  取消
                </Button>
                <Button type="submit" disabled={isSubmittingApiKey}>
                  {isSubmittingApiKey ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : null}
                  生成 Key
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!revealedApiKey}
        onOpenChange={(open) => !open && setRevealedApiKey(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API Key 已生成</DialogTitle>
            <DialogDescription>
              这是 {revealedApiKey?.userName ?? '当前用户'} 的新 Key，只会展示这一次。
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-xl border bg-muted/60 p-4">
            <code className="break-all text-sm">{revealedApiKey?.value}</code>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (revealedApiKey) {
                  void copyApiKey(revealedApiKey.value)
                }
              }}
            >
              <Copy className="mr-2 size-4" />
              复制
            </Button>
            <Button type="button" onClick={() => setRevealedApiKey(null)}>
              我已保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!departmentToDelete}
        onOpenChange={(open) => !open && setDepartmentToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除部门</AlertDialogTitle>
            <AlertDialogDescription>
              将删除部门“{departmentToDelete?.name ?? ''}”。如果该部门仍有子部门或用户，系统会阻止删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                void handleDeleteDepartment()
              }}
              disabled={pendingDepartmentActionId === departmentToDelete?.id}
            >
              {pendingDepartmentActionId === departmentToDelete?.id ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!localAuthTarget}
        onOpenChange={(open) => !open && setLocalAuthTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {localAuthTarget?.currentAuth ? '取消Local授权' : 'Local授权'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {localAuthTarget?.currentAuth
                ? `取消授权${localAuthTarget.userName}的Local模式`
                : `确认授权${localAuthTarget?.userName ?? ''}Local模式`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={isSubmittingLocalAuth}
              onClick={(event) => {
                event.preventDefault()
                if (!localAuthTarget) return
                setIsSubmittingLocalAuth(true)
                setUserLocalAuth(localAuthTarget.userId, !localAuthTarget.currentAuth)
                  .then(() => {
                    toast.success(localAuthTarget.currentAuth ? '已取消Local授权' : '已授予Local授权')
                    setLocalAuthTarget(null)
                    void fetchData()
                  })
                  .catch((err: Error) => {
                    toast.error(err.message || '操作失败')
                  })
                  .finally(() => {
                    setIsSubmittingLocalAuth(false)
                  })
              }}
            >
              {isSubmittingLocalAuth ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
              确认
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Sheet open={!!selectedUser} onOpenChange={(open) => !open && setSelectedUser(null)}>
        <SheetContent className="sm:max-w-[560px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{selectedUser?.name ?? '用户详情'}</SheetTitle>
            <SheetDescription>
              查看用户基础信息、API Key 以及最近会话。
            </SheetDescription>
          </SheetHeader>
          {selectedUser ? (
            <div className="mt-6 space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">基本信息</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">用户 ID</span>
                    <code className="text-xs">{selectedUser.id}</code>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">所属部门</span>
                    <span>{getDepartmentName(selectedUser.departmentId)}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">角色</span>
                    <Badge variant={getRoleBadgeVariant(selectedUser.role)}>
                      {ROLE_LABELS[selectedUser.role]}
                    </Badge>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">状态</span>
                    <Badge variant={selectedUser.status === 'active' ? 'default' : 'secondary'}>
                      {selectedUser.status === 'active' ? '启用' : '禁用'}
                    </Badge>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Token 限额</span>
                    <span>{selectedUser.tokenLimit != null ? selectedUser.tokenLimit.toLocaleString() : '不限制'}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">创建时间</span>
                    <span>{new Date(selectedUser.createdAt).toLocaleString('zh-CN')}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">最后登录</span>
                    <span>{formatTimestamp(selectedUser.lastLoginAt)}</span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0">
                  <div className="space-y-1">
                    <CardTitle className="text-base">API Keys</CardTitle>
                    <CardDescription>
                      共 {getUserApiKeys(selectedUser.id).length} 个 Key
                    </CardDescription>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => setApiKeyUser(selectedUser)}>
                    <Plus className="mr-2 size-4" />
                    生成 Key
                  </Button>
                </CardHeader>
                <CardContent>
                  {getUserApiKeys(selectedUser.id).length > 0 ? (
                    <div className="space-y-3">
                      {getUserApiKeys(selectedUser.id).map(apiKey => (
                        <div key={apiKey.id} className="rounded-xl border p-4">
                          <div className="flex items-start justify-between gap-4">
                            <div className="space-y-2">
                              <div className="flex items-center gap-2">
                                <span className="font-medium">{apiKey.name}</span>
                                <Badge variant={apiKey.status === 'active' ? 'default' : 'secondary'}>
                                  {apiKey.status === 'active' ? '启用' : '已撤销'}
                                </Badge>
                              </div>
                              <code className="text-xs text-muted-foreground">
                                {apiKey.prefix}...
                              </code>
                              <div className="flex flex-wrap gap-1">
                                {apiKey.scopes.map(scope => (
                                  <Badge key={scope} variant="secondary" className="text-xs">
                                    {SCOPE_LABELS[scope] ?? scope}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                            {apiKey.status === 'active' ? (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={pendingApiKeyActionId === apiKey.id}
                                onClick={() => void handleRevokeApiKey(apiKey)}
                              >
                                {pendingApiKeyActionId === apiKey.id ? (
                                  <Loader2 className="mr-2 size-4 animate-spin" />
                                ) : null}
                                撤销
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                      当前用户还没有 API Key。
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">最近会话</CardTitle>
                  <CardDescription>显示最近 10 条用户会话。</CardDescription>
                </CardHeader>
                <CardContent>
                  {isLoadingSessions ? (
                    <div className="flex items-center justify-center py-10">
                      <Loader2 className="size-6 animate-spin text-muted-foreground" />
                    </div>
                  ) : userSessions.length > 0 ? (
                    <div className="space-y-3">
                      {userSessions.slice(0, 10).map(session => (
                        <div
                          key={session.sessionId}
                          className="flex items-center justify-between rounded-xl border p-4"
                        >
                          <div className="space-y-1">
                            <code className="text-xs">{session.sessionId.slice(0, 18)}...</code>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Badge variant="secondary" className="text-xs">
                                {session.runtime.type}
                              </Badge>
                              <span>{new Date(session.createdAt).toLocaleString('zh-CN')}</span>
                            </div>
                          </div>
                          <Button variant="ghost" size="sm" asChild>
                            <Link to={`/sessions/${session.sessionId}`}>
                              <ExternalLink className="size-4" />
                            </Link>
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                      当前用户暂无会话记录。
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </DashboardLayout>
  )
}
