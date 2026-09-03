'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  getServerCredentials,
  updateServerCredential,
  type ServerCredentialGroup,
  type ServerCredentialItem,
} from '@/lib/api/server-credentials'
import { KeyRound, Loader2, RefreshCw, ShieldAlert, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'

/** 字段路径 → 中文标签（仅展示用，不影响提交的 key）。 */
const FIELD_LABELS: Record<string, string> = {
  'hub.authorization': 'Hub 授权',
  'wikiIndex.resourceTokenSecret': '资源令牌 HMAC 密钥',
  'cabin.tokenSecret': '客舱令牌 HMAC 密钥',
  'cabin.passengerInfoAuth': '乘客信息接口鉴权',
  'cabin.asrApiKey': 'ASR API Key',
  'cabin.ttsApiKey': 'TTS API Key',
  'cabin.llmApiKey': 'LLM API Key',
  'cabin.controlAuth': '控制接口鉴权',
  'cabin.broadcastApiKey': '广播 API Key',
  'cabin.broadcastAuth': '广播鉴权',
}

const GROUP_META: Record<
  ServerCredentialGroup,
  { title: string; description: string }
> = {
  hub: {
    title: 'Hub 授权',
    description: '服务端访问 Hub 的授权凭据（server.json 的 hub.authorization）。',
  },
  wikiIndex: {
    title: '资源令牌密钥',
    description:
      '文档/资源 URL 的 HMAC 签名密钥（server.json 的 wikiIndex.resourceTokenSecret）。',
  },
  cabin: {
    title: '客舱服务凭据',
    description: '客舱 AI 相关的服务鉴权与 API Key（server.json 的 cabin.*）。',
  },
}

const GROUP_ORDER: ServerCredentialGroup[] = ['hub', 'wikiIndex', 'cabin']

/**
 * 清空后会回落公开 dev 常量、导致已签发资源 URL 失效且可被伪造的 HMAC 密钥字段。
 * 与计划一致：仅这两个字段在清空时给出后果警示。
 */
const HMAC_SECRET_PATHS = new Set([
  'wikiIndex.resourceTokenSecret',
  'cabin.tokenSecret',
])

function CredentialRow({
  item,
  onSaved,
}: {
  item: ServerCredentialItem
  onSaved: () => void
}) {
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const label = FIELD_LABELS[item.path] ?? item.path
  const isHmacSecret = HMAC_SECRET_PATHS.has(item.path)

  // 提交契约：脱敏占位（**** 开头）视为未修改，禁止提交覆盖真实凭据
  const isPlaceholder = value.trim().startsWith('****')
  const canSave = value.trim().length > 0 && !isPlaceholder && !saving

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    try {
      const res = await updateServerCredential(item.key, value.trim())
      if (res.ignored) {
        toast.warning(`${label}：提交值与脱敏占位相同，已忽略`)
      } else {
        toast.success(`${label} 已保存并即时生效`)
        setValue('')
        onSaved()
      }
    } catch (error) {
      toast.error(
        `保存 ${label} 失败：${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async () => {
    if (saving) return
    const warning = isHmacSecret
      ? `确认清空「${label}」？清空后该 HMAC 密钥将回落公开 dev 常量，已签发的资源 URL 会失效且可被伪造。`
      : `确认清空「${label}」？`
    if (!window.confirm(warning)) return
    setSaving(true)
    try {
      await updateServerCredential(item.key, '')
      toast.success(`${label} 已清空并即时生效`)
      setValue('')
      onSaved()
    } catch (error) {
      toast.error(
        `清空 ${label} 失败：${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2 border-b pb-4 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="font-mono text-xs text-muted-foreground">{item.path}</span>
        <Badge variant={item.set ? 'secondary' : 'outline'}>
          {item.set ? `已设置 ${item.masked ?? ''}` : '未设置'}
        </Badge>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          type="password"
          value={value}
          className="font-mono text-xs"
          placeholder={item.set ? '输入新值以覆盖（留空不修改）' : '未设置，输入值以录入'}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button
          size="sm"
          className="sm:shrink-0"
          disabled={!canSave}
          onClick={() => void handleSave()}
        >
          {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
          保存
        </Button>
        {item.set ? (
          <Button
            variant="outline"
            size="sm"
            className="sm:shrink-0"
            disabled={saving}
            onClick={() => void handleClear()}
          >
            清空
          </Button>
        ) : null}
      </div>
      {isHmacSecret ? (
        <p className="flex items-center gap-1.5 text-xs text-destructive">
          <ShieldAlert className="size-3.5 shrink-0" />
          清空后回落公开 dev 常量，已签发资源 URL 将失效且可被伪造。
        </p>
      ) : null}
    </div>
  )
}

export default function ServerCredentialsPage() {
  const [items, setItems] = useState<ServerCredentialItem[] | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setIsLoading(true)
    setLoadError(null)
    try {
      const res = await getServerCredentials()
      setItems(res.items)
    } catch (error) {
      setItems(null)
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const grouped = useMemo(() => {
    const map = new Map<ServerCredentialGroup, ServerCredentialItem[]>()
    for (const item of items ?? []) {
      const list = map.get(item.group) ?? []
      list.push(item)
      map.set(item.group, list)
    }
    return map
  }, [items])

  return (
    <DashboardLayout
      title="服务器凭据"
      description="管理 server.json 侧的敏感凭据（存储于 Nexus，不再明文落盘）。保存后即时生效。"
    >
      <div className="space-y-6">
        <div className="flex justify-end">
          <Button
            variant="outline"
            onClick={() => void load()}
            disabled={isLoading}
          >
            <RefreshCw className="mr-2 size-4" />
            刷新
          </Button>
        </div>

        {isLoading && !items ? (
          <div className="space-y-4">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : loadError ? (
          <Alert variant="destructive">
            <TriangleAlert className="size-4" />
            <AlertTitle>读取服务器凭据失败</AlertTitle>
            <AlertDescription>
              <p>{loadError}</p>
            </AlertDescription>
          </Alert>
        ) : (
          GROUP_ORDER.map((group) => {
            const groupItems = grouped.get(group)
            if (!groupItems || groupItems.length === 0) return null
            const meta = GROUP_META[group]
            return (
              <Card key={group}>
                <CardHeader className="border-b">
                  <div className="flex items-center gap-2">
                    <KeyRound className="size-4 text-muted-foreground" />
                    <div>
                      <CardTitle>{meta.title}</CardTitle>
                      <CardDescription>{meta.description}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4 pt-6">
                  {groupItems.map((item) => (
                    <CredentialRow key={item.key} item={item} onSaved={() => void load()} />
                  ))}
                </CardContent>
              </Card>
            )
          })
        )}
      </div>
    </DashboardLayout>
  )
}
