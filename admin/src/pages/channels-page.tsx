'use client'

import { useCallback, useEffect, useState } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  getPlugins,
  enablePlugin,
  disablePlugin,
  testPlugin,
  getPluginCredentials,
  getPendingPairings,
  approvePairing,
  rejectPairing,
  getUsers,
  deleteUser,
  startWechatQrLogin,
  pollWechatQrStatus,
} from '@/lib/api/channels'
import type {
  IChannelPluginConfig,
  IChannelUser,
  IChannelPendingPairing,
  ChannelPlatform,
} from '@/lib/api/types'
import {
  Loader2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Trash2,
  Check,
  X,
  ChevronDown,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { toast } from 'sonner'

const PLATFORM_LABELS: Record<ChannelPlatform, string> = {
  telegram: 'Telegram',
  lark: '飞书 (Lark)',
  dingtalk: '钉钉 (DingTalk)',
  wechat: '个人微信 (WeChat)',
  wecom: '企业微信 (WeCom)',
}

const PLATFORM_LOGOS: Record<ChannelPlatform, string> = {
  telegram: `${import.meta.env.BASE_URL}channel-logos/telegram.svg`,
  lark: `${import.meta.env.BASE_URL}channel-logos/lark.svg`,
  dingtalk: `${import.meta.env.BASE_URL}channel-logos/dingtalk.svg`,
  wechat: `${import.meta.env.BASE_URL}channel-logos/wechat.svg`,
  wecom: `${import.meta.env.BASE_URL}channel-logos/wecom.svg`,
}

const SETUP_STEPS = [
  '选择一个渠道完成配置',
  '验证并启用渠道',
  '在 IM 应用中与 AI 助手开始对话',
]

type PlatformField = {
  key: string
  label: string
  type: 'text' | 'password'
  required?: boolean
  placeholder?: string
}

function getFieldsForPlatform(platform: ChannelPlatform): PlatformField[] {
  switch (platform) {
    case 'telegram':
      return [{ key: 'token', label: 'Bot Token', type: 'password', required: true, placeholder: '123456:ABC-DEF...' }]
    case 'lark':
      return [
        { key: 'appId', label: 'App ID', type: 'text', required: true, placeholder: 'cli_xxxxxxxxxx' },
        { key: 'appSecret', label: 'App Secret', type: 'password', required: true, placeholder: 'xxxxxxxxxxxxxxxxxx' },
        { key: 'encryptKey', label: 'Encrypt Key (可选)', type: 'password' },
        { key: 'verificationToken', label: 'Verification Token (可选)', type: 'password' },
      ]
    case 'dingtalk':
      return [
        { key: 'clientId', label: 'Client ID', type: 'text', required: true, placeholder: 'dingxxxxxxxxxx' },
        { key: 'clientSecret', label: 'Client Secret', type: 'password', required: true, placeholder: 'xxxxxxxxxxxxxxxxxx' },
      ]
    case 'wechat':
      return []
    case 'wecom':
      return [
        { key: 'botId', label: 'Bot ID', type: 'text', required: true, placeholder: 'Bot ID' },
        { key: 'secret', label: 'Secret', type: 'password', required: true, placeholder: 'xxxxxxxxxxxxxxxxxx' },
      ]
    default:
      return []
  }
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'running') {
    return <Badge variant="default" className="bg-green-600 text-white gap-1"><CheckCircle2 className="h-3 w-3" /> 运行中</Badge>
  }
  if (status === 'error') {
    return <Badge variant="destructive" className="gap-1"><AlertCircle className="h-3 w-3" /> 错误</Badge>
  }
  if (status === 'stopped') {
    return <Badge variant="secondary" className="gap-1"><XCircle className="h-3 w-3" /> 已停止</Badge>
  }
  return <Badge variant="outline" className="gap-1">未配置</Badge>
}

