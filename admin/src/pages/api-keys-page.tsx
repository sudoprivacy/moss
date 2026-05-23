'use client'

import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
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
import { getApiKeys, createApiKey, getUsers } from '@/lib/api/auth'
import type { ApiKey, AuthUser } from '@/lib/api/types'
import { Plus, Copy, Key, Loader2, MoreHorizontal } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from 'sonner'

const apiKeySchema = z.object({
  user_id: z.string().min(1, '请选择用户'),
  name: z.string().min(2, '名称至少2个字符'),
  scopes: z.array(z.string()).min(1, '请选择至少一个权限'),
})

type ApiKeyFormData = z.infer<typeof apiKeySchema>

const scopeOptions = [
  { value: 'sessions:create', label: '创建会话' },
  { value: 'sessions:attach', label: '接入会话' },
  { value: 'sessions:list', label: '列出会话' },
  { value: 'sessions:list:any', label: '查看所有会话' },
  { value: 'sessions:attach:any', label: '接入任何会话' },
  { value: 'admin:users', label: '管理用户' },
  { value: 'admin:api_keys', label: '管理 API Keys' },
  { value: 'admin:settings', label: '管理系统设置' },
]

export default function ApiKeysPage() {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [users, setUsers] = useState<AuthUser[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [newApiKey, setNewApiKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const form = useForm<ApiKeyFormData>({
    resolver: zodResolver(apiKeySchema),
    defaultValues: {
      user_id: '',
      name: '',
      scopes: [],
    },
  })

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    try {
      const [keysRes, usersRes] = await Promise.all([
        getApiKeys(),
        getUsers(),
      ])
      setApiKeys(keysRes.api_keys)
      setUsers(usersRes.users)
    } catch (error) {
      console.error('Failed to fetch data:', error)
      toast.error('获取 API Key 列表失败')
    } finally {
      setIsLoading(false)
    }
  }

  const filteredApiKeys = apiKeys.filter((key) => {
    const user = users.find((u) => u.id === key.userId)
    const matchesSearch =
      key.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      key.prefix.toLowerCase().includes(searchQuery.toLowerCase()) ||
      user?.name.toLowerCase().includes(searchQuery.toLowerCase())
    return matchesSearch
  })

  const handleSubmit = async (data: ApiKeyFormData) => {
    setIsSubmitting(true)
    try {
      const response = await createApiKey(data)
      setNewApiKey(response.plain_text_key)
      toast.success('API Key 创建成功')
      setIsDialogOpen(false)
      form.reset()
      fetchData()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建 API Key 失败')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCopy = (key: string) => {
    navigator.clipboard.writeText(key)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const getUserName = (userId: string) => {
    const user = users.find((u) => u.id === userId)
    return user?.name || userId.slice(0, 8)
  }

  if (isLoading) {
    return (
      <DashboardLayout title="API Key 管理">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout title="API Key 管理">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1 max-w-md">
            <Key className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder="搜索 Key 名称或用户..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button
            onClick={() => {
              setNewApiKey(null)
              setIsDialogOpen(true)
            }}
          >
            <Plus className="size-4 mr-2" />
            创建 API Key
          </Button>
        </div>

        {/* API Keys Table */}
        <div className="border rounded-lg">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>Key 前缀</TableHead>
                <TableHead>所属用户</TableHead>
                <TableHead>权限范围</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead>最后使用</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredApiKeys.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="font-medium">{key.name}</TableCell>
                  <TableCell>
                    <code className="text-sm bg-muted px-2 py-1 rounded">{key.prefix}...</code>
                  </TableCell>
                  <TableCell>{getUserName(key.userId)}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {key.scopes.slice(0, 2).map((scope) => (
                        <Badge key={scope} variant="secondary" className="text-xs">
                          {scope}
                        </Badge>
                      ))}
                      {key.scopes.length > 2 && (
                        <Badge variant="outline" className="text-xs">
                          +{key.scopes.length - 2}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={key.status === 'active' ? 'default' : 'secondary'}>
                      {key.status === 'active' ? '启用' : '已撤销'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {new Date(key.createdAt).toLocaleString('zh-CN')}
                  </TableCell>
                  <TableCell>
                    {key.lastUsedAt
                      ? new Date(key.lastUsedAt).toLocaleString('zh-CN')
                      : '从未使用'}
                  </TableCell>
                </TableRow>
              ))}
              {filteredApiKeys.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    没有找到匹配的 API Key
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Create Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={(open) => {
        setIsDialogOpen(open)
        if (!open) {
          setNewApiKey(null)
          form.reset()
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{newApiKey ? 'API Key 已创建' : '创建 API Key'}</DialogTitle>
            <DialogDescription>
              {newApiKey
                ? '请妥善保管此 Key，它不会再显示第二次'
                : '创建一个新的 API Key 用于程序化访问'}
            </DialogDescription>
          </DialogHeader>

          {newApiKey ? (
            <div className="space-y-4">
              <div className="p-4 bg-muted rounded-lg">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-muted-foreground">你的 API Key</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleCopy(newApiKey)}
                  >
                    <Copy className="size-4 mr-1" />
                    {copied ? '已复制' : '复制'}
                  </Button>
                </div>
                <code className="text-sm break-all">{newApiKey}</code>
              </div>
              <p className="text-sm text-muted-foreground">
                请将上述 Key 妥善保存。创建后无法再次查看完整内容。
              </p>
              <Button onClick={() => {
                setNewApiKey(null)
                setIsDialogOpen(false)
              }} className="w-full">
                完成
              </Button>
            </div>
          ) : (
            <Form {...form}>
              <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="user_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>所属用户</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="选择用户" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {users.map((user) => (
                            <SelectItem key={user.id} value={user.id}>
                              {user.email ? `${user.name} (${user.email})` : user.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Key 名称</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="如: Production API Key" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="scopes"
                  render={() => (
                    <FormItem>
                      <div className="mb-2">
                        <FormLabel>权限范围</FormLabel>
                        <FormDescription>
                          选择此 Key 拥有的权限
                        </FormDescription>
                      </div>
                      <div className="flex flex-col gap-2">
                        {scopeOptions.map((scope) => (
                          <FormField
                            key={scope.value}
                            control={form.control}
                            name="scopes"
                            render={({ field }) => (
                              <FormItem className="flex items-center space-y-0">
                                <FormControl>
                                  <Checkbox
                                    checked={field.value?.includes(scope.value)}
                                    onCheckedChange={(checked) => {
                                      const value = field.value || []
                                      if (checked) {
                                        field.onChange([...value, scope.value])
                                      } else {
                                        field.onChange(
                                          value.filter((v) => v !== scope.value)
                                        )
                                      }
                                    }}
                                  />
                                </FormControl>
                                <FormLabel className="font-normal ml-2 cursor-pointer">
                                  {scope.label}
                                  <span className="ml-2 text-xs text-muted-foreground">
                                    ({scope.value})
                                  </span>
                                </FormLabel>
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
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setIsDialogOpen(false)
                      setNewApiKey(null)
                      form.reset()
                    }}
                  >
                    取消
                  </Button>
                  <Button type="submit" disabled={isSubmitting}>
                    {isSubmitting && <Loader2 className="mr-2 size-4 animate-spin" />}
                    创建
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          )}
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}
