import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'

type Preview = { currentVersion: string | null; nextVersion: string; publishNote: string }
export function PublicationSubmitButton({ loadPreview, onSubmit, disabled }: { loadPreview: () => Promise<Preview>; onSubmit: (version: string, note: string) => Promise<void>; disabled?: boolean }) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [version, setVersion] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const validVersion = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(version)
  return <>
    <Button size="sm" disabled={disabled || busy} onClick={async () => {
      setBusy(true)
      try { const data = await loadPreview(); setPreview(data); setVersion(data.nextVersion); setNote(data.publishNote || ''); setError('') }
      catch (cause) { toast.error(cause instanceof Error ? cause.message : '读取发布版本失败') }
      finally { setBusy(false) }
    }}>提交审核</Button>
    <Dialog open={preview !== null} onOpenChange={open => { if (!open && !busy) setPreview(null) }}>
      <DialogContent><DialogHeader><DialogTitle>提交版本审核</DialogTitle><DialogDescription>审核通过并正式发布后，其他用户才能看到新版本。已发布版本号不可修改。</DialogDescription></DialogHeader>
        <p className="text-sm text-muted-foreground">当前正式版本：{preview?.currentVersion || '尚未发布'}</p>
        <label className="grid gap-2 text-sm">发布版本号<Input aria-label="发布版本号" value={version} maxLength={29} disabled={busy} onChange={event => setVersion(event.target.value)} placeholder="例如 1.1.0 或 2.0.0" /></label>
        <p className="text-xs text-muted-foreground">已自动建议下一版本，可修改为更高的版本号。</p>
        {!!version && !validVersion && <p role="alert" className="text-sm text-destructive">请输入主版本.次版本.修订号，例如 1.1.0</p>}
        <label className="grid gap-2 text-sm">更新说明<Textarea aria-label="更新说明" value={note} maxLength={2000} rows={4} disabled={busy} onChange={event => setNote(event.target.value)} placeholder="说明本次新增能力、修复和使用上的变化" /></label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setPreview(null)}>取消</Button><Button disabled={busy || !validVersion || !note.trim()} onClick={async () => {
          setBusy(true); setError('')
          try { await onSubmit(version, note.trim()); setPreview(null); toast.success('已提交版本审核') }
          catch (cause) { setError(cause instanceof Error ? cause.message : '提交失败') }
          finally { setBusy(false) }
        }}>{busy ? '提交中…' : '确认提交'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
