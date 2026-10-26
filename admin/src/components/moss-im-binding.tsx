import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { bindMossIm, getMossImBindings, unlinkMossIm, type MossImBinding } from '@/lib/api/moss-im'

export function MossImBindingPanel() {
  const [bindings, setBindings] = useState<MossImBinding[] | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const lifetime = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    setBindings(null)
    void getMossImBindings(controller.signal).then(result => {
      if (!controller.signal.aborted) { setBindings(result.bindings); setError(null) }
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '读取绑定失败。') })
    return () => controller.abort()
  }, [revision])

  async function onChangeBinding(bindingId?: string) {
    const controller = lifetime.current
    if (!controller || controller.signal.aborted || isBusy) return
    const proof = code.trim()
    setCode('')
    setIsBusy(true)
    setError(null)
    try {
      if (bindingId) await unlinkMossIm(bindingId)
      else await bindMossIm(proof, controller.signal)
      if (!controller.signal.aborted) setRevision(value => value + 1)
    } catch (reason) {
      if (!controller.signal.aborted) {
        setBindings(null)
        setError(reason instanceof Error ? reason.message : '结果未确认，请重新读取绑定。')
      }
    } finally { if (!controller.signal.aborted) setIsBusy(false) }
  }

  return <section className="space-y-3 rounded-lg border p-4" aria-label="飞书绑定">
    <h2 className="font-medium">飞书绑定</h2>
    <p className="text-sm text-muted-foreground">先在飞书中向 Moss 发消息，再把 Moss 私聊给你的验证码填在这里。绑定后使用你自己的 Agent、权限和模型账户；同群成员的会话分别保存。</p>
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    {bindings === null ? <Button variant="outline" disabled={isBusy} onClick={() => setRevision(value => value + 1)}>重新读取绑定</Button> : <>
      <div className="flex flex-wrap gap-2">
        <Input className="min-w-0 flex-1" type="password" autoComplete="off" aria-label="飞书私聊验证码" placeholder="10 分钟内的一次性验证码" value={code} onChange={event => setCode(event.target.value)} disabled={isBusy} />
        <Button disabled={isBusy || !/^[A-Za-z0-9_-]{32}$/.test(code.trim())} onClick={() => void onChangeBinding()}>绑定本人飞书</Button>
      </div>
      {bindings.map(binding => <div key={binding.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p>飞书 {binding.senderId} · {binding.isCurrent ? '绑定有效' : '连接已变化或不可用'}</p>
        <Button variant="outline" size="sm" disabled={isBusy} onClick={() => void onChangeBinding(binding.id)}>解除绑定</Button>
      </div>)}
      {!bindings.length ? <p className="text-sm text-muted-foreground">尚未绑定飞书。</p> : null}
    </>}
    <p className="text-sm text-muted-foreground">飞书中可用 /new 新建会话、/resume &lt;会话 ID&gt; 接续自己的会话。解除绑定会停止从该飞书身份继续执行，并保留 Agent 和历史。</p>
  </section>
}
