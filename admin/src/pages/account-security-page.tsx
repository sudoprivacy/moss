import { useState } from 'react'
import { toast } from 'sonner'
import { LockKeyhole, Loader2 } from 'lucide-react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { changeOwnPassword } from '@/lib/api/auth'

export default function AccountSecurityPage() {
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [saving, setSaving] = useState(false)
  return <DashboardLayout title="账户安全" description="管理自己的登录密码">
    <Card className="max-w-xl"><CardHeader><CardTitle className="flex items-center gap-2"><LockKeyhole className="size-5" />修改密码</CardTitle><CardDescription>Moss 和 Sudowork 的密码登录共用此密码。修改不会影响短信或 CAS 登录。</CardDescription></CardHeader><CardContent>
      <form className="space-y-5" onSubmit={async event => {
        event.preventDefault()
        if (saving) return
        if (newPassword !== confirmation) { toast.error('两次新密码不一致'); return }
        setSaving(true)
        try { await changeOwnPassword(oldPassword, newPassword); setOldPassword(''); setNewPassword(''); setConfirmation(''); toast.success('密码已修改，请在下次登录时使用新密码') }
        catch (e) { toast.error(e instanceof Error ? e.message : '修改失败') }
        finally { setSaving(false) }
      }}>
        <div className="space-y-2"><Label htmlFor="current-password">当前密码</Label><Input id="current-password" type="password" autoComplete="current-password" required value={oldPassword} onChange={e => setOldPassword(e.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor="new-password">新密码</Label><Input id="new-password" type="password" autoComplete="new-password" required minLength={8} maxLength={20} value={newPassword} onChange={e => setNewPassword(e.target.value)} /><p className="text-xs text-muted-foreground">8–20 位，包含大写字母、小写字母和数字。</p></div>
        <div className="space-y-2"><Label htmlFor="confirm-password">确认新密码</Label><Input id="confirm-password" type="password" autoComplete="new-password" required value={confirmation} onChange={e => setConfirmation(e.target.value)} /></div>
        <Button disabled={saving} type="submit">{saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}保存新密码</Button>
      </form>
    </CardContent></Card>
  </DashboardLayout>
}
