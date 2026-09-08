'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { operationsApi } from '@/lib/api/operations'
import type { AuthUser } from '@/lib/api/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { parsePositiveIntegerPoints, type UserOperation } from '../user-operations'

type LedgerEntry = {
  id: number
  amount: number
  type: string
  memo?: string | null
  timestamp: string
}

export function UserOperationsDialogs({
  target,
  operation,
  onClose,
  onChanged,
}: {
  target: AuthUser | null
  operation: UserOperation | null
  onClose(): void
  onChanged(): Promise<void> | void
}) {
  const [points, setPoints] = useState('')
  const [reason, setReason] = useState('')
  const [paymentReference, setPaymentReference] = useState('')
  const [adjustment, setAdjustment] = useState<'add' | 'subtract'>('add')
  const [syncSudorouter, setSyncSudorouter] = useState(true)
  const [ledger, setLedger] = useState<LedgerEntry[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setPoints('')
    setReason('')
    setPaymentReference('')
    setAdjustment('add')
    setSyncSudorouter(true)
    setLedger([])
    if (!target || operation !== 'ledger' || !target.legacyId) return
    const ledgerUserId = target.legacyId
    setLoading(true)
    operationsApi.listUserLedger(ledgerUserId, 100)
      .then(response => setLedger(response.data as LedgerEntry[]))
      .catch(error => toast.error(error instanceof Error ? error.message : '获取账本失败'))
      .finally(() => setLoading(false))
  }, [operation, target])

  if (!target || !operation) return null
  if (!target.legacyId) return null
  const legacyUserId = target.legacyId

  const finish = async (message: string) => {
    toast.success(message)
    onClose()
    await onChanged()
  }

  const submit = async () => {
    setLoading(true)
    try {
      if (operation === 'approve') {
        await operationsApi.approvePendingUser(legacyUserId)
        await finish('用户已审批通过')
      } else if (operation === 'reject') {
        await operationsApi.rejectPendingUser(legacyUserId)
        await finish('用户申请已拒绝')
      } else if (operation === 'delete_pending') {
        await operationsApi.deletePendingUser(legacyUserId)
        await finish('待审批用户已删除')
      } else if (operation === 'sync_quota') {
        await operationsApi.syncUserQuota(legacyUserId)
        await finish('Sudorouter 额度已同步')
      } else if (operation === 'recharge') {
        const value = parsePositiveIntegerPoints(points)
        if (!reason.trim()) throw new Error('请输入充值原因')
        await operationsApi.rechargeUser(legacyUserId, {
          points: value,
          reason: reason.trim(),
          paymentReference: paymentReference.trim() || undefined,
        })
        await finish('后台充值成功')
      } else if (operation === 'adjust') {
        const value = parsePositiveIntegerPoints(points)
        await operationsApi.adjustUserPoints(legacyUserId, {
          amount: value,
          operation: adjustment,
          reason: reason.trim() || undefined,
          syncSudorouter,
        })
        await finish('积分调整成功')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败')
    } finally {
      setLoading(false)
    }
  }

  const title = operation === 'recharge' ? '后台充值'
    : operation === 'adjust' ? '积分调整'
      : operation === 'ledger' ? '用户账本'
        : operation === 'sync_quota' ? '同步用户额度'
          : operation === 'approve' ? '审批用户'
            : operation === 'reject' ? '拒绝用户申请'
              : '删除待审批用户'
  const confirmMessage = operation === 'approve' ? '确认通过该用户的注册申请？'
    : operation === 'reject' ? '确认拒绝该用户的注册申请？'
      : operation === 'delete_pending' ? '确认永久删除该待审批用户？'
        : operation === 'sync_quota' ? '从 Sudorouter 拉取并更新该用户的额度快照？'
          : null

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className={operation === 'ledger' ? 'sm:max-w-3xl' : undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{target.displayName || target.name}，旧用户 ID #{target.legacyId}</DialogDescription>
        </DialogHeader>

        {confirmMessage ? <p className="text-sm">{confirmMessage}</p> : null}

        {operation === 'recharge' || operation === 'adjust' ? (
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="user-operation-points">积分数量</Label>
              <Input id="user-operation-points" inputMode="numeric" value={points} onChange={event => setPoints(event.target.value)} placeholder="请输入正整数" />
            </div>
            {operation === 'adjust' ? (
              <div className="grid gap-2">
                <Label>操作</Label>
                <Select value={adjustment} onValueChange={value => setAdjustment(value as 'add' | 'subtract')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="add">增加积分</SelectItem><SelectItem value="subtract">扣减积分</SelectItem></SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="grid gap-2">
              <Label htmlFor="user-operation-reason">原因</Label>
              <Input id="user-operation-reason" value={reason} onChange={event => setReason(event.target.value)} placeholder={operation === 'recharge' ? '必填，例如：线下支付' : '选填'} />
            </div>
            {operation === 'recharge' ? (
              <div className="grid gap-2">
                <Label htmlFor="user-operation-reference">支付参考号</Label>
                <Input id="user-operation-reference" value={paymentReference} onChange={event => setPaymentReference(event.target.value)} placeholder="选填" />
              </div>
            ) : (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={syncSudorouter} onChange={event => setSyncSudorouter(event.target.checked)} />
                同步 Sudorouter 额度
              </label>
            )}
          </div>
        ) : null}

        {operation === 'ledger' ? (
          <div className="max-h-[55vh] overflow-auto rounded-md border">
            <Table>
              <TableHeader><TableRow><TableHead>时间</TableHead><TableHead>类型</TableHead><TableHead>变动</TableHead><TableHead>备注</TableHead></TableRow></TableHeader>
              <TableBody>
                {ledger.map(entry => <TableRow key={entry.id}><TableCell className="whitespace-nowrap">{new Date(entry.timestamp).toLocaleString('zh-CN')}</TableCell><TableCell>{entry.type}</TableCell><TableCell className={entry.amount < 0 ? 'text-destructive' : 'text-emerald-600'}>{entry.amount > 0 ? '+' : ''}{entry.amount}</TableCell><TableCell>{entry.memo || '-'}</TableCell></TableRow>)}
                {!loading && ledger.length === 0 ? <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">暂无账本记录</TableCell></TableRow> : null}
              </TableBody>
            </Table>
            {loading ? <div className="flex justify-center py-8"><Loader2 className="size-5 animate-spin" /></div> : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>关闭</Button>
          {operation !== 'ledger' ? <Button disabled={loading} onClick={() => void submit()}>{loading ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}确认</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
