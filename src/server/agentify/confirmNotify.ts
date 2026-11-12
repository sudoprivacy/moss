/**
 * Notices for tasks that wait for a person's confirmation, sent through a
 * corp app that can send messages (today: a WeCom 自建应用).
 *
 * When a task starts waiting, every confirmer of the target agent who has an
 * account configured gets a short message with the task number and a
 * link to its approval page in moss admin. When any confirmer (or an
 * administrator) decides, all of them are told who decided. The notice holds
 * no task content: the approval page shows that after login, to people
 * allowed to decide.
 */
import type { ConfirmNotifyConfig } from './config.js'

export interface NoticeResult {
  ok: boolean
  /** Accounts the message could not be delivered to. */
  invalid: string[]
  error?: string
}

export interface ConfirmNotifier {
  /** null when this corp app can send notices for the organization; otherwise why not. */
  checkCorpApp(orgId: string, corpAppId: string): string | null
  /** Send `text` to each account; `ok` = it reached at least one. */
  send(input: { orgId: string; corpAppId: string; to: string[]; text: string }): Promise<NoticeResult>
  /** Approval page of one task; null when no public address of moss is configured. */
  approvalLink(callId: string): string | null
}

/** The task number people see: the first 8 characters of the call id. */
export function taskNumber(callId: string): string {
  return callId.slice(0, 8)
}

/** Accounts to notify: configured confirmers, each once. */
export function noticeRecipients(confirmers: string[], notify: ConfirmNotifyConfig | undefined): string[] {
  if (!notify) return []
  const out: string[] = []
  for (const userId of confirmers) {
    const account = notify.accountIds[userId]
    if (account && !out.includes(account)) out.push(account)
  }
  return out
}

export function pendingNoticeText(input: { callerName: string; targetName: string; callId: string; link: string | null }): string {
  return [
    '【协作任务待确认】',
    `${input.callerName} → ${input.targetName} 的协作任务需要您确认`,
    `任务编号：${taskNumber(input.callId)}`,
    input.link ? `查看并确认：${input.link}` : '请登录 moss 管理端，在「待确认任务」中处理。',
  ].join('\n')
}

export function decidedNoticeText(input: { callerName: string; targetName: string; callId: string; approved: boolean; byName: string }): string {
  const verb = input.approved ? '确认' : '拒绝'
  return [
    `【协作任务已${verb}】`,
    `任务编号 ${taskNumber(input.callId)}（${input.callerName} → ${input.targetName}）已由 ${input.byName} ${verb}。`,
  ].join('\n')
}

export function testNoticeText(input: { targetName: string }): string {
  return `【测试通知】这是智能体「${input.targetName}」的任务确认通知测试。收到此消息说明您会收到该智能体待确认任务的提醒。`
}

/** `<publicBaseUrl>/admin/agentify/confirmations/<callId>`, or null without a base URL. */
export function approvalLinkFor(publicBaseUrl: string | null | undefined, callId: string): string | null {
  const base = (publicBaseUrl ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) return null
  return `${base}/admin/agentify/confirmations/${encodeURIComponent(callId)}`
}
