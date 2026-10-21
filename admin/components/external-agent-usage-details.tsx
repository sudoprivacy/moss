import type { ExternalAgent } from '../../contracts/external-provider/v1/contract'

const capabilityLabel = { supported: '支持', unsupported: '不支持', unknown: '未确认' }
const reviewLabel = { current: '审核有效期内', expired: '审核已到期', not_approved: '未批准或已失效' }

export function ExternalAgentUsageDetails({ agent }: { agent: ExternalAgent }) {
  const usage = agent.usage
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground">能力与使用范围</summary>
      {usage ? (
        <div className="mt-2 space-y-2 text-xs text-muted-foreground">
          <p>对话仅接受合成测试文本，不接受附件、资源引用或用户指定的工具。智能体自身的工具权限需单独审核。</p>
          <p>数据类型由调用方声明，尚未进行内容识别。请勿提交真实业务或敏感数据。</p>
          <dl className="grid grid-cols-2 gap-2">
            <dt>流式回复</dt><dd>{capabilityLabel[agent.capabilities.streaming]}</dd>
            <dt>取消远端任务</dt><dd>{capabilityLabel[agent.capabilities.cancel]}</dd>
            <dt>查询恢复</dt><dd>{capabilityLabel[agent.capabilities.resume]}</dd>
            <dt>固定执行版本</dt><dd>{capabilityLabel[agent.capabilities.version_pin]}</dd>
            <dt>审核状态（生成信息时）</dt><dd>{reviewLabel[usage.review_state]}</dd>
            <dt>本次配置审核时间</dt><dd>{usage.reviewed_at === null ? '未记录' : new Date(usage.reviewed_at).toLocaleString()}</dd>
            <dt>信息生成时间</dt><dd>{new Date(usage.evaluated_at).toLocaleString()}</dd>
          </dl>
          <p>能力依据为当前适配器契约，不代表实时连接状态或某次运行的执行证明。提交任务时会重新检查准入。</p>
          <p>来源身份尚未验证；源码摘要只证明审核快照。查询恢复只查询同一远端运行，不会自动重新执行未知任务。</p>
        </div>
      ) : <p className="mt-2 text-xs text-muted-foreground">服务未提供使用范围信息，请刷新或联系管理员确认。</p>}
    </details>
  )
}
