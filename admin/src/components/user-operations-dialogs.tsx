'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { operationsApi } from '@/lib/api/operations'
import type { AuthUser } from '@/lib/api/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ModelMemberDialog, ModelUsageDialog } from './model-account-management'
import type { UserOperation } from '../user-operations'

export function UserOperationsDialogs(props: { target: AuthUser | null; operation: UserOperation | null; onClose(): void; onChanged(): Promise<void> | void }) {
  if (!props.target || !props.operation) return null
  if (props.operation === 'model_usage') return <ModelUsageDialog key={props.target.id} target={props.target} onClose={props.onClose} />
  if (props.operation === 'model_account') return <ModelMemberDialog target={props.target} onClose={props.onClose} onChanged={props.onChanged} />
  return <PendingMemberDialog {...props} target={props.target} operation={props.operation} />
}

function PendingMemberDialog({ target, operation, onClose, onChanged }: { target: AuthUser; operation: Exclude<UserOperation, 'model_account' | 'model_usage'>; onClose(): void; onChanged(): Promise<void> | void }) {
  const [isBusy, setIsBusy] = useState(false)
  const title = operation === 'approve' ? '审批通过' : operation === 'reject' ? '拒绝申请' : '删除待审批用户'
  const onSubmit = async () => {
    if (!target.legacyId) return
    setIsBusy(true)
    try {
      if (operation === 'approve') await operationsApi.approvePendingUser(target.legacyId)
      else if (operation === 'reject') await operationsApi.rejectPendingUser(target.legacyId)
      else await operationsApi.deletePendingUser(target.legacyId)
      toast.success('操作成功'); onClose(); await onChanged()
    } catch (e) { toast.error((e as Error).message) } finally { setIsBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !isBusy) onClose() }}><DialogContent><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{target.displayName || target.name}：{operation === 'approve' ? '审批后使用组织默认成员限额。' : '确认处理此成员申请。'}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={isBusy} onClick={onClose}>取消</Button><Button disabled={isBusy || !target.legacyId} onClick={() => void onSubmit()}>{title}</Button></DialogFooter></DialogContent></Dialog>
}
