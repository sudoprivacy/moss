export const QMS_OPERATION_TABS = [
  'overview',
  'conversations',
  'installs',
  'performance',
  'users',
  'crashes',
  'alerts',
  'system',
] as const

export type QmsOperationTab = (typeof QMS_OPERATION_TABS)[number]

export function crashIssueActions(status: string): Array<'detail' | 'resolve' | 'ignore'> {
  return status === 'unresolved' ? ['detail', 'resolve', 'ignore'] : ['detail']
}

export function qualityDateRange(start: string, end: string) {
  const first = new Date(`${start}T00:00:00`)
  const last = new Date(`${end}T00:00:00`)
  last.setDate(last.getDate() + 1)
  if (!Number.isFinite(first.getTime()) || !Number.isFinite(last.getTime()) || first >= last)
    throw new Error('请选择有效的起止日期')
  return { start_time: first.getTime(), end_time: last.getTime() }
}

export function qualityConfigValues(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return {}
  return Object.fromEntries(
    value
      .filter((row) => row && typeof row.key === 'string')
      .map((row) => [row.key, String(row.value ?? '')]),
  )
}

export function qualityRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((row) => row && typeof row === 'object')
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['items', 'list', 'rows', 'data'])
      if (Array.isArray(record[key])) return qualityRows(record[key])
  }
  return []
}

export const QUALITY_LABELS: Record<string, string> = {
  queue_mode: '队列类型',
  pending: '等待写入',
  processing: '正在写入',
  bytes: '队列占用（字节）',
  capacity: '最大事件数',
  max_bytes: '最大容量（字节）',
  accepting: '接受新上报',
  consecutive_failures: '连续写入失败次数',
  turns: '轮次',
  steps: '步骤',
  model_usage: '模型使用',
  conversations: '会话',
  installs: '安装',
  errors: '错误',
  performance: '性能',
  crashes: 'Crash',
  total: '总数',
  success: '成功',
  error: '失败',
  failed: '失败',
  user_cancel: '用户取消',
  success_rate: '成功率（%）',
  error_rate: '错误率（%）',
  avg_duration_ms: '平均耗时（ms）',
  avg_tokens: '平均 Token',
  trend: '环比（%）',
  metric: '指标',
  min: '最小值（ms）',
  max: '最大值（ms）',
  avg: '平均值（ms）',
  avg_value: '平均值（ms）',
  p50: 'P50（ms）',
  p90: 'P90（ms）',
  p95: 'P95（ms）',
  p99: 'P99（ms）',
  count: '数量',
  date: '日期',
  platform: '平台',
  arch: '架构',
  version: '版本',
  install_type: '安装类型',
  success_count: '成功数',
  error_count: '错误数',
  failed_count: '失败数',
  user_cancel_count: '取消数',
  total_count: '总数',
  error_code: '错误码',
  last_occurrence: '最近发生',
  user_id: '用户 ID',
  user_nickname: '用户昵称',
  user_phone: '手机号',
  tenant_id: '企业代码',
  org_id: '组织',
  login_mode: '登录模式',
  conversation_count: '会话数',
  turn_count: '轮次数',
  step_count: '步骤数',
  total_tokens: 'Token 总数',
  input_tokens: '输入 Token',
  output_tokens: '输出 Token',
  avg_tokens_per_turn: '每轮平均 Token',
  step_type: '步骤类型',
  total_users: '活跃用户',
  total_conversations: '会话总数',
  total_turns: '轮次总数',
  total_steps: '步骤总数',
  rank: '排名',
  value: '数值',
  type: '类型',
  status: '状态',
  id: 'ID',
  title: '标题',
  level: '级别',
  user_count: '影响用户',
  first_seen: '首次发生',
  last_seen: '最近发生',
  first_release: '首次版本',
  last_release: '最近版本',
  assigned_to: '负责人',
  total_events: 'Crash 事件',
  unresolved_issues: '未解决问题',
  fatal_issues: '致命问题',
  error_issues: '错误问题',
  recent_24h: '近 24 小时',
  recent_7d: '近 7 天',
  key: '名称',
  percentage: '占比（%）',
  timestamp: '时间',
  process_type: '进程',
  error_name: '错误名称',
  error_message: '错误信息',
  stack_trace: '原始堆栈',
  symbolicated_stack: '还原堆栈',
  stack_summary: '堆栈摘要',
  name: '名称',
  threshold: '阈值',
  comparison: '比较方式',
  channels: '通知渠道',
  enabled: '启用',
  cooldown_minutes: '冷却（分钟）',
  description: '说明',
  sent_at: '发送时间',
  acknowledged: '已确认',
  message: '消息',
  uptime: '运行时长（秒）',
  node_version: 'Node 版本',
  last_run: '上次执行',
  next_run: '下次执行',
  running: '执行中',
  last_error: '最近错误',
  table: '数据表',
  label: '名称',
  earliest: '最早数据',
  latest: '最新数据',
  timescaledb_available: 'TimescaleDB 可用',
  using_continuous_aggregates: '连续聚合',
  mode: '聚合模式',
  model_id: '模型',
  code: '错误码',
  location: '来源',
  upstream_component: '所属组件',
  trigger_scenario: '触发场景',
  created_at: '创建时间',
  updated_at: '更新时间',
  period: '统计区间',
  start: '开始',
  end: '结束',
}
