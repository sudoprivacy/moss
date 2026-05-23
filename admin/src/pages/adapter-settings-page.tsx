'use client'

import { useCallback, useEffect, useState } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  getAdapterConfig,
  getAdapterProcesses,
  updateAdapterConfig,
  startAdapterProcess,
  stopAdapterProcess,
} from '@/lib/api/adapters'
import type { AdapterConfigsResponse, AdapterProcessStatus } from '@/lib/api/types'
import { Loader2, MessageSquare, Play, Square, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

type ImTab = 'feishu' | 'telegram'

export default function AdapterSettingsPage() {
  const [config, setConfig] = useState<AdapterConfigsResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [activeIm, setActiveIm] = useState<ImTab>('feishu')
  const [processes, setProcesses] = useState<Record<string, AdapterProcessStatus>>({})

  // Telegram
  const [tgBotToken, setTgBotToken] = useState('')
  const [tgAllowedUsers, setTgAllowedUsers] = useState('')
  // Feishu
  const [fsAppId, setFsAppId] = useState('')
  const [fsAppSecret, setFsAppSecret] = useState('')
  const [fsEncryptKey, setFsEncryptKey] = useState('')
  const [fsVerificationToken, setFsVerificationToken] = useState('')
  const [fsAllowedUsers, setFsAllowedUsers] = useState('')
  const [fsStreamingCard, setFsStreamingCard] = useState(false)

  const loadConfig = useCallback(async () => {
    setIsLoading(true)
    try {
      const [data, procData] = await Promise.all([getAdapterConfig(), getAdapterProcesses()])
      setConfig(data)
      setProcesses(procData)
      setTgBotToken(data.telegram?.botToken ?? '')
      setTgAllowedUsers(data.telegram?.allowedUsers?.join(', ') ?? '')
      setFsAppId(data.feishu?.appId ?? '')
      setFsAppSecret(data.feishu?.appSecret ?? '')
      setFsEncryptKey(data.feishu?.encryptKey ?? '')
      setFsVerificationToken(data.feishu?.verificationToken ?? '')
      setFsAllowedUsers(data.feishu?.allowedUsers?.join(', ') ?? '')
      setFsStreamingCard(data.feishu?.streamingCard ?? false)
    } catch (err) {
      toast.error('加载配置失败', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  async function handleSave() {
    setIsSaving(true)
    try {
      if (activeIm === 'telegram') {
        const tgUsers = tgAllowedUsers
          .split(',')
          .map((s: string) => s.trim())
          .filter(Boolean)
          .map(Number)
          .filter((n: number) => !isNaN(n))
        await updateAdapterConfig('telegram', {
          botToken: tgBotToken || undefined,
          allowedUsers: tgUsers.length ? tgUsers : [],
        })
      } else {
        const fsUsers = fsAllowedUsers
          .split(',')
          .map((s: string) => s.trim())
          .filter(Boolean)
        await updateAdapterConfig('feishu', {
          appId: fsAppId || undefined,
          appSecret: fsAppSecret || undefined,
          encryptKey: fsEncryptKey || undefined,
          verificationToken: fsVerificationToken || undefined,
          allowedUsers: fsUsers.length ? fsUsers : [],
          streamingCard: fsStreamingCard,
        })
      }
      toast.success('配置已保存')
      void loadConfig()
    } catch (err) {
      toast.error('保存失败', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally {
      setIsSaving(false)
    }
  }

  const tgKey = Object.keys(processes).find((k) => k.endsWith(':telegram'))
  const fsKey = Object.keys(processes).find((k) => k.endsWith(':feishu'))
  const tgStatus = tgKey ? processes[tgKey] : null
  const fsStatus = fsKey ? processes[fsKey] : null

  async function handleToggle(adapter: 'telegram' | 'feishu') {
    try {
      const key = adapter === 'telegram' ? tgKey : fsKey
      const status = adapter === 'telegram' ? tgStatus : fsStatus
      if (status?.status === 'running') {
        await stopAdapterProcess(adapter, key?.split(':')[1])
        toast.success(`${adapter === 'telegram' ? 'Telegram' : '飞书'} Bot 已停止`)
      } else {
        await startAdapterProcess(adapter, key?.split(':')[1])
        toast.success(`${adapter === 'telegram' ? 'Telegram' : '飞书'} Bot 已启动`)
      }
      void loadConfig()
    } catch (err) {
      toast.error('操作失败', { description: err instanceof Error ? err.message : 'Unknown error' })
    }
  }

  if (isLoading) {
    return (
      <DashboardLayout title="IM 接入" description="配置当前账号的飞书与 Telegram 机器人">
        <div className="space-y-6">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout title="IM 接入" description="配置当前账号的飞书与 Telegram 机器人">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">IM 接入</h1>
            <p className="text-sm text-muted-foreground mt-1">配置飞书和 Telegram 机器人，每个用户可以独立配置自己的 Bot</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void loadConfig()}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" /> 刷新
            </Button>
          </div>
        </div>

        {/* Process status */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageSquare className="h-4 w-4" /> Bot 进程状态
            </CardTitle>
            <CardDescription>当前用户的 IM Bot 进程运行状态</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              {/* Telegram status */}
              <div className="flex items-center justify-between rounded-lg border px-4 py-3">
                <div>
                  <p className="text-sm font-medium">Telegram Bot</p>
                  <p className="text-xs text-muted-foreground">
                    {tgStatus?.status === 'running'
                      ? `运行中 (PID ${tgStatus.pid})`
                      : tgStatus?.status === 'error'
                        ? `错误: ${tgStatus.error}`
                        : '未运行'}
                  </p>
                </div>
                <Button
                  variant={tgStatus?.status === 'running' ? 'destructive' : 'outline'}
                  size="sm"
                  onClick={() => void handleToggle('telegram')}
                >
                  {tgStatus?.status === 'running' ? (
                    <><Square className="mr-1 h-3 w-3" /> 停止</>
                  ) : (
                    <><Play className="mr-1 h-3 w-3" /> 启动</>
                  )}
                </Button>
              </div>
              {/* Feishu status */}
              <div className="flex items-center justify-between rounded-lg border px-4 py-3">
                <div>
                  <p className="text-sm font-medium">飞书 Bot</p>
                  <p className="text-xs text-muted-foreground">
                    {fsStatus?.status === 'running'
                      ? `运行中 (PID ${fsStatus.pid})`
                      : fsStatus?.status === 'error'
                        ? `错误: ${fsStatus.error}`
                        : '未运行'}
                  </p>
                </div>
                <Button
                  variant={fsStatus?.status === 'running' ? 'destructive' : 'outline'}
                  size="sm"
                  onClick={() => void handleToggle('feishu')}
                >
                  {fsStatus?.status === 'running' ? (
                    <><Square className="mr-1 h-3 w-3" /> 停止</>
                  ) : (
                    <><Play className="mr-1 h-3 w-3" /> 启动</>
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* IM Tabs */}
        <Card>
          <div role="tablist" className="flex border-b">
            <button
              type="button"
              role="tab"
              aria-selected={activeIm === 'feishu'}
              onClick={() => setActiveIm('feishu')}
              className={`relative px-4 py-2.5 text-sm font-medium transition-colors ${
                activeIm === 'feishu'
                  ? 'text-foreground after:absolute after:left-3 after:right-3 after:bottom-0 after:h-[2px] after:bg-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              飞书
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeIm === 'telegram'}
              onClick={() => setActiveIm('telegram')}
              className={`relative px-4 py-2.5 text-sm font-medium transition-colors ${
                activeIm === 'telegram'
                  ? 'text-foreground after:absolute after:left-3 after:right-3 after:bottom-0 after:h-[2px] after:bg-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Telegram
            </button>
          </div>

          {activeIm === 'feishu' && (
            <CardContent className="space-y-4 pt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>App ID</Label>
                  <Input value={fsAppId} onChange={(e) => setFsAppId(e.target.value)} placeholder="cli_xxxxxxxx" />
                </div>
                <div className="space-y-2">
                  <Label>App Secret</Label>
                  <Input type="password" value={fsAppSecret} onChange={(e) => setFsAppSecret(e.target.value)} placeholder="****" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Encrypt Key</Label>
                  <Input type="password" value={fsEncryptKey} onChange={(e) => setFsEncryptKey(e.target.value)} placeholder="****" />
                </div>
                <div className="space-y-2">
                  <Label>Verification Token</Label>
                  <Input type="password" value={fsVerificationToken} onChange={(e) => setFsVerificationToken(e.target.value)} placeholder="****" />
                </div>
              </div>
              <div className="space-y-2">
                <Label>允许的用户 ID</Label>
                <Input value={fsAllowedUsers} onChange={(e) => setFsAllowedUsers(e.target.value)} placeholder="ou_xxx, ou_yyy（逗号分隔，留空允许所有人）" />
              </div>
              <label className="flex items-center gap-3 cursor-pointer">
                <input type="checkbox" checked={fsStreamingCard} onChange={(e) => setFsStreamingCard(e.target.checked)} className="h-4 w-4 rounded border-border accent-primary" />
                <div>
                  <span className="text-sm font-medium">流式卡片</span>
                  <p className="text-xs text-muted-foreground">开启后飞书消息流式更新</p>
                </div>
              </label>
            </CardContent>
          )}

          {activeIm === 'telegram' && (
            <CardContent className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label>Bot Token</Label>
                <Input type="password" value={tgBotToken} onChange={(e) => setTgBotToken(e.target.value)} placeholder="123456:ABC-DEF..." className="font-mono text-xs" />
              </div>
              <div className="space-y-2">
                <Label>允许的用户 ID</Label>
                <Input value={tgAllowedUsers} onChange={(e) => setTgAllowedUsers(e.target.value)} placeholder="123456789, 987654321（逗号分隔，留空允许所有人）" />
              </div>
            </CardContent>
          )}
        </Card>

        {/* Save */}
        <div className="flex items-center gap-3">
          <Button onClick={() => void handleSave()} disabled={isSaving}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isSaving ? '保存中…' : '保存配置'}
          </Button>
          <p className="text-xs text-muted-foreground">保存后需点击上方「启动」按钮启动 Bot 进程</p>
        </div>
      </div>
    </DashboardLayout>
  )
}
