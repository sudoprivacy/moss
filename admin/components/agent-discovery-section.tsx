'use client'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  createInventoryApi,
  type InventoryAccess,
  type DiscoveredAsset,
  type DiscoverySource,
  type DiscoveryResult,
} from '@/lib/api/agent-inventory'
import { inventoryError } from '@/lib/agent-inventory-labels'

export function AgentDiscoverySection({
  api,
  access,
  onChange,
}: {
  api: ReturnType<typeof createInventoryApi>
  access: InventoryAccess
  onChange: () => Promise<void>
}) {
  const [sources, setSources] = useState<DiscoverySource[]>([])
  const [origins, setOrigins] = useState<string[]>([])
  const [canStore, setCanStore] = useState(false)
  const [items, setItems] = useState<DiscoveredAsset[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [results, setResults] = useState<DiscoveryResult[]>([])
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({
    name: '',
    kind: 'dify' as DiscoverySource['kind'],
    origin: '',
    scope: '',
    external_domain: false,
    api_key: '',
    csrf_token: '',
  })
  const load = useCallback(async () => {
    const [page, connections] = await Promise.all([
      api.discovered(),
      access.can_manage ? api.sources() : Promise.resolve(null),
    ])
    setItems(page.items)
    setCursor(page.next_cursor)
    if (connections) {
      setSources(connections.items)
      setOrigins(connections.allowed_origins)
      setCanStore(connections.credentials_available)
    }
  }, [api, access.can_manage])
  useEffect(() => {
    void load().catch((cause) => {
      if (cause?.name !== 'AbortError') setError(inventoryError(cause))
    })
  }, [load])
  const run = async (work: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await work()
    } catch (cause) {
      if ((cause as Error)?.name !== 'AbortError') setError(inventoryError(cause))
    } finally {
      setBusy(false)
    }
  }
  const scan = async (id: string) =>
    run(async () => {
      const result = await api.discover(id)
      setResults((previous) => [result, ...previous.filter((row) => row.source_id !== id)])
      await Promise.all([load(), onChange()])
    })
  return (
    <section aria-label="智能体发现与认领" className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">发现与认领</h3>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(load)}>
            刷新待认领
          </Button>
          {access.can_manage && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setAdding(!adding)
                setForm({ ...form, api_key: '', csrf_token: '' })
              }}
            >
              添加发现来源
            </Button>
          )}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        发现项只建立 L0 台账。认领后请补充业务用途、数据与工具信息并提交审核；不会自动开放调用权限。
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {access.can_manage && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void scan('catalog')}>
              扫描 Moss 目录
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void scan('im')}>
              扫描已连接 IM Bot
            </Button>
          </div>
          {sources.map((source) => (
            <div key={source.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span>
                {source.name} · {source.kind} · {source.origin} · {source.scope}
                {source.external_domain ? ' · 域外' : ''}
                {!source.enabled ? ' · 已停用' : ''}
              </span>
              <Button size="sm" variant="ghost" disabled={busy || !source.enabled} onClick={() => void scan(source.id)}>
                扫描
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !source.enabled}
                onClick={() =>
                  void run(async () => {
                    await api.disableSource(source.id)
                    await load()
                  })
                }
              >
                停用来源
              </Button>
            </div>
          ))}
          {adding && (
            <form
              aria-label="添加发现来源"
              className="space-y-3 rounded-md bg-muted/40 p-3"
              onSubmit={(event) => {
                event.preventDefault()
                void run(async () => {
                  await api.createSource({ ...form, csrf_token: form.kind === 'dify' ? form.csrf_token : undefined })
                  setForm({ ...form, name: '', api_key: '', csrf_token: '' })
                  setAdding(false)
                  await load()
                  setNotice('发现来源已保存，凭据已存入密钥库。点击扫描读取应用清单。')
                })
              }}
            >
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <Label htmlFor="discovery-name">来源名称</Label>
                  <Input
                    id="discovery-name"
                    required
                    maxLength={200}
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="discovery-kind">来源类型</Label>
                  <select
                    id="discovery-kind"
                    className="h-9 w-full rounded-md border bg-background px-2"
                    value={form.kind}
                    onChange={(e) => setForm({ ...form, kind: e.target.value as DiscoverySource['kind'] })}
                  >
                    <option value="dify">Dify 工作区</option>
                    <option value="router">SudoRouter 调用记录</option>
                    <option value="platform">平台清单接口</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="discovery-origin">已批准的服务地址</Label>
                  <select
                    id="discovery-origin"
                    required
                    className="h-9 w-full rounded-md border bg-background px-2"
                    value={form.origin}
                    onChange={(e) => setForm({ ...form, origin: e.target.value })}
                  >
                    <option value="">选择服务地址</option>
                    {origins.map((origin) => (
                      <option key={origin}>{origin}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="discovery-scope">
                    {form.kind === 'dify' ? 'Dify 工作区 ID' : form.kind === 'router' ? 'Router 账户 ID' : '平台 scope'}
                  </Label>
                  <Input
                    id="discovery-scope"
                    required
                    maxLength={150}
                    value={form.scope}
                    onChange={(e) => setForm({ ...form, scope: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="discovery-token">
                    {form.kind === 'dify' ? 'Dify 控制台访问令牌（非应用 API Key）' : '来源 API 访问令牌'}
                  </Label>
                  <Input
                    id="discovery-token"
                    type="password"
                    autoComplete="off"
                    required
                    value={form.api_key}
                    onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                  />
                </div>
                {form.kind === 'dify' && (
                  <div>
                    <Label htmlFor="discovery-csrf">Dify CSRF Token（控制台 Cookie 中的 csrf_token）</Label>
                    <Input
                      id="discovery-csrf"
                      type="password"
                      autoComplete="off"
                      value={form.csrf_token}
                      onChange={(e) => setForm({ ...form, csrf_token: e.target.value })}
                    />
                  </div>
                )}
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.external_domain}
                    onChange={(e) => setForm({ ...form, external_domain: e.target.checked })}
                  />
                  公有 SaaS／域外来源（仅登记）
                </label>
              </div>
              {form.kind === 'dify' && (
                <p className="text-sm text-muted-foreground">
                  Dify 1.14 控制台需要同次登录的 access_token 与
                  csrf_token。工作区必须匹配；登录过期后请更新来源凭据，不会自动切换工作区。
                </p>
              )}
              {!origins.length && (
                <p className="text-sm">尚未批准可连接的来源地址，请由部署管理员配置当前组织的发现服务地址。</p>
              )}
              {!canStore && <p className="text-sm">密钥库尚未连接，暂不能添加来源。</p>}
              <Button type="submit" disabled={busy || !canStore || !origins.length}>
                保存来源
              </Button>
            </form>
          )}
          {results.map((result) => (
            <div key={result.source_id} role="status" className="rounded-md border p-2 text-sm">
              <p>
                {result.complete ? '扫描完成' : '扫描未完成'}：已处理 {result.scanned}，新增 {result.created}，更新{' '}
                {result.updated}，未变化 {result.unchanged}。
              </p>
              <p className="text-muted-foreground">{result.boundary}</p>
              {result.error && (
                <p className="text-destructive">
                  {inventoryError(new Error(result.error))}。已写入的发现证据保留，可修复来源后重新扫描。
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      {!items.length ? (
        <p className="text-sm text-muted-foreground">当前页没有待认领项。</p>
      ) : (
        <ul className="divide-y">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-2 py-2 text-sm">
              <span>
                {item.name} · {item.platform}
                {item.external_domain ? ' · 域外风险' : ''}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !access.can_own}
                onClick={() =>
                  void run(async () => {
                    await api.command({
                      kind: 'ClaimAsset',
                      asset_id: item.id,
                      expected_revision: item.revision,
                      request_id: crypto.randomUUID(),
                    })
                    await Promise.all([load(), onChange()])
                    setNotice('已认领，请在台账中补充信息并提交审核。')
                  })
                }
              >
                认领
              </Button>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const page = await api.discovered(cursor)
              setItems((previous) => [...previous, ...page.items])
              setCursor(page.next_cursor)
            })
          }
        >
          加载更多待认领项
        </Button>
      )}
    </section>
  )
}