export default function ChannelsPage() {
  const [plugins, setPlugins] = useState<(IChannelPluginConfig & { error?: string })[]>([])
  const [users, setUsers] = useState<IChannelUser[]>([])
  const [pairings, setPairings] = useState<IChannelPendingPairing[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [togglingPlugins, setTogglingPlugins] = useState<Set<string>>(new Set())

  // Per-platform expand state
  const [expandedPlatforms, setExpandedPlatforms] = useState<Set<string>>(new Set())

  // Per-platform form values and test status
  const [platformFormValues, setPlatformFormValues] = useState<Record<string, Record<string, string>>>({})
  const [platformTestStatus, setPlatformTestStatus] = useState<Record<string, 'idle' | 'testing' | 'success' | 'error'>>({})
  const [platformSaving, setPlatformSaving] = useState<Record<string, boolean>>({})

  // WeChat QR login state
  const [wechatQrPhase, setWechatQrPhase] = useState<'idle' | 'loading' | 'qrcode' | 'scanned' | 'success' | 'error'>('idle')
  const [wechatQrUrl, setWechatQrUrl] = useState('')
  const [wechatQrError, setWechatQrError] = useState('')
  const loadData = useCallback(async (silent = false) => {
    if (!silent) setIsLoading(true)
    else setIsRefreshing(true)

    try {
      const [pluginsRes, usersRes, pairingsRes] = await Promise.all([
        getPlugins(),
        getUsers(),
        getPendingPairings(),
      ])
      setPlugins(pluginsRes.plugins)
      setUsers(usersRes.users)
      setPairings(pairingsRes.pairings)
    } catch (err) {
      toast.error('加载数据失败', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally {
      setIsLoading(false)
      setIsRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  // Poll for updates every 5 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      void loadData(true)
    }, 5000)
    return () => clearInterval(interval)
  }, [loadData])

  const toggleExpand = (platform: string) => {
    const isExpanding = !expandedPlatforms.has(platform)
    setExpandedPlatforms(prev => {
      const next = new Set(prev)
      if (next.has(platform)) {
        next.delete(platform)
      } else {
        next.add(platform)
      }
      return next
    })

    // Load credentials when expanding
    if (isExpanding) {
      void loadCredentials(platform)
    }
  }

  const loadCredentials = async (platform: string) => {
    const plugin = plugins.find(p => p.type === platform)
    if (plugin?.credentials && Object.keys(plugin.credentials).length > 0) {
      setPlatformFormValues(prev => ({
        ...prev,
        [platform]: Object.fromEntries(
          Object.entries(plugin.credentials).map(([k, v]) => [k, String(v || '')])
        ),
      }))
    } else {
      try {
        const creds = await getPluginCredentials(plugin?.id || `${platform}_default`)
        if (creds && Object.keys(creds).length > 0) {
          setPlatformFormValues(prev => ({
            ...prev,
            [platform]: Object.fromEntries(
              Object.entries(creds).map(([k, v]) => [k, String(v || '')])
            ),
          }))
        }
      } catch {
        // No credentials stored yet
      }
    }
  }

  const updateFormValue = (platform: string, key: string, value: string) => {
    setPlatformFormValues(prev => ({
      ...prev,
      [platform]: { ...(prev[platform] || {}), [key]: value },
    }))
    // Reset test status when form changes
    setPlatformTestStatus(prev => ({ ...prev, [platform]: 'idle' }))
  }

  const handleTest = async (platform: string) => {
    const plugin = plugins.find(p => p.type === platform)
    if (!plugin) return
    const values = platformFormValues[platform] || {}

    setPlatformTestStatus(prev => ({ ...prev, [platform]: 'testing' }))
    try {
      const res = await testPlugin(plugin.id, values)
      if (res.ok) {
        setPlatformTestStatus(prev => ({ ...prev, [platform]: 'success' }))
        toast.success('测试成功', { description: res.message })
      } else {
        setPlatformTestStatus(prev => ({ ...prev, [platform]: 'error' }))
        toast.error('测试失败', { description: res.message })
      }
    } catch (err) {
      setPlatformTestStatus(prev => ({ ...prev, [platform]: 'error' }))
      toast.error('测试出错', { description: err instanceof Error ? err.message : 'Unknown error' })
    }
  }

  const handleTestAndEnable = async (platform: string) => {
    const plugin = plugins.find(p => p.type === platform)
    if (!plugin) return
    const values = platformFormValues[platform] || {}

    setPlatformTestStatus(prev => ({ ...prev, [platform]: 'testing' }))
    try {
      const res = await testPlugin(plugin.id, values)
      if (res.ok) {
        toast.success('测试成功，正在启用...', { description: res.message })
        setPlatformSaving(prev => ({ ...prev, [platform]: true }))
        try {
          await enablePlugin(plugin.id, values)
          toast.success('渠道已启用')
          void loadData(true)
        } catch (enableErr) {
          toast.error('启用失败', { description: enableErr instanceof Error ? enableErr.message : 'Unknown error' })
        } finally {
          setPlatformSaving(prev => ({ ...prev, [platform]: false }))
        }
      } else {
        setPlatformTestStatus(prev => ({ ...prev, [platform]: 'error' }))
        toast.error('测试失败', { description: res.message })
      }
    } catch (err) {
      setPlatformTestStatus(prev => ({ ...prev, [platform]: 'error' }))
      toast.error('测试出错', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally {
      if (platformTestStatus[platform] !== 'success' && platformTestStatus[platform] !== 'error') {
        setPlatformTestStatus(prev => ({ ...prev, [platform]: 'idle' }))
      }
    }
  }

  const handleTogglePlugin = async (plugin: IChannelPluginConfig, enabled: boolean) => {
    setTogglingPlugins(prev => new Set(prev).add(plugin.id))
    try {
      if (enabled) {
        // WeChat uses QR login flow, not credentials form
        if (plugin.type === 'wechat') {
          if (!expandedPlatforms.has(plugin.type)) {
            toggleExpand(plugin.type)
          }
          setTogglingPlugins(prev => {
            const next = new Set(prev)
            next.delete(plugin.id)
            return next
          })
          return
        }
        if (!plugin.credentials || Object.keys(plugin.credentials).length === 0) {
          // No credentials, expand to show form
          if (!expandedPlatforms.has(plugin.type)) {
            toggleExpand(plugin.type)
          }
          setTogglingPlugins(prev => {
            const next = new Set(prev)
            next.delete(plugin.id)
            return next
          })
          return
        }
        await enablePlugin(plugin.id, plugin.credentials)
        toast.success('已启用')
      } else {
        await disablePlugin(plugin.id)
        toast.success('已禁用')
        // Reset wechat QR state on disable
        if (plugin.type === 'wechat') {
          setWechatQrPhase('idle')
          setWechatQrUrl('')
          setWechatQrError('')
        }
      }
      void loadData(true)
    } catch (err) {
      toast.error(enabled ? '启用失败' : '禁用失败', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally {
      setTogglingPlugins(prev => {
        const next = new Set(prev)
        next.delete(plugin.id)
        return next
      })
    }
  }

  const handleApprovePairing = async (code: string) => {
    try {
      await approvePairing(code)
      toast.success('已批准配对')
      void loadData(true)
    } catch (err) {
      toast.error('操作失败', { description: err instanceof Error ? err.message : 'Unknown error' })
    }
  }

  const handleRejectPairing = async (code: string) => {
    try {
      await rejectPairing(code)
      toast.success('已拒绝配对')
      void loadData(true)
    } catch (err) {
      toast.error('操作失败', { description: err instanceof Error ? err.message : 'Unknown error' })
    }
  }

  const handleDeleteUser = async (id: string) => {
    if (!confirm('确定要删除该用户吗？')) return
    try {
      await deleteUser(id)
      toast.success('已删除用户')
      void loadData(true)
    } catch (err) {
      toast.error('删除失败', { description: err instanceof Error ? err.message : 'Unknown error' })
    }
  }

  // WeChat QR login flow
  const handleWechatConnect = async () => {
    setWechatQrPhase('loading')
    setWechatQrError('')
    setWechatQrUrl('')
    try {
      const res = await startWechatQrLogin()
      if (!res.ok || !res.qrcode || !res.qrcodeImgContent) {
        setWechatQrPhase('error')
        setWechatQrError(res.error || '获取二维码失败')
        return
      }
      setWechatQrUrl(res.qrcodeImgContent)
      setWechatQrPhase('qrcode')

      // Poll for scan status
      const maxPolls = 100
      for (let i = 0; i < maxPolls; i++) {
        await new Promise(resolve => setTimeout(resolve, 3000))
        try {
          const pollRes = await pollWechatQrStatus(res.qrcode!)
          if (!pollRes.ok) continue

          if (pollRes.status === 'scaned') {
            setWechatQrPhase('scanned')
          } else if (pollRes.status === 'confirmed' && pollRes.botToken && pollRes.accountId) {
            try {
              await enablePlugin('wechat_default', { token: pollRes.botToken, accountId: pollRes.accountId })
              setWechatQrPhase('success')
              toast.success('微信连接成功')
              void loadData(true)
            } catch (enableErr) {
              setWechatQrPhase('error')
              setWechatQrError(enableErr instanceof Error ? enableErr.message : '启用失败')
            }
            return
          } else if (pollRes.status === 'expired') {
            setWechatQrPhase('error')
            setWechatQrError('二维码已过期，请重试')
            return
          }
        } catch {
          // Continue polling on transient errors
        }
      }
      setWechatQrPhase('error')
      setWechatQrError('登录超时，请重试')
    } catch (err) {
      setWechatQrPhase('error')
      setWechatQrError(err instanceof Error ? err.message : '连接失败')
    }
  }

  if (isLoading) {
    return (
      <DashboardLayout title="IM管理" description="管理接入的 IM 渠道">
        <div className="space-y-6">
          <Skeleton className="h-8 w-48" />
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout title="IM管理" description="管理接入的 IM 渠道">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">IM管理</h1>
            <p className="text-sm text-muted-foreground mt-1">
              配置并管理 Telegram、飞书、钉钉、个人微信等渠道的接入
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadData(true)}
            disabled={isRefreshing}
          >
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} /> 刷新
          </Button>
        </div>

        {/* Setup Guide */}
        <Card className="bg-muted/50">
          <CardContent className="py-4">
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {SETUP_STEPS.map((step, idx) => (
                <div key={idx} className="inline-flex items-center gap-2">
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-semibold bg-primary/10 text-primary">
                    {idx + 1}
                  </span>
                  <Check className="h-4 w-4 text-primary" />
                  <span className="text-sm text-muted-foreground">{step}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Channel Items */}
        <div className="space-y-3">
          {plugins.map((plugin) => {
            const isExpanded = expandedPlatforms.has(plugin.type)
            const fields = getFieldsForPlatform(plugin.type as ChannelPlatform)
            const formValues = platformFormValues[plugin.type] || {}
            const testStatus = platformTestStatus[plugin.type] || 'idle'
            const isSaving = platformSaving[plugin.type] || false
            const isToggling = togglingPlugins.has(plugin.id)
            const platformPairings = pairings.filter(p => p.platformType === plugin.type)
            const platformUsers = users.filter(u => u.platformType === plugin.type)

            return (
              <Collapsible
                key={plugin.id}
                open={isExpanded}
                onOpenChange={() => void toggleExpand(plugin.type)}
              >
                <div className="border rounded-lg">
                  {/* Header */}
                  <CollapsibleTrigger className="flex items-center justify-between w-full px-4 py-3 hover:bg-muted/50 transition-colors">
                    <div className="flex items-center gap-3">
                      {PLATFORM_LOGOS[plugin.type as ChannelPlatform] && (
                        <img
                          src={PLATFORM_LOGOS[plugin.type as ChannelPlatform]}
                          alt={PLATFORM_LABELS[plugin.type as ChannelPlatform]}
                          className="w-5 h-5 object-contain"
                        />
                      )}
                      <span className="text-sm font-medium">{PLATFORM_LABELS[plugin.type as ChannelPlatform] || plugin.name}</span>
                      <StatusBadge status={!plugin.enabled && plugin.status === 'stopped' ? 'unconfigured' : plugin.status} />
                      {platformUsers.length > 0 && (
                        <Badge variant="outline" className="text-xs">{platformUsers.length} 用户</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
                      <Switch
                        checked={plugin.enabled}
                        onCheckedChange={(checked) => void handleTogglePlugin(plugin, checked)}
                        disabled={isToggling}
                      />
                      {isToggling && <Loader2 className="h-4 w-4 animate-spin" />}
                      <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                    </div>
                  </CollapsibleTrigger>

                  {/* Content */}
                  <CollapsibleContent>
                    <div className="px-4 pb-4 pt-2 border-t space-y-4">
                      {/* Config Form (non-WeChat platforms) */}
                      {fields.length > 0 && !plugin.enabled && (
                        <div className="space-y-3">
                          {fields.map((field) => (
                            <div key={field.key} className="grid grid-cols-[14rem_1fr] items-center gap-4">
                              <Label htmlFor={`${plugin.type}-${field.key}`} className="text-right text-sm">
                                {field.label}
                                {field.required && <span className="text-destructive ml-0.5">*</span>}
                              </Label>
                              <Input
                                id={`${plugin.type}-${field.key}`}
                                type={field.type}
                                value={formValues[field.key] || ''}
                                onChange={(e) => updateFormValue(plugin.type, field.key, e.target.value)}
                                placeholder={field.placeholder}
                                className="max-w-xs"
                              />
                            </div>
                          ))}
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void handleTest(plugin.type)}
                              disabled={testStatus === 'testing' || isSaving}
                            >
                              {testStatus === 'testing' && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                              测试连接
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => void handleTestAndEnable(plugin.type)}
                              disabled={testStatus === 'testing' || isSaving}
                            >
                              {isSaving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                              测试并启用
                            </Button>
                          </div>
                          {testStatus === 'success' && (
                            <p className="text-sm text-green-600 text-right">连接测试成功</p>
                          )}
                          {testStatus === 'error' && (
                            <p className="text-sm text-destructive text-right">连接测试失败</p>
                          )}
                        </div>
                      )}

                      {/* WeChat QR Login (replaces credential form) */}
                      {plugin.type === 'wechat' && !plugin.enabled && (
                        <div className="space-y-3">
                          {wechatQrPhase === 'idle' && (
                            <div className="space-y-2">
                              <p className="text-sm text-muted-foreground">
                                扫描二维码连接个人微信账号
                              </p>
                              <Button size="sm" onClick={handleWechatConnect}>
                                连接微信
                              </Button>
                            </div>
                          )}
                          {wechatQrPhase === 'loading' && (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              正在获取二维码...
                            </div>
                          )}
                          {wechatQrPhase === 'qrcode' && (
                            <div className="flex flex-col items-center gap-3 p-4 rounded-lg border bg-muted/50">
                              <span className="text-sm font-medium">请使用微信扫描二维码</span>
                              <div className="bg-white rounded-lg p-3">
                                <QRCodeSVG value={wechatQrUrl} size={200} level="H" />
                              </div>
                              <span className="text-xs text-muted-foreground">打开手机微信，扫描上方二维码</span>
                            </div>
                          )}
                          {wechatQrPhase === 'scanned' && (
                            <div className="flex items-center gap-2 p-3 rounded-lg border bg-yellow-50 border-yellow-200 dark:bg-yellow-900/20 dark:border-yellow-800">
                              <CheckCircle2 className="h-4 w-4 text-yellow-600" />
                              <span className="text-sm">已扫描，请在手机上确认...</span>
                            </div>
                          )}
                          {wechatQrPhase === 'success' && (
                            <div className="flex items-center gap-2 p-3 rounded-lg border bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800">
                              <CheckCircle2 className="h-4 w-4 text-green-600" />
                              <span className="text-sm">微信已连接</span>
                            </div>
                          )}
                          {wechatQrPhase === 'error' && (
                            <div className="space-y-2">
                              <div className="flex items-center gap-2 p-3 rounded-lg border bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800">
                                <AlertCircle className="h-4 w-4 text-destructive" />
                                <span className="text-sm text-destructive">{wechatQrError}</span>
                              </div>
                              <Button size="sm" variant="outline" onClick={handleWechatConnect}>
                                重试
                              </Button>
                            </div>
                          )}
                        </div>
                      )}

                      {/* When enabled, show config info + reconfigure option */}
                      {plugin.enabled && (
                        <div className="space-y-3">
                          {/* Connection Status */}
                          <div className={`rounded-lg p-3 border ${
                            plugin.status === 'running' ? 'bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800' :
                            plugin.status === 'error' ? 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800' :
                            'bg-yellow-50 border-yellow-200 dark:bg-yellow-900/20 dark:border-yellow-800'
                          }`}>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium">连接状态</span>
                                <StatusBadge status={plugin.status} />
                              </div>
                              {plugin.status === 'running' && (
                                <span className="text-xs text-muted-foreground">
                                  正在运行
                                </span>
                              )}
                            </div>
                            {plugin.status === 'error' && plugin.error && (
                              <p className="text-sm text-destructive mt-1">{plugin.error}</p>
                            )}
                            {plugin.status === 'running' && plugin.type !== 'wechat' && plugin.type !== 'wecom' && (
                              <div className="text-sm text-muted-foreground mt-2 space-y-1">
                                <p className="font-medium text-foreground">下一步：</p>
                                <p>1. 在 IM 应用中找到机器人并发送消息</p>
                                <p>2. 在下方批准配对请求</p>
                                <p>3. 配对成功后即可开始对话</p>
                              </div>
                            )}
                          </div>

                          {/* Credentials summary (masked) */}
                          {fields.length > 0 && (
                            <div className="space-y-2">
                              <span className="text-xs text-muted-foreground">配置信息</span>
                              <div className="flex flex-wrap gap-x-6 gap-y-1">
                                {fields.map((field) => {
                                  const hasValue = plugin.credentials?.[field.key]
                                  return (
                                    <div key={field.key} className="text-xs">
                                      <span className="text-muted-foreground">{field.label}:</span>{' '}
                                      <span className="font-mono">{hasValue ? '••••••••' : '—'}</span>
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Pending Pairings for this platform */}
                      {plugin.enabled && platformPairings.length > 0 && (
                        <div>
                          <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                            待处理配对
                            <Badge variant="secondary" className="text-xs">{platformPairings.length}</Badge>
                          </h4>
                          <div className="space-y-2">
                            {platformPairings.map((p) => (
                              <div key={p.code} className="flex items-center justify-between bg-muted/50 rounded-lg p-3">
                                <div>
                                  <span className="text-sm font-medium">{p.displayName || p.platformUserId}</span>
                                  <span className="text-xs text-muted-foreground ml-2">配对码: <code className="bg-muted px-1 rounded">{p.code}</code></span>
                                </div>
                                <div className="flex gap-2">
                                  <Button size="sm" variant="default" onClick={() => void handleApprovePairing(p.code)}>
                                    <Check className="h-3.5 w-3.5 mr-1" /> 批准
                                  </Button>
                                  <Button size="sm" variant="outline" onClick={() => void handleRejectPairing(p.code)}>
                                    <X className="h-3.5 w-3.5 mr-1" /> 拒绝
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Authorized Users for this platform */}
                      {plugin.enabled && platformUsers.length > 0 && (
                        <div>
                          <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                            已配对用户
                            <Badge variant="secondary" className="text-xs">{platformUsers.length}</Badge>
                          </h4>
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>用户</TableHead>
                                <TableHead>配对时间</TableHead>
                                <TableHead className="text-right w-16">操作</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {platformUsers.map((u) => (
                                <TableRow key={u.id}>
                                  <TableCell>
                                    <div>
                                      <span className="font-medium text-sm">{u.displayName || 'Unknown'}</span>
                                      <span className="text-xs text-muted-foreground ml-2">{u.platformUserId}</span>
                                    </div>
                                  </TableCell>
                                  <TableCell className="text-xs text-muted-foreground">
                                    {u.authorizedAt ? new Date(u.authorizedAt).toLocaleString() : '-'}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="text-destructive hover:text-destructive h-8 w-8 p-0"
                                      onClick={() => void handleDeleteUser(u.id)}
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      )}

                      {/* No pairings/users yet when enabled */}
                      {plugin.enabled && plugin.status === 'running' && platformPairings.length === 0 && platformUsers.length === 0 && plugin.type !== 'wechat' && plugin.type !== 'wecom' && (
                        <p className="text-sm text-muted-foreground text-center py-2">
                          等待用户配对请求...
                        </p>
                      )}
                    </div>
                  </CollapsibleContent>
                </div>
              </Collapsible>
            )
          })}
        </div>
      </div>
    </DashboardLayout>
  )
}
