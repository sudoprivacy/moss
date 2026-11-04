/**
 * Session summaries for the agent home.
 *
 * Uses the deployment's own model gateway (system settings url / apiKey,
 * Anthropic Messages format, as scode does). Any failure — no key, gateway
 * down, odd response — falls back to an extractive summary so a digest never
 * blocks on the model.
 */

export interface SummaryInput {
  agentDisplayName: string
  conversation: string
  artifacts: string[]
  /** Who started the session and how (cron / web / another agent). */
  origin: string
  /** Input files are kept more privately than summaries: name them, do not copy their content. */
  inputsPrivate?: boolean
  /** Returned when the model cannot be used. */
  fallbackText: string
}

export interface Summarizer {
  summarize(input: SummaryInput): Promise<{ text: string; model: string | null }>
}

export interface ModelGateway {
  url: string
  apiKey: string
  model: string
}

const SYSTEM_PROMPT = `你是企业智能体的工作记录员。根据一次会话的对话记录，写一份简洁的中文工作摘要，供这个智能体以后的会话和其他智能体检索使用。

要求：
- 只写对话中真实出现的信息，不要编造；数字、单号、SKU、日期、人名、文件名照原样保留。
- 使用以下 Markdown 小标题，没有内容的小标题省略：
  ### 任务
  ### 结论
  ### 关键数据
  ### 产出文件
  ### 未完成事项
- 不要写入身份证号、手机号、银行卡号、密码、密钥、令牌等个人或敏感信息；如对话涉及，只写“已提供”。
- 总长度不超过 800 字。`

export function buildSummaryUserPrompt(input: SummaryInput): string {
  const artifacts = input.artifacts.length > 0 ? input.artifacts.map(a => `- ${a}`).join('\n') : '（无）'
  const note = input.inputsPrivate
    ? '\n注意：员工提供的输入文件只有提供者本人能看到。摘要中输入文件只写文件名和用途，不要摘抄其中的明细数据。\n'
    : ''
  return `智能体：${input.agentDisplayName}\n会话来源：${input.origin}\n${note}\n产出文件：\n${artifacts}\n\n对话记录：\n\n${input.conversation}`
}

function messagesUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? `${trimmed}/messages` : `${trimmed}/v1/messages`
}

export class ModelSummarizer implements Summarizer {
  constructor(
    private readonly gateway: () => ModelGateway | null,
    private readonly timeoutMs = 60_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async summarize(input: SummaryInput): Promise<{ text: string; model: string | null }> {
    const gw = this.gateway()
    if (!gw || !gw.url || !gw.apiKey || !gw.model) return { text: input.fallbackText, model: null }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(messagesUrl(gw.url), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': gw.apiKey,
          authorization: `Bearer ${gw.apiKey}`,
        },
        body: JSON.stringify({
          model: gw.model,
          max_tokens: 1200,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildSummaryUserPrompt(input) }],
        }),
      })
      if (!res.ok) throw new Error(`summary model HTTP ${res.status}`)
      const body = (await res.json()) as { content?: Array<{ type?: string; text?: string }> }
      const text = (body.content ?? [])
        .filter(b => b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
        .join('\n')
        .trim()
      if (!text) throw new Error('summary model returned no text')
      return { text, model: gw.model }
    } catch (err) {
      console.warn(`[agentify] summary model unavailable, using extractive summary: ${err instanceof Error ? err.message : String(err)}`)
      return { text: input.fallbackText, model: null }
    } finally {
      clearTimeout(timer)
    }
  }
}
