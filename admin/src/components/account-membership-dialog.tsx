import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { addOrganizationMember } from '@/lib/api/auth'

/** Link an existing account without moving its other enterprise identities. */
export function AccountMembershipDialog({ onClose, onAdded }: IAccountMembershipDialogProps) {
  const [phone, setPhone] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (isSubmitting) return
    setIsSubmitting(true)
    setError(null)
    try {
      const result = await addOrganizationMember(phone)
      toast.success(result.created ? '已添加为普通成员，可在成员菜单授予 Moss 使用权' : '该账号已是当前企业成员')
      onAdded()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '添加失败，请重试')
    } finally {
      setIsSubmitting(false)
    }
  }

  return <Dialog open onOpenChange={isOpen => { if (!isOpen && !isSubmitting) onClose() }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>添加已有账号</DialogTitle>
        <DialogDescription>
          将已注册账号加入当前企业，保留其在其他企业的身份。新成员默认为普通成员，可再单独授予 Moss 使用权。
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={event => void onSubmit(event)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="membership-phone">账号手机号</Label>
          <Input id="membership-phone" type="tel" autoComplete="tel" value={phone}
            onChange={event => setPhone(event.target.value)} disabled={isSubmitting} required />
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={isSubmitting} onClick={onClose}>取消</Button>
          <Button type="submit" disabled={isSubmitting || !phone.trim()}>
            {isSubmitting ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}添加成员
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

interface IAccountMembershipDialogProps {
  onClose: () => void
  onAdded: () => void
}
