import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { getMossMemberAccess, setMossMemberAccess, type MossMemberAccess } from '@/lib/api/moss-member-access'

/** One mounted dialog is scoped to one member and selected organization. */
export function MossMemberAccessDialog({ orgId, userId, userName, onClose }: IMossMemberAccessDialogProps) {
  const [access, setAccess] = useState<MossMemberAccess | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [reload, setReload] = useState(0)
  const lifetime = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    setAccess(null)
    setError(null)
    void getMossMemberAccess(userId, controller.signal).then(result => {
      if (controller.signal.aborted) return
      if (result.orgId !== orgId || result.userId !== userId) throw new Error('组织或成员已变化，请重新打开。')
      setAccess(result)
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '读取 Moss 使用权失败。')
    })
    return () => controller.abort()
  }, [orgId, userId, reload])

  async function onToggleAccess() {
    const controller = lifetime.current
    if (!access || !controller || controller.signal.aborted || isSubmitting) return
    setIsSubmitting(true)
    setError(null)
    try {
      const result = await setMossMemberAccess(userId, !access.isGranted, controller.signal)
      if (controller.signal.aborted) return
      if (result.orgId !== orgId || result.userId !== userId) throw new Error('组织或成员已变化，请重新打开。')
      setAccess(result)
    } catch (reason) {
      if (!controller.signal.aborted) {
        // The request may have committed before a connection failed. Require
        // a fresh read before offering another mutation.
        setAccess(null)
        setError(reason instanceof Error ? reason.message : '更新结果尚未确认，请重新读取。')
      }
    } finally {
      if (!controller.signal.aborted) setIsSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={isOpen => { if (!isOpen && !isSubmitting) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Moss 使用权</DialogTitle>
          <DialogDescription>管理 {userName} 在当前企业的 Moss 使用权。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm" aria-live="polite">
          {access ? <>
            <p>当前状态：{access.isEnabled ? '可使用 Moss' : '不可使用 Moss'}</p>
            <p className="text-muted-foreground">
              {access.source === 'role'
                ? access.isGranted ? '企业管理员默认有使用权。' : '普通成员需要管理员授权。'
                : access.isGranted ? '管理员已明确授予使用权。' : '管理员已明确撤销使用权。'}
              {access.memberStatus !== 'active' ? ' 该成员尚未启用，授权也不会启用账户。' : ''}
            </p>
          </> : !error ? <p className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" />正在读取使用权…</p> : null}
          <p className="text-muted-foreground">撤销后会保留 Agent 和会话历史，并阻止继续执行。此授权不会增加数据访问权限。</p>
          {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={isSubmitting} onClick={onClose}>关闭</Button>
          {access ? <Button variant={access.isGranted ? 'destructive' : 'default'} disabled={isSubmitting} onClick={() => void onToggleAccess()}>
            {isSubmitting ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            {access.isGranted ? '撤销使用权' : '授予使用权'}
          </Button> : error ? <Button onClick={() => setReload(value => value + 1)}>重新读取</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface IMossMemberAccessDialogProps {
  orgId: string
  userId: string
  userName: string
  onClose: () => void
}
