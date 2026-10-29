import { parseDocument } from 'yaml'
import { ExternalProviderError } from './policy.js'
import { digest } from './store.js'

export const DEFINITION_PROFILE_VERSION = 1
const reject = (): never => { throw new ExternalProviderError(400, 'UNSUPPORTED_DIFY_DEFINITION') }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) return reject()
  return value as Record<string, unknown>
}
function empty(value: unknown): void { if (value !== undefined && (!Array.isArray(value) || value.length)) reject() }
function disabled(value: unknown, keys: string[] = []): Record<string, unknown> {
  if (value === undefined) return {}
  const item = record(value, ['enabled', ...keys])
  if (item.enabled !== false) reject()
  return item
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  return JSON.stringify(value)
}

/** Validates an observed query-only snapshot, never proves the remotely executed revision. */
export function definitionDigest(source: unknown): string {
  if (typeof source !== 'string' || !source.trim() || source.length > 256_000) return reject()
  const document = parseDocument(source, { uniqueKeys: true })
  if (document.errors.length) return reject()
  let value: unknown
  try { value = document.toJS({ maxAliasCount: 0 }) } catch { return reject() }
  const root = record(value, ['kind', 'version', 'app', 'dependencies', 'workflow'])
  if (root.kind !== undefined && root.kind !== 'app') reject()
  if (root.app !== undefined) {
    const app = record(root.app, ['name', 'mode', 'icon', 'icon_type', 'icon_background', 'description', 'use_icon_as_answer_icon'])
    if (app.mode !== 'advanced-chat') reject()
  }
  // Model plugin declarations are provenance only. Never install anything from the DSL.
  if (root.dependencies !== undefined) {
    if (!Array.isArray(root.dependencies)) return reject()
    for (const dependency of root.dependencies) {
      const item = record(dependency, ['type', 'value', 'current_identifier'])
      if (item.type !== 'marketplace') reject()
      const value = record(item.value, ['marketplace_plugin_unique_identifier', 'current_identifier', 'version'])
      for (const metadata of [item.current_identifier, value.current_identifier, value.version]) {
        if (metadata !== undefined && metadata !== null && typeof metadata !== 'string') reject()
      }
    }
  }
  const workflow = record(root.workflow, ['graph', 'features', 'environment_variables', 'conversation_variables', 'rag_pipeline_variables'])
  empty(workflow.environment_variables); empty(workflow.conversation_variables); empty(workflow.rag_pipeline_variables)
  // Graph-only uploads omit workflow-wide capabilities and cannot establish this profile.
  const features = record(workflow.features, ['file_upload', 'opening_statement', 'suggested_questions', 'suggested_questions_after_answer', 'speech_to_text', 'text_to_speech', 'retriever_resource', 'sensitive_word_avoidance'])
  if (features.opening_statement !== undefined && typeof features.opening_statement !== 'string') reject()
  if (features.suggested_questions !== undefined && (!Array.isArray(features.suggested_questions) || features.suggested_questions.some(item => typeof item !== 'string'))) reject()
  disabled(features.suggested_questions_after_answer)
  disabled(features.speech_to_text)
  disabled(features.text_to_speech, ['language', 'voice', 'autoPlay'])
  // Dify's retrieval_resource manager maps this solely to show_retrieve_source.
  // Retrieval nodes and LLM context remain forbidden independently.
  if (features.retriever_resource !== undefined) {
    const display = record(features.retriever_resource, ['enabled'])
    if (typeof display.enabled !== 'boolean') reject()
  }
  disabled(features.sensitive_word_avoidance, ['type', 'configs'])
  if (features.file_upload !== undefined) {
    const files = record(features.file_upload, ['enabled', 'image', 'allowed_file_extensions', 'allowed_file_types', 'allowed_file_upload_methods', 'number_limits', 'fileUploadConfig'])
    if (files.enabled !== undefined && files.enabled !== false) reject()
    disabled(files.image, ['number_limits', 'transfer_methods'])
  }
  const graph = record(workflow.graph, ['nodes', 'edges', 'viewport'])
  if (!Array.isArray(graph.nodes) || graph.nodes.length !== 3 || !Array.isArray(graph.edges) || graph.edges.length !== 2) return reject()
  const ids = new Map<string, string>()
  for (const node of graph.nodes) {
    const item = record(node, ['id', 'type', 'data', 'position', 'positionAbsolute', 'sourcePosition', 'targetPosition', 'width', 'height', 'selected', 'dragging'])
    if (typeof item.id !== 'string' || !item.id || ids.has(item.id)) return reject()
    const data = record(item.data, ['type', 'title', 'desc', 'selected', 'variables', 'answer', 'model', 'prompt_template', 'context', 'vision', 'memory'])
    if (!['start', 'llm', 'answer'].includes(String(data.type)) || [...ids.values()].includes(String(data.type))) reject()
    ids.set(item.id, String(data.type))
    const common = ['type', 'title', 'desc', 'selected']
    if (data.type === 'start') { record(data, [...common, 'variables']); empty(data.variables) }
    if (data.type === 'answer') {
      record(data, [...common, 'variables', 'answer']); empty(data.variables)
      if (typeof data.answer !== 'string') reject()
    }
    if (data.type === 'llm') {
      record(data, [...common, 'model', 'prompt_template', 'context', 'vision', 'memory'])
      const model = record(data.model, ['provider', 'name', 'mode', 'completion_params'])
      if (typeof model.provider !== 'string' || !model.provider || typeof model.name !== 'string' || !model.name || model.mode !== 'chat') reject()
      const params = record(model.completion_params, ['temperature', 'max_tokens', 'top_p', 'top_k', 'presence_penalty', 'frequency_penalty', 'seed', 'stop'])
      for (const [key, value] of Object.entries(params)) {
        if (key === 'stop' ? !Array.isArray(value) || value.some(item => typeof item !== 'string') : typeof value !== 'number' || !Number.isFinite(value)) reject()
      }
      const context = disabled(data.context, ['variable_selector']); empty(context.variable_selector)
      const vision = disabled(data.vision, ['configs'])
      if (vision.configs !== undefined) record(vision.configs, ['detail', 'variable_selector'])
      if (!Array.isArray(data.prompt_template) || !data.prompt_template.length) return reject()
      for (const prompt of data.prompt_template) {
        const part = record(prompt, ['id', 'role', 'text', 'edition_type'])
        if (!['system', 'user', 'assistant'].includes(String(part.role)) || typeof part.text !== 'string' || (part.edition_type !== undefined && part.edition_type !== 'basic')) reject()
      }
      if (data.memory !== undefined && data.memory !== null) {
        const memory = record(data.memory, ['window', 'query_prompt_template', 'role_prefix'])
        if (memory.window !== undefined) {
          const window = record(memory.window, ['enabled', 'size'])
          if (typeof window.enabled !== 'boolean' || !Number.isSafeInteger(window.size) || Number(window.size) < 1) reject()
        }
        if (memory.query_prompt_template !== undefined && typeof memory.query_prompt_template !== 'string') reject()
        if (memory.role_prefix !== undefined) {
          const prefix = record(memory.role_prefix, ['user', 'assistant'])
          if (Object.values(prefix).some(value => typeof value !== 'string')) reject()
        }
      }
    }
  }
  const links = new Set<string>()
  for (const edge of graph.edges) {
    const item = record(edge, ['id', 'source', 'sourceHandle', 'target', 'targetHandle', 'type', 'data', 'zIndex', 'selected'])
    const link = `${ids.get(String(item.source))}:${ids.get(String(item.target))}`
    if (!['start:llm', 'llm:answer'].includes(link) || links.has(link)) reject()
    if (item.data !== undefined) record(item.data, ['sourceType', 'targetType', 'isInIteration', 'isInLoop'])
    links.add(link)
  }
  return digest(stable(root))
}
