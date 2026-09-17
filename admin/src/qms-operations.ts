export const QMS_OPERATION_TABS = [
  'overview', 'conversations', 'installs', 'performance', 'users', 'crashes', 'alerts', 'system',
] as const

export type QmsOperationTab = typeof QMS_OPERATION_TABS[number]

export function crashIssueActions(status: string): Array<'detail' | 'resolve' | 'ignore'> {
  return status === 'unresolved' ? ['detail', 'resolve', 'ignore'] : ['detail']
}
